// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-exec-state.mjs — the exec sessions an agent has left running, shared
 * between unieai-exec (which owns them) and unieai-exec-notify (which reports
 * their exits). Not a plugin itself.
 *
 * A session enters here the first time a call returns it to the model still
 * running ("backgrounded") and leaves when it is retired. unieai-exec calls
 * `publishBackground`; observers subscribe with `onBackground`. Both plugins
 * must load this module from the same URL (the package's own copy).
 *
 * A handle is a narrow view of one session:
 *   { id, cmd, tty, startedAt, backgroundedAt, interrupted, running, busy,
 *     whenExited(ms, signal) -> Promise<boolean>,
 *     take({maxOutputTokens}) -> Promise<report | null> }
 * `take` drains the output the model has not read and retires the session,
 * exactly as a poll would; it returns null when a poll got there first.
 */

const background = new WeakMap(); // agent -> Map<id, handle>
const observers = new Set();

/** The sessions `agent` has running in the background, oldest first. */
export function backgroundSessions(agent) {
  return [...(background.get(agent)?.values() ?? [])];
}

/** Record a newly backgrounded session and tell the observers. */
export function publishBackground(agent, handle) {
  let table = background.get(agent);
  if (!table) {
    table = new Map();
    background.set(agent, table);
  }
  if (table.has(handle.id)) return;
  table.set(handle.id, handle);
  for (const observer of observers) {
    try {
      observer(agent, handle);
    } catch {
      // An observer's failure is its own; the session runs on.
    }
  }
}

/** Forget a session (exited and reported, or terminated). */
export function retireBackground(agent, id) {
  background.get(agent)?.delete(id);
}

/** Call `observer(agent, handle)` for every session backgrounded from now on. Returns the unsubscribe. */
export function onBackground(observer) {
  observers.add(observer);
  return () => observers.delete(observer);
}
