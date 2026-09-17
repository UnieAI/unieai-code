// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-guard.mjs — unieai-agent-core's loop guardrails on dsh's loop.
 *
 * dsh's agent loop runs until the model stops calling tools: no step or time
 * limit, and a model that keeps repeating a call is only reminded. A server
 * that answers requests (UnieAI Studio) needs every turn bounded and ended in
 * text, so this plugin brings unieai-agent-core's guarantees as hooks, leaving
 * dsh's loop itself untouched:
 *
 *   Budget   `maxSteps` steps (config, else env `UNIEAI_TURN_MAX_STEPS`) and
 *            `deadlineMs` (config, else `UNIEAI_TURN_DEADLINE_MS`). One notice
 *            at 75% of the steps (budgets of 8+), one when `warnRatio` of the
 *            time is left.
 *   Landing  From the last step (or when the deadline passed, or doom layer 2
 *            forced it) the model is told to wrap up in text, and an
 *            agent-scoped `tools.guard` makes every further call return
 *            "Not executed" instead of running (history stays well formed).
 *   Grace    If the model still called tools, exactly one more step runs with
 *            the global tools restricted away; after that the turn is
 *            rejected. Tools registered in the agent's own scope cannot be
 *            restricted; the guard still keeps them from running.
 *   Doom L1  The `doomLimit`-th identical call (same tool, same arguments) is
 *            not executed; the model is told to use the earlier result. A
 *            successful file mutation clears the counts.
 *   Doom L2  A streak of calls to one tool (novel successful call 0.5,
 *            repeat or failure 1, skipped repeat 2) warns at `streakWarn` and
 *            forces the landing at `streakForce`.
 *
 * Budget and doom are independent: with no budget configured only the doom
 * guard runs (`doom: false` turns it off), and with both off the plugin is
 * idle. unieai-loop-completion can rescind a landing once per turn (reprieve)
 * through unieai-loop-state.
 *
 * The deadline also cancels a step that overruns it by `cancelGraceMs`, and
 * stops delegating provider retries once less than `minRetryWindowMs` is left.
 */
import { pluginNotice, positiveInt } from "./unieai-loop-common.mjs";
import { dropAgent, releaseLanding, stableStringify, turnState } from "./unieai-loop-state.mjs";

export const name = "unieai-loop-guard";
export const inject = ["tools"];

export const DEFAULTS = Object.freeze({
  warnRatio: 0.2,
  minRetryWindowMs: 15_000,
  cancelGraceMs: 60_000,
  doom: true,
  doomLimit: 3,
  streakWarn: 5,
  streakForce: 7,
  noticeRatio: 0.75,
  noticeMinSteps: 8,
});

/** Tools whose successful call changes files (retires doom layer 1 counts). */
export const MUTATING_TOOLS = Object.freeze([
  "write",
  "edit",
  "multi_edit",
  "apply_patch",
  "str_replace_based_edit_tool",
  "notebook_edit",
]);

export const MESSAGES = Object.freeze({
  wrapUp:
    "[loop guardrail] Your tool budget for this turn is exhausted. Do not call any more tools. " +
    "Reply with plain text now, summarizing: (1) what you completed and the key results, " +
    "(2) what remains incomplete, (3) recommended next steps.",
  notExecuted: "Not executed — the tool budget for this turn is exhausted. Provide your final text summary now.",
  budgetNotice: (used, max) =>
    `[loop guardrail] You have used ${used} of ${max} tool steps this turn. Start converging: ` +
    "finish the remaining work and verify it before the budget runs out.",
  deadlineNotice: (seconds) =>
    `[loop guardrail] About ${seconds} seconds remain for this turn. Stop exploring: finish the change ` +
    "you are making, run the most relevant check once, and give your final answer.",
  repeated: (tool, count) =>
    `You have already called ${tool} with these exact arguments ${count} times. Do not repeat it — ` +
    "use the earlier result or change your approach. If you cannot proceed, answer with what you have.",
  streak: (tool, count) =>
    `[loop guardrail] You have called "${tool}" ${count} times in a row. Step back: summarize what you ` +
    "have learned so far, then either take a DIFFERENT action or answer the user with what you have.",
});

const flag = (value, fallback) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim()) return !/^(?:0|false|off|no)$/i.test(value.trim());
  return fallback;
};

