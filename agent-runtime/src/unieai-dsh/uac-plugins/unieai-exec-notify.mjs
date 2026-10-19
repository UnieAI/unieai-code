// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-exec-notify.mjs — a command left running tells the model when it ends.
 *
 * unieai-exec hands a command that outlives `yield_time_ms` back as a session
 * the model has to poll with write_stdin. Models poll a build three or four
 * times with short waits, or forget it and finish while the tests are still
 * running. dsh already reports its own background work (tool-jobs: jobs;
 * dsh-subagent: children); this does the same for exec sessions, the way
 * Claude Code reports background shells:
 *
 * - When a backgrounded session exits, the output the model has not read yet
 *   (head and tail, `noticeOutputTokens`) and the exit code are delivered as a
 *   notice. A busy agent gets it at its next step (`agent.inject`). The
 *   session is retired as a poll would retire it, so nothing is reported
 *   twice: a poll that already saw the exit wins and no notice is sent, and a
 *   later poll of a reported session says where its output went.
 * - An idle agent (the turn ended) gets it with its next prompt
 *   (`idleDelivery: "inject"`, the default) — UnieAI Code's TUI has no turn
 *   that starts on its own — or in a turn of its own (`"wakeup"`).
 * - When the model is about to end its turn while a command it backgrounded
 *   during this turn is still running, the stop is held (at most
 *   `stopWaitMs`, cancellable) until one exits; the notice then continues
 *   the turn, so the answer does not go out on an unfinished build or test
 *   run. Not for commands that look like services (servers, watchers,
 *   `tail -f`), PTY sessions, sessions the model interrupted, and not while
 *   unieai-loop-guard is winding the turn down: those just end the turn.
 *
 * Sessions the model interrupted (Ctrl-C) are not reported, as tool-jobs does
 * not report jobs the model killed.
 */
import { formatOutput, renderResponse } from "./unieai-exec.mjs";
import { backgroundSessions, onBackground } from "./unieai-exec-state.mjs";
import { pluginNotice, positiveInt } from "./unieai-loop-common.mjs";
import { turnState, windingDown } from "./unieai-loop-state.mjs";

export const name = "unieai-exec-notify";
export const inject = ["systemPrompt"];

export const DEFAULTS = Object.freeze({
  noticeOutputTokens: 2_000,
  // How long a turn that wants to end waits on its own background command.
  stopWaitMs: 300_000,
  idleDelivery: "inject",
});

/**
 * Commands that are meant to keep running (servers, watchers, followers):
 * ending the turn while one runs is normal, so the stop is not held for it.
 */
const SERVICE_PATTERN = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|preview|watch)\b`,
    String.raw`\b(?:runserver|http\.server|uvicorn|gunicorn|hypercorn|daphne|flask\s+run|rails\s+s(?:erver)?|php\s+-S|jekyll\s+serve|hugo\s+server)\b`,
    String.raw`\b(?:nodemon|webpack-dev-server|vite\b(?!\s+build)|next\s+(?:dev|start)|ng\s+serve|http-server|live-server)`,
    String.raw`\b(?:docker(?:-compose|\s+compose)\s+up|kubectl\s+(?:port-forward|logs\s+-f)|tail\s+-[a-zA-Z]*[fF]|journalctl\s+-[a-zA-Z]*f|watch\s)`,
    String.raw`--watch\b|\bsleep\s+(?:inf|infinity|\d{4,})\b`,
    String.raw`\b(?:node|python3?|deno|bun|ruby|go\s+run)\s+\S*(?:server|app)\.\w+\b`,
  ].join("|"),
);

export function looksLikeService(cmd) {
  return SERVICE_PATTERN.test(String(cmd ?? ""));
}

const seconds = (value) => `${Number(value ?? 0).toFixed(1)} s`;
const quoted = (cmd) => {
  const line = String(cmd).trim().split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/** The model-facing account of one finished session (`report` from a handle's `take`). */
export function describeReport(report, maxTokens) {
  const head = `Session ${report.id} (\`${quoted(report.cmd)}\`) finished after ${seconds(report.wall_time_seconds)}.`;
  if (report.error) return `${head}\nThe command failed to run: ${report.error}`;
  const output = report.output ? formatOutput(report.output, maxTokens) : "";
  const body = renderResponse({ wall_time_seconds: report.wall_time_seconds, exit_code: report.exit_code, output: output || "(no output since your last read)\n" })
    // Wall time is in the first line already.
    .replace(/^Wall time: .*\n/, "")
    .replace(/^Output:\n/m, "Output you have not seen yet:\n");
  return `${head}\n${body}`;
}

export const MESSAGES = Object.freeze({
  finished: (texts) =>
    [
      "<system-reminder>",
      texts.length === 1 ? "A command you left running has finished:" : "Commands you left running have finished:",
      ...texts,
      "You do not need to poll these sessions; they are closed. Do not mention this reminder.",
      "</system-reminder>",
    ].join("\n"),
  finishedAtStop: (texts) =>
    [
      "<system-reminder>",
      "You were about to finish while a command you started was still running. It has finished since:",
      ...texts,
      "Check this result before you answer. If it changes your conclusion (a failure, an error, a different number), fix that or say so; otherwise give your final answer.",
      "</system-reminder>",
    ].join("\n"),
});

