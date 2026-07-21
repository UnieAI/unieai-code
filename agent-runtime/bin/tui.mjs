#!/usr/bin/env node
/**
 * unieai-agent — slim terminal UI for UnieAI Code on the agent-core loop.
 *
 * Deliberately minimal (readline, no ratatui parity): streaming replies,
 * dimmed thinking, tool lines, interactive approvals, /model /new /sessions
 * /resume /quit. The full-featured Rust TUI remains available as `unieai`
 * during the engine transition.
 */
import readline from "node:readline";
import { stdin, stdout, argv, exit, cwd } from "node:process";
import { createEngine } from "../src/engine.mjs";
import { listSessions } from "../src/session.mjs";

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

// Web access (the fetch tool) is off by default; opt in with `--web`, the
// UNIEAI_WEB_ACCESS/UNIEAI_WEB env var, or `/web` at runtime. New engines from
// /new, /resume, and /model inherit the current setting via this shared flag.
const truthy = (v) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());
let webAccess =
  args.web === true || truthy(args.web) || truthy(process.env.UNIEAI_WEB_ACCESS) || truthy(process.env.UNIEAI_WEB);

function makeEngine(resume = null, model = null) {
  return createEngine({
    workspace: cwd(),
    model,
    resume,
    webAccess,
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
console.log(`${DIM}/model /new /sessions /resume <id> /web /quit${RESET}\n`);

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
    if (line === "/web") {
      webAccess = !webAccess;
      engine.setWebAccess(webAccess); // keeps the current session; retools next turn
      console.log(`${DIM}web access ${webAccess ? "on — fetch tool available" : "off"}${RESET}`);
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