export function resolveConfig(config = {}, env = process.env) {
  const ratio = Number(config.warnRatio);
  const streakWarn = Math.max(2, positiveInt(config.streakWarn, positiveInt(env.UNIEAI_DOOM_STREAK_WARN, DEFAULTS.streakWarn)));
  return {
    deadlineMs: positiveInt(config.deadlineMs, positiveInt(env.UNIEAI_TURN_DEADLINE_MS, 0)),
    maxSteps: positiveInt(config.maxSteps, positiveInt(env.UNIEAI_TURN_MAX_STEPS, 0)),
    warnRatio: Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULTS.warnRatio,
    minRetryWindowMs: positiveInt(config.minRetryWindowMs, DEFAULTS.minRetryWindowMs),
    cancelGraceMs: positiveInt(config.cancelGraceMs, DEFAULTS.cancelGraceMs),
    doom: flag(config.doom, flag(env.UNIEAI_DOOM_GUARD, DEFAULTS.doom)),
    doomLimit: Math.max(2, positiveInt(config.doomLimit, positiveInt(env.UNIEAI_DOOM_LIMIT, DEFAULTS.doomLimit))),
    streakWarn,
    streakForce: Math.max(streakWarn + 1, positiveInt(config.streakForce, positiveInt(env.UNIEAI_DOOM_STREAK_FORCE, DEFAULTS.streakForce))),
    mutatingTools: new Set(Array.isArray(config.mutatingTools) ? config.mutatingTools : MUTATING_TOOLS),
  };
}

/** Doom layer 2 weight of one finished call. */
export function streakWeight({ skipped, repeated, failed }) {
  if (skipped) return 2;
  return repeated || failed ? 1 : 0.5;
}

