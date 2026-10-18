// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-todo-guard.mjs — a todo list the model wrote is a promise; keep it.
 *
 * Measured on FrontierHarness (DeepSeek-V4-Flash, dsh 0.2.1): three of the
 * four runs that used `todo_write` wrote the list once, at the start, and
 * never touched it again; they ended with every item still `pending` or
 * `in_progress`, and two of the three failed by a few hidden tests. The model
 * stops looking at its plan, so it cannot see what it skipped.
 *
 * Two deterministic nudges, both about the current turn's list only (dsh
 * clears the standing plan when the next turn starts):
 *
 * - At `agent/turn-stopping`, when the newest list still has unfinished items,
 *   the list is shown back with the instruction to verify each item, update
 *   the list, and only then answer. At most `maxStopNudges` per turn, never
 *   twice for the same list (a model that stops again without changing it is
 *   let go), and not while unieai-loop-guard is winding the turn down.
 * - At `agent/pre-step`, after `staleSteps` model steps without a
 *   `todo_write` while items are unfinished, the list is shown once as a
 *   reminder, so a long turn does not lose its plan.
 */
import { pluginNotice, positiveInt, shortHash } from "./unieai-loop-common.mjs";
import { turnState, windingDown } from "./unieai-loop-state.mjs";

export const name = "unieai-todo-guard";

export const DEFAULTS = Object.freeze({ maxStopNudges: 2, staleSteps: 20 });

/**
 * The newest todo list of `turn`: `{todos, seq, stepsSince}`, or null when the
 * turn wrote none. `stepsSince` counts the model responses after the write.
 */
export function todoStateInTurn(session, turn) {
  let stepsSince = 0;
  for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === "todo/write") {
      const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
      return { todos, seq, stepsSince };
    }
    if (event.type === "assistant/message" && event.data?.turn === turn) stepsSince += 1;
    if (event.type === "turn/start") return null;
  }
  return null;
}

/** The items not yet `completed`. */
export function unfinished(todos) {
  return todos.filter((todo) => todo?.status !== "completed");
}

const listText = (todos) => todos.map((todo) => `- [${todo.status ?? "pending"}] ${todo.content ?? ""}`).join("\n");

export const MESSAGES = Object.freeze({
  stop: (todos, open) =>
    [
      "<system-reminder>",
      `You are about to finish, but your todo list still has ${open} unfinished item(s):`,
      listText(todos),
      "Go through the list before you answer. For each item: if it is done, make sure it really is (run the check that proves it if you have not) and mark it completed; if it is no longer needed, drop it; otherwise do it now.",
      "Then call todo_write with the updated list. If you must stop with items open (you need the user, or something is blocked), say which ones and why in your answer.",
      "</system-reminder>",
    ].join("\n"),
  stale: (todos, steps) =>
    [
      "<system-reminder>",
      `Your todo list has not been updated for ${steps} steps. This is what it says:`,
      listText(todos),
      "If your progress has moved on, update it with todo_write (mark finished items completed, keep the item you are on in_progress, add steps you have discovered). Do not mention this reminder.",
      "</system-reminder>",
    ].join("\n"),
});

/** Whether unieai-loop-guard is winding `turn` down (read only: never starts its state). */
function landing(agent, turn) {
  const loop = turnState(agent);
  return loop?.turn === turn && windingDown(loop);
}

export function apply(ctx, rawConfig = {}) {
  const maxStopNudges = positiveInt(rawConfig.maxStopNudges, DEFAULTS.maxStopNudges);
  const staleSteps = positiveInt(rawConfig.staleSteps, DEFAULTS.staleSteps);
  const states = new WeakMap();
  const stateOf = (agent, turn) => {
    let state = states.get(agent);
    if (!state || state.turn !== turn) {
      state = { turn, stopNudges: 0, seenLists: new Set(), remindedSeq: -1 };
      states.set(agent, state);
    }
    return state;
  };

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== "enter" || decision.messages.length === 0) return decision;
    const { agent, turn } = payload;
    const plan = todoStateInTurn(agent.session, turn);
    if (!plan || plan.stepsSince < staleSteps) return decision;
    const open = unfinished(plan.todos);
    const state = stateOf(agent, turn);
    if (open.length === 0 || state.remindedSeq === plan.seq || landing(agent, turn)) return decision;
    state.remindedSeq = plan.seq;
    ctx.logger.info(`${name}: turn ${turn} todo list untouched for ${plan.stepsSince} steps with ${open.length} open; reminding`);
    const notice = pluginNotice(name, MESSAGES.stale(plan.todos, plan.stepsSince), "todo list not updated");
    return { ...decision, messages: [...decision.messages, notice] };
  });

  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    if (signal?.aborted) return;
    if (agent.inbox.nextStep.length > 0) return; // someone already continues the turn
    const plan = todoStateInTurn(agent.session, turn);
    if (!plan) return;
    const open = unfinished(plan.todos);
    if (open.length === 0) return;
    const state = stateOf(agent, turn);
    const fingerprint = shortHash(JSON.stringify(plan.todos));
    if (state.stopNudges >= maxStopNudges || state.seenLists.has(fingerprint)) return;
    if (landing(agent, turn)) return;
    state.seenLists.add(fingerprint);
    state.stopNudges += 1;
    ctx.logger.info(`${name}: turn ${turn} stopping with ${open.length} open todo(s); review ${state.stopNudges}/${maxStopNudges}`);
    agent.steer(pluginNotice(name, MESSAGES.stop(plan.todos, open.length), `${open.length} todo item(s) still open`));
  });
}
