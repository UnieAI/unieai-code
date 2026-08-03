#!/usr/bin/env node
/**
 * unieai-agent — slim terminal UI for UnieAI Code on the agent-core loop.
 *
 * Deliberately minimal (readline, no ratatui parity): streaming replies,
 * dimmed thinking, tool lines, interactive approvals, /model /vision-model /new /sessions
 * /resume /ps /kill /quit. The full-featured Rust TUI remains available as
 * `unieai` during the engine transition.
 */
import readline from "node:readline";
import { stdin, stdout, argv, exit, cwd } from "node:process";
import { createEngine } from "../src/engine.mjs";
import { listSessions } from "../src/session.mjs";
import { unieaiHome } from "../src/config.mjs";
import { liveProcessManagers } from "../src/process-manager.mjs";
import { activeThreadId, listThreads } from "../../third_party/unieai-agent-core/src/agent-threads.mjs";
import { describeProbe } from "../../third_party/unieai-agent-core/src/vision.mjs";
import {
  readVisionState,
  setVisionModel as setStoredVisionModel,
  visionStatePath,
  writeVisionState,
} from "../../third_party/unieai-agent-core/src/vision-store.mjs";

const DIM = "\x1b[2m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RED = "\x1b[31m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

const args = Object.fromEntries(
  argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] ?? true] : null)).filter(Boolean)
);

const rl = readline.createInterface({ input: stdin, output: stdout });
let stdinClosed = false;
rl.on("close", () => { stdinClosed = true; });
const question = (q) =>
  stdinClosed ? Promise.resolve("/quit") : new Promise((res) => {
    try { rl.question(q, res); } catch { res("/quit"); }
  });

let reasoningOpen = false;
function closeReasoning() {
  if (reasoningOpen) {
    stdout.write(RESET + "\n");
    reasoningOpen = false;
  }
}

/**
 * Background processes, across every engine this TUI has built.
 *
 * The manager belongs to a toolset closure and neither the toolset nor the
 * engine hands it back, so process-manager.mjs keeps a registry of every
 * manager alive in the process and this reads it. Deliberately NOT scoped to
 * the current engine: /new and /model build a fresh one, and a dev server
 * started before that is still holding its port — scoping would leave the user
 * looking at an empty list with no way left to stop it.
 */
function backgroundProcesses() {
  return liveProcessManagers().flatMap((m) => m.list());
}

/** One /ps row: what it is, whether it is alive, and how much output is waiting. */
function describeProcess(p) {
  // An exit code answers "why did it stop" and uptime answers "is it making
  // progress"; only one of the two is ever the interesting number.
  const life = p.status === "running" ? `up ${Math.round(p.uptimeMs / 1000)}s` : `exit ${p.exitCode ?? p.signal ?? "?"}`;
  const dropped = p.droppedLines ? ` (+${p.droppedLines} dropped)` : "";
  return `${p.id.padEnd(7)}${p.status.padEnd(9)}${life.padEnd(12)}${`${p.outputLines} line(s)${dropped}`.padEnd(22)}${String(p.command).slice(0, 60)}`;
}

// Web access (the fetch tool) is off by default; opt in with `--web`, the
// UNIEAI_WEB_ACCESS/UNIEAI_WEB env var, or `/web` at runtime. New engines from
// /new, /resume, and /model inherit the current setting via this shared flag.
const truthy = (v) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());
let webAccess =
  args.web === true || truthy(args.web) || truthy(process.env.UNIEAI_WEB_ACCESS) || truthy(process.env.UNIEAI_WEB);

// Delegation is off by default: a sub-agent spends its own tokens on a context
// the user never sees, so it should be an explicit choice rather than a default
// the model can reach for. New engines from /new, /resume and /model inherit
// this the same way webAccess does.
let subagents = args.subagents === true || truthy(args.subagents) || truthy(process.env.UNIEAI_SUBAGENTS);

// The chosen vision model persists across runs — probing costs a real model
// call, so re-picking every session would make the feature not worth using.
const visionPath = visionStatePath(unieaiHome());
let visionModel = (await readVisionState(visionPath)).model;

