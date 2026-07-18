// SWE-bench Lite — stage 1: generate predictions (the agentic part).
// Portable: paths relative to this file; binary + model via env.
//
//   UNIEAI_BIN=/path/to/unieai UNIEAI_HOME=~/.unieai node benchmarks/swebench-gen.mjs
//
// Clones the repo@base_commit, the agent reads the real issue and edits the
// source, and `git diff` is captured as model_patch in official
// predictions.jsonl format (one file per engine under benchmarks/results/).
// Evaluate with the official docker harness (see AWS-TESTING.md).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BIN = process.env.UNIEAI_BIN || "unieai";
const STOCK_PROMPT = join(HERE, "stock-codex-prompt.md");
const MODEL = process.env.MODEL || "Qwen3.6-35B-A3B";
const REPO_URL = process.env.REPO_URL || "https://github.com/pallets/flask";
const INST_FILE = process.env.INST_FILE || join(HERE, "flask-instances.jsonl");
const ENGINE = join(REPO, "agent-runtime", "src", "engine.mjs");
const ROOT = "/tmp/swebench-gen";
const OUT = join(HERE, "results", "swebench-preds");

const { createEngine } = await import(ENGINE);
const seen = new Set();
const instances = readFileSync(INST_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((d) => (seen.has(d.instance_id) ? false : (seen.add(d.instance_id), true)));
const sh = (cmd, cwd, t = 180000) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: t, maxBuffer: 64 * 1024 * 1024 });
const PROMPT = (inst) => `You are fixing a real bug in this repository (checked out in the current directory). Read the issue, locate the cause in the SOURCE code, and edit the source to fix it. Do NOT edit or add tests. Explore with your tools first, then make a minimal fix.\n\n## Issue\n${inst.problem_statement.slice(0, 7000)}`;

function clone(inst, tag) {
  const dir = join(ROOT, `${tag}-${inst.instance_id}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  sh(`git clone --quiet ${REPO_URL} repo`, dir); const repo = join(dir, "repo"); sh(`git checkout --quiet ${inst.base_commit}`, repo); return { dir, repo };
}
function runCodex(repo, inst, stock) {
  const args = ["exec", "--experimental-json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", repo, "-m", MODEL];
  if (stock) args.push("-c", `model_instructions_file="${STOCK_PROMPT}"`);
  spawnSync(BIN, args, { input: PROMPT(inst), encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
}
async function runAgentCore(repo, inst) {
  const engine = createEngine({ workspace: repo, model: MODEL, onText: () => {}, onToolEvent: () => {}, requestApproval: async () => "accept" });
  await engine.send(PROMPT(inst));
}
const ARMS = [
  { name: "codex-stock", run: (r, i) => runCodex(r, i, true) },
  { name: "codex-unieai", run: (r, i) => runCodex(r, i, false) },
  { name: "agent-core", run: (r, i) => runAgentCore(r, i) },
];

rmSync(ROOT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const summary = {};
for (const a of ARMS) { summary[a.name] = { produced: 0, total: 0 }; writeFileSync(join(OUT, `${a.name}.jsonl`), ""); }
for (const inst of instances) {
  console.log(`\n### ${inst.instance_id}`);
  for (const arm of ARMS) {
    const t0 = Date.now(); let patch = "", err = "";
    try { const { dir, repo } = clone(inst, arm.name); await arm.run(repo, inst); patch = sh(`git diff`, repo).stdout || ""; rmSync(dir, { recursive: true, force: true }); }
    catch (e) { err = String(e.message).slice(0, 60); }
    const nonEmpty = patch.trim().length > 0; if (nonEmpty) summary[arm.name].produced++; summary[arm.name].total++;
    appendFileSync(join(OUT, `${arm.name}.jsonl`), JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: `unieai-${arm.name}-${MODEL}`, model_patch: patch }) + "\n");
    console.log(`${nonEmpty ? "📝" : "∅"} ${arm.name.padEnd(13)} ${((Date.now()-t0)/1000).toFixed(0)}s  ${patch.split("\n").length} diff lines  ${err}`);
  }
}
console.log(`\n=== non-empty patches / total ===`);
for (const a of ARMS) console.log(`${a.name.padEnd(14)} ${summary[a.name].produced}/${summary[a.name].total}`);
console.log(`\npredictions → benchmarks/results/swebench-preds/  (evaluate with official swebench harness)`);
