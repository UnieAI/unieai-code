// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-budget.mjs — a wall-clock / step budget per turn.
 *
 * dsh's agent loop has no step or time limit, and provider retries can burn
 * minutes. For unattended runs (benchmarks, headless jobs) this plugin gives
 * each turn a budget:
 *   - deadline: `deadlineMs` config, else env `UNIEAI_TURN_DEADLINE_MS`;
 *   - steps:    `maxSteps` config, else env `UNIEAI_TURN_MAX_STEPS`.
 * Unset (or non-positive) means unlimited; with neither set the plugin is idle.
 *
 * When `warnRatio` of the time (or `warnSteps` steps) is left, the next step
 * carries one reminder to wrap up and verify. Past the budget, the next step
 * boundary is rejected (the turn ends `blocked`), a timer cancels a step that
 * runs past the deadline (cause `hook`), and `agent/request-error` stops
 * delegating to provider retries (listener prepended so it runs before
 * llm-retry) once the deadline has passed or fewer than `minRetryWindowMs`
 * remain.
 *
 * Loaded through the uac patch as an `insert` row (see config.mjs).
 */
import { pluginNotice, positiveInt } from "./unieai-loop-common.mjs";

export const name = "unieai-loop-budget";

export const DEFAULTS = Object.freeze({ warnRatio: 0.2, warnSteps: 5, minRetryWindowMs: 15_000, cancelGraceMs: 5_000 });

export function resolveConfig(config = {}, env = process.env) {
  const ratio = Number(config.warnRatio);
  return {
    deadlineMs: positiveInt(config.deadlineMs, positiveInt(env.UNIEAI_TURN_DEADLINE_MS, 0)),
    maxSteps: positiveInt(config.maxSteps, positiveInt(env.UNIEAI_TURN_MAX_STEPS, 0)),
    warnRatio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULTS.warnRatio,
    warnSteps: positiveInt(config.warnSteps, DEFAULTS.warnSteps),
    minRetryWindowMs: positiveInt(config.minRetryWindowMs, DEFAULTS.minRetryWindowMs),
    cancelGraceMs: positiveInt(config.cancelGraceMs, DEFAULTS.cancelGraceMs),
  };
}

export function wrapUpText({ remainingMs, remainingSteps }) {
  const parts = [];
  if (remainingMs !== null) parts.push(`about ${Math.max(0, Math.round(remainingMs / 1000))} seconds`);
  if (remainingSteps !== null) parts.push(`${Math.max(0, remainingSteps)} steps`);
  return [
    "<system-reminder>",
    `This task's budget is nearly used up: ${parts.join(" and ")} remain.`,
    "Stop exploring. Finish the change you are making, run the most relevant check once, and give your final answer.",
    "</system-reminder>",
  ].join("\n");
}

/** Where a turn stands against the budget. */
export function budgetStatus(config, { startedAt, step, now }) {
  const remainingMs = config.deadlineMs ? config.deadlineMs - (now - startedAt) : null;
  const remainingSteps = config.maxSteps ? config.maxSteps - step + 1 : null; // steps left including this one
  const exhausted = (remainingMs !== null && remainingMs <= 0) || (remainingSteps !== null && remainingSteps <= 0);
  const low =
    (remainingMs !== null && remainingMs <= config.deadlineMs * config.warnRatio) ||
    (remainingSteps !== null && remainingSteps <= config.warnSteps);
  return { remainingMs, remainingSteps, exhausted, low };
}

export function apply(ctx, rawConfig = {}, { now = () => Date.now(), env = process.env } = {}) {
  const config = resolveConfig(rawConfig, env);
  if (!config.deadlineMs && !config.maxSteps) {
    ctx.logger.info(`${name}: no deadline or step budget configured; idle`);
    return;
  }
  const states = new WeakMap();
  const timers = new Set();

  const clearTimer = (state) => {
    if (state?.timer) {
      clearTimeout(state.timer);
      timers.delete(state.timer);
      state.timer = null;
    }
  };

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent, turn, step } = payload;
    let state = states.get(agent);
    if (!state || state.turn !== turn) {
      clearTimer(state);
      state = { turn, startedAt: now(), warned: false, timer: null };
      states.set(agent, state);
      if (config.deadlineMs) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (states.get(agent) !== state || agent.status !== "running") return;
          ctx.logger.warn(`${name}: turn ${turn} passed its ${config.deadlineMs}ms deadline; cancelling`);
          agent.cancel({ kind: "hook", reason: "unieai turn deadline reached" });
        }, config.deadlineMs + config.cancelGraceMs);
        timer.unref?.();
        timers.add(timer);
        state.timer = timer;
      }
    }
    const decision = await next();
    if (decision?.kind !== "enter") return decision;
    const status = budgetStatus(config, { startedAt: state.startedAt, step, now: now() });
    if (status.exhausted) {
      ctx.logger.warn(`${name}: turn ${turn} is out of budget at step ${step}; ending it`);
      return { kind: "reject" };
    }
    // A first step without messages completes the turn at once; adding one
    // would start work nobody asked for.
    if (status.low && !state.warned && (step > 1 || decision.messages.length > 0)) {
      state.warned = true;
      return { ...decision, messages: [...decision.messages, pluginNotice(name, wrapUpText(status), "budget nearly used: wrap up")] };
    }
    return decision;
  });

  ctx.on(
    "agent/request-error",
    (payload, next) => {
      const state = states.get(payload.agent);
      if (!state || state.turn !== payload.turn || !config.deadlineMs) return next();
      const remaining = config.deadlineMs - (now() - state.startedAt);
      if (remaining > config.minRetryWindowMs) return next();
      ctx.logger.warn(`${name}: not retrying ${payload.failure?.code ?? "a failed request"}; ${Math.max(0, remaining)}ms of the turn budget left`);
      return Promise.resolve(undefined);
    },
    { prepend: true },
  );

  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") clearTimer(states.get(agent));
  });

  ctx.on("dispose", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
}
