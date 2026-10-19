// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-schedule.mjs — wake-ups, recurring tasks and `/loop` for a live session.
 *
 * Claude Code-style scheduling, scoped to the session that is open right now:
 *
 *   schedule_wakeup { delay_seconds, prompt, reason }
 *     Start a new turn with `prompt` after the delay ("check CI again in 8
 *     minutes"). The delay is clamped to [minDelaySeconds, maxDelaySeconds];
 *     a session has at most one pending wake-up, and a new one replaces it.
 *   cron_create { cron | every_seconds, prompt, recurring?, time_zone? }
 *   cron_list {}
 *   cron_delete { id }
 *     Recurring (or one-shot cron) tasks for the session, at most `maxJobs`.
 *
 * Timers live in this process and die with it: nothing is written to disk and
 * there is no daemon, so a schedule only fires while the session is open.
 * dsh's own dsh-schedule is the durable, host-wide kind (it restores cold
 * sessions through the web host's session controller, which the ACP profile
 * does not have); its cron arithmetic is reused here.
 *
 * A due item never interrupts work: when the agent is busy (the user's turn,
 * a goal round) delivery waits for it to go idle, and items due together go
 * in one message. The message is a `followup`, so dsh opens a turn of its own
 * and the host shows it (UnieAI Code's bridge shows such a turn, and the
 * prompt from the message's `source.summary`).
 *
 * `/loop` is served through `loopCommand(sessionId, text)` on the
 * `unieaiSchedule` service (UnieAI Code's bridge calls it for a `/loop` it is
 * given instead of sending the text to the model):
 *
 *   /loop                       list what is scheduled
 *   /loop stop [id]             cancel one item, or everything
 *   /loop 5m <prompt>           run now, then every 5 minutes
 *   /loop <prompt>              run now; the model paces itself with
 *                               schedule_wakeup and stops by not calling it
 */
import { createCronScheduleRecord, resolveCronOccurrence } from "@deepseek-ai/dsh-schedule";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { positiveInt } from "./unieai-loop-common.mjs";

export const name = "unieai-schedule";
export const inject = ["tools", "agents"];

export const DEFAULTS = Object.freeze({
  minDelaySeconds: 60,
  maxDelaySeconds: 3600,
  // An interval loop may be slower than a wake-up, but not slower than a day.
  maxIntervalSeconds: 86_400,
  maxJobs: 20,
  // After the agent goes idle, let the host finish closing the turn first.
  idleSettleMs: 1000,
});

/** setTimeout's ceiling; longer waits re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const UNITS = { s: 1, m: 60, h: 3600, d: 86_400 };

/** `30s`, `5m`, `2h`, `1d` (and spelled-out units) -> seconds, else null. */
export function parseInterval(text) {
  const match = /^(\d+)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const seconds = Number(match[1]) * UNITS[match[2][0].toLowerCase()];
  return seconds > 0 ? seconds : null;
}

/** Seconds as the shortest exact `1h30m`-style text. */
export function formatDuration(seconds) {
  let left = Math.round(seconds);
  const parts = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (left >= size) {
      parts.push(`${Math.floor(left / size)}${unit}`);
      left %= size;
    }
  }
  return parts.join("") || "0s";
}

/**
 * What `/loop ...` asks for: `{ action: "list" }`, `{ action: "stop", id }`,
 * `{ action: "every", seconds, prompt }`, `{ action: "paced", prompt }`, or
 * `{ action: "usage", error }`. Null when `text` is not a /loop command.
 */
export function parseLoopCommand(text) {
  const match = /^\/loop(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest || /^(list|ls|status)$/i.test(rest)) return { action: "list" };
  const stop = /^(stop|cancel|off|clear)(?:\s+(\S+))?$/i.exec(rest);
  if (stop) return { action: "stop", id: stop[2] && stop[2].toLowerCase() !== "all" ? stop[2] : null };
  const [first, ...tail] = rest.split(/\s+/);
  // `/loop every 5m <prompt>` reads the same as `/loop 5m <prompt>`.
  const words = /^every$/i.test(first) && parseInterval(tail[0]) ? tail : [first, ...tail];
  const seconds = parseInterval(words[0]);
  if (seconds !== null) {
    const prompt = rest.slice(rest.indexOf(words[0]) + words[0].length).trim();
    if (!prompt) return { action: "usage", error: "Give the prompt to repeat after the interval, e.g. /loop 5m check the deploy" };
    return { action: "every", seconds, prompt };
  }
  return { action: "paced", prompt: rest };
}

