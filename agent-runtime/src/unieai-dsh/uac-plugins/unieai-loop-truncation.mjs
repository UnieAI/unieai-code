// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-truncation.mjs — recover tool calls cut off by the output cap.
 *
 * When a response stops at max tokens, dsh's BlockAssembler drops every
 * tool-call block and the agent loop ends the turn with `max-tokens`: the
 * call the model was writing (typically a large file write) never runs and
 * the task silently stops. Codex instead treats an incomplete response as a
 * retryable stream error.
 *
 * Strategy 1 (clean retry): an `llm/stream` wrapper sees an agent-loop
 * attempt finish with `max-tokens` after a tool-call block started, and
 * rewrites that finish into a retryable error (`UNIEAI_OUTPUT_TRUNCATED`).
 * `agent/request-error` answers it with `retry`, and `agent/request` raises
 * `maxTokens` for the retried attempt of that same step (×growth, bounded by
 * the model's context window minus the observed input, and by a ceiling). At
 * most `maxRetries` such retries per step; the failed attempt is recorded
 * only as `assistant/attempt`, so history stays clean. The next step goes
 * back to the original `maxTokens`.
 *
 * Strategy 2 (after retries are exhausted, or when no larger cap is
 * possible): the max-tokens finish passes through, and at
 * `agent/turn-stopping` the plugin steers a reminder that the truncated call
 * did not run and should be re-issued in smaller pieces (at most
 * `maxReminders` per turn).
 *
 * Sticky max-tokens: once a step ends at the cap, the loop keeps the turn's
 * end reason at `max-tokens` and stops at every later step boundary, even
 * after a step that made tool calls. So after a truncation has surfaced, a
 * turn-stopping whose closing step made (non-concluding) tool calls is
 * continued with a one-line steer, at most `maxContinuations` per turn. The
 * turn's recorded end reason stays `max-tokens` (ACP `max_tokens`).
 *
 * Loaded as a patch `insert` row (see unieai-catalog.mjs).
 */
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { inputTokensOf, lastAssistantEventInTurn, pluginNotice, positiveInt } from "./unieai-loop-common.mjs";

export const name = "unieai-loop-truncation";
export const inject = ["agents", "llm"];

export const TRUNCATED_CODE = "UNIEAI_OUTPUT_TRUNCATED";

export const DEFAULTS = Object.freeze({
  maxRetries: 2,
  growth: 2,
  maxTokensCeiling: 65536,
  reserveTokens: 1024,
  maxReminders: 2,
  maxContinuations: 64,
});

export const REMINDER = [
  "<system-reminder>",
  "Your previous response hit the output token limit while it was still writing a tool call.",
  "That tool call was discarded and did NOT run; nothing it would have changed has changed.",
  "Re-issue the work in smaller pieces: for example create a large file in several parts",
  "(write the first part, then append the rest in follow-up calls), or split one large edit",
  "into several smaller edits. Keep any prose before the tool call short.",
  "</system-reminder>",
].join("\n");

export const CONTINUE = "<system-reminder>Continue with the task.</system-reminder>";

export function resolveConfig(config = {}) {
  const growth = Number(config.growth ?? DEFAULTS.growth);
  return {
    maxRetries: Number.isSafeInteger(config.maxRetries) && config.maxRetries >= 0 ? config.maxRetries : DEFAULTS.maxRetries,
    growth: Number.isFinite(growth) && growth > 1 ? growth : DEFAULTS.growth,
    maxTokensCeiling: positiveInt(config.maxTokensCeiling, DEFAULTS.maxTokensCeiling),
    reserveTokens: Number.isSafeInteger(config.reserveTokens) && config.reserveTokens >= 0 ? config.reserveTokens : DEFAULTS.reserveTokens,
    maxReminders: Number.isSafeInteger(config.maxReminders) && config.maxReminders >= 0 ? config.maxReminders : DEFAULTS.maxReminders,
    maxContinuations: Number.isSafeInteger(config.maxContinuations) && config.maxContinuations >= 0 ? config.maxContinuations : DEFAULTS.maxContinuations,
  };
}

/**
 * The output cap for the retry, or null when no larger cap is possible.
 * `current` is the cap the truncated attempt ran with (undefined when the
 * provider applied its own default); the observed output stands in for it.
 */
export function nextMaxTokens({ current, usage, contextWindow, growth, ceiling, reserve }) {
  const basis = Math.max(current ?? 0, usage?.outputTokens ?? 0);
  if (!(basis > 0)) return null;
  let limit = ceiling;
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
    limit = Math.min(limit, contextWindow - inputTokensOf(usage) - reserve);
  }
  const proposed = Math.floor(Math.min(basis * growth, limit));
  return proposed > basis ? proposed : null;
}

