// SWE-bench Verified (500) — prediction generation, agent-core arm.
// Compares MODELS on a fixed harness. Local mirrors, resume, trajectory capture.
//
//   MODEL=Qwen3.6-35B-A3B WORKERS=4 LIMIT=6 node benchmarks/swebench-gen-verified.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/ubuntu/service/unieai-code";
const MODEL = process.env.MODEL || "Qwen3.6-35B-A3B";
const WORKERS = Number(process.env.WORKERS || 4);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 900000);
const LIMIT = Number(process.env.LIMIT || 0);
const INST_FILE = process.env.INST_FILE || join(REPO, "benchmarks/verified-500-instances.jsonl");
const MIRRORS = join(REPO, "benchmarks/mirrors");
const RUN_TAG = String(process.env.RUN_TAG || MODEL);
const ROOT = `/tmp/swebench-verified-${RUN_TAG}`;
const SUF = process.env.OUT_SUF || ""; // e.g. "-smoke" to keep a trial run out of the real preds
const OUT = join(REPO, "benchmarks/results", `swebench-preds-verified-${MODEL}${SUF}`);
const TRAJ = join(REPO, "benchmarks/results", `traj-verified-${MODEL}${SUF}`);
const ARMS = String(process.env.ARMS || "agent-core").split(",").filter(Boolean);
const BIN = process.env.UNIEAI_BIN || join(REPO, "codex-rs/target/release/codex");
const STOCK_PROMPT = join(REPO, "benchmarks/stock-codex-prompt.md");
// Container mode needs a codex built against the images' glibc (2.35); the host
// binary targets 2.39 and will not start there.
const CODEX_CTR_BIN = process.env.CODEX_CTR_BIN || "/tmp/codex-musl-target/release/codex";
const UNIEAI_HOME = join(process.env.HOME || "/home/ubuntu", ".unieai");

const { createEngine } = await import(join(REPO, "agent-runtime/src/engine.mjs"));
const { dockerExecBackend } = await import(join(REPO, "agent-runtime/src/exec-backend.mjs"));
const CONTAINER = process.env.CONTAINER === "1";
const seen = new Set();
let instances = readFileSync(INST_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((d) => (seen.has(d.instance_id) ? false : (seen.add(d.instance_id), true)));
if (LIMIT) instances = instances.slice(0, LIMIT);
const PROMPT = (inst) => `You are fixing a real bug in this repository (checked out in the current directory). Read the issue, locate the cause in the SOURCE code, and edit the source to fix it. Do NOT edit or add tests. Explore with your tools first, then make a minimal fix.\n\n## Issue\n${inst.problem_statement.slice(0, 7000)}`;

mkdirSync(OUT, { recursive: true }); mkdirSync(TRAJ, { recursive: true }); mkdirSync(ROOT, { recursive: true });

// Resume: skip (arm, instance) pairs already written to the output jsonl.
const done = new Set();
const outFile = (arm) => join(OUT, `${arm}.jsonl`);
for (const arm of ARMS) {
  const f = outFile(arm);
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) done.add(`${arm}:${JSON.parse(l).instance_id}`);
  else writeFileSync(f, "");
}

function shSync(cmd, cwd, t = 300000) { return spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: t, maxBuffer: 64 * 1024 * 1024 }); }