export const USAGE = [
  "Usage:",
  "  /loop <interval> <prompt>   run the prompt now, then every interval (e.g. /loop 5m check CI)",
  "  /loop <prompt>              run it now; the model decides when to check again, and stops when done",
  "  /loop                       list scheduled wake-ups and tasks",
  "  /loop stop [id]             cancel one, or all of them",
].join("\n");

const clip = (text, max = 100) => {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/** How an item repeats, for people and the model. */
function cadence(job) {
  if (job.kind === "wakeup") return "wake-up";
  if (job.kind === "every") return `every ${formatDuration(job.everySeconds)}`;
  return `${job.recurring ? "cron" : "once at"} "${job.record.expression}" (${job.record.timeZone})`;
}

export function viewOf(job, now) {
  const view = {
    id: job.id,
    kind: job.kind,
    prompt: job.prompt,
    next_at: new Date(job.nextAt).toISOString(),
    in_seconds: Math.max(0, Math.round((job.nextAt - now) / 1000)),
  };
  if (job.reason) view.reason = job.reason;
  if (job.kind === "every") view.every_seconds = job.everySeconds;
  if (job.kind === "cron") Object.assign(view, { cron: job.record.expression, time_zone: job.record.timeZone, recurring: job.recurring });
  if (job.loop) view.loop = true;
  return view;
}

export function renderList(views, { loop = null } = {}) {
  if (views.length === 0 && !loop) return "Nothing is scheduled in this session.";
  const lines = views.map((view) => {
    const what = view.kind === "wakeup" ? "wake-up" : view.kind === "every" ? `every ${formatDuration(view.every_seconds)}` : `${view.recurring ? "cron" : "once"} ${view.cron}`;
    return `- ${view.id}  ${what}${view.loop ? " (/loop)" : ""}, next in ${formatDuration(view.in_seconds)}: ${clip(view.prompt)}`;
  });
  if (loop) lines.unshift(`Self-paced /loop: ${clip(loop.prompt)}${views.some((view) => view.kind === "wakeup") ? "" : " (no wake-up pending; it ends when this turn does)"}`);
  return lines.join("\n");
}

/**
 * The message a due batch starts its turn with. The model is told where the
 * turn came from, since no one just typed anything.
 */
export function renderDue(jobs, { loop = null } = {}) {
  const lines = [
    "<scheduled-task>",
    "This turn was started by a schedule set earlier in this session, not by a new message from the user. Do what the prompt asks now.",
  ];
  for (const job of jobs) {
    lines.push(`- [${cadence(job)}, ${job.id}${job.reason ? `, set because: ${job.reason}` : ""}]`, job.prompt);
  }
  if (loop && jobs.some((job) => job.kind === "wakeup")) {
    lines.push(
      "",
      "This is a round of a self-paced /loop. When the round is done: if another round is useful, call schedule_wakeup again " +
        "with the same prompt and a delay that fits what you are waiting for; if the work is finished, blocked, or no longer useful, " +
        "do not schedule one, and say that the loop has ended. The user can stop it with /loop stop.",
    );
  }
  if (jobs.some((job) => job.kind !== "wakeup")) {
    lines.push("", "Recurring tasks keep running until deleted (cron_delete, or the user's /loop stop); keep each round short.");
  }
  lines.push("</scheduled-task>");
  return lines.join("\n");
}

/** What the host shows as this turn's user message. */
export function summaryOf(jobs) {
  return clip(`[scheduled] ${jobs.map((job) => job.prompt).join(" · ")}`, 300);
}

class ScheduleError extends Error {}

/**
 * The scheduling core, with time, timers and delivery injected so it can be
 * driven by a test clock.
 *
 * `deliver(sessionId, jobs, session)` returns "delivered", "busy" (try again
 * once `waitIdle(sessionId)` resolves) or "gone" (the session is closed).
 */
export function createScheduler({
  cfg = DEFAULTS,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref?.() ?? null,
  clearTimer = clearTimeout,
  deliver,
  waitIdle = async () => {},
  timeZone = localTimeZone,
  logger = null,
}) {
  const sessions = new Map();
  let counter = 0;
  const nextId = (prefix) => `${prefix}${(counter += 1)}`;
  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { jobs: new Map(), due: new Map(), waiting: false, loop: null };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const arm = (sessionId, job) => {
    if (job.timer) clearTimer(job.timer);
    const wait = Math.min(Math.max(0, job.nextAt - now()), MAX_TIMER_MS);
    job.timer = setTimer(() => fire(sessionId, job.id), wait);
  };
  const disarm = (job) => {
    if (job.timer) clearTimer(job.timer);
    job.timer = null;
  };

  const fire = (sessionId, id) => {
    const state = sessions.get(sessionId);
    const job = state?.jobs.get(id);
    if (!job) return;
    const at = now();
    if (at < job.nextAt) return arm(sessionId, job); // a long wait re-arming
    state.due.set(job.id, { ...job, timer: null });
    if (job.kind === "wakeup" || (job.kind === "cron" && !job.recurring)) {
      state.jobs.delete(job.id);
    } else if (job.kind === "every") {
      const missed = Math.floor((at - job.nextAt) / (job.everySeconds * 1000)) + 1;
      job.nextAt += missed * job.everySeconds * 1000;
      arm(sessionId, job);
    } else {
      const next = resolveCronOccurrence(job.record, Math.max(at, Date.parse(job.record.scheduledAt))).nextScheduledAt;
      if (next === undefined) state.jobs.delete(job.id);
      else {
        job.record = { ...job.record, scheduledAt: next };
        job.nextAt = Date.parse(next);
        arm(sessionId, job);
      }
    }
    flush(sessionId);
  };

  /** Deliver what is due, or wait for the agent to go idle. Missed rounds coalesce. */
  const flush = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state || state.due.size === 0 || state.waiting) return;
    const jobs = [...state.due.values()];
    let outcome;
    try {
      outcome = deliver(sessionId, jobs, state);
    } catch (error) {
      logger?.warn(`${name}: delivery to ${sessionId} failed: ${error?.message ?? error}`);
      outcome = "busy";
    }
    if (outcome === "delivered") {
      state.due.clear();
      logger?.info(`${name}: started a turn in ${sessionId} for ${jobs.map((job) => job.id).join(", ")}`);
    } else if (outcome === "gone") {
      drop(sessionId);
    } else {
      state.waiting = true;
      Promise.resolve(waitIdle(sessionId))
        .catch(() => {})
        .then(() => {
          setTimer(() => {
            state.waiting = false;
            if (sessions.get(sessionId) === state) flush(sessionId);
          }, cfg.idleSettleMs);
        });
    }
  };

  const drop = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return;
    for (const job of state.jobs.values()) disarm(job);
    sessions.delete(sessionId);
  };

  const list = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return [];
    const at = now();
    return [...state.jobs.values()].sort((a, b) => a.nextAt - b.nextAt).map((job) => viewOf(job, at));
  };

  const api = {
    sessions,

    /** One wake-up per session: a new one replaces the pending one. */
    wakeup(sessionId, { delay_seconds, prompt, reason = "" }) {
      const asked = Number(delay_seconds);
      if (!Number.isFinite(asked)) throw new ScheduleError("delay_seconds must be a number of seconds");
      if (!String(prompt ?? "").trim()) throw new ScheduleError("prompt must not be empty");
      const delay = Math.round(Math.min(Math.max(asked, cfg.minDelaySeconds), cfg.maxDelaySeconds));
      const state = stateOf(sessionId);
      const replaced = [...state.jobs.values()].find((job) => job.kind === "wakeup");
      if (replaced) {
        disarm(replaced);
        state.jobs.delete(replaced.id);
      }
      const job = {
        id: nextId("w"),
        kind: "wakeup",
        prompt: String(prompt).trim(),
        reason: String(reason ?? "").trim(),
        nextAt: now() + delay * 1000,
        loop: Boolean(state.loop),
      };
      state.jobs.set(job.id, job);
      arm(sessionId, job);
      return { ...viewOf(job, now()), delay_seconds: delay, clamped: delay !== asked, ...(replaced ? { replaced: replaced.id } : {}) };
    },

    create(sessionId, { cron, every_seconds, prompt, recurring = true, time_zone, loop = false }) {
      if (!String(prompt ?? "").trim()) throw new ScheduleError("prompt must not be empty");
      if ((cron === undefined) === (every_seconds === undefined)) throw new ScheduleError("give exactly one of cron or every_seconds");
      const state = stateOf(sessionId);
      const recurringCount = [...state.jobs.values()].filter((job) => job.kind !== "wakeup").length;
      if (recurringCount >= cfg.maxJobs) throw new ScheduleError(`this session already has ${cfg.maxJobs} scheduled tasks; delete one first`);
      const at = now();
      let job;
      if (every_seconds !== undefined) {
        const seconds = Number(every_seconds);
        if (!Number.isSafeInteger(seconds) || seconds < cfg.minDelaySeconds || seconds > cfg.maxIntervalSeconds) {
          throw new ScheduleError(`every_seconds must be a whole number from ${cfg.minDelaySeconds} to ${cfg.maxIntervalSeconds}`);
        }
        job = { id: nextId("t"), kind: "every", prompt: String(prompt).trim(), everySeconds: seconds, nextAt: at + seconds * 1000, recurring: true };
      } else {
        let record;
        try {
          record = createCronScheduleRecord("cron", String(prompt), { expression: String(cron), time_zone: String(time_zone || timeZone()) }, at, "cron");
        } catch (error) {
          throw new ScheduleError(error?.message ?? String(error));
        }
        job = { id: nextId("t"), kind: "cron", prompt: record.prompt, record, nextAt: Date.parse(record.scheduledAt), recurring: recurring !== false };
      }
      if (loop) job.loop = true;
      state.jobs.set(job.id, job);
      arm(sessionId, job);
      return viewOf(job, at);
    },

    list,

    /** Cancel one item (`id`), or every item and the self-paced loop (`null`). */
    remove(sessionId, id = null) {
      const state = sessions.get(sessionId);
      if (!state) return [];
      const at = now();
      const removed = [];
      for (const job of [...state.jobs.values()]) {
        if (id !== null && job.id !== id) continue;
        removed.push(viewOf(job, at));
        disarm(job);
        state.jobs.delete(job.id);
      }
      if (id === null) {
        state.due.clear();
        state.loop = null;
      } else state.due.delete(id);
      return removed;
    },

    /** Mark a self-paced /loop as running (its wake-ups get loop framing). */
    startLoop(sessionId, prompt) {
      stateOf(sessionId).loop = { prompt, startedAt: now() };
    },
    loopOf: (sessionId) => sessions.get(sessionId)?.loop ?? null,

    /** A turn ended: a self-paced loop with no wake-up pending is over. */
    turnEnded(sessionId) {
      const state = sessions.get(sessionId);
      if (!state?.loop) return;
      const pending = [...state.jobs.values()].some((job) => job.kind === "wakeup") || [...state.due.values()].some((job) => job.kind === "wakeup");
      if (!pending) {
        logger?.info(`${name}: self-paced loop in ${sessionId} ended (no wake-up scheduled)`);
        state.loop = null;
      }
    },

    drop,
    flush,
    fire,

    /** `/loop ...`: `{ reply }` to show the user, or `{ prompt }` to send to the model. */
    loopCommand(sessionId, text) {
      const command = parseLoopCommand(text);
      if (!command) return { handled: false };
      switch (command.action) {
        case "list":
          return { handled: true, reply: `${renderList(list(sessionId), { loop: api.loopOf(sessionId) })}\n\n${USAGE}` };
        case "stop": {
          const removed = api.remove(sessionId, command.id);
          if (command.id !== null && removed.length === 0) return { handled: true, reply: `Nothing scheduled has id ${command.id}.\n\n${renderList(list(sessionId))}` };
          if (removed.length === 0) return { handled: true, reply: "Nothing was scheduled; any self-paced loop is stopped." };
          return { handled: true, reply: `Cancelled ${removed.map((view) => view.id).join(", ")}.` };
        }
        case "usage":
          return { handled: true, reply: `${command.error}\n\n${USAGE}` };
        case "every": {
          const seconds = Math.min(Math.max(command.seconds, cfg.minDelaySeconds), cfg.maxIntervalSeconds);
          let view;
          try {
            view = api.create(sessionId, { every_seconds: seconds, prompt: command.prompt, loop: true });
          } catch (error) {
            return { handled: true, reply: `Could not start the loop: ${error.message}` };
          }
          const note = seconds === command.seconds ? "" : ` (${formatDuration(command.seconds)} is outside ${formatDuration(cfg.minDelaySeconds)}–${formatDuration(cfg.maxIntervalSeconds)})`;
          return {
            handled: true,
            job: view,
            prompt: [
              `<loop id="${view.id}" every="${formatDuration(seconds)}">`,
              `The user started a loop: this prompt now runs every ${formatDuration(seconds)}${note} while this session stays open, as task ${view.id}. ` +
                "Do it now for the first time. Keep each round short; the user stops the loop with /loop stop.",
              "</loop>",
              "",
              command.prompt,
            ].join("\n"),
          };
        }
        case "paced":
        default:
          api.startLoop(sessionId, command.prompt);
          return {
            handled: true,
            prompt: [
              "<loop paced>",
              "The user started a self-paced loop: do the task below now. When this round is done, decide whether another round is useful. " +
                `If it is, call schedule_wakeup with this same task as the prompt and a delay (${cfg.minDelaySeconds}–${cfg.maxDelaySeconds} seconds) ` +
                "that fits what you are waiting for (a build, CI, a deploy). If the work is finished, blocked, or no longer useful, " +
                "do not schedule one, and say that the loop has ended. The user can stop it with /loop stop.",
              "</loop>",
              "",
              command.prompt,
            ].join("\n"),
          };
      }
    },
  };
  return api;
}