/** Whether a chunk shows the model had started a tool call. */
export function startsToolCall(chunk) {
  return (chunk?.type === "block-start" && chunk.blockType === "tool-call") || chunk?.type === "tool-call-delta";
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  /** @type {WeakMap<object, any>} per-agent state */
  const states = new WeakMap();

  const stateOf = (agent) => {
    let state = states.get(agent);
    if (!state) {
      state = { turn: null, position: null, retries: new Map(), boost: null, raised: null, truncated: null, reminders: 0, sticky: false, continuations: 0, concludedStep: null };
      states.set(agent, state);
    }
    return state;
  };

  async function modelContextWindow(provider, model) {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model);
      return info?.context?.contextWindow;
    } catch {
      return undefined;
    }
  }

  async function* guard(options, source, state, position) {
    let sawToolCall = false;
    let usage;
    for await (const chunk of source) {
      if (startsToolCall(chunk)) sawToolCall = true;
      if (chunk?.type === "usage") usage = chunk.usage;
      // A text-only truncation passes through: the turn's end reason is now max-tokens.
      if (chunk?.type === "finish" && chunk.reason?.kind === "max-tokens" && !sawToolCall) state.sticky = true;
      if (chunk?.type === "finish" && chunk.reason?.kind === "max-tokens" && sawToolCall) {
        const key = `${position.turn}:${position.step}`;
        const used = state.retries.get(key) ?? 0;
        const next = used < config.maxRetries
          ? nextMaxTokens({
              current: options.maxTokens,
              usage,
              contextWindow: await modelContextWindow(options.provider, options.model),
              growth: config.growth,
              ceiling: config.maxTokensCeiling,
              reserve: config.reserveTokens,
            })
          : null;
        if (next !== null) {
          state.retries.set(key, used + 1);
          state.boost = { ...position, maxTokens: next };
          ctx.logger.info(`${name}: tool call truncated at ${options.maxTokens ?? usage?.outputTokens ?? "?"} tokens (turn ${position.turn} step ${position.step}); retry ${used + 1}/${config.maxRetries} with maxTokens ${next}`);
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                code: TRUNCATED_CODE,
                message: `response truncated at the output token limit while writing a tool call; retrying with maxTokens ${next}`,
              },
            },
          };
          continue;
        }
        state.truncated = { ...position };
        state.sticky = true;
        ctx.logger.info(`${name}: tool call truncated (turn ${position.turn} step ${position.step}); no retry left, will remind`);
      }
      yield chunk;
    }
  }

  ctx.on("llm/stream", (options, next) => {
    if (options?.sessionId === undefined || !isAgentLoopRequest(options)) return next();
    const agent = ctx.agents.get(options.sessionId);
    const state = agent && states.get(agent);
    if (!state?.position) return next();
    return guard(options, next(), state, state.position);
  });

  ctx.on("agent/request", async (payload, next) => {
    const { agent, turn, step } = payload;
    const state = stateOf(agent);
    if (state.turn !== turn) {
      state.turn = turn;
      state.retries.clear();
      state.truncated = null;
      state.reminders = 0;
      state.sticky = false;
      state.continuations = 0;
      state.concludedStep = null;
    }
    state.position = { turn, step };
    const base = await next();
    const boost = state.boost;
    if (boost && boost.turn === turn && boost.step === step) {
      if (!state.raised) state.raised = { original: base.maxTokens, value: boost.maxTokens };
      else state.raised.value = boost.maxTokens;
      return { ...base, maxTokens: boost.maxTokens };
    }
    state.boost = null;
    const raised = state.raised;
    state.raised = null;
    // The raised cap was logged in the request header, which seeds later
    // requests: put the original back.
    if (raised && base.maxTokens === raised.value) {
      const { maxTokens: _dropped, ...rest } = base;
      return raised.original === undefined ? rest : { ...rest, maxTokens: raised.original };
    }
    return base;
  });

  ctx.on("agent/request-error", (payload, next) => {
    if (payload.failure?.code !== TRUNCATED_CODE) return next();
    return Promise.resolve({ kind: "retry" });
  });

  ctx.on("tools/result", (exec, result) => {
    if (exec.parent !== undefined || !exec.agent || result?.concludesTurn !== true) return;
    const state = states.get(exec.agent);
    if (state?.position) state.concludedStep = state.position.step;
  });

  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    const state = states.get(agent);
    if (!state || state.turn !== turn || signal?.aborted) return;
    const truncated = state.truncated;
    state.truncated = null;
    if (agent.inbox.nextStep.length > 0) return;
    const closingStep = state.position?.step;
    // The step closing the turn is the truncated one: remind.
    if (truncated && truncated.step === closingStep) {
      if (state.reminders >= config.maxReminders) return;
      state.reminders += 1;
      agent.steer(pluginNotice(name, REMINDER, "truncated tool call was not run"));
      return;
    }
    // Stopping only because max-tokens is sticky: the closing step made tool
    // calls and none concluded the turn, so the loop would have gone on.
    if (!state.sticky || state.concludedStep === closingStep) return;
    const last = lastAssistantEventInTurn(agent.session, turn);
    if (!last || last.data.step !== closingStep || last.data.interrupted) return;
    if (!last.data.message?.content?.some((block) => block?.type === "tool-call")) return;
    if (state.continuations >= config.maxContinuations) return;
    state.continuations += 1;
    agent.steer(pluginNotice(name, CONTINUE, "continue after an output-limit stop"));
  });
}
