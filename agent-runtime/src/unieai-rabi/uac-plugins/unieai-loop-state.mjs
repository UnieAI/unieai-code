// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-state.mjs — per-agent turn state shared by the unieai-loop-*
 * plugins. Not a plugin itself.
 *
 * The guardrails of unieai-agent-core's loop interact: a completion-contract
 * rejection during the wind-down rescinds the wrap-up and resets the doom
 * streak. With the guardrails split across plugins, that shared state lives
 * here, keyed by agent (WeakMap) and reset when a new turn starts. Every
 * plugin must load this module from the same URL (the package's own copy) to
 * see the same map.
 *
 * Nothing here is module-level request data: an agent that is disposed drops
 * its entry with it.
 */

const states = new WeakMap();

/**
 * The state of `agent`'s current turn. Passing a `turn` different from the
 * stored one starts a fresh state (running the previous one's cleanups).
 */
export function turnState(agent, turn) {
  let state = states.get(agent);
  if (state && (turn === undefined || state.turn === turn)) return state;
  if (turn === undefined) return undefined;
  if (state) releaseTurn(state);
  state = {
    turn,
    step: 0,
    /** Effective step budget (0 = none); a reprieve raises it. */
    maxSteps: 0,
    /** Wrap-up instruction sent: tool calls are no longer executed. */
    wrapUp: false,
    /** Step the wrap-up instruction entered. */
    wrapUpStep: 0,
    /** Why the wrap-up started: 'steps' | 'deadline' | 'doom'. */
    wrapUpReason: null,
    /** Doom layer 2 asked for the wrap-up. */
    forceWrapUp: false,
    /** The tools-stripped grace step has been entered (its step number). */
    graceStep: 0,
    reprieveUsed: false,
    completionNudges: 0,
    budgetNoticed: false,
    /** Doom layer 1: `name:args` → executions seen (cleared by a mutation). */
    doomCounts: new Map(),
    /** Doom layer 2: consecutive same-tool streak. */
    streak: { name: null, count: 0, warned: false },
    /** Doom layer 2 warning waiting for the next step. */
    pendingWarning: null,
    /** callId → how the guard treated it ('repeat' | 'skipped' | 'not-executed'). */
    calls: new Map(),
    /** Disposers to run when the turn ends or the wrap-up is rescinded. */
    landingDisposers: [],
  };
  states.set(agent, state);
  return state;
}

/** Undo a wrap-up in progress: tools run again. */
export function releaseLanding(state) {
  for (const dispose of state.landingDisposers.splice(0)) {
    try {
      dispose();
    } catch {
      // A disposer of an already-disposed agent scope; nothing left to undo.
    }
  }
}

export function releaseTurn(state) {
  releaseLanding(state);
  state.calls.clear();
}

/** Forget `agent` (turn ended with the agent going idle, or disposed). */
export function dropAgent(agent) {
  const state = states.get(agent);
  if (state) releaseTurn(state);
  states.delete(agent);
}

export const REPRIEVE_STEPS = 10;

/**
 * Hand a winding-down turn a small budget back (once per turn): the wrap-up
 * is rescinded, the doom streak reset, and the budget extended to at least
 * `step + steps`. Returns whether the reprieve was granted.
 */
export function grantReprieve(state, steps = REPRIEVE_STEPS) {
  if (state.reprieveUsed) return false;
  state.reprieveUsed = true;
  releaseLanding(state);
  state.wrapUp = false;
  state.wrapUpStep = 0;
  state.wrapUpReason = null;
  state.graceStep = 0;
  state.forceWrapUp = false;
  state.streak = { name: null, count: 0, warned: false };
  state.pendingWarning = null;
  if (state.maxSteps > 0) state.maxSteps = Math.max(state.maxSteps, state.step + steps);
  return true;
}

/** Whether the turn is in its wind-down (wrap-up sent, grace, or on its last step). */
export function windingDown(state) {
  if (!state) return false;
  return state.wrapUp || state.graceStep > 0 || (state.maxSteps > 0 && state.step >= state.maxSteps);
}

/** Canonical JSON with sorted keys (doom layer 1 key). */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
