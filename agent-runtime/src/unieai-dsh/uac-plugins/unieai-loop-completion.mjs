// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-completion.mjs — do not let a turn end on a non-answer.
 *
 * dsh ends a turn as soon as a response carries no tool call. Weaker models
 * often stop with (a) a response that has neither text nor a tool call
 * (reasoning only), or (b) text announcing the next action ("Let me fix the
 * file:") without calling the tool. Both end the task with nothing done.
 *
 * At `agent/turn-stopping` this plugin reads the turn's last
 * `assistant/message` from the session log and, for those two shapes, steers
 * a short continuation so the loop runs another step. It is deterministic
 * (no extra model calls) and bounded, the analogue of codex's
 * `stop_hook_active`: at most `maxNudges` per turn, and never twice for the
 * same response fingerprint (a model that repeats itself is let go).
 *
 * Completion contract (unieai-agent-core): a host may veto a final answer.
 * `checkUrl` (config, else env `UNIEAI_COMPLETION_CHECK_URL`) is POSTed
 * `{sessionId, turn, answerText, nudges}` and answers `{nudge}`; a non-empty
 * nudge is steered in and the turn goes on, at most `checkMax` times per turn.
 * An in-process plugin can register a check with `setCompletionCheck`. A check
 * that fails or times out accepts the answer. When the veto lands while the
 * turn is winding down (unieai-loop-guard sent the wrap-up), the wrap-up is
 * rescinded once per turn and the budget extended by `reprieveSteps`.
 *
 * The empty/announce nudges are skipped during the wind-down: there is no
 * budget left to act on them.
 */
import { lastAssistantEventInTurn, pluginNotice, positiveInt, shortHash, textOfBlocks } from "./unieai-loop-common.mjs";
import { REPRIEVE_STEPS, grantReprieve, turnState, windingDown } from "./unieai-loop-state.mjs";

export const name = "unieai-loop-completion";

export const DEFAULTS = Object.freeze({ maxNudges: 3, announceMaxChars: 600, checkMax: 1, checkTimeoutMs: 10_000, reprieveSteps: REPRIEVE_STEPS });

const checks = new WeakMap();

/**
 * Register the host completion check for one dsh app (`ctx.root`):
 * `async ({agent, turn, answerText, nudges}) => string | null`. Returns the
 * disposer.
 */
export function setCompletionCheck(ctx, check) {
  const root = ctx.root ?? ctx;
  checks.set(root, check);
  return () => {
    if (checks.get(root) === check) checks.delete(root);
  };
}

/** A check that asks the host over HTTP. */
export function httpCompletionCheck(url, { timeoutMs = DEFAULTS.checkTimeoutMs, fetchImpl = globalThis.fetch } = {}) {
  return async ({ agent, turn, answerText, nudges }) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: agent.id, turn, answerText, nudges }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`completion check answered ${response.status}`);
    const body = await response.json();
    return typeof body?.nudge === "string" ? body.nudge : null;
  };
}

export const NUDGES = Object.freeze({
  empty: [
    "<system-reminder>",
    "Your last response had no answer text and no tool call, so the turn was about to end with nothing to show.",
    "If the task is not finished, continue now by calling the appropriate tool.",
    "If it is finished, reply with a brief final answer that states the result.",
    "</system-reminder>",
  ].join("\n"),
  announce: [
    "<system-reminder>",
    "You described your next action but did not call a tool, so nothing was executed and the turn was about to end.",
    "If that action is still needed, perform it now with a tool call instead of describing it.",
    "If the task is already complete, reply with the final answer.",
    "</system-reminder>",
  ].join("\n"),
});