export const SYSTEM_PROMPT_TEXT =
  "When a command you left running in an exec session exits, you get a notice with its exit code and the output you have not read; " +
  "you need not poll it with write_stdin to find out. Work on something else meanwhile, or, when there is nothing else to do, wait with one write_stdin poll with a long `yield_time_ms`.";

/** Whether unieai-loop-guard is winding `turn` down (read only: never starts its state). */
function landing(agent, turn) {
  const loop = turnState(agent);
  return loop !== undefined && (turn === undefined || loop.turn === turn) && windingDown(loop);
}

export function apply(ctx, rawConfig = {}) {
  const noticeOutputTokens = positiveInt(rawConfig.noticeOutputTokens, DEFAULTS.noticeOutputTokens);
  const stopWaitMs = Number(rawConfig.stopWaitMs) === 0 ? 0 : positiveInt(rawConfig.stopWaitMs, DEFAULTS.stopWaitMs);
  const idleDelivery = rawConfig.idleDelivery === "wakeup" ? "wakeup" : DEFAULTS.idleDelivery;
  /** agent -> { turn, startedAt } of its current turn */
  const turns = new WeakMap();
  /** agents whose turn-stopping is waiting: they take exits themselves */
  const holding = new WeakSet();
  let disposed = false;
  const lifetime = new AbortController();

  const finish = async (handles) => {
    const texts = [];
    for (const handle of handles) {
      const report = await handle.take({ maxOutputTokens: noticeOutputTokens }).catch(() => null);
      if (report) texts.push(describeReport(report, noticeOutputTokens));
    }
    return texts;
  };

  const deliver = (agent, texts) => {
    const summary = texts.length === 1 ? "background command finished" : `${texts.length} background commands finished`;
    const notice = pluginNotice(name, MESSAGES.finished(texts), summary);
    if (agent.status === "idle" && idleDelivery === "wakeup") agent.followup(notice);
    else agent.inject(notice);
  };

  const unsubscribe = onBackground((agent, handle) => {
    if (disposed) return;
    void handle.whenExited(Infinity, lifetime.signal).then(async (exited) => {
      // A poll in flight reports the exit itself; the stop hold takes its own.
      if (!exited || disposed || handle.interrupted || holding.has(agent)) return;
      const texts = await finish([handle]);
      if (texts.length === 0 || disposed) return;
      ctx.logger?.info?.(`${name}: session ${handle.id} finished; notifying`);
      deliver(agent, texts);
    });
  });
  if (typeof ctx.effect === "function") {
    ctx.effect(
      () => () => {
        disposed = true;
        lifetime.abort();
        unsubscribe();
      },
      `${name} observer`,
    );
  }

  ctx.systemPrompt?.section?.({
    name: "tool:exec_command:notify",
    order: ctx.systemPrompt.getSectionOrder?.("TOOL_BASH"),
    text: SYSTEM_PROMPT_TEXT,
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent, turn } = payload;
    if (turns.get(agent)?.turn !== turn) turns.set(agent, { turn, startedAt: Date.now() });
    return next();
  });

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    if (stopWaitMs === 0 || signal?.aborted) return;
    if (agent.inbox?.nextStep?.length > 0) return; // someone already continues the turn
    const startedAt = turns.get(agent)?.turn === turn ? turns.get(agent).startedAt : Infinity;
    const awaited = backgroundSessions(agent).filter(
      (handle) => handle.running && !handle.tty && !handle.interrupted && handle.backgroundedAt >= startedAt && !looksLikeService(handle.cmd),
    );
    if (awaited.length === 0 || landing(agent, turn)) return;
    holding.add(agent);
    try {
      ctx.logger?.info?.(`${name}: turn ${turn} stopping with ${awaited.length} background command(s) running; waiting up to ${stopWaitMs}ms`);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race(awaited.map((handle) => handle.whenExited(stopWaitMs, abort.signal)));
      } finally {
        abort.abort(); // release the other waits
        signal?.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted || disposed) return;
      const texts = await finish(awaited.filter((handle) => !handle.running));
      if (texts.length === 0) {
        ctx.logger?.info?.(`${name}: turn ${turn} still has background commands running after ${stopWaitMs}ms; letting it end`);
        return;
      }
      const summary = texts.length === 1 ? "background command finished" : `${texts.length} background commands finished`;
      agent.steer(pluginNotice(name, MESSAGES.finishedAtStop(texts), summary));
    } finally {
      holding.delete(agent);
      // Exits that landed while the stop was held but were not waited on.
      const late = backgroundSessions(agent).filter((handle) => !handle.running && !handle.interrupted);
      if (late.length > 0 && !disposed) {
        void finish(late).then((texts) => {
          if (texts.length > 0) deliver(agent, texts);
        });
      }
    }
  });
}