function makeEngine(resume = null, model = null) {
  return createEngine({
    workspace: cwd(),
    model,
    resume,
    webAccess,
    visionModel,
    subagents,
    onText: (d) => {
      closeReasoning();
      stdout.write(d);
    },
    onReasoning: (d) => {
      if (!reasoningOpen) {
        stdout.write(DIM + "· thinking · ");
        reasoningOpen = true;
      }
      stdout.write(DIM + d.replace(/\n+/g, " ") + RESET);
    },
    onToolEvent: (e) => {
      closeReasoning();
      if (e.type === "tool_use_started") stdout.write(`${CYAN}• ${e.tool_name}${RESET} ${DIM}${String(e.args_preview ?? "").slice(0, 80)}${RESET}\n`);
      if (e.type === "tool_use_failed") stdout.write(`${RED}✗ ${e.tool_name} ${String(e.error ?? "").slice(0, 120)}${RESET}\n`);
      // A sub-agent runs in its own context and only reports a conclusion, so
      // without these two lines a delegation looked like the session had simply
      // stopped responding for however long it took.
      if (e.type === "task_start") stdout.write(`${CYAN}⑂ 子代理 ${e.taskId ?? ""}${RESET} ${DIM}${String(e.description ?? "").slice(0, 80)}${RESET}\n`);
      if (e.type === "task_end") {
        const summary = String(e.result ?? e.summary ?? "").replace(/\s+/g, " ").slice(0, 160);
        stdout.write(`${CYAN}⑂ 子代理 ${e.taskId ?? ""} 完成${RESET}${summary ? ` ${DIM}${summary}${RESET}` : ""}\n`);
      }
      // A background job outlives the turn that started it and prints nowhere,
      // so without this line the whole thing is invisible: the transcript would
      // show a tool call and no sign that a dev server is now holding a port.
      if (e.type === "process_start") {
        stdout.write(`${CYAN}⚙ 背景程序 ${e.id ?? ""}${RESET} ${DIM}${String(e.command ?? "").slice(0, 80)} — /ps 查看, /kill ${e.id ?? "<id>"} 停止${RESET}\n`);
      }
      // A stop the MODEL initiated used to leave the process on screen as
      // running, so the user kept looking for a port that was already free.
      if (e.type === "process_stop") {
        const what = e.all ? `全部 ${e.count ?? ""} 個背景程序` : `背景程序 ${e.id ?? ""}`;
        stdout.write(`${CYAN}⚙ 已停止 ${what}${RESET}${e.forced ? ` ${DIM}(強制)${RESET}` : ""}\n`);
      }
      if (e.type === "process_failed") {
        stdout.write(`${RED}⚙ 背景程序啟動失敗${RESET} ${DIM}${String(e.error ?? "").slice(0, 120)}${RESET}\n`);
      }
      // Threads move where later work lands, so a switch the user cannot see
      // makes the next few replies look like they came from nowhere.
      if (e.type === "thread_open") stdout.write(`${CYAN}⑂ 開啟 thread ${e.threadId ?? ""}${RESET} ${DIM}${String(e.name ?? "").slice(0, 60)}${RESET}\n`);
      if (e.type === "thread_switch") stdout.write(`${CYAN}⑂ 切換到 ${e.threadId ?? "主線"}${RESET}\n`);
      if (e.type === "thread_finish") stdout.write(`${CYAN}⑂ thread ${e.threadId ?? ""} 收束${RESET} ${DIM}${String(e.conclusion ?? "").slice(0, 100)}${RESET}\n`);
    },
    requestApproval: async ({ tool, action, detail }) => {
      closeReasoning();
      stdout.write(`\n${YELLOW}⚠ ${tool} 請求${action}:${RESET}\n  ${detail}\n`);
      const answer = (await question(`${YELLOW}允許? [y]一次 [a]本次對話 [N]拒絕: ${RESET}`)).trim().toLowerCase();
      return answer === "y" ? "accept" : answer === "a" ? "acceptForSession" : "decline";
    },
    requestQuestion: async ({ question: qText, options }) => {
      closeReasoning();
      stdout.write(`\n${CYAN}? ${qText}${RESET}\n`);
      options.forEach((o, i) => stdout.write(`  ${CYAN}${i + 1}${RESET}. ${o}\n`));
      const ans = (await question(`${CYAN}選擇 [1-${options.length}]，Enter 跳過: ${RESET}`)).trim();
      const idx = Number(ans);
      return Number.isInteger(idx) && idx >= 1 && idx <= options.length ? options[idx - 1] : null;
    }
  });
}

let engine;
try {
  engine = makeEngine(args.resume || null, args.model || null);
} catch (e) {
  console.error(RED + String(e.message || e) + RESET);
  exit(1);
}

console.log(`${BOLD}UnieAI Code${RESET} ${DIM}(agent-core engine · ${engine.model} · session ${engine.sessionId}${webAccess ? " · web on" : ""})${RESET}`);
console.log(`${DIM}/model /vision-model /new /sessions /resume <id> /web /subagents /threads /ps /kill <id> /quit${RESET}\n`);