const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
const textOutput = { schema: { type: "string" }, render: (_args, value) => text(value) };

/** Schedules belong to the session the user has open, not a subagent's. */
function ownerOf(exec) {
  const agent = exec?.agent;
  if (!agent) throw new ScheduleError("scheduling needs a calling agent");
  const header = agent.session?.header;
  if (header?.parentSession || header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0) {
    throw new ScheduleError("a subagent cannot schedule turns; tell the agent that started you what to schedule");
  }
  return agent.id;
}

export function apply(ctx, rawConfig = {}) {
  const cfg = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.keys(DEFAULTS).map((key) => [key, positiveInt(rawConfig[key], DEFAULTS[key])]),
    ),
  };
  if (cfg.maxDelaySeconds < cfg.minDelaySeconds) cfg.maxDelaySeconds = cfg.minDelaySeconds;

  const scheduler = createScheduler({
    cfg,
    logger: ctx.logger,
    deliver(sessionId, jobs, state) {
      const agent = ctx.agents.get(sessionId);
      if (!agent) return "gone";
      if (agent.status !== "idle") return "busy";
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: renderDue(jobs, { loop: state.loop }) }],
          source: { kind: name, summary: summaryOf(jobs), ids: jobs.map((job) => job.id) },
        }),
      );
      return "delivered";
    },
    waitIdle: (sessionId) => ctx.agents.get(sessionId)?.whenIdle?.(),
  });

  ctx.on("agent/disposed", ({ agent }) => scheduler.drop(agent.id));
  ctx.on("session/event", (session, event) => {
    if (event?.type === "turn/end") scheduler.turnEnded(session?.header?.id);
  });
  ctx.on("dispose", () => {
    for (const sessionId of [...scheduler.sessions.keys()]) scheduler.drop(sessionId);
  });

  // For hosts: UnieAI Code's bridge (unieai-control) serves `/loop` with it.
  const service = {
    loopCommand: (sessionId, commandText) => scheduler.loopCommand(sessionId, commandText),
    list: (sessionId) => scheduler.list(sessionId),
    remove: (sessionId, id = null) => scheduler.remove(sessionId, id),
  };
  try {
    ctx.provide?.("unieaiSchedule", service);
  } catch (error) {
    ctx.logger.warn(`${name}: unieaiSchedule service not provided: ${error?.message ?? error}`);
  }

  const run = (fn) => async (args, exec) => {
    try {
      return fn(ownerOf(exec), args ?? {});
    } catch (error) {
      if (error instanceof ScheduleError) return `Error: ${error.message}`;
      throw error;
    }
  };

  ctx.tools.register(
    defineTool({
      name: "schedule_wakeup",
      description:
        "Start a new turn in this session later, with `prompt` as its message: use it to come back to something you are waiting on " +
        "(\"check CI again in 8 minutes\") instead of polling or sleeping. " +
        `The delay is clamped to ${cfg.minDelaySeconds}-${cfg.maxDelaySeconds} seconds. Only one wake-up is pending at a time; ` +
        "a new call replaces the previous one. It fires only while this session stays open, and waits if a turn is running. " +
        "In a self-paced /loop, call it at the end of each round to continue; not calling it ends the loop.",
      parameters: {
        delay_seconds: { type: "number", required: true, description: `Seconds from now (${cfg.minDelaySeconds}-${cfg.maxDelaySeconds}).` },
        prompt: { type: "string", required: true, description: "What to do when it fires, written so it makes sense on its own." },
        reason: { type: "string", required: true, description: "Why this delay (shown to the user), e.g. \"CI takes about 8 minutes\"." },
      },
      output: textOutput,
      execute: run((sessionId, args) => {
        const view = scheduler.wakeup(sessionId, args);
        const parts = [`Wake-up ${view.id} set for ${view.next_at} (in ${formatDuration(view.delay_seconds)}).`];
        if (view.clamped) parts.push(`The delay was clamped to ${cfg.minDelaySeconds}-${cfg.maxDelaySeconds} seconds.`);
        if (view.replaced) parts.push(`It replaces wake-up ${view.replaced}.`);
        parts.push("End your turn now; the session continues when it fires.");
        return parts.join(" ");
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "cron_create",
      description:
        "Schedule a task that starts a new turn in this session with `prompt`: either every `every_seconds` " +
        `(at least ${cfg.minDelaySeconds}), or on a five-field cron expression ("*/15 9-17 * * 1-5") in local time ` +
        `(${localTimeZone()} unless time_zone is given). Recurring by default; recurring: false fires once at the next cron match. ` +
        `At most ${cfg.maxJobs} tasks per session. Tasks run only while this session stays open; they are not durable.`,
      parameters: {
        prompt: { type: "string", required: true, description: "What to do each time, written so it makes sense on its own." },
        cron: { type: "string", description: "Five-field cron expression: minute hour day-of-month month day-of-week." },
        every_seconds: { type: "number", description: "A fixed interval in seconds, instead of cron." },
        recurring: { type: "boolean", description: "For cron: false fires once. Defaults to true." },
        time_zone: { type: "string", description: "IANA time zone for cron, e.g. Asia/Taipei. Defaults to the local zone." },
      },
      output: textOutput,
      execute: run((sessionId, args) => {
        const view = scheduler.create(sessionId, args);
        return `Task ${view.id} scheduled; next run ${view.next_at} (in ${formatDuration(view.in_seconds)}). Delete it with cron_delete.`;
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "cron_list",
      description: "List this session's pending wake-up and scheduled tasks, with their ids and next run times.",
      parameters: {},
      output: textOutput,
      execute: run((sessionId) => renderList(scheduler.list(sessionId), { loop: scheduler.loopOf(sessionId) })),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "cron_delete",
      description: "Cancel a scheduled task or the pending wake-up by id (from cron_list or the tool that created it).",
      parameters: { id: { type: "string", required: true, description: "The id to cancel, e.g. t2 or w1." } },
      output: textOutput,
      execute: run((sessionId, { id }) => {
        const removed = scheduler.remove(sessionId, String(id));
        return removed.length ? `Cancelled ${id}.` : `Nothing scheduled has id ${id}.`;
      }),
    }),
  );
}