// "Let me …", "I'll …", "Now I will …", "Next, I'm going to …" — but not "let me know".
const ANNOUNCE_EN = /^(?:(?:ok(?:ay)?|now|next|first|then|great|alright|so)[,!.]?\s+)*(?:let me|let's|let us|i(?:'ll| will| am going to|'m going to| need to| should))\s+(?!know\b)/i;
// 让我/讓我 …, 我将/我將/我会/我會/我来/我來/我要 …, 接下来我 …
const ANNOUNCE_ZH = /^(?:(?:好的|好|現在|现在|接下來|接下来|首先|然後|然后|下一步)[，,：:]?\s*)*(?:讓我|让我|我們來|我们来|我(?:將|将|會|会|來|来|要|需要|先))/;

// Endings addressed to the user are legitimate ("let me know", "I'll wait").
const ADDRESSED_TO_USER = /\b(?:let\s+me\s+know|let\s+us\s+know|i['’]?ll\s+(?:wait|stop|leave|hold)|let['’]?s\s+(?:discuss|talk)|i\s+will\s+wait|if\s+you\s+(?:want|would|prefer|need))\b/i;

/** The last sentence-ish fragment of a text, markdown decorations and code fences removed. */
export function lastSentence(text) {
  const lines = text.replace(/```[\s\S]*?```/g, " ").split(/\r?\n/).map((line) => line.replace(/^[\s>*#\-\d.)`]+/, "").trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  // ASCII punctuation ends a sentence only before whitespace ("main.py" does not).
  const parts = last.split(/(?<=[.!?])\s+|(?<=[。！？])/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? last;
}

/** Whether the response ends by announcing an action instead of doing it. */
export function announcesAction(text, maxChars = DEFAULTS.announceMaxChars) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const sentence = lastSentence(trimmed);
  if (!sentence || /[?？]$/.test(sentence) || ADDRESSED_TO_USER.test(sentence)) return false;
  if (!(ANNOUNCE_EN.test(sentence) || ANNOUNCE_ZH.test(sentence))) return false;
  // A long answer that merely ends with "I'll …" is most likely a real answer;
  // a trailing colon or ellipsis is a hand-off to a call that never came.
  return trimmed.length <= maxChars || /(?:[:：]|\.\.\.|…)$/.test(sentence);
}

/**
 * Why a response should not end the turn, or null.
 * @returns {{kind: 'empty'|'announce', fingerprint: string} | null}
 */
export function classifyStop(data, options = {}) {
  if (!data || data.interrupted) return null;
  const content = data.message?.content ?? [];
  if (content.some((block) => block?.type === "tool-call")) return null;
  const text = textOfBlocks(content).trim();
  if (!text) {
    const reasoning = content.filter((block) => block?.type === "reasoning").map((block) => block.text ?? "").join("");
    return { kind: "empty", fingerprint: `empty:${shortHash(reasoning)}` };
  }
  if (announcesAction(text, options.announceMaxChars)) {
    return { kind: "announce", fingerprint: `announce:${shortHash(text.replace(/\s+/g, " "))}` };
  }
  return null;
}

export function apply(ctx, rawConfig = {}, { env = process.env, fetchImpl } = {}) {
  const maxNudges = positiveInt(rawConfig.maxNudges, DEFAULTS.maxNudges);
  const announceMaxChars = positiveInt(rawConfig.announceMaxChars, DEFAULTS.announceMaxChars);
  const checkMax = positiveInt(rawConfig.checkMax, DEFAULTS.checkMax);
  const reprieveSteps = positiveInt(rawConfig.reprieveSteps, DEFAULTS.reprieveSteps);
  const checkUrl = rawConfig.checkUrl ?? env.UNIEAI_COMPLETION_CHECK_URL;
  if (checkUrl) {
    const timeoutMs = positiveInt(rawConfig.checkTimeoutMs, DEFAULTS.checkTimeoutMs);
    ctx.effect(() => setCompletionCheck(ctx, httpCompletionCheck(String(checkUrl), { timeoutMs, fetchImpl })));
  }
  const states = new WeakMap();

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    if (signal?.aborted) return;
    if (agent.inbox.nextStep.length > 0) return; // someone already continues the turn
    let state = states.get(agent);
    if (!state || state.turn !== turn) {
      state = { turn, nudges: 0, seen: new Set() };
      states.set(agent, state);
    }
    const loop = turnState(agent, turn);
    const winding = windingDown(loop);
    const event = lastAssistantEventInTurn(agent.session, turn);

    if (!winding && state.nudges < maxNudges) {
      const verdict = classifyStop(event?.data, { announceMaxChars });
      if (verdict && !state.seen.has(verdict.fingerprint)) {
        state.seen.add(verdict.fingerprint);
        state.nudges += 1;
        ctx.logger.info(`${name}: turn ${turn} stopping on ${verdict.kind} response; continuation ${state.nudges}/${maxNudges}`);
        agent.steer(pluginNotice(name, NUDGES[verdict.kind], verdict.kind === "empty" ? "empty response: continue" : "announced action without a tool call"));
        return;
      }
    }

    const check = checks.get(ctx.root ?? ctx);
    if (!check || event?.data?.interrupted || loop.completionNudges >= checkMax) return;
    if (winding && loop.reprieveUsed) return;
    let nudge = null;
    try {
      nudge = await check({ agent, turn, answerText: textOfBlocks(event?.data?.message?.content), nudges: loop.completionNudges });
    } catch (error) {
      ctx.logger.warn(`${name}: completion check failed; accepting the answer: ${error?.message ?? error}`);
    }
    if (typeof nudge !== "string" || !nudge.trim() || signal?.aborted) return;
    loop.completionNudges += 1;
    if (winding && grantReprieve(loop, reprieveSteps)) {
      ctx.logger.info(`${name}: turn ${turn} completion check rejected a wind-down answer; reprieve of ${reprieveSteps} steps`);
    }
    agent.steer(pluginNotice(name, nudge.trim(), "completion check: not done yet"));
  });
}
