/**
 * engine.mjs — one conversation on the agent-core loop, surface-agnostic.
 *
 * The TUI and the VS Code panel both drive this: they provide callbacks
 * (onText/onReasoning/onToolEvent/requestApproval) and call send() per user
 * turn. History persistence and toolset assembly live here.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildToolset } from "../../third_party/unieai-agent-core/src/toolset.mjs";
import { runAgentLoop, repairHistory } from "../../third_party/unieai-agent-core/src/loop.mjs";
import { buildSystemPrompt } from "../../third_party/unieai-agent-core/src/prompt.mjs";
import { callModelJson } from "../../third_party/unieai-agent-core/src/upstream.mjs";
import { compactWithSummary, ensureLoopBudget } from "../../third_party/unieai-agent-core/src/compaction.mjs";
import { createCompactionArchive } from "./compaction-archive.mjs";
import { coreMemoryWriter, readCoreMemorySync } from "./memory-store.mjs";
import { renderCoreMemoryBlock } from "../../third_party/unieai-agent-core/src/memory-core.mjs";
import { pickSmallModel } from "../../third_party/unieai-agent-core/src/model-picker.mjs";
import { makeVisionCaller, probeVisionModel } from "../../third_party/unieai-agent-core/src/vision.mjs";
import {
  dateSource,
  agentsMdSource,
  resolveSources,
  applyEpoch,
  renderContextUpdate,
} from "../../third_party/unieai-agent-core/src/context-sources.mjs";
import {
  ENTRY_TYPES,
  append,
  createTree,
  currentPath,
  deriveState,
} from "../../third_party/unieai-agent-core/src/session-tree.mjs";
import { buildCodingTools } from "./tools.mjs";
import { loadCredentials, applyUpstreamEnv, sandboxBin } from "./config.mjs";
import { newSessionId, saveSession, snapshotDir } from "./session.mjs";
import { loadSessionTree, saveSessionTree } from "./session-tree-store.mjs";
import {
  appendFold,
  appendMessages,
  deriveEngineContext,
  makeEntryIdFactory,
  messageIndexFor,
} from "./session-tree-context.mjs";
import { initShadow, snapshotWorkspaceAsync, listChangedPaths, previewRestore, restoreToTree } from "./snapshot.mjs";
import { createTurnCoordinator } from "./turn-coordinator.mjs";
import { ruleSignature, loadApprovals } from "./approval-rules.mjs";
import { fingerprintGaps, isRepeatedStall } from "../../third_party/unieai-agent-core/src/gap-fingerprint.mjs";
import { buildNudge } from "./completion-escalation.mjs";
import { buildPlanRequest, parsePlan, reconcilePlan, planNudgeBlock } from "./goal-plan.mjs";
import { changedFilesFromStatus, buildSummaryRequest, clampSummary } from "./goal-summarizer.mjs";

// A caller's deadline is when it will ABORT, so the loop must aim earlier: the
// wrap-up it triggers still costs one model call (and the verifier may want one
// more), and on the degraded gateway that made this necessary those calls are the
// slow ones. Reserve a fifth of the budget, floored at 90s, capped at half — so a
// short turn is not reduced to nothing and a long one is not over-reserved.
export function landingDeadline(abortAtMs) {
  const total = Number(abortAtMs) || 0;
  if (total <= 0) return 0;
  const reserve = Math.min(total / 2, Math.max(90_000, total * 0.2));
  return Math.max(1, Math.round(total - reserve));
}

const CODE_IDENTITY =
  "You are UnieAI Code, a coding agent running in a CLI harness attached to the user's workspace.";

const CODE_TOOL_GUIDANCE = [
  "- bash — run shell commands in the workspace (sandboxed; escalations ask the user). Prefer `rg` for searching.",
  "- read / write / edit — inspect and change files. edit is exact search/replace: oldString must match exactly once; read the file first and copy the exact text.",
  "- Follow the codebase's conventions and never assume a library is available — verify it is already used in the project first.",
  "- Before choosing API names, parameters, or exception types for a change, check how nearby code and tests do it — match the project's existing interface conventions, don't invent your own. Exception: input validation on public APIs must raise a specific exception (ValueError/TypeError), never `assert` — asserts vanish under `python -O` and callers/tests expect a real exception, even if older nearby code still uses assert.",
  "- After fixing an issue, search for sibling code paths that need the same fix (other entry points, overloads, or callers with the same flaw) before finishing.",
  "- Act, don't announce: never end a reply with intent (\"let me…\", \"now I will…\") — if any work remains, emit the corresponding tool call in this same turn. A plain-text reply means you are DONE.",
  "- When the task quotes an exact expected output (error message, repr, generated code/LaTeX, serialized form), run the changed entry point with a tiny script before finishing and compare your actual output against EVERY quoted literal character-for-character — near-miss formatting is a failure.",
  "- After a tool call that changes state (edits, writes, installs), confirm the result before reporting success — never claim an action worked without evidence.",
  "- When a tool call fails, adapt: don't retry the identical call unchanged, and don't paper over the failure.",
  "- ask — put a real decision to the user as fixed options ONLY when the answer is not inferable from the repo or the task and picking wrong would waste real work. Never ask to confirm something you can verify yourself.",
  "- run_tests — run THIS project's tests. It already knows the right invocation for the repo (pytest, Django's runtests.py, unittest, jest, cargo, go), so use it instead of composing a test command through bash; pass the target covering what you changed.",
  "- Verify with the project's own checks (tests/lint/typecheck) when they exist. Never commit unless the user explicitly asks."
];

// Completion contract for action-type turns (grok-build TodoGate + goal-verifier
// pattern, codex stop-hook seam). Two escalating gates, budgeted by the loop's
// ctx.completionCheckMax:
//   1. Mutation gate — claims done but the workspace is untouched → nudge.
//   2. Skeptic gate  — workspace changed; an independent LLM call reviews the
//      task + diff and either accepts (ACHIEVED) or returns concrete gaps,
//      which are injected back so the model addresses them (gap replay).
// Only used when the host declares the turn expects mutation — interactive Q&A
// must never be nudged into editing files.
const MID = (s, max) => (s.length <= max ? s : `${s.slice(0, max / 2)}\n[...truncated...]\n${s.slice(-max / 2)}`);

// New files, rendered so the skeptic can judge them alongside `git diff` (which
// only ever shows tracked edits). Capped hard: a verification prompt is not the
// place to paste a build output or a vendored directory that happens to be
// untracked, and a file's opening lines are enough to say what it is.
export function untrackedDigest(workspace, porcelain) {
  const paths = String(porcelain || "")
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (!paths.length) return "";
  let out = "\n\n## New (untracked) files\n";
  for (const p of paths.slice(0, 5)) {
    let body = "";
    try {
      body = readFileSync(join(workspace, p), "utf8").split("\n").slice(0, 60).join("\n");
    } catch { continue; } // a directory or an unreadable blob — the name still tells the reviewer it exists
    out += `\n### ${p}\n${MID(body, 1500)}\n`;
  }
  if (paths.length > 5) out += `\n(+${paths.length - 5} more untracked paths)\n`;
  return out;
}

// Deterministic pre-gates over the changed files (v0.3.0, from SWE-bench
// failure-mode analysis: most applied-but-failed patches die on errors a single
// execution would have caught). Best-effort: environments without the repo's
// deps must never false-positive, so anything that looks like a missing
// EXTERNAL dependency is treated as "cannot judge" and skipped.
export function deterministicGates(workspace) {
  const changed = spawnSync("git", ["-C", workspace, "diff", "--name-only"], { encoding: "utf8", timeout: 10000 });
  if (changed.status !== 0) return null;
  const pyFiles = String(changed.stdout || "").split("\n").filter((f) => f.endsWith(".py"));
  const problems = [];
  for (const f of pyFiles.slice(0, 10)) {
    // 1. Syntax gate — always valid regardless of deps.
    const syn = spawnSync("python3", ["-m", "py_compile", f], { cwd: workspace, encoding: "utf8", timeout: 15000 });
    if (syn.status !== 0) {
      problems.push(`\`${f}\` fails to compile:\n${MID(String(syn.stderr || ""), 600)}`);
      continue;
    }
    // 2. Import gate — catches circular imports / NameErrors at module level.
    //    A ModuleNotFoundError for something outside the workspace is an
    //    environment gap, not a patch bug → ignore.
    const mod = f.replace(/^src\//, "").replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
    const imp = spawnSync("python3", ["-c", `import ${mod}`], { cwd: workspace, encoding: "utf8", timeout: 20000, env: { ...process.env, PYTHONPATH: `${workspace}/src:${workspace}` } });
    if (imp.status !== 0) {
      const err = String(imp.stderr || "");
      const missing = err.match(/ModuleNotFoundError: No module named '([^']+)'/);
      const missingIsExternal = missing && !pyFiles.some((p) => p.startsWith(missing[1].split(".")[0]));
      if (!missingIsExternal && /Error/.test(err)) {
        problems.push(`\`import ${mod}\` fails:\n${MID(err, 600)}`);
      }
    }
  }
  return problems.length ? problems : null;
}

// Static diff checks (deterministic, dependency-free — pure text analysis of
// the diff + task). Each is a high-precision pattern from observed SWE-bench
// failure modes; all report-style (the model judges applicability).
export function staticDiffChecks(workspace, task) {
  const out = [];
  const d = spawnSync("git", ["-C", workspace, "diff", "-U0"], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (d.status !== 0) return out;
  const files = {};
  let cur = null;
  for (const line of String(d.stdout || "").split("\n")) {
    if (line.startsWith("+++ b/")) { cur = line.slice(6); files[cur] = { removed: [], added: [] }; }
    else if (cur && line.startsWith("-") && !line.startsWith("---")) files[cur].removed.push(line.slice(1));
    else if (cur && line.startsWith("+") && !line.startsWith("+++")) files[cur].added.push(line.slice(1));
  }
  // 1. Test files must not be edited (SWE-bench contract; also generally risky).
  const testFiles = Object.keys(files).filter((f) => /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$/.test(f));
  if (testFiles.length) {
    out.push(`You modified test file(s): ${testFiles.join(", ")} — the task says do NOT edit or add tests. Revert them unless the task explicitly requires it.`);
  }
  // 2. Exception-type contract: task names an exception, change adds bare assert.
  const excs = [...new Set([...String(task).matchAll(/raise[sd]?\s+(?:an?\s+)?`?([A-Z][A-Za-z]*Error)`?/g)].map((m) => m[1]))];
  for (const [f, ch] of Object.entries(files)) {
    if (/test/.test(f) || !f.endsWith(".py")) continue;
    const addsAssert = ch.added.some((l) => /^\s*assert\s/.test(l));
    const addsExc = ch.added.some((l) => excs.some((e) => l.includes(e)));
    if (excs.length && addsAssert && !addsExc) {
      out.push(`The task mentions raising ${excs.join("/")} but your change adds a bare \`assert\` in ${f} — asserts vanish under \`python -O\` and tests check the exception type. Use \`raise ${excs[0]}(...)\`.`);
    }
  }
  // 3. Surviving identical copies of a line you changed (exact match → zero
  //    false positives; the classic missed-sibling signal).
  for (const [f, ch] of Object.entries(files)) {
    let content;
    try { content = readFileSync(join(workspace, f), "utf8").split("\n"); } catch { continue; }
    const seen = new Set();
    for (const r of ch.removed) {
      const t = r.trim();
      if (t.length < 12 || t.startsWith("#") || seen.has(t)) continue;
      seen.add(t);
      const hits = content.map((l, i) => (l.trim() === t ? i + 1 : 0)).filter(Boolean);
      if (hits.length) {
        out.push(`In ${f} you changed \`${t.slice(0, 90)}\` — but an IDENTICAL line still exists at line ${hits.slice(0, 4).join(", ")}. Check whether it needs the same fix (sibling code path).`);
      }
    }
  }
  return out.slice(0, 6);
}

/**
 * The user's actual task. The engine injects synthetic `role:"user"` wrappers
 * (project instructions, context updates, the rolling compaction summary), so
 * "first user message" no longer means "the task" — skip anything wrapped in a
 * synthetic tag. Exported for tests.
 */
