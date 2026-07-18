// HumanEval pass@1 — three engines × configurable models.
// Portable: paths resolve relative to this file; binary + model via env.
//
//   UNIEAI_BIN=/path/to/unieai UNIEAI_HOME=~/.unieai node benchmarks/humaneval.mjs
//
// Env:
//   UNIEAI_BIN   path to the `unieai` binary (default: "unieai" on PATH)
//   UNIEAI_HOME  sign-in dir written by `unieai login` (default: ~/.unieai)
//   MODELS       comma list "Qwen3.6-35B-A3B:164,GLM-5.2:40" (model:count)
//   ARMS         comma list of engines to run (default all three)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BIN = process.env.UNIEAI_BIN || "unieai";
const STOCK_PROMPT = join(HERE, "stock-codex-prompt.md");
const HE = join(HERE, "humaneval.jsonl");
const ENGINE = join(REPO, "agent-runtime", "src", "engine.mjs");
const ROOT = "/tmp/humaneval-runs";
const OUT = join(HERE, "results");

const { createEngine } = await import(ENGINE);
const all = readFileSync(HE, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const PLAN = (process.env.MODELS || "Qwen3.6-35B-A3B:164,GLM-5.2:40,MiniMax-M2:40")
  .split(",").map((s) => { const [model, n] = s.split(":"); return { model, n: Number(n) || 164 }; });
const ARM_NAMES = (process.env.ARMS || "codex-stock,codex-unieai,agent-core").split(",");

const INSTR = "Write the complete Python implementation to solution.py. The file must contain the full function definition (signature + body) that satisfies the docstring. Use the write or edit tool — do not print the code in your reply.";

function passes(ws, prob) {
  const sol = existsSync(join(ws, "solution.py")) ? readFileSync(join(ws, "solution.py"), "utf8") : "";
  if (!sol.includes(`def ${prob.entry_point}`)) return false;
  writeFileSync(join(ws, "_test.py"), `${sol}\n\n${prob.test}\n\ncheck(${prob.entry_point})\nprint("HUMANEVAL_PASS")\n`);
  const r = spawnSync("python3", ["_test.py"], { cwd: ws, encoding: "utf8", timeout: 20000 });
  return (r.stdout || "").includes("HUMANEVAL_PASS");
}
function runCodex(ws, prob, stock, MODEL) {
  const args = ["exec", "--experimental-json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", ws, "-m", MODEL];
  if (stock) args.push("-c", `model_instructions_file="${STOCK_PROMPT}"`);
  const t0 = Date.now();
  const r = spawnSync(BIN, args, { input: `${INSTR}\n\n\`\`\`python\n${prob.prompt}\`\`\``, encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  let tok = 0;
  for (const line of (r.stdout || "").split("\n")) { if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch { continue; } if (e.type === "turn.completed" && e.usage) tok += (e.usage.input_tokens || 0) + (e.usage.output_tokens || 0); }
  return { ms: Date.now() - t0, tokens: tok };
}
async function runAgentCore(ws, prob, MODEL) {
  const engine = createEngine({ workspace: ws, model: MODEL, onText: () => {}, onToolEvent: () => {}, requestApproval: async () => "accept" });
  const t0 = Date.now(); const res = await engine.send(`${INSTR}\n\n\`\`\`python\n${prob.prompt}\`\`\``);
  const u = res.usage || {}; return { ms: Date.now() - t0, tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0) };
}
const ARMS = {
  "codex-stock": (ws, p, m) => runCodex(ws, p, true, m),
  "codex-unieai": (ws, p, m) => runCodex(ws, p, false, m),
  "agent-core": (ws, p, m) => runAgentCore(ws, p, m),
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = {};
for (const step of PLAN) {
  const MODEL = step.model, problems = all.slice(0, step.n), agg = {};
  for (const a of ARM_NAMES) agg[a] = { pass: 0, total: 0, ms: 0, tokens: 0 };
  console.log(`\n########## ${MODEL} (${problems.length} problems) ##########`);
  for (const prob of problems) {
    const tid = prob.task_id.replace("/", "_");
    for (const a of ARM_NAMES) {
      const ws = join(ROOT, `${MODEL}-${a}-${tid}`); mkdirSync(ws, { recursive: true });
      let out; try { out = await ARMS[a](ws, prob, MODEL); } catch { out = { ms: 0, tokens: 0 }; }
      const ok = (() => { try { return passes(ws, prob); } catch { return false; } })();
      const s = agg[a]; s.total++; s.ms += out.ms; s.tokens += out.tokens; if (ok) s.pass++;
      console.log(`${ok ? "✅" : "❌"} ${MODEL.padEnd(16)} ${a.padEnd(13)} ${prob.task_id.padEnd(13)} ${(out.ms/1000).toFixed(1)}s ${out.tokens}tok`);
      rmSync(ws, { recursive: true, force: true });
    }
  }
  report[MODEL] = agg;
}
console.log(`\n=== HumanEval pass@1 ===`);
for (const [MODEL, agg] of Object.entries(report)) {
  console.log(`\n# ${MODEL}\n  engine          pass@1          avg time  avg tokens`);
  for (const a of ARM_NAMES) { const s = agg[a]; const pct = Math.round(100 * s.pass / s.total); console.log(`  ${a.padEnd(14)} ${(pct + "% (" + s.pass + "/" + s.total + ")").padEnd(14)} ${(s.ms/s.total/1000).toFixed(1).padStart(6)}s  ${Math.round(s.tokens/s.total)}`); }
}
writeFileSync(join(OUT, "humaneval.json"), JSON.stringify(report, null, 2));
console.log(`\nresults → benchmarks/results/humaneval.json`);
