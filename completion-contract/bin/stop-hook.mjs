#!/usr/bin/env node
/**
 * stop-hook.mjs — the completion contract, as a codex `Stop` hook.
 *
 * codex calls this when the model has decided a turn is over
 * (`core/src/session/turn.rs` → `run_turn_stop_hooks`). We read the hook input
 * from stdin, run the contract, and answer:
 *
 *   {"decision":"block","reason":"<nudge>"}   → codex injects the reason as a
 *                                               continuation prompt and the
 *                                               turn keeps going
 *   {}                                        → the turn ends
 *
 * The hook input already carries everything the contract needs
 * (`codex-rs/hooks/src/schema.rs` `StopCommandInput`):
 *
 *   cwd                  the workspace — `git status` / `git diff` run here
 *   last_assistant_message  what the model claims it did, for the skeptic
 *   turn_id              what the per-turn nudge budget is keyed by
 *   stop_hook_active     true once we have already blocked in this turn.
 *                        Informational only — codex does not cap repeated
 *                        blocks, so the budget below is ours to set.
 *   session_id           what the cross-turn escalation state is keyed by
 *   transcript_path      the rollout, for recovering the user's actual task
 *
 * Everything fails OPEN. A hook that errors, times out, or cannot reach a model
 * must let the turn end — refusing to finish because our verifier is broken is
 * strictly worse than finishing unverified.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createCompletionContract } from "../src/index.mjs";

/**
 * How many times one turn may be sent back. Matches the in-process contract's
 * `completionCheckMax`, which is the value the SWE-bench numbers were measured
 * with. A turn that cannot be closed in this many rounds is not going to be.
 */
const MAX_NUDGES_PER_TURN = Number(process.env.UNIEAI_MAX_NUDGES) || 5;

/** Read all of stdin. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Let the turn end. The only safe answer to anything unexpected. */
function allow() {
  process.stdout.write("{}\n");
  process.exit(0);
}

/**
 * The escalation ladder spans turns, so it has to outlive this process.
 * Keyed by session, under the codex home when we can see it.
 */
