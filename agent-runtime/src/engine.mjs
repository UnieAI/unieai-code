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
import { runAgentLoop } from "../../third_party/unieai-agent-core/src/loop.mjs";
import { buildSystemPrompt } from "../../third_party/unieai-agent-core/src/prompt.mjs";
import { callModelJson } from "../../third_party/unieai-agent-core/src/upstream.mjs";
import { compactWithSummary } from "../../third_party/unieai-agent-core/src/compaction.mjs";
import { pickSmallModel } from "../../third_party/unieai-agent-core/src/model-picker.mjs";
import {
  dateSource,
  agentsMdSource,
  resolveSources,
  applyEpoch,
  renderContextUpdate,
} from "../../third_party/unieai-agent-core/src/context-sources.mjs";
import { buildCodingTools } from "./tools.mjs";
import { loadCredentials, applyUpstreamEnv, sandboxBin } from "./config.mjs";
import { newSessionId, saveSession, loadSession, snapshotDir } from "./session.mjs";
import { initShadow, snapshotWorkspace } from "./snapshot.mjs";
import { createTurnCoordinator } from "./turn-coordinator.mjs";
import { fingerprintGaps, isRepeatedStall } from "../../third_party/unieai-agent-core/src/gap-fingerprint.mjs";

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

function workspaceCompletionCheck({ workspace, model, callerKey, goalState = {} }) {
  let skepticRan = false;
  let gatesRan = false;
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
        const task = realUserTask(messages);
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
      if (diff.status !== 0 || !String(diff.stdout || "").trim()) return null;
      const task = realUserTask(messages);
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
        user: `## Task\n${MID(task, 3000)}\n\n## Workspace diff\n${MID(diff.stdout, 6000)}\n\n## Agent's final report\n${MID(String(answerText || ""), 1500)}`
      });
      const text = String(verdict || "").trim();
      if (!text || /^achieved\b/i.test(text.replace(/^[*#\s]+/, ""))) return null;
      // Stall exit (grok-build gap-fingerprint): if this turn's gaps match the
      // previous turn's, re-nudging only spins on the same blocker — accept the
      // turn and let the user/next turn take over instead of looping.
      const fp = fingerprintGaps(text);
      if (isRepeatedStall(goalState.lastGapFingerprint, fp)) {
        goalState.lastGapFingerprint = fp;
        return null;
      }
      goalState.lastGapFingerprint = fp;
      return (
        "[verification] A skeptical review of your diff found gaps:\n" +
        MID(text, 1500) +
        "\nAddress each gap now by editing the code (or state precisely why a gap does not apply), then finish."
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
  expectsMutation = false,
  webAccess = false
} = {}) {
  const credentials = loadCredentials();
  if (!credentials.signedIn) {
    throw new Error("not signed in — run `unieai login` first");
  }
  applyUpstreamEnv(credentials);

  const resumed = resume ? loadSession(resume) : null;
  const sessionId = resumed?.id || newSessionId();
  const activeModel = model || resumed?.model || credentials.models[0]?.id;
  if (!activeModel) {
    throw new Error(`no models available — add models in UnieAI Studio (${credentials.studioUrl}/models)`);
  }

  // A cheap model for auxiliary calls (summary/compaction) so they don't burn the
  // main model's budget. Falls back to the active model when the catalog has no
  // smaller option.
  const auxModel = pickSmallModel(credentials.models, { excludeId: activeModel }) || activeModel;

  // Rolling structured summary of folded-away turns (see compaction.mjs). Kept
  // in the engine (stateful) so the summarizer model call happens BETWEEN turns,
  // off the request critical path; restored on resume.
  let rollingSummary = resumed?.summary || "";

  // Workspace checkpoints in a shadow git repo (see snapshot.mjs). One per turn,
  // keyed by the message index at snapshot time, so a future revert can restore
  // the workspace to any past turn. Best-effort — a git failure never breaks a
  // turn. The destructive apply is not implemented here (see session-checkpoint-
  // revert / tui-rewind-diff); this just accumulates the checkpoints.
  const shadowGitDir = snapshotDir(sessionId);
  const shadowReady = initShadow(shadowGitDir, workspace);
  const checkpoints = Array.isArray(resumed?.checkpoints) ? resumed.checkpoints.slice() : [];

  // Cross-turn state for the completion verifier: the last turn's gap fingerprint,
  // so repeated identical gaps stop the re-nudge loop instead of spinning.
  const goalState = { lastGapFingerprint: "" };

  // Serialize turns for this conversation so a double-send never interleaves and
  // corrupts the shared `messages` array (see turn-coordinator.mjs).
  const turnCoordinator = createTurnCoordinator();

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
  const seed = applyEpoch(resumed?.contextEpoch || {}, resolveSources(contextSources));
  let contextEpoch = seed.epoch;
  const dateNow = (contextEpoch.date || "").replace(/^Current date:\s*/, "");
  const agentsMdText = contextEpoch["agents-md"] || "";

  const messages = resumed?.messages || [
    {
      role: "system",
      content: buildSystemPrompt({
        runtimeContext: { knowledgeBases: [], workspace: {} },
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
  ];

  // A resumed session already carries its baseline; if a source changed while it
  // was away, inject that change up front so this turn sees it.
  if (resumed?.messages) {
    const awayUpdate = renderContextUpdate(seed.deltas);
    if (awayUpdate) messages.push({ role: "user", content: awayUpdate });
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
  let toolsetPromise = null;
  function toolset(ctx) {
    toolsetPromise ||= buildToolset({
      runtimeContext: { workspace: {} },
      ctx,
      domainToolBuilders: [buildCodingTools({ workspace, sandboxBin: sandboxBin(), webAccess: webAccessState })]
    });
    return toolsetPromise;
  }

  return {
    sessionId,
    model: activeModel,
    models: credentials.models,
    messages,

    get webAccess() {
      return webAccessState;
    },

    /** Workspace checkpoints (message index → shadow-git tree) for revert. */
    get checkpoints() {
      return checkpoints.slice();
    },

    /** Flip the fetch tool on/off for subsequent turns, keeping the session. */
    setWebAccess(value) {
      const next = Boolean(value);
      if (next !== webAccessState) {
        webAccessState = next;
        toolsetPromise = null;
      }
    },

    /** Run one user turn; resolves when the turn ends. */
    send(text, { abortSignal = null } = {}) {
      // Turns run one at a time per conversation; a send while another is in
      // flight waits its turn rather than interleaving.
      return turnCoordinator.run(sessionId, () => runTurn(text, { abortSignal }));
    },

    isBusy() {
      return turnCoordinator.isBusy(sessionId);
    }
  };

  async function runTurn(text, { abortSignal = null } = {}) {
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
        maxSteps: 96,
        // Consecutive bash calls are normal coding exploration, not flailing;
        // raise the layer-2 doom thresholds (failures still count double vs
        // novel successful calls — see loop.mjs progress-aware weights).
        doomStreakWarn: 10,
        doomStreakForce: 14,
        completionCheck: expectsMutation
          ? workspaceCompletionCheck({ workspace, model: activeModel, callerKey: credentials.gatewayApiKey, goalState })
          : null,
        completionCheckMax: 3, // mutation gate + deterministic gates + one skeptic gap-replay round
        abortSignal,
        requestApproval,
        requestQuestion
      };
      const result = await runAgentLoop({ messages, toolset: await toolset(ctx), emitter, ctx });

      // Between-turns semantic compaction (off critical path, fail-open). When
      // the history grows past budget, fold the older turns into one rolling
      // structured summary instead of letting the per-request mechanical path
      // truncate them. A no-op below budget. Never blocks the turn's result.
      try {
        const folded = await compactWithSummary({
          messages,
          prevSummary: rollingSummary,
          ctx: { requestId: `${sessionId}-summary` },
          summarize: ({ system, user }) =>
            callModelJson({
              baseModelSlug: auxModel,
              callerKey: credentials.gatewayApiKey,
              system,
              user,
              maxTokens: 1500,
            }),
        });
        if (folded.changed) {
          messages.splice(0, messages.length, ...folded.messages);
          rollingSummary = folded.summary;
          // The splice renumbered history: [systemCount, systemCount+foldedCount)
          // became one summary message. Remap checkpoint boundaries (message
          // counts) so revert planning still lines up with the live array —
          // checkpoints inside the folded span clamp to just after the summary.
          const { systemCount, foldedCount } = folded;
          for (const cp of checkpoints) {
            if (cp.messageIndex >= systemCount + foldedCount) cp.messageIndex += 1 - foldedCount;
            else if (cp.messageIndex > systemCount) cp.messageIndex = systemCount + 1;
          }
        }
      } catch {
        // fail-open: a summarization hiccup must never drop the turn's result;
        // the mechanical PRUNE→TRIM path still bounds the next request.
      }

      // Checkpoint the workspace after the turn's edits settle (best-effort).
      if (shadowReady) {
        const tree = snapshotWorkspace(shadowGitDir, workspace);
        if (tree && checkpoints[checkpoints.length - 1]?.tree !== tree) {
          checkpoints.push({ messageIndex: messages.length, tree });
        }
      }

      saveSession({
        id: sessionId,
        messages,
        model: activeModel,
        cwd: workspace,
        summary: rollingSummary,
        contextEpoch,
        checkpoints,
      });
      return result;
  }
}
