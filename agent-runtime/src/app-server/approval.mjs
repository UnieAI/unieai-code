/**
 * approval.mjs — ask the user before running something, over the protocol.
 *
 * agent-runtime's engine expects `requestApproval({ tool, action, detail })` to
 * resolve to "accept" / "acceptForSession" / "decline". The protocol asks the
 * other way round: the server sends `item/commandExecution/requestApproval` (or
 * the fileChange variant) and the client answers with a ReviewDecision. This
 * adapts one to the other.
 *
 * Everything here fails CLOSED. An unanswered request, a dropped connection, a
 * client that errors — all become "decline". Running an unapproved command
 * because a message went missing is the one outcome that is never acceptable.
 */

/** Protocol decision -> engine decision. Anything unrecognised is a refusal. */
export function toEngineDecision(decision) {
  if (decision === "approved") return "accept";
  if (decision === "approved_for_session") return "acceptForSession";
  // "denied", "abort", "timed_out", and the amendment variants (which carry a
  // policy change we do not implement) all mean: do not run it.
  return "decline";
}

/** Split a shell command into the argv the protocol wants. */
export function commandArgv(detail) {
  const text = String(detail ?? "").trim();
  if (!text) return [];
  // The protocol's `command` is an argv array; the engine hands us a command
  // line. Shipping it as `sh -lc <line>` keeps the rendering honest — that IS
  // what will run — rather than inventing a tokenisation the shell would not do.
  return ["sh", "-lc", text];
}

/**
 * Build a `requestApproval` for the engine, backed by `request(method, params)`.
 *
 * `timeoutMs` bounds the wait so a user who walked away pauses the turn instead
 * of pinning it forever; the protocol has a "timed_out" decision for exactly
 * this, and it maps to a refusal.
 */
export function createApprovalBridge({ request, cwd, timeoutMs = 0 }) {
  let callSeq = 0;
  return async function requestApproval({ tool, action, detail } = {}) {
    const callId = `call-${++callSeq}`;
    const isFileChange = tool === "edit" || tool === "write" || tool === "apply_patch";
    const method = isFileChange
      ? "item/fileChange/requestApproval"
      : "item/commandExecution/requestApproval";
    const params = isFileChange
      ? { callId, approvalId: callId, path: String(detail ?? ""), reason: action ?? null, grantRoot: null }
      : {
          callId,
          approvalId: callId,
          command: commandArgv(detail),
          cwd: cwd ?? process.cwd(),
          reason: action ?? null,
          parsedCmd: [],
        };
    try {
      const answer = await request(method, params, { timeoutMs });
      return toEngineDecision(answer?.decision);
    } catch {
      // A client that errors or vanishes gets the same answer as one that says no.
      return "decline";
    }
  };
}
