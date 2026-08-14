/**
 * approval.mjs — ask the user before running something, over the protocol.
 *
 * agent-runtime's engine expects `requestApproval({ tool, action, detail })` to
 * resolve to "accept" / "acceptForSession" / "decline". The protocol asks the
 * other way round: the server sends `item/commandExecution/requestApproval` (or
 * the fileChange variant) and the client answers with a decision. This adapts
 * one to the other.
 *
 * Two things this got wrong, both of which made every approval a silent refusal:
 *
 *  1. The decision vocabulary was the CORE enum (`approved`,
 *     `approved_for_session`), not the v2 wire one. The v2 enums are
 *     `accept` / `acceptForSession` / `decline` / `cancel`
 *     (codex-rs/app-server-protocol/src/protocol/v2/item.rs). A user pressing
 *     "approve" therefore fell through to the default and was read as a refusal.
 *  2. The params were missing every required field — `threadId`, `turnId`,
 *     `itemId`, `startedAtMs` — and sent `command` as an argv array where the
 *     protocol has an optional string. The request could not deserialize, so the
 *     client answered `-32601`, which this file caught and turned into a
 *     refusal. The user was never asked at all.
 *
 * Everything here still fails CLOSED. An unanswered request, a dropped
 * connection, a client that errors — all become "decline". Running an unapproved
 * command because a message went missing is the one outcome that is never
 * acceptable. The difference is that a refusal now means the user refused.
 */

/**
 * Protocol decision -> engine decision. Anything unrecognised is a refusal.
 *
 * The amendment variants (`acceptWithExecpolicyAmendment`,
 * `applyNetworkPolicyAmendment`) carry a policy change we do not implement.
 * They ARE approvals, so treating them as refusals would ignore a user who
 * said yes; we honour the approval and drop the policy part.
 */
export function toEngineDecision(decision) {
  // A tagged variant arrives as an object: `{ acceptWithExecpolicyAmendment: … }`.
  const name = typeof decision === "string" ? decision : Object.keys(decision ?? {})[0];
  switch (name) {
    case "accept":
    case "acceptWithExecpolicyAmendment":
    case "applyNetworkPolicyAmendment":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    // "decline", "cancel", and anything we do not recognise: do not run it.
    default:
      return "decline";
  }
}

/**
 * The protocol's `command` is an optional STRING, not an argv array.
 *
 * The engine hands us a command line, and a command line is what will run —
 * `sh -lc <line>`. Rendering it as the line itself is both what the type says
 * and what is true; inventing a tokenisation the shell would not perform would
 * be neither.
 */
export function commandText(detail) {
  const text = String(detail ?? "").trim();
  return text || null;
}

/**
 * Build a `requestApproval` for the engine, backed by `request(method, params)`.
 *
 * `ids()` supplies the thread and turn this approval belongs to; the client
 * files the request by them and drops anything it cannot place. `timeoutMs`
 * bounds the wait so a user who walked away pauses the turn instead of pinning
 * it forever, and a timeout is a refusal.
 */
export function createApprovalBridge({ request, cwd, timeoutMs = 0, ids = () => ({}), newItemId }) {
  let callSeq = 0;
  return async function requestApproval({ tool, action, detail, reason } = {}) {
    const callId = `call-${++callSeq}`;
    const { threadId, turnId } = ids() ?? {};
    // The client routes by these. Without them the request cannot deserialize,
    // and a failed deserialization is answered as an error — i.e. a refusal the
    // user never saw.
    if (!threadId || !turnId) return "decline";

    const isFileChange = tool === "fs" || tool === "edit" || tool === "write" || tool === "apply_patch";
    const method = isFileChange
      ? "item/fileChange/requestApproval"
      : "item/commandExecution/requestApproval";
    const base = {
      threadId,
      turnId,
      itemId: newItemId ? newItemId() : callId,
      startedAtMs: Date.now(),
      approvalId: callId,
      reason: reason ?? action ?? null,
    };
    const params = isFileChange
      ? { ...base, grantRoot: null }
      : { ...base, command: commandText(detail), cwd: cwd ?? process.cwd(), environmentId: null, parsedCmd: [] };

    try {
      const answer = await request(method, params, { timeoutMs });
      return toEngineDecision(answer?.decision);
    } catch {
      // A client that errors or vanishes gets the same answer as one that says no.
      return "decline";
    }
  };
}