function cloneFromMirror(inst, tag) {
  const mirror = join(MIRRORS, inst.repo.replace("/", "_") + ".git");
  const dir = join(ROOT, `${tag}-${inst.instance_id}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const r = shSync(`git clone --quiet "${mirror}" repo && cd repo && git checkout --quiet ${inst.base_commit}`, dir);
  if (r.status !== 0) throw new Error(`clone/checkout: ${(r.stderr || "").slice(0, 150)}`);
  return { dir, repo: join(dir, "repo") };
}

// --- container mode -------------------------------------------------------
// CONTAINER=1 runs each instance against its prepared SWE-bench image instead of
// a bare mirror clone. It matters more than it sounds: a bare clone has none of
// the repo's dependencies installed, so `import django` fails, no test can run,
// and every arm is reduced to guessing a patch it cannot execute. The published
// numbers everyone compares against are produced in these images.
//
// The workspace is a HOST COPY of the image's /testbed (taken with `docker cp`,
// so compiled extensions and the exact base_commit checkout come along), bind
// mounted back over /testbed in a running container. Files stay local — the
// read/write/edit tools are unchanged — while shell commands cross into the
// container, where the toolchain lives.
const imageFor = (inst) => `swebench/sweb.eval.x86_64.${inst.instance_id.replace("__", "_1776_")}:latest`;
// Instances sharing a repo+version share an env image: 3.3GB and 35s for the
// first, 150MB and 5s for each one after. Grouping the run by that key is what
// keeps peak disk at a few GB instead of the ~180GB the full set would need.
const envKeyOf = (inst) => `${inst.repo}@${inst.version}`;

function dockerSync(args, t = 600000) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: t, maxBuffer: 64 * 1024 * 1024 });
}

function prepareContainer(inst, tag, { forCodex = false } = {}) {
  const image = imageFor(inst);
  const pull = dockerSync(["pull", "-q", image], 1800000);
  if (pull.status !== 0) throw new Error(`docker pull: ${(pull.stderr || "").slice(0, 200)}`);
  const dir = join(ROOT, `${tag}-${inst.instance_id}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const staging = dockerSync(["create", image]);
  if (staging.status !== 0) throw new Error(`docker create: ${(staging.stderr || "").slice(0, 200)}`);
  const stagingId = staging.stdout.trim();
  try {
    const cp = dockerSync(["cp", `${stagingId}:/testbed`, join(dir, "repo")]);
    if (cp.status !== 0) throw new Error(`docker cp: ${(cp.stderr || "").slice(0, 200)}`);
  } finally {
    dockerSync(["rm", "-f", stagingId], 60000);
  }
  const repo = join(dir, "repo");
  // The container runs as root and the host tools run as the invoking user, both
  // writing the same bind mount. Without this the two fight: root-created files
  // (notably __pycache__) are unwritable from the host, which surfaced as 42
  // "Permission denied" and 10 EACCES failures in a single 100-instance run.
  shSync(`chmod -R a+rwX "${repo}"`, dir);
  // The codex arm runs the WHOLE agent inside the container (it is one process
  // that owns its own shell), so it needs its binary and gateway credentials in
  // there. agent-core needs neither: its loop stays on the host and only shell
  // commands cross the boundary.
  // codex writes into its home at startup (app-server state), so the credential
  // directory cannot be mounted read-only — and must not be the user's real one,
  // which a benchmark has no business writing to. Each instance gets a copy.
  let codexMounts = [];
  if (forCodex) {
    const home = join(dir, "codex-home");
    mkdirSync(home, { recursive: true });
    // ONLY the credential + config files. The real ~/.unieai also holds session
    // history, snapshots and a 167MB log database — copying it per instance costs
    // minutes and carries nothing codex needs to authenticate.
    const cp = shSync(`cp "${UNIEAI_HOME}/unieai.json" "${UNIEAI_HOME}/config.toml" "${home}/" 2>&1`, dir);
    if (cp.status !== 0) throw new Error(`copy unieai credentials: ${(cp.stdout || cp.stderr || "").slice(0, 150)}`);
    // The binary lands in a normally-writable directory so codex can still create
    // the PATH aliases it expects; only the file itself is read-only.
    codexMounts = ["-v", `${CODEX_CTR_BIN}:/usr/local/bin/codex:ro`, "-v", `${home}:/root/.unieai`];
  }
  const up = dockerSync(["run", "-d", "--rm", "-v", `${repo}:/testbed`, ...codexMounts, "-w", "/testbed", image, "sleep", "infinity"]);
  if (up.status !== 0) throw new Error(`docker run: ${(up.stderr || "").slice(0, 200)}`);
  const container = up.stdout.trim();
  // git refuses to operate on a tree owned by someone else ("detected dubious
  // ownership"), which is exactly what a bind mount from the host looks like to
  // root. Every `git diff`/`git status` the model ran failed until this is set —
  // 38 times in one run.
  dockerSync(["exec", container, "git", "config", "--global", "--add", "safe.directory", "/testbed"], 60000);
  return { dir, repo, container, image };
}

function tearDownContainer(ws) {
  if (!ws?.container) return;
  // The container runs as root (running it as the host user leaves conda's
  // `testbed` env unactivated, so python resolves to the wrong interpreter and
  // nothing is importable). Anything it created in the bind mount — .pytest_cache,
  // __pycache__, build artifacts — is therefore root-owned, and the host cannot
  // delete it. Hand ownership back while the container still exists.
  dockerSync(["exec", ws.container, "chown", "-R", `${process.getuid()}:${process.getgid()}`, "/testbed"], 300000);
  dockerSync(["rm", "-f", ws.container], 120000);
}

// Control arm: upstream codex harness with the stock prompt, same model + gateway.
/**
 * A CODEX_HOME carrying our Stop hook, built once and reused by every instance.
 *
 * The hook arm and the stock arm must differ in EXACTLY one thing — the hook —
 * or the comparison measures something else. Same binary, same prompt file,
 * same sandbox, same model; this home is a copy of the real one with the hook
 * appended, so even the model/provider config is identical.
 *
 * `--dangerously-bypass-hook-trust` is required because a hook declared in a
 * user config is Untrusted until a hash is recorded, and an untrusted hook is
 * silently skipped — which would make the arm a duplicate of the baseline and
 * report "the hook does nothing".
 */
let HOOK_HOME = null;
function hookHome() {
  if (HOOK_HOME) return HOOK_HOME;
  const home = `/tmp/swebench-hook-home-${RUN_TAG}`;
  mkdirSync(home, { recursive: true });
  for (const f of ["unieai.json", "config.toml", "auth.json"]) {
    try { writeFileSync(join(home, f), readFileSync(join(UNIEAI_HOME, f), "utf8")); } catch { /* optional */ }
  }
  const hookBin = join(REPO, "completion-contract/bin/stop-hook.mjs");
  appendFileSync(
    join(home, "config.toml"),
    `\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node ${hookBin}"\n`
  );
  HOOK_HOME = home;
  return home;
}

function runCodexAsync(repo, inst, stock, trajDir, container = null, withHook = false) {
  return new Promise((resolve) => {
    // Inside the container, codex's own sandbox is redundant and its user
    // namespaces are unavailable — the container IS the boundary, which is also
    // exactly how the agent-core arm's shell runs there. Equivalent footing.
    const sandboxArgs = container
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "workspace-write"];
    const args = ["exec", "--experimental-json", ...sandboxArgs, "--skip-git-repo-check", "-C", container ? "/testbed" : repo, "-m", MODEL];
    if (stock) args.push("-c", `model_instructions_file="${container ? "/testbed/.stock-prompt.md" : STOCK_PROMPT}"`);
    if (withHook) args.push("--dangerously-bypass-hook-trust");
    const [cmdBin, cmdArgs] = container
      ? ["docker", ["exec", "-i", "-w", "/testbed", container, "/usr/local/bin/codex", ...args]]
      : [BIN, args];
    const p = spawn(cmdBin, cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: withHook ? { ...process.env, CODEX_HOME: hookHome() } : process.env,
    });
    let out = "", errB = "";
    const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, TIMEOUT_MS);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { errB += d; });
    p.on("close", (code, signal) => {
      clearTimeout(killer);
      writeFileSync(join(trajDir, "codex-stdout.jsonl"), out);
      writeFileSync(join(trajDir, "codex-stderr.txt"), errB);
      writeFileSync(join(trajDir, "meta.json"), JSON.stringify({ code, signal }, null, 1));
      resolve();
    });
    p.stdin.write(PROMPT(inst)); p.stdin.end();
  });
}