export function realUserTask(messages) {
  const SYNTHETIC = /^\s*<(project_instructions|context_update|conversation_summary)>/;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (SYNTHETIC.test(text)) continue;
    return text;
  }
  return "";
}

function workspaceCompletionCheck({ workspace, model, auxModel, callerKey, goalState = {}, onSummary = () => {} }) {
  let skepticRan = false;
  let gatesRan = false;
  // Fire the closing summarizer exactly once, off the hot path: on the ACHIEVED
  // verdict we kick a single small aux-model call and surface its result via
  // onSummary without ever awaiting it, so completion is never blocked. Fail-open
  // — any error just skips the summary (goal-harness §4.2).
  const maybeSummarize = ({ task, files, diff }) => {
    if (goalState.summaryFired) return;
    goalState.summaryFired = true;
    const { system, user } = buildSummaryRequest({ task, files, diff });
    Promise.resolve()
      .then(() =>
        callModelJson({ baseModelSlug: auxModel || model, callerKey, system, user, temperature: 0, maxTokens: 400 })
      )
      .then((raw) => {
        const summary = clampSummary(raw);
        if (summary) onSummary(summary);
      })
      .catch(() => {}); // fail-open: a summary hiccup never affects completion
  };
  return async ({ answerText, messages }) => {
    const st = spawnSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8", timeout: 10000 });
    if (st.status !== 0) return null; // not a git repo / git broken — never block
    if (String(st.stdout || "").trim().length === 0) {
      return (
        "No files in the workspace have been modified. If the task requires changes, " +
        "make them now with the edit/write tools and verify them. If you are certain no " +
        "change is needed, state explicitly why."
      );
    }
    // Deterministic gates first (cheap, no LLM): syntax + import health of the
    // touched Python files. One round of feedback, then don't repeat.
    if (!gatesRan) {
      gatesRan = true;
      try {
        const task = goalState.currentTask || realUserTask(messages);
        const problems = [...(deterministicGates(workspace) || []), ...staticDiffChecks(workspace, task)];
        if (problems.length) {
          return (
            "[verification] Automatic checks on your changes found issues:\n\n- " +
            problems.join("\n- ") +
            "\n\nAddress each one now (fix it, or state precisely why it does not apply), then finish."
          );
        }
      } catch { /* gates are best-effort */ }
    }
    // Skeptic verification: once per turn, only when something was changed.
    if (skepticRan) return null;
    skepticRan = true;
    try {
      const diff = spawnSync("git", ["-C", workspace, "diff"], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      if (diff.status !== 0) return null;
      // `git diff` shows tracked edits only, so a turn whose only output was a new
      // untracked file (a repro script, most often) used to reach here with an empty
      // diff and skip verification entirely — while `git status` above was non-empty,
      // so the mutation gate had already passed it. That pair let "wrote a scratch
      // file, changed nothing" end a turn unchallenged. Show new files to the skeptic.
      const diffText = String(diff.stdout || "") + untrackedDigest(workspace, st.stdout);
      if (!diffText.trim()) return null;
      // Judge against THIS turn's request (set by runTurn), not the session's
      // first user message — after compaction or in a multi-task session the
      // first message is stale or gone, and the skeptic would review the diff
      // against the wrong task.
      const task = goalState.currentTask || realUserTask(messages);
      const verdict = await callModelJson({
        baseModelSlug: model,
        callerKey,
        temperature: 0,
        maxTokens: 600,
        system:
          "You are a skeptical senior reviewer. Judge STRICTLY whether the diff fully addresses the task:\n" +
          "1. LITERALS: if the task quotes an exact expected output/message/format (error string, printed repr, " +
          "serialized form, LaTeX/code output), verify the diff produces that EXACT literal — case, braces, " +
          "quoting, spacing. Near-miss output is a gap.\n" +
          "2. SIBLINGS: other code paths with the same flaw (the next line, the reverse branch, other entry " +
          "points/overloads/callers, init vs update paths) must be fixed too — an identical unfixed pattern " +
          "adjacent to the edit is a gap.\n" +
          "3. EXCEPTIONS: error types callers/tests expect (input validation raises ValueError/TypeError — " +
          "`assert` is a gap; returning the wrong exception type from a deeper layer is a gap).\n" +
          "4. REGRESSIONS: module-level imports that could be circular, API signatures changed under existing " +
          "callers, behavior changes that break the unchanged default path.\n" +
          'Reply with exactly "ACHIEVED" if complete; otherwise list the concrete gaps (max 5 short bullets, each actionable, no preamble).',
        user: `## Task\n${MID(task, 3000)}\n\n## Workspace diff\n${MID(diffText, 6000)}\n\n## Agent's final report\n${MID(String(answerText || ""), 1500)}`
      });
      const text = String(verdict || "").trim();
      if (!text || /^achieved\b/i.test(text.replace(/^[*#\s]+/, ""))) {
        goalState.consecutiveNotAchieved = 0; // achieved → reset the escalation ladder
        // ACHIEVED: kick the one-shot closing summarizer (non-blocking, fail-open).
        maybeSummarize({ task, files: changedFilesFromStatus(st.stdout), diff: diffText });
        return null;
      }
      // NotAchieved: check off any plan steps the diff now covers, so the nudge
      // only surfaces items that are genuinely still open (goal-harness §3).
      reconcilePlan(goalState.plan, `${changedFilesFromStatus(st.stdout).join(" ")}\n${diffText}`);
      // Stall exit (grok-build gap-fingerprint): if this turn's gaps match the
      // previous turn's, re-nudging only spins on the same blocker — accept the
      // turn and let the user/next turn take over instead of looping.
      const fp = fingerprintGaps(text);
      if (isRepeatedStall(goalState.lastGapFingerprint, fp)) {
        goalState.lastGapFingerprint = fp;
        return null;
      }
      goalState.lastGapFingerprint = fp;
      // Strategist escalation (grok-build stop-drift): the gaps DIFFER from last
      // turn but the task keeps failing review — after enough rounds, stop asking
      // for small fixes and tell the model to rethink its whole approach.
      goalState.consecutiveNotAchieved = (goalState.consecutiveNotAchieved || 0) + 1;
      return (
        buildNudge({ consecutiveNotAchieved: goalState.consecutiveNotAchieved, gapText: MID(text, 1500) }) +
        planNudgeBlock(goalState.plan)
      );
    } catch {
      return null; // verifier unavailable — never block completion on infrastructure
    }
  };
}

export function createEngine({
  workspace,
  model,
  resume = null,
  onText = () => {},
  onReasoning = () => {},
  onToolEvent = () => {},
  requestApproval = null,
  requestQuestion = null,
  onSummary = () => {},
  onReview = () => {},
  onPlan = () => {},
  expectsMutation = false,
  // Default wall clock for every turn, when the host has one (0 = none).
  deadlineMs: engineDeadlineMs = 0,
  // How much history the loop may keep before it starts pruning tool outputs.
  // agent-core's own default is 32k — the size of the models it was written
  // against — which on a 60-step coding turn discards what the model just read
  // and makes it re-read the same files. Coding declares the real budget.
  contextTokens: initialContextTokens = Number(process.env.UNIEAI_CONTEXT_TOKENS) || 128_000,
  // Where the model's shell commands run. Null = this machine, inside the local
  // sandbox. A host whose workspace is a checkout whose toolchain lives
  // elsewhere (a prepared container, a devcontainer) passes a backend from
  // exec-backend.mjs; file tools still operate on the local path.
  execBackend = null,
  webAccess = false,
  visionModel = null,
  subagents = false
} = {}) {
  // Goal mode: false = off, "gate" = verification blocks turn completion so
  // the model fixes its own gaps in-turn, "review" = the turn ends immediately
  // and the SAME verifier runs in the background, surfacing findings via
  // onReview for the user to act on. Legacy true means "gate".
  let goalMode = expectsMutation === true ? "gate" : expectsMutation || false;
  const credentials = loadCredentials();
  if (!credentials.signedIn) {
    throw new Error("not signed in — run `unieai login` first");
  }
  applyUpstreamEnv(credentials);

  // The session is a TREE (see session-tree-context.mjs): entries are appended
  // and the messages we send are DERIVED by walking root → leaf, so a fold hides
  // history from the prompt instead of deleting it. `loadSessionTree` reads
  // either store — this session's tree file when it has one, otherwise the
  // legacy `{messages:[...]}` file converted on read — so an old session resumes
  // with exactly the messages the array loader produced.
  const resumed = resume ? loadSessionTree(resume) : null;
  if (resume && !resumed) {
    // The array loader threw ENOENT here. Starting a fresh session instead would
    // silently discard the id the user asked to resume.
    throw new Error(`session ${resume} not found`);
  }
  const sessionId = resumed?.id || newSessionId();
  const resumedMeta = resumed?.meta || {};
  // A migrated legacy file records model/cwd as a leading state_change, and a
  // tree written here does the same, so one lookup answers for both shapes.
  const resumedState = resumed ? deriveState(currentPath(resumed.tree)) : {};
  const activeModel = model || resumedState.model || credentials.models[0]?.id;
  if (!activeModel) {
    throw new Error(`no models available — add models in UnieAI Studio (${credentials.studioUrl}/models)`);
  }

  let sessionTree = resumed?.tree || createTree({ now: Date.now() });
  const nextEntryId = makeEntryIdFactory(sessionTree);
  /** The prompt as it currently derives from the tree, plus the entry per message. */
  const derive = () => deriveEngineContext(sessionTree);
  /** Append messages as one entry each; returns their ids, in order. */
  const record = (list) => {
    const { tree, ids } = appendMessages(sessionTree, list, { nextId: nextEntryId });
    sessionTree = tree;
    return ids;
  };
  /** Record a change of what is answering, as history rather than a variable. */
  const recordState = (patch) => {
    sessionTree = append(sessionTree, { type: ENTRY_TYPES.STATE_CHANGE, patch }, { id: nextEntryId(), now: Date.now() });
  };

  // A cheap model for auxiliary calls (summary/compaction) so they don't burn the
  // main model's budget. Falls back to the active model when the catalog has no
  // smaller option.
  const auxModel = pickSmallModel(credentials.models, { excludeId: activeModel }) || activeModel;

  // Rolling structured summary of folded-away turns (see compaction.mjs). Kept
  // in the engine (stateful) so the summarizer model call happens BETWEEN turns,
  // off the request critical path; restored on resume.
  let rollingSummary = resumedMeta.summary || "";

  // Workspace checkpoints in a shadow git repo (see snapshot.mjs). One per turn,
  // keyed by the ENTRY that was the leaf at snapshot time, so a future revert can
  // restore the workspace to any past turn. An entry id survives compaction; the
  // message index this used to store did not, and had to be renumbered against
  // the geometry of every fold. Hosts still speak in message counts, so the index
  // is DERIVED on read (see describeCheckpoints). Best-effort — a git failure
  // never breaks a turn.
  const shadowGitDir = snapshotDir(sessionId);
  const shadowReady = initShadow(shadowGitDir, workspace);
  // A checkpoint resumed from a legacy file only carries the count, so it is
  // converted once, here, against the migrated tree: index N was taken after N
  // messages, i.e. at the entry that produced the Nth one.
  const resumedEntryIds = resumed ? derive().entryIds : [];
  const checkpoints = (Array.isArray(resumedMeta.checkpoints) ? resumedMeta.checkpoints : [])
    .filter((cp) => cp && typeof cp === "object")
    .map((cp) => {
      if (cp.entryId) return { ...cp };
      const at = Number.isFinite(cp.messageIndex) ? cp.messageIndex - 1 : -1;
      return { ...cp, entryId: at >= 0 ? resumedEntryIds[at] ?? null : null };
    });
  // Snapshots run in the BACKGROUND, serialized on this chain, so a turn's
  // completion never waits on a whole-workspace `git add -A` (the first one on
  // a large repo takes seconds). The warm-up below also pre-hashes the tree at
  // session start, doubling as the session's baseline checkpoint.
  let snapshotChain = Promise.resolve();
  if (shadowReady) {
    snapshotChain = snapshotChain
      .then(() => snapshotWorkspaceAsync(shadowGitDir, workspace))
      .then((tree) => {
        if (tree && checkpoints.length === 0) checkpoints.push({ entryId: sessionTree.leafId, tree, at: Date.now() });
      })
      .catch(() => {});
  }

  // Cross-turn state for the completion verifier (persisted like rollingSummary /
  // contextEpoch): the last turn's gap fingerprint (so repeated identical gaps
  // stop the re-nudge loop), the escalation counter, the lightweight task plan
  // (goal-harness §3), and one-shot latches for plan derivation + summarizer.
  const goalState = { lastGapFingerprint: "", plan: resumedMeta.plan || null, planAttempted: Boolean(resumedMeta.plan) };

  // Serialize turns for this conversation so a double-send never interleaves
  // (see turn-coordinator.mjs). Two turns would derive from the same leaf and
  // then both append their own, forking the session behind the user's back.
  const turnCoordinator = createTurnCoordinator();

  // Steer: mid-turn interjections the running turn folds in (the loop drains
  // this between steps via ctx.drainSteer). steer() enqueues; if no turn is
  // running it is delivered on the next send().
  const steerQueue = [];
  const drainSteer = () => steerQueue.shift() || null;

  // Remember bash approvals so the same command shape isn't re-asked. A session
  // set (populated by "allow for this conversation") plus the durable per-project
  // store give auto-approval; the host approval prompt is only shown on a miss.
  const projectApprovals = loadApprovals(workspace);
  const sessionApprovals = new Set();
  const requestApprovalWrapped = requestApproval
    ? async (d) => {
        const sig = d?.tool === "bash" ? ruleSignature(d.detail) : "";
        if (sig && (sessionApprovals.has(sig) || projectApprovals.has(sig))) return "accept";
        const decision = await requestApproval(d);
        if (sig && decision === "acceptForSession") sessionApprovals.add(sig);
        return decision;
      }
    : null;

  // Versioned context sources (see context-sources.mjs): the date (previously
  // never injected) and project AGENTS.md, resolved to a baseline that seeds the
  // prompt and re-emitted as a small delta when they change between turns.
  const contextSources = [
    dateSource(),
    agentsMdSource(workspace, {
      readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
      isProjectRoot: (dir) => existsSync(join(dir, ".git")),
      homeConfigPath: join(homedir(), ".config", "AGENTS.md"),
    }),
  ];
  // Seed against the saved epoch so a change made while a resumed session was
  // away surfaces as a delta on the next turn.
  const seed = applyEpoch(resumedMeta.contextEpoch || {}, resolveSources(contextSources));
  let contextEpoch = seed.epoch;
  const dateNow = (contextEpoch.date || "").replace(/^Current date:\s*/, "");
  const agentsMdText = contextEpoch["agents-md"] || "";

  // Memory is scoped to the PROJECT, not the model. agent-core names the key
  // `customModelId` after Studio's concept, but for a coding agent the thing
  // worth remembering is what is true about this repo — carrying it between
  // unrelated checkouts would leak one project's conventions into another.
  const memoryScope = `ws-${workspace}`;
  const coreMemoryBlock = renderCoreMemoryBlock(readCoreMemorySync(memoryScope), { toolEnabled: true });

  // A new session's opening messages become the tree's first entries; a resumed
  // one already carries them on its path.
  if (!resumed) {
    recordState({ model: activeModel, cwd: workspace });
    record([
      {
        role: "system",
        content: buildSystemPrompt({
          // Enabling memory here is what mounts the tool; without it buildToolset
          // skips memory entirely and writes silently go nowhere.
          runtimeContext: { knowledgeBases: [], workspace: { memory: { enabled: true } } },
          // Rendered once, at session start: agent-core's frozen-snapshot rule
          // keeps mid-turn writes out of the live prompt so the prefix cache holds.
          coreMemoryBlock,
          capabilities: { memory: true },
          identity: CODE_IDENTITY,
          runtime: "UnieAI Code (agent-core loop, sandboxed shell tools)",
          now: dateNow,
          extraToolGuidance: webAccess
            ? [...CODE_TOOL_GUIDANCE, "- fetch — read a web page or HTTP API by URL (returns readable text). Use it to consult docs or fetch data the task references; prefer it over shelling out to curl."]
            : CODE_TOOL_GUIDANCE
        })
      },
      // AGENTS.md rides as a user message (not the system prompt) so compaction
      // keeps it verbatim, matching how project instructions are meant to persist.
      ...(agentsMdText
        ? [{ role: "user", content: `<project_instructions>\n${agentsMdText}\n</project_instructions>` }]
        : [])
    ]);
  } else {
    // Resuming under a different model (or from another checkout) is a change of
    // what is answering, which the tree records rather than overwrites.
    if (resumedState.model !== activeModel || resumedState.cwd !== workspace) {
      recordState({ model: activeModel, cwd: workspace });
    }
    // If a source changed while the session was away, inject that change up
    // front so this turn sees it.
    const awayUpdate = renderContextUpdate(seed.deltas);
    if (awayUpdate) record([{ role: "user", content: awayUpdate }]);
  }

  /**
   * Write the session to BOTH stores.
   *
   * The tree is the engine's own state, but the session picker and the VS Code
   * panel read the legacy `{messages:[...]}` file directly, so it keeps being
   * written — from the DERIVED messages, which are what the array engine would
   * have held. The tree goes first: it is what a resume reads, and a legacy file
   * newer than the tree beside it would mean a resume silently losing the last
   * turn.
   */
  function persist() {
    const meta = { summary: rollingSummary, contextEpoch, checkpoints, plan: goalState.plan };
    saveSessionTree({ id: sessionId, tree: sessionTree, meta });
    saveSession({
      id: sessionId,
      messages: derive().messages,
      model: activeModel,
      cwd: workspace,
      summary: rollingSummary,
      contextEpoch,
      checkpoints,
      plan: goalState.plan,
    });
  }

  const emitter = {
    writeContent: (d) => onText(d),
    writeReasoning: (d) => onReasoning(d),
    writeMetadata: () => {},
    emitToolEvent: (e) => onToolEvent(e)
  };

  // Mutable so the web-access toggle can flip mid-session: changing it drops the
  // cached toolset (rebuilt next turn with/without fetch) without discarding the
  // engine — messages and session survive. Rebuilding the whole engine would
  // start a fresh conversation, which is the wrong behaviour for a toggle.
  let webAccessState = webAccess;
  let contextTokensState = Math.max(8_000, Number(initialContextTokens) || 128_000);
  let visionModelState = visionModel;
  let subagentsState = subagents;
  let toolsetPromise = null;
  function toolset(ctx) {
    toolsetPromise ||= buildToolset({
      // `agent.subagent` gates agent-core's `task` tool: with it on the model
      // can delegate exploration-heavy work to a sub-loop that reports back
      // only a conclusion, keeping the transcript out of this context.
      runtimeContext: { workspace: { agent: { subagent: subagentsState }, memory: { enabled: true } } },
      // Storage is injected explicitly rather than through
      // configureCoreMemoryStorage(): that is module-level state whose effect
      // depends on import order, and the fallback it would otherwise reach for
      // resolves against a path this package does not own.
      //
      // `customModelId` is agent-core's name for the memory scope key; here it
      // is the project, so what is learned about one repo stays with it.
      memoryWrite: coreMemoryWriter(),
      // Mounts the `thread` tool. An accessor rather than the tree itself: the
      // toolset is built once and the tree is replaced on every append, so a
      // captured value would go stale after the first turn and the model would
      // branch off a session that had moved on.
      sessionTree: { get: () => sessionTree, set: (next) => { sessionTree = next; } },
      ctx: { ...ctx, customModelId: memoryScope },
      domainToolBuilders: [buildCodingTools({
        workspace,
        sandboxBin: sandboxBin(),
        execBackend,
        webAccess: webAccessState,
        // Vision is DELEGATED: read_media_file hands the image to this model and
        // returns its prose, so the main model never needs image support.
        visionModel: visionModelState,
        callModelJson,
        visionOptions: { callerKey: credentials.gatewayApiKey },
      })]
    });
    return toolsetPromise;
  }

  return {
    sessionId,
    model: activeModel,
    models: credentials.models,

    /**
     * The messages this session would send right now.
     *
     * Derived, not stored: it is a fresh array off the tree on every read, so a
     * caller reading it holds a snapshot rather than the engine's live state.
     */
    get messages() {
      return derive().messages;
    },

    /** The session tree itself — history, folds and branches. Read-only. */
    get sessionTree() {
      return sessionTree;
    },

    get webAccess() {
      return webAccessState;
    },

    /** Workspace checkpoints (leaf entry → shadow-git tree) for revert. */
    get checkpoints() {
      return checkpoints.slice();
    },

    /**
     * Describe the session's rewind points for a picker UI (grok views/rewind
     * idea, read-only): each checkpoint with its timestamp and the files that
     * changed SINCE the previous checkpoint. Never applies anything.
     */
    describeCheckpoints() {
      const out = [];
      for (let i = 0; i < checkpoints.length; i++) {
        const cp = checkpoints[i];
        const prev = i > 0 ? checkpoints[i - 1] : null;
        const files = prev && shadowReady ? listChangedPaths(shadowGitDir, workspace, prev.tree, cp.tree) : [];
        out.push({
          index: i,
          at: cp.at || null,
          // Derived from the checkpoint's entry, because a fold moves where that
          // entry sits in the prompt — and hosts still speak in message counts.
          messageIndex: messageIndexFor(sessionTree, cp.entryId, { fallback: cp.messageIndex ?? 0 }),
          entryId: cp.entryId ?? null,
          files,
        });
      }
      return out;
    },

    /**
     * Preview a rewind to checkpoint `index`: the files that would change,
     * WITHOUT touching anything. Serialized on the snapshot chain so it never
     * races the background checkpointer for the shadow index.
     */
    previewRewind(index) {
      const cp = checkpoints[index];
      if (!cp || !shadowReady) return Promise.resolve(null);
      const run = snapshotChain.then(() => {
        const p = previewRestore(shadowGitDir, workspace, cp.tree);
        return p ? { index, files: p.files } : null;
      });
      snapshotChain = run.catch(() => {});
      return run;
    },

    /**
     * Apply a rewind to checkpoint `index` after the user confirmed the
     * preview. The current state is snapshotted first and pushed as a new
     * checkpoint (the undo point), so a rewind is itself rewindable. Refused
     * while a turn is running — files are never changed under a live turn.
     */
    applyRewind(index) {
      const cp = checkpoints[index];
      if (!cp || !shadowReady) return Promise.resolve(null);
      if (turnCoordinator.isBusy(sessionId)) return Promise.resolve(null);
      const run = snapshotChain.then(() => {
        const r = restoreToTree(shadowGitDir, workspace, cp.tree);
        if (!r) return null;
        if (checkpoints[checkpoints.length - 1]?.tree !== r.undoTree) {
          checkpoints.push({ entryId: sessionTree.leafId, tree: r.undoTree, at: Date.now() });
        }
        persist();
        return { index, restored: r.restored, deleted: r.deleted };
      });
      snapshotChain = run.catch(() => {});
      return run;
    },

    /** Flip the fetch tool on/off for subsequent turns, keeping the session. */
    /**
     * How much history to keep before pruning tool outputs. Unlike the toolset
     * settings this needs no retooling — the loop reads it fresh each turn — so
     * a change takes effect on the very next turn. Floored: below ~8k the model
     * cannot hold even one file, and the pruning would thrash.
     */
    get contextTokens() { return contextTokensState; },
    setContextTokens(value) {
      contextTokensState = Math.max(8_000, Number(value) || 128_000);
      return contextTokensState;
    },
    setWebAccess(value) {
      const next = Boolean(value);
      if (next !== webAccessState) {
        webAccessState = next;
        toolsetPromise = null;
      }
    },

    get subagents() {
      return subagentsState;
    },

    /** Flip the `task` delegation tool on/off for subsequent turns. */
    setSubagents(value) {
      const next = Boolean(value);
      if (next !== subagentsState) {
        subagentsState = next;
        toolsetPromise = null;
      }
    },

    get visionModel() {
      return visionModelState;
    },

    /**
     * Point read_media_file at a different vision model, keeping the session.
     *
     * Like setWebAccess, this drops the memoized toolset so the next turn is
     * built with the new model — leaving it cached would silently keep using
     * the old one for the rest of the conversation.
     */
    setVisionModel(value) {
      const next = value ? String(value) : null;
      if (next !== visionModelState) {
        visionModelState = next;
        toolsetPromise = null;
      }
    },

    /**
     * Check that `model` can genuinely see an image, using this session's
     * credentials. Returns the structured probe outcome (ok / refused / wrong /
     * error) so a UI can explain a failure instead of just refusing the pick.
     */
    probeVision(model) {
      return probeVisionModel({
        model,
        callModel: makeVisionCaller(callModelJson, { callerKey: credentials.gatewayApiKey }),
      });
    },

    /**
     * Set goal mode (the completion contract) for subsequent turns, keeping
     * the session. false = off; "review" = verify in the BACKGROUND after the
     * turn ends (zero latency, findings via onReview); "gate" (or legacy true)
     * = verification blocks completion so the model fixes gaps in-turn. Off by
     * default — a deliberate opt-in for "action" turns.
     */
    setGoalMode(value) {
      goalMode = value === true ? "gate" : value === "gate" || value === "review" ? value : false;
    },

    /** Current goal mode: false | "review" | "gate". */
    get goalMode() {
      return goalMode;
    },

    /** Run one user turn; resolves when the turn ends. */
    send(text, { abortSignal = null, deadlineMs = 0 } = {}) {
      // Turns run one at a time per conversation; a send while another is in
      // flight waits its turn rather than interleaving.
      return turnCoordinator.run(sessionId, () => runTurn(text, { abortSignal, deadlineMs }));
    },

    isBusy() {
      return turnCoordinator.isBusy(sessionId);
    },

    /**
     * Fold a mid-turn interjection into the running turn (drained by the loop
     * between steps). Returns whether a turn was in flight to receive it; when
     * none is, the text is NOT queued — the caller shows it as undelivered and
     * the user resends, so silently injecting the original into the next turn
     * too would deliver the instruction twice.
     */
    steer(text) {
      const t = String(text ?? "").trim();
      if (!t) return false;
      const busy = turnCoordinator.isBusy(sessionId);
      if (busy) steerQueue.push(t);
      return busy;
    }
  };

  async function runTurn(text, { abortSignal = null, deadlineMs = 0 } = {}) {
      // This turn's prompt, derived fresh from the tree, with `ids` parallel to
      // it so the fold at the end can name entries instead of indices.
      const { messages, entryIds } = derive();
      const idOf = new Map(messages.map((m, i) => [m, entryIds[i]]));
      // Repair BEFORE measuring the turn's boundary. The loop repairs on entry
      // too, and if it were the first to drop an unpaired tool message every
      // index here would shift under us; running it now makes the loop's own
      // pass a no-op (it is idempotent). A message the repair SYNTHESIZED
      // belongs to no entry, hence the null.
      repairHistory(messages);
      const ids = messages.map((m) => idOf.get(m) ?? null);
      // The tree keeps every tool result in full, so a derived prompt starts the
      // turn unpruned. The array engine persisted its pruning and so never
      // re-sent what it had dropped; pruning here sends the same first request it
      // would have, while the originals stay in the tree.
      ensureLoopBudget(messages);
      // Everything appended past this point belongs to this turn and becomes
      // entries when it ends. The boundary holds because the loop only appends
      // and pruning replaces message slots without changing the array's length.
      // It also tells us afterwards whether this turn used any file-mutating tool
      // (and thus whether the costly workspace snapshot below is worth taking).
      const turnStart = messages.length;
      // Re-resolve context sources; if the date rolled over or AGENTS.md changed
      // since last turn, inject a compact delta (not the whole prompt) before the
      // user's message so this turn sees the current state.
      try {
        const { epoch, deltas } = applyEpoch(contextEpoch, resolveSources(contextSources));
        contextEpoch = epoch;
        const update = renderContextUpdate(deltas);
        if (update) messages.push({ role: "user", content: update });
      } catch {
        // context refresh is best-effort — never block a turn on it
      }
      messages.push({ role: "user", content: text });
      // The task the verifier/planner should judge against — this turn's
      // request, immune to compaction folding away the first user message.
      goalState.currentTask = text;
      // Lightweight planner (goal-harness §3): once per mutation session, derive a
      // small task checklist from the task with ONE small aux-model call. Kicked
      // fire-and-forget (never awaited) so it stays off the turn's critical path;
      // the verifier references whatever is ready via planNudgeBlock. fail-closed
      // on a malformed plan = leave goalState.plan null and simply skip planning.
      if (goalMode && !goalState.planAttempted) {
        goalState.planAttempted = true;
        const { system, user } = buildPlanRequest(text || realUserTask(messages));
        Promise.resolve()
          .then(() =>
            callModelJson({ baseModelSlug: auxModel, callerKey: credentials.gatewayApiKey, system, user, temperature: 0, maxTokens: 400 })
          )
          .then((raw) => {
            const p = parsePlan(raw);
            if (p) {
              goalState.plan = p;
              onPlan(p); // surface the checklist to the host UI (advisory)
            }
          })
          .catch(() => {}); // fail-open: no plan → verifier omits the plan block
      }
      // One verifier per turn, shared by both goal modes: in "gate" mode the
      // loop consults it before ending (gaps feed BACK into the same turn); in
      // "review" mode it runs AFTER the turn in the background and its
      // findings surface via onReview instead.
      const completionCheck = goalMode
        ? workspaceCompletionCheck({ workspace, model: activeModel, auxModel, callerKey: credentials.gatewayApiKey, goalState, onSummary })
        : null;
      const ctx = {
        baseModelSlug: activeModel,
        callerKey: credentials.gatewayApiKey,
        requestId: `${sessionId}-${messages.length}`,
        // Coding needs a longer leash than the Studio default: real-repo work is
        // exploration-heavy (many bash steps before the first edit). Both codex-rs
        // and grok-build run their primary loops UNCAPPED and rely on quality
        // gates instead; we keep a high backstop cap (runaway insurance) and let
        // the completion contract + doom guards govern. Simple tasks still end
        // early — this is a cap, not a target.
        maxSteps: 128,
        contextTokens: contextTokensState,
        // Consecutive bash calls are normal coding exploration, not flailing;
        // raise the layer-2 doom thresholds (failures still count double vs
        // novel successful calls — see loop.mjs progress-aware weights).
        doomStreakWarn: 10,
        doomStreakForce: 14,
        completionCheck: goalMode === "gate" ? completionCheck : null,
        completionCheckMax: 5, // mutation + deterministic + announce gates, plus skeptic gap-replay rounds
        // A coding turn is long and expensive: an hour of tool work is not worth
        // discarding because the gateway dropped one stream. Re-streaming may
        // repeat a fragment on screen; the history only ever keeps one attempt.
        retryOnPartialStream: true,
        // A caller that will kill this turn at a wall clock (a benchmark harness,
        // a CI job, a user's patience) must say so. Without it the loop cannot
        // budget against the deadline: it keeps retrying a degraded gateway until
        // it is SIGKILLed mid-edit and the work is lost. With it, `deadlineHit()`
        // triggers the normal wrap-up, retries stop short of the cliff, and the
        // turn lands with whatever it achieved. 0 = no deadline (interactive use).
        deadlineMs: landingDeadline(Number(deadlineMs) || Number(engineDeadlineMs) || 0),
        abortSignal,
        requestApproval: requestApprovalWrapped,
        requestQuestion,
        drainSteer
      };
      let result;
      try {
        result = await runAgentLoop({ messages, toolset: await toolset(ctx), emitter, ctx });
      } finally {
        // Fold the turn into the tree even when it threw: an aborted turn's
        // messages stayed in the array engine's history and the next turn saw
        // them, so dropping them here would change what an abort means.
        const produced = messages.slice(turnStart);
        if (produced.length) ids.push(...record(produced));
      }
      // The leaf as of this turn's last message — the point a checkpoint taken
      // now refers to, chosen before any compaction entry lands on top of it.
      const turnLeafId = sessionTree.leafId;

      // "review" goal mode: run the SAME verifier in the background AFTER the
      // turn ends — zero added latency; findings surface via onReview and the
      // user decides whether to continue. Snapshot messages now so the check
      // judges this turn, not whatever a later turn mutated the array into.
      if (goalMode === "review" && completionCheck) {
        const messagesAtEnd = messages.slice();
        const answerText = String(result?.text ?? "");
        Promise.resolve()
          .then(() => completionCheck({ answerText, messages: messagesAtEnd, nudges: 0 }))
          .then((finding) => { if (finding) onReview(String(finding)); })
          .catch(() => {}); // review is advisory — never let it break anything
      }

      // Did this turn run a file-mutating tool? (Drives the workspace snapshot
      // below.) Only this turn's messages are examined, hence turnStart.
      const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "bash"]);
      let touchedWorkspace = false;
      for (let i = turnStart; i < messages.length && !touchedWorkspace; i++) {
        const m = messages[i];
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
          touchedWorkspace = m.tool_calls.some((tc) => MUTATING_TOOLS.has(tc.function?.name));
        }
      }

      // Between-turns semantic compaction (off critical path, fail-open). When
      // the history grows past budget, fold the older turns into one rolling
      // structured summary instead of letting the per-request mechanical path
      // truncate them. A no-op below budget. Never blocks the turn's result.
      //
      // In the tree this is an ENTRY, not a replacement: it says "from here, use
      // this summary", and the turns it replaced stay on the path where recovery
      // and the archive can still reach them.
      try {
        const folded = await compactWithSummary({
          messages,
          prevSummary: rollingSummary,
          ctx: { requestId: `${sessionId}-summary` },
          // Keep the folded originals. What the summary omits is otherwise
          // unrecoverable, and this is the only point where the originals and
          // their replacement exist together.
          archive: createCompactionArchive({ sessionId }),
          summarize: ({ system, user }) =>
            callModelJson({
              baseModelSlug: auxModel,
              callerKey: credentials.gatewayApiKey,
              system,
              user,
              maxTokens: 1500,
            }),
        });
        // `ids` is parallel to `messages`, which is what turns the fold's
        // geometry (indices into the array it was given) back into the entry the
        // summary should keep from. Nothing is spliced and no checkpoint needs
        // renumbering: they name entries, and the entries have not moved.
        const fold = appendFold(sessionTree, { folded, entryIds: ids, nextId: nextEntryId });
        if (fold.applied) {
          sessionTree = fold.tree;
          rollingSummary = folded.summary;
        }
      } catch {
        // fail-open: a summarization hiccup must never drop the turn's result;
        // the mechanical PRUNE→TRIM path still bounds the next request.
      }

      // Checkpoint the workspace after the turn's edits settle (best-effort),
      // in the BACKGROUND: the turn's result returns immediately and the
      // checkpoint lands on the serialized chain when git finishes — it
      // persists with the next saveSession (best-effort by design). Only turns
      // that ran a file-mutating tool snapshot at all; a pure Q&A or read-only
      // turn cannot have changed files.
      if (shadowReady && touchedWorkspace) {
        snapshotChain = snapshotChain
          .then(() => snapshotWorkspaceAsync(shadowGitDir, workspace))
          .then((tree) => {
            if (tree && checkpoints[checkpoints.length - 1]?.tree !== tree) {
              checkpoints.push({ entryId: turnLeafId, tree, at: Date.now() });
            }
          })
          .catch(() => {});
      }

      persist();
      return result;
  }
}