async function repl() {
  for (;;) {
    const line = (await question(`${BOLD}› ${RESET}`)).trim();
    if (stdinClosed && !line) break;
    if (line === "/quit" && stdinClosed) break;
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    if (line === "/sessions") {
      for (const s of listSessions(10)) console.log(`${DIM}${s.id}${RESET}  ${s.preview}`);
      continue;
    }
    if (line.startsWith("/resume ")) {
      try { engine = makeEngine(line.slice(8).trim()); console.log(`${DIM}resumed ${engine.sessionId}${RESET}`); }
      catch (e) { console.log(RED + String(e.message || e) + RESET); }
      continue;
    }
    if (line === "/new") {
      engine = makeEngine();
      console.log(`${DIM}new session ${engine.sessionId}${RESET}`);
      continue;
    }
    if (line === "/ps") {
      const rows = backgroundProcesses();
      // Say it plainly. "0 process(es)" over an empty table reads like the list
      // failed to load, and the answer to "is my dev server up" has to be blunt.
      if (!rows.length) { console.log(`${DIM}沒有背景程序。用 run_background 啟動一個。${RESET}`); continue; }
      for (const p of rows) console.log(`${DIM}${describeProcess(p)}${RESET}`);
      continue;
    }
    if (line === "/kill" || line.startsWith("/kill ")) {
      const target = line.slice("/kill".length).trim();
      if (!target) { console.log(`${DIM}用法: /kill <id> 或 /kill all${RESET}`); continue; }
      const managers = liveProcessManagers();
      if (target === "all") {
        const stopped = (await Promise.all(managers.map((m) => m.stopAll()))).flat();
        console.log(`${DIM}stopped ${stopped.length} process(es)${RESET}`);
        continue;
      }
      // An id is unique only within the manager that issued it, so ask each one
      // whether it owns this id rather than assuming a single global table.
      const owners = managers.filter((m) => m.status(target));
      if (!owners.length) { console.log(`${DIM}no such process ${target} — /ps for the list${RESET}`); continue; }
      for (const m of owners) {
        const result = await m.stop(target);
        if (!result.ok) console.log(`${RED}${result.error}${RESET}`);
        // Worth reporting: a job that ignored SIGTERM had no chance to release
        // its port or write its report, and may leave something half-written.
        else console.log(`${DIM}stopped ${target}${result.forced ? " (it ignored the polite signal and was killed)" : ""}${RESET}`);
      }
      continue;
    }
    if (line === "/web") {
      webAccess = !webAccess;
      engine.setWebAccess(webAccess); // keeps the current session; retools next turn
      console.log(`${DIM}web access ${webAccess ? "on — fetch tool available" : "off"}${RESET}`);
      continue;
    }
    if (line === "/threads") {
      // Read-only on purpose. Switching from here would move where the NEXT
      // model turn lands without the model being told, which is exactly the
      // confusion the timeline events above exist to prevent.
      const rows = listThreads(engine.sessionTree);
      if (!rows.length) console.log(`${DIM}沒有 thread（全部在主線上）${RESET}`);
      else {
        const active = activeThreadId(engine.sessionTree);
        for (const t of rows) {
          const mark = t.id === active ? `${CYAN}▸${RESET}` : " ";
          console.log(`${mark} ${DIM}${t.id.padEnd(8)}${t.status.padEnd(10)}${String(t.entryCount).padStart(3)} 則${RESET}  ${t.name || t.task || ""}`);
        }
      }
      continue;
    }
    if (line === "/subagents") {
      subagents = !subagents;
      engine.setSubagents(subagents); // keeps the current session; retools next turn
      console.log(`${DIM}sub-agents ${subagents ? "on — the model can delegate with the task tool" : "off"}${RESET}`);
      continue;
    }
    if (line === "/vision-model" || line === "/vlm") {
      if (visionModel) console.log(`${DIM}current: ${visionModel}${RESET}`);
      engine.models.forEach((m, i) => console.log(`${DIM}${i + 1}.${RESET} ${m.id}`));
      const pick = Number((await question("vision model # (blank to cancel): ")).trim());
      const chosen = engine.models[pick - 1];
      if (!chosen) { console.log(`${DIM}cancelled${RESET}`); continue; }

      // Verify rather than trust: the catalog says nothing about image support,
      // and a gateway can accept an image, drop it, and let the model guess.
      console.log(`${DIM}testing ${chosen.id} with a sample image…${RESET}`);
      const outcome = await engine.probeVision(chosen.id);
      if (outcome.result !== "ok") {
        // Not saved on failure — remembering a model that cannot see just moves
        // the failure to later, mid-task, when it is harder to diagnose.
        console.log(RED + describeProbe(outcome) + RESET);
        continue;
      }

      visionModel = chosen.id;
      engine.setVisionModel(visionModel); // keeps the session; retools next turn
      try {
        const state = await readVisionState(visionPath);
        await writeVisionState(visionPath, setStoredVisionModel(state, visionModel));
      } catch (e) {
        console.log(`${YELLOW}chosen for this session, but could not save: ${e.message}${RESET}`);
      }
      console.log(`${DIM}${describeProbe(outcome)}${RESET}`);
      continue;
    }
    if (line === "/model") {
      engine.models.forEach((m, i) => console.log(`${DIM}${i + 1}.${RESET} ${m.id}`));
      const pick = Number((await question("model #: ")).trim());
      const chosen = engine.models[pick - 1];
      if (chosen) { engine = makeEngine(null, chosen.id); console.log(`${DIM}switched to ${chosen.id}${RESET}`); }
      continue;
    }
    try {
      await engine.send(line);
    } catch (e) {
      console.log(`\n${RED}error: ${String(e.message || e).slice(0, 300)}${RESET}`);
    }
    closeReasoning();
    stdout.write("\n\n");
  }
  if (!stdinClosed) rl.close();
}

repl();