async function runAgentCore(repo, inst, trajDir, container = null) {
  const events = []; let text = "";
  const engine = createEngine({
    workspace: repo, model: MODEL,
    execBackend: container ? dockerExecBackend({ container }) : null,
    onText: (d) => { text += d; },
    onToolEvent: (e) => events.push({ t: Date.now(), type: e.type, tool: e.tool_name || "", err: e.error || "", action: e.action || "" }),
    requestApproval: async () => "accept",
    expectsMutation: true,
  });
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let result = null;
  // Tell the engine when we will pull the plug, so it lands gracefully instead of
  // being killed mid-edit with nothing to show. Previously the only signal was the
  // abort itself, and a turn spending minutes on gateway retries had no idea.
  try { result = await engine.send(PROMPT(inst), { abortSignal: ac.signal, deadlineMs: TIMEOUT_MS }); }
  finally {
    clearTimeout(killer);
    writeFileSync(join(trajDir, "messages.json"), JSON.stringify(engine.messages, null, 1));
    writeFileSync(join(trajDir, "events.json"), JSON.stringify(events, null, 1));
    writeFileSync(join(trajDir, "final-text.md"), text);
    writeFileSync(join(trajDir, "meta.json"), JSON.stringify(result || { aborted: true }, null, 1));
  }
}