function stateFile(sessionId) {
  const home = process.env.UNIEAI_HOME || process.env.CODEX_HOME || join(tmpdir(), "unieai-completion-contract");
  return join(home, "completion-contract", `${String(sessionId).replace(/[^\w.-]/g, "")}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return {};
  }
}

function saveState(sessionId, state) {
  try {
    const path = stateFile(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // Losing the ladder costs us escalation, not correctness.
  }
}

/**
 * The user's actual request for this turn, recovered from the rollout.
 *
 * The skeptic judges the diff against the task, so a wrong task here is worse
 * than none: it would review the work against something the user never asked
 * for. We take the LAST user message and skip the wrappers a harness injects
 * (project instructions, context refreshes, folded summaries, and our own
 * previous nudges).
 */
function taskFromTranscript(path) {
  if (!path || !existsSync(path)) return "";
  let lines;
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return "";
  }
  const SYNTHETIC = /^(\[verification\]|\[loop guardrail\]|<project_instructions>|<context_update>|<conversation_summary>|No files in the workspace have been modified)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const item = rec?.payload ?? rec?.item ?? rec;
    if (item?.type !== "message" || item?.role !== "user") continue;
    const text = (Array.isArray(item.content) ? item.content : [])
      .map((part) => part?.text ?? "")
      .join("")
      .trim();
    if (!text || SYNTHETIC.test(text)) continue;
    return text;
  }
  return "";
}

/**
 * The skeptic's model call, over the same gateway codex itself is using.
 *
 * Deliberately chat-completions rather than the Responses wire: this is a
 * one-shot judgement with no tools and no streaming, and every gateway that
 * serves codex also serves this.
 */
function makeCallModel({ model }) {
  const baseUrl = (process.env.UNIEAI_BASE_URL || "https://api.unieai.com/v1").replace(/\/+$/, "");
  const key = process.env.UNIEAI_API_KEY || process.env.CODEX_API_KEY || "";
  if (!key) return null;
  return async ({ system, user }) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 600,
        stream: false,
        // This is a one-line verdict, not a problem to think through. A thinking
        // model spends the whole token budget on `reasoning_content` and returns
        // `content: null` — which reads as an empty verdict, which reads as
        // ACHIEVED. That silently turned the skeptic into a no-op for an entire
        // benchmark run.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(Number(process.env.UNIEAI_HOOK_TIMEOUT_MS) || 60_000),
    });
    if (!res.ok) throw new Error(`skeptic call failed: ${res.status}`);
    const body = await res.json();
    const message = body?.choices?.[0]?.message ?? {};
    // Belt and braces: if a provider ignores the flag above and still answers
    // with thinking only, the verdict is in `reasoning_content`. An empty
    // verdict is indistinguishable from "no gaps found", so it must never be
    // the result of a field name we failed to read.
    return message.content || message.reasoning_content || "";
  };
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return allow();
  }

  const workspace = input?.cwd;
  const sessionId = input?.session_id || "unknown";
  const turnId = input?.turn_id || "unknown";
  if (!workspace) return allow();

  const state = loadState(sessionId);

  // Per-turn state, reset when the turn changes. The escalation ladder
  // (consecutiveNotAchieved / lastGapFingerprint) deliberately does NOT reset —
  // it is what notices a task failing review turn after turn.
  if (state.turn?.id !== turnId) state.turn = { id: turnId, nudges: 0 };

  // The budget is ours. codex does NOT cap repeated blocks — `stop_hook_active`
  // is informational, and the core keeps continuing the turn for as long as the
  // hook says block (session/turn.rs:402 sets the flag and loops). Using that
  // flag as the budget capped us at ONE nudge per turn, five times fewer than
  // the in-process contract this was ported from, and the difference is
  // measured: instances nudged twice were fixed correctly 75% of the time
  // versus 58% for those never nudged.
  if (state.turn.nudges >= MAX_NUDGES_PER_TURN) return allow();
  const callModel = makeCallModel({ model: input?.model });
  // The contract reads `gatesRan` / `skepticRan` (once per turn) and
  // `consecutiveNotAchieved` / `lastGapFingerprint` (across turns) off one
  // object, so hand it a view that merges both scopes and write the per-turn
  // half back afterwards.
  const view = { ...state, ...state.turn };
  const contract = createCompletionContract({
    workspace,
    // No credentials → the deterministic gates still run; the skeptic is simply
    // skipped rather than the whole contract being disabled.
    callModel: callModel ?? (async () => ""),
    state: view,
    skepticMode: process.env.UNIEAI_SKEPTIC_MODE || "nudged",
  });

  let nudge = null;
  try {
    nudge = await contract({
      task: taskFromTranscript(input?.transcript_path),
      answerText: input?.last_assistant_message ?? "",
      // Did this turn have to be pushed to get here? codex's own re-entry flag
      // answers that without us tracking it: it is set precisely when a previous
      // block in THIS turn was accepted.
      wasNudged: Boolean(input?.stop_hook_active) || state.turn.nudges > 0,
    });
  } catch {
    return allow();
  }
  state.consecutiveNotAchieved = view.consecutiveNotAchieved;
  state.lastGapFingerprint = view.lastGapFingerprint;
  state.turn = {
    ...state.turn,
    gatesRan: view.gatesRan,
    skepticRan: view.skepticRan,
    // Skipped-by-policy is not the same as ran-and-found-nothing, and only the
    // former tells you the adaptive rule is doing anything. Dropping it here made
    // the instrumentation report "0 skipped" for a run where the skeptic went
    // from 97 invocations to 34.
    skepticSkipped: view.skepticSkipped,
  };
  if (nudge) state.turn.nudges += 1;
  saveState(sessionId, state);

  if (!nudge) return allow();
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: nudge })}\n`);
  process.exit(0);
}

main().catch(allow);