export function apply(ctx, rawConfig = {}, { now = () => Date.now(), env = process.env } = {}) {
  const config = resolveConfig(rawConfig, env);
  const budgeted = config.maxSteps > 0 || config.deadlineMs > 0;
  if (!budgeted && !config.doom) {
    ctx.logger.info(`${name}: no budget and doom guard off; idle`);
    return;
  }
  const clocks = new WeakMap(); // agent → { turn, startedAt, deadlineWarned, timer }
  const timers = new Set();

  const clearTimer = (clock) => {
    if (clock?.timer) {
      clearTimeout(clock.timer);
      timers.delete(clock.timer);
      clock.timer = null;
    }
  };

  const clockOf = (agent, turn) => {
    let clock = clocks.get(agent);
    if (clock && clock.turn === turn) return clock;
    clearTimer(clock);
    clock = { turn, startedAt: now(), deadlineWarned: false, timer: null };
    clocks.set(agent, clock);
    if (config.deadlineMs) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (clocks.get(agent) !== clock || agent.status !== "running") return;
        ctx.logger.warn(`${name}: turn ${turn} overran its ${config.deadlineMs}ms deadline; cancelling`);
        agent.cancel({ kind: "hook", reason: "unieai turn deadline reached" });
      }, config.deadlineMs + config.cancelGraceMs);
      timer.unref?.();
      timers.add(timer);
      clock.timer = timer;
    }
    return clock;
  };

  /** Send the wrap-up: from now on no call of this agent runs. */
  const startLanding = (agent, state, step, reason) => {
    state.wrapUp = true;
    state.wrapUpStep = step;
    state.wrapUpReason = reason;
    try {
      const dispose = agent.ctx.tools.guard((exec) => {
        if (exec.agent !== agent) return undefined;
        state.calls.set(exec.callId, "not-executed");
        return MESSAGES.notExecuted;
      });
      state.landingDisposers.push(dispose);
    } catch (error) {
      ctx.logger.warn(`${name}: could not guard tools for the wrap-up: ${error?.message ?? error}`);
    }
    ctx.logger.info(`${name}: turn ${state.turn} winding down at step ${step} (${reason})`);
  };

  /**
   * The grace step: strip every tool the agent inherits. dsh assembles a
   * step's tools before `agent/pre-step`, so this runs as soon as a wrap-up
   * call is refused, ahead of the next step.
   */
  const startGrace = (agent, state) => {
    const step = state.step + 1;
    state.graceStep = step;
    try {
      const restrictable = ctx.tools.view?.(agent)?.restrictableNames;
      const names = ctx.tools
        .schemas(agent)
        .map((schema) => schema.name)
        .filter((toolName) => (restrictable ? restrictable.has(toolName) : true));
      if (names.length > 0) state.landingDisposers.push(agent.ctx.tools.restrict({ deny: names }));
    } catch (error) {
      ctx.logger.warn(`${name}: could not strip tools for the grace step: ${error?.message ?? error}`);
    }
    ctx.logger.info(`${name}: turn ${state.turn} grace step ${step} (tool calls after the wrap-up were not run)`);
  };

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent, turn, step } = payload;
    const state = turnState(agent, turn);
    if (state.step === 0 && config.maxSteps) state.maxSteps = config.maxSteps;
    const clock = budgeted ? clockOf(agent, turn) : null;
    const decision = await next();
    if (decision?.kind !== "enter") return decision;
    state.step = step;
    // A first step without messages completes the turn at once; anything
    // added here would start work nobody asked for.
    if (step === 1 && decision.messages.length === 0) return decision;

    if (state.graceStep > 0 && step > state.graceStep) {
      ctx.logger.warn(`${name}: turn ${turn} still calling tools after its grace step; ending it`);
      return { kind: "reject" };
    }
    const notices = [];
    if (state.wrapUp && state.graceStep === 0 && step > state.wrapUpStep) {
      // The wrap-up step continued without a refused call (e.g. steering).
      state.step = step - 1;
      startGrace(agent, state);
    } else if (!state.wrapUp) {
      const elapsed = clock ? now() - clock.startedAt : 0;
      const deadlinePassed = config.deadlineMs > 0 && elapsed >= config.deadlineMs;
      const lastStep = state.maxSteps > 0 && step >= state.maxSteps;
      const reason = state.forceWrapUp ? "doom" : deadlinePassed ? "deadline" : lastStep ? "steps" : null;
      if (reason) {
        startLanding(agent, state, step, reason);
        notices.push(pluginNotice(name, MESSAGES.wrapUp, `wrap up now (${reason})`));
      } else {
        const used = step - 1;
        if (
          !state.budgetNoticed &&
          state.maxSteps >= DEFAULTS.noticeMinSteps &&
          used >= Math.floor(state.maxSteps * DEFAULTS.noticeRatio)
        ) {
          state.budgetNoticed = true;
          notices.push(pluginNotice(name, MESSAGES.budgetNotice(used, state.maxSteps), "step budget mostly used"));
        }
        if (clock && config.deadlineMs > 0 && !clock.deadlineWarned && config.deadlineMs - elapsed <= config.deadlineMs * config.warnRatio) {
          clock.deadlineWarned = true;
          const seconds = Math.max(0, Math.round((config.deadlineMs - elapsed) / 1000));
          notices.push(pluginNotice(name, MESSAGES.deadlineNotice(seconds), "time budget nearly used"));
        }
      }
    }
    if (state.pendingWarning && !state.wrapUp) {
      notices.push(pluginNotice(name, state.pendingWarning, "repeating one tool"));
    }
    state.pendingWarning = null;
    return notices.length > 0 ? { ...decision, messages: [...decision.messages, ...notices] } : decision;
  });

  if (config.doom) {
    // Layer 1: one guard for the whole tree; it only counts, and denies the
    // repeat. It runs after every tools/pre-execute listener allowed the call.
    ctx.tools.guard((exec) => {
      if (!exec.agent || exec.parent !== undefined) return undefined;
      const state = turnState(exec.agent);
      if (!state || state.wrapUp) return undefined;
      let key;
      try {
        key = `${exec.name}:${stableStringify(exec.arguments ?? {})}`;
      } catch {
        return undefined;
      }
      const seen = (state.doomCounts.get(key) ?? 0) + 1;
      state.doomCounts.set(key, seen);
      if (seen >= config.doomLimit) {
        state.calls.set(exec.callId, "skipped");
        ctx.logger.info(`${name}: ${exec.name} repeated ${seen} times with identical arguments; not running it`);
        return MESSAGES.repeated(exec.name, seen);
      }
      if (seen > 1) state.calls.set(exec.callId, "repeat");
      return undefined;
    });

  }

  ctx.on("tools/result", (exec, result) => {
    if (!exec.agent || exec.parent !== undefined) return;
    const state = turnState(exec.agent);
    if (!state) return;
    const mark = state.calls.get(exec.callId);
    state.calls.delete(exec.callId);
    if (mark === "not-executed") {
      if (state.graceStep === 0) startGrace(exec.agent, state);
      return;
    }
    // Layer 2: account every finished top-level call of the turn.
    if (config.doom) {
      const failed = result?.isError === true;
      if (!failed && config.mutatingTools.has(exec.name)) state.doomCounts.clear();
      const weight = streakWeight({ skipped: mark === "skipped", repeated: mark === "repeat", failed });
      const streak = state.streak;
      if (streak.name === exec.name) streak.count += weight;
      else Object.assign(streak, { name: exec.name, count: weight, warned: false });
      if (!state.forceWrapUp && streak.count >= config.streakForce) {
        state.forceWrapUp = true;
        ctx.logger.info(`${name}: ${exec.name} streak ${streak.count}; forcing the wrap-up`);
      } else if (streak.count >= config.streakWarn && !streak.warned) {
        streak.warned = true;
        state.pendingWarning = MESSAGES.streak(exec.name, Math.ceil(streak.count));
      }
    }
  });

  if (config.deadlineMs) {
    ctx.on(
      "agent/request-error",
      (payload, next) => {
        const clock = clocks.get(payload.agent);
        if (!clock || clock.turn !== payload.turn) return next();
        const remaining = config.deadlineMs - (now() - clock.startedAt);
        if (remaining > config.minRetryWindowMs) return next();
        ctx.logger.warn(`${name}: not retrying ${payload.failure?.code ?? "a failed request"}; ${Math.max(0, remaining)}ms of the turn budget left`);
        return Promise.resolve(undefined);
      },
      { prepend: true },
    );
  }

  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle") return;
    clearTimer(clocks.get(agent));
    const state = turnState(agent);
    if (state) releaseLanding(state);
  });

  ctx.on("agent/disposed", ({ agent }) => {
    clearTimer(clocks.get(agent));
    clocks.delete(agent);
    dropAgent(agent);
  });

  ctx.on("dispose", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
}