const jobs = [];
for (const inst of instances) for (const arm of ARMS) if (!done.has(`${arm}:${inst.instance_id}`)) jobs.push({ inst, arm });
if (CONTAINER) jobs.sort((a, b) => envKeyOf(a.inst).localeCompare(envKeyOf(b.inst)) || a.inst.instance_id.localeCompare(b.inst.instance_id));
// Outstanding job count per env group; the last instance out turns off the lights.
const envRemaining = new Map();
const envImages = new Map();
for (const j of jobs) {
  const k = envKeyOf(j.inst);
  envRemaining.set(k, (envRemaining.get(k) || 0) + 1);
  if (!envImages.has(k)) envImages.set(k, new Set());
  envImages.get(k).add(imageFor(j.inst));
}
function releaseEnv(inst) {
  const k = envKeyOf(inst);
  const left = (envRemaining.get(k) || 1) - 1;
  envRemaining.set(k, left);
  if (left > 0) return;
  // Whole group finished: reclaim its ~3.3GB before the next group pulls.
  const imgs = [...(envImages.get(k) || [])];
  if (imgs.length) dockerSync(["rmi", "-f", ...imgs], 300000);
}
console.log(`model=${MODEL} arms=${ARMS.join(",")} jobs: ${jobs.length} (skipped ${instances.length * ARMS.length - jobs.length} already done)`);

let completed = 0, produced = 0;
const total = jobs.length;
async function worker(wid) {
  for (;;) {
    const job = jobs.shift(); if (!job) return;
    const { inst, arm } = job;
    const trajDir = join(TRAJ, `${arm}-${inst.instance_id}`);
    rmSync(trajDir, { recursive: true, force: true }); mkdirSync(trajDir, { recursive: true });
    const t0 = Date.now(); let patch = "", err = "";
    let ws = null;
    try {
      const isCodex = arm !== "agent-core";
      ws = CONTAINER ? prepareContainer(inst, `w${wid}-${arm}`, { forCodex: isCodex }) : cloneFromMirror(inst, `w${wid}-${arm}`);
      if (!isCodex) await runAgentCore(ws.repo, inst, trajDir, ws.container || null);
      else {
        // The prompt file has to be reachable from inside the container; the
        // workspace is the only path both sides agree on.
        // The hook arm carries the stock prompt too: the two codex arms must
        // differ in the hook and nothing else.
        const useStock = arm === "codex-stock" || arm === "codex-hook";
        if (CONTAINER && useStock) writeFileSync(join(ws.repo, ".stock-prompt.md"), readFileSync(STOCK_PROMPT, "utf8"));
        await runCodexAsync(ws.repo, inst, useStock, trajDir, ws.container || null, arm === "codex-hook");
        if (CONTAINER && useStock) rmSync(join(ws.repo, ".stock-prompt.md"), { force: true });
      }
    } catch (e) { err = String(e.message).slice(0, 120); appendFileSync(join(trajDir, "error.txt"), String(e.stack || e) + "\n"); }
    // Read the diff even when the run threw. A mid-turn gateway abort used to
    // discard edits the agent had already made and leak the clone, which scored
    // the instance empty and hid the fact that anything was attempted. The
    // instance is still worth RE-RUNNING (its turn never finished, so no
    // verification pass ran) — this just stops a harness error from being
    // silently indistinguishable from a model that did nothing.
    if (ws) {
      try { patch = shSync(`git diff`, ws.repo).stdout || ""; } catch { /* clone is gone — leave the patch empty */ }
      // Teardown is best-effort from here on. The prediction is already in hand,
      // and a stuck container or an undeletable temp directory must never take
      // down the worker — that turns one bad instance into a lost run.
      try { tearDownContainer(ws); } catch { /* container already gone */ }
      try { rmSync(ws.dir, { recursive: true, force: true }); } catch { /* leftover temp dir; the run matters more */ }
      if (CONTAINER) { try { releaseEnv(inst); } catch { /* image reclaim is an optimisation */ } }
    }
    const secs = (Date.now() - t0) / 1000;
    const nonEmpty = patch.trim().length > 0; if (nonEmpty) produced++;
    completed++;
    writeFileSync(join(trajDir, "patch.diff"), patch);
    writeFileSync(join(trajDir, "timing.json"), JSON.stringify({ seconds: secs }));
    appendFileSync(outFile(arm), JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: `unieai-${arm}-${MODEL}`, model_patch: patch }) + "\n");
    console.log(`${nonEmpty ? "📝" : "∅"} [${completed}/${total}] ${arm.padEnd(11)} ${MODEL.padEnd(24)} ${inst.instance_id.padEnd(34)} ${secs.toFixed(0)}s ${err}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
console.log(`@@@ VERIFIED DONE model=${MODEL} produced=${produced}/${total}`);
