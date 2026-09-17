// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-context-overflow.mjs — a way out when the compaction summary itself
 * overflows the context window.
 *
 * compaction-basic summarizes a span by replaying it to the model. If that
 * request is itself too large (typically when the model's real window is
 * smaller than dsh believes), the summary fails with
 * CONTEXT_WINDOW_EXCEEDED and so does the compaction that was meant to
 * rescue the turn. Codex (compact.rs) drops the oldest history items from the
 * summary input and tries again.
 *
 * dsh's hook for this is the `compaction/summary-error` waterfall: a listener
 * that durably changes the selected input and returns true makes the
 * compactor re-derive the input from the same span and retry. This plugin
 * replaces the oldest tool outputs inside the span with a short stub —
 * about `dropRatio` of the span's estimated tokens per attempt — using the
 * same durable protocol as dsh's tool-result pruner (a `compaction/prune`
 * shadow price immediately followed by a `tool/result` surface replace).
 * Those nodes are about to be folded into the summary anyway. The span's
 * first and last nodes are never replaced: the compactor re-validates the
 * span by them. When nothing replaceable is left it delegates (`next()`), so
 * the retry loop always terminates.
 *
 * Only tool outputs are shed: replacing user or assistant messages would
 * break tool-call pairing or lose the task. A span whose bulk is not tool
 * output still fails as before.
 *
 * Loaded as a patch `insert` row (see unieai-catalog.mjs).
 */
import { freezeMessage, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import { textOfBlocks } from "./unieai-loop-common.mjs";

export const name = "unieai-context-overflow";
export const inject = ["tokenMeter"];

export const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
export const STUB_TEXT = "[tool output dropped to fit the context window during compaction; re-run the call if it is still needed]";
export const DEFAULTS = Object.freeze({ dropRatio: 0.25 });

export function isOverflowError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === CONTEXT_WINDOW_EXCEEDED || error.failure?.code === CONTEXT_WINDOW_EXCEEDED) return true;
  try {
    return typeof error.message === "string" && isContextWindowExceededError(error.message);
  } catch {
    return false;
  }
}

const isStub = (message) => textOfBlocks(message?.content?.[0]?.content).trim() === STUB_TEXT;

/**
 * Replace the oldest tool outputs in `seqs` (excluding its ends) until about
 * `dropRatio` of the span's estimated tokens is gone.
 * @returns the number of replaced nodes (0 = no progress possible).
 */
export function shedOldestToolOutputs(session, seqs, estimate, dropRatio = DEFAULTS.dropRatio) {
  let total = 0;
  const priced = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    const message = event ? session.deriveEventMessage(event) : null;
    if (!message) continue;
    const tokens = estimate(message);
    total += tokens;
    priced.push({ seq, event, message, tokens });
  }
  const ends = new Set([seqs[0], seqs.at(-1)]);
  const stubPrice = (entry) => estimate(stubbed(entry.message));
  const candidates = priced.filter(
    (entry) => entry.event.type === "tool/result" && !ends.has(entry.seq) && !isStub(entry.message) && entry.tokens > stubPrice(entry),
  );
  const target = Math.max(1, Math.ceil(total * dropRatio));
  let dropped = 0;
  let replaced = 0;
  for (const entry of candidates) {
    if (dropped >= target) break;
    const message = stubbed(entry.message);
    session.append("compaction/prune", {
      shadowedRange: { start: entry.seq, end: entry.seq },
      shadowedSeqs: [entry.seq],
      shadowedTokenCount: entry.tokens,
    });
    session.append(
      "tool/result",
      { ...entry.event.data, message },
      { surfaceOp: { op: "replace", startSeq: entry.seq, endSeq: entry.seq }, sourceEventSeqs: [entry.seq] },
    );
    dropped += entry.tokens - estimate(message);
    replaced += 1;
  }
  return replaced;
}

function stubbed(original) {
  const result = original.content[0];
  return freezeMessage({ ...original, content: [{ ...result, content: [{ type: "text", text: STUB_TEXT }] }] });
}

export function apply(ctx, config = {}) {
  const ratio = Number(config.dropRatio);
  const dropRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULTS.dropRatio;
  ctx.on("compaction/summary-error", (payload, next) => {
    const { session, sourceEventSeqs, error, signal } = payload;
    if (!isOverflowError(error) || !sourceEventSeqs?.length) return next();
    signal?.throwIfAborted();
    const replaced = shedOldestToolOutputs(session, sourceEventSeqs, (message) => ctx.tokenMeter.estimateMessage(message), dropRatio);
    if (replaced === 0) return next();
    ctx.logger.info(`${name}: compaction summary overflowed; dropped ${replaced} oldest tool output(s) from the span and retrying`);
    return true;
  });
}
