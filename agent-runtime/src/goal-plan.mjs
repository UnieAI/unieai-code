/**
 * goal-plan.mjs — a lightweight, in-session task checklist for a mutation turn
 * (goal-harness §3, translated from grok-build's goal_planner / goal_next_step
 * IDEAS, NOT its subagent machinery). The heavy version spawns a fail-closed
 * planner subagent that writes a structured plan.md contract; here we keep a few
 * bullet steps in the engine session and let the completion verifier reference
 * the still-open ones in its nudge ("plan item still open: …").
 *
 * fail-CLOSED here means: a malformed / empty plan yields `null` so the engine
 * simply SKIPS planning — it never breaks the turn. Pure and dependency-free;
 * the one small model call that fills a plan lives in engine.mjs.
 */

// Words too generic to signal that a step is done (used by reconcilePlan).
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "add", "fix", "make", "use", "then", "when", "each", "all", "any", "not",
  "code", "file", "files", "test", "tests", "case", "cases", "handle",
]);

/** Significant lowercase tokens (>=4 chars, not a stopword) of a string. */
function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** Strip a leading markdown bullet / numbered marker; returns the rest or null. */
function stripMarker(line) {
  const t = line.trim();
  const m = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
  return m ? m[1] : null;
}

/**
 * Parse a plan from the aux model's output. Accepts, in order:
 *   1. a JSON array of short strings (the format buildPlanRequest asks for),
 *      optionally wrapped in ```json fences or under { steps|plan|checklist }.
 *   2. markdown checklist / bullet lines (`- [ ]`, `- [x]`, `- `, `1.`).
 * `[x]` / `[X]` mark a step already done. Empty labels are dropped.
 *
 * @returns {{steps: {text:string, done:boolean}[]}|null} null when nothing
 *   parseable is found (fail-closed → caller skips planning).
 */
export function parsePlan(raw, { maxSteps = 8, maxLen = 200 } = {}) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let steps = fromJson(text);
  if (!steps) steps = fromMarkdown(text);
  steps = (steps || [])
    .map((s) => ({ text: String(s.text || "").trim().slice(0, maxLen), done: Boolean(s.done) }))
    .filter((s) => s.text.length > 0)
    .slice(0, maxSteps);
  return steps.length ? { steps } : null;
}

function fromJson(text) {
  const body = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let val;
  try { val = JSON.parse(body); } catch { return null; }
  const arr = Array.isArray(val)
    ? val
    : Array.isArray(val?.steps) ? val.steps
    : Array.isArray(val?.plan) ? val.plan
    : Array.isArray(val?.checklist) ? val.checklist
    : null;
  if (!arr) return null;
  return arr.map((item) => {
    if (typeof item === "string") return { text: item, done: false };
    return { text: item?.text ?? item?.step ?? "", done: Boolean(item?.done ?? item?.checked) };
  });
}

function fromMarkdown(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const body = stripMarker(line);
    if (body == null) continue;
    const box = body.match(/^\[( |x|X)\]\s*(.*)$/);
    if (box) out.push({ text: box[2], done: box[1] !== " " });
    else out.push({ text: body, done: false });
  }
  return out.length ? out : null;
}

/** Texts of steps not yet marked done. */
export function openSteps(plan) {
  if (!plan || !Array.isArray(plan.steps)) return [];
  return plan.steps.filter((s) => !s.done).map((s) => s.text);
}

/**
 * Check off steps whose significant tokens are (nearly) all present in the
 * evidence (the diff / changed files). CONSERVATIVE by design: a high coverage
 * threshold and a >=2-significant-token floor mean the failure direction is
 * "keep reminding" (false negative), never "wrongly hide open work" (false
 * positive). Mutates and returns `plan`; a null/empty plan is a no-op.
 *
 * @param {{steps:{text:string,done:boolean}[]}|null} plan
 * @param {string} evidenceText
 */
export function reconcilePlan(plan, evidenceText, { coverage = 0.8, maxEvidence = 20000 } = {}) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const ev = new Set(tokens(String(evidenceText || "").slice(0, maxEvidence)));
  if (ev.size === 0) return plan;
  for (const step of plan.steps) {
    if (step.done) continue;
    const toks = tokens(step.text);
    if (toks.length < 2) continue; // too little signal to judge — leave open
    const hit = toks.filter((t) => ev.has(t)).length;
    if (hit / toks.length >= coverage) step.done = true;
  }
  return plan;
}

/**
 * The plan block appended to the verifier's NotAchieved nudge, or "" when no
 * steps remain open. Reminds the model of the whole task, not just the gaps.
 */
export function planNudgeBlock(plan, { max = 3 } = {}) {
  const open = openSteps(plan).slice(0, max);
  if (!open.length) return "";
  return (
    "\n\nPlan items still open (cover the WHOLE task, not only the gaps above):\n" +
    open.map((t) => `- plan item still open: ${t}`).join("\n")
  );
}

/**
 * Pure prompt assembly for the one small model call that derives the plan.
 * Returns { system, user } for callModelJson.
 */
export function buildPlanRequest(task, { maxSteps = 6, maxTaskChars = 3000 } = {}) {
  const t = String(task || "").trim().slice(0, maxTaskChars);
  return {
    system:
      "Break the coding task into a short checklist of atomic, independently-checkable steps " +
      `(at most ${maxSteps}). Each step is one concrete action toward the goal, phrased in a few words. ` +
      "Do NOT prescribe file layout or exact signatures, do NOT invent scope beyond the task, and do NOT " +
      'write code. Reply with ONLY a JSON array of short strings, e.g. ["parse the input", "handle the empty case"].',
    user: `## Task\n${t}`,
  };
}
