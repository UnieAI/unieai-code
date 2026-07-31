/**
 * compaction-eval.mjs — measure what a compaction summary actually kept.
 *
 * Each archived fold pairs the ORIGINAL messages with the summary that replaced
 * them, which is the only way to answer the question that matters: when the
 * summary dropped something, was it something we needed?
 *
 * Three signals, chosen because they fail in different ways:
 *
 *   · Identifiers — file paths, symbols, numbers. These are the things a later
 *     turn tries to act on, and a summary that loses them sends the model
 *     hunting for a filename it can no longer name.
 *   · Decisions — "we chose X because Y". Losing one of these is worse than
 *     losing a filename: the model does not know it is missing, and may redo a
 *     decision the opposite way.
 *   · Compression ratio — context on its own. A low retention score is expected
 *     at 50:1 and alarming at 3:1.
 *
 * Pure: it reads records, not the filesystem, so it can be tested against
 * fixtures rather than requiring a live session.
 */

/** Words that look like identifiers but carry no signal if dropped. */
const COMMON = new Set([
  "true", "false", "null", "none", "self", "this", "const", "class", "async",
  "await", "return", "import", "export", "function", "value", "result", "data",
  "error", "string", "number", "object", "array", "http", "https", "json",
]);

/**
 * Pull out the things a later turn would need to name.
 *
 * Deliberately conservative: a pattern that also matches ordinary prose would
 * flood the denominator and make every summary look terrible.
 */
export function extractIdentifiers(text) {
  const s = String(text ?? "");
  const found = new Set();

  // Paths with a directory separator and an extension — src/a/b.ts, ./x.py
  for (const m of s.matchAll(/\b[\w.-]+(?:\/[\w.-]+)+\.\w{1,6}\b/g)) found.add(m[0]);
  // Bare filenames with a code-ish extension.
  for (const m of s.matchAll(/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|rs|py|go|java|rb|json|toml|yaml|yml|md|sql)\b/g)) found.add(m[0]);
  // snake_case / camelCase / PascalCase symbols of a reasonable length.
  for (const m of s.matchAll(/\b(?:[a-z]+_[a-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g)) {
    if (m[0].length >= 4 && !COMMON.has(m[0].toLowerCase())) found.add(m[0]);
  }
  // file:line references and standalone numbers of 3+ digits.
  for (const m of s.matchAll(/\b\w[\w./-]*:\d+\b/g)) found.add(m[0]);
  for (const m of s.matchAll(/\b\d{3,}\b/g)) found.add(m[0]);

  return found;
}

/** Markers that a sentence is recording a CHOICE rather than narrating work. */
const DECISION_RE = /\b(?:because|instead of|rather than|so that|decided|chose|switch(?:ed)? to|we will|must not|do not|avoid|prefer(?:red)?|turned out|the reason)\b/i;

/** Sentences that read as decisions, normalized for comparison. */
export function extractDecisions(text) {
  return String(text ?? "")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && DECISION_RE.test(s));
}

/**
 * Significant tokens, for the loose overlap test used on decisions.
 *
 * `.` `/` `-` stay word characters so `src/ws.rs` survives as one token, which
 * means sentence-final words arrive as `surface.` — trimmed at the edges only,
 * or every last word of a sentence would fail to match its own counterpart.
 */
function tokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map((t) => t.replace(/^[./-]+/, "").replace(/[./-]+$/, ""))
      .filter((t) => t.length >= 4 && !COMMON.has(t))
  );
}

/**
 * Is a decision from the original still represented in the summary?
 *
 * Compared by token overlap rather than substring: a good summary REWORDS, so
 * demanding the sentence verbatim would score a faithful summary as a failure.
 */
function decisionSurvives(decision, summaryTokens, threshold = 0.5) {
  const want = tokens(decision);
  if (!want.size) return true;
  let hit = 0;
  for (const t of want) if (summaryTokens.has(t)) hit += 1;
  return hit / want.size >= threshold;
}

const text = (message) => {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  return "";
};

/**
 * Score one archived fold.
 *
 * @returns {{identifiers:{total:number, kept:number, lost:string[], rate:number},
 *   decisions:{total:number, kept:number, lost:string[], rate:number},
 *   originalChars:number, summaryChars:number, ratio:number}}
 */
export function evaluateFold(record) {
  const original = (record?.folded ?? []).map(text).join("\n");
  const summary = String(record?.summary ?? "");

  const wanted = extractIdentifiers(original);
  const inSummary = extractIdentifiers(summary);
  // Match case-insensitively; a summary that renames the case still names it.
  const summaryLower = new Set([...inSummary].map((s) => s.toLowerCase()));
  const lostIdentifiers = [...wanted].filter((id) => !summaryLower.has(id.toLowerCase()));

  const decisions = extractDecisions(original);
  const summaryTokens = tokens(summary);
  const lostDecisions = decisions.filter((d) => !decisionSurvives(d, summaryTokens));

  const rate = (total, lost) => (total === 0 ? 1 : (total - lost) / total);

  return {
    identifiers: {
      total: wanted.size,
      kept: wanted.size - lostIdentifiers.length,
      lost: lostIdentifiers.slice(0, 40),
      rate: rate(wanted.size, lostIdentifiers.length),
    },
    decisions: {
      total: decisions.length,
      kept: decisions.length - lostDecisions.length,
      lost: lostDecisions.slice(0, 10),
      rate: rate(decisions.length, lostDecisions.length),
    },
    originalChars: original.length,
    summaryChars: summary.length,
    ratio: summary.length ? original.length / summary.length : Infinity,
  };
}

/** Aggregate several folds; per-fold rates are weighted by their totals. */
export function summarizeEvaluations(results) {
  if (!results.length) return null;
  const sum = (pick) => results.reduce((n, r) => n + pick(r), 0);
  const idTotal = sum((r) => r.identifiers.total);
  const idKept = sum((r) => r.identifiers.kept);
  const decTotal = sum((r) => r.decisions.total);
  const decKept = sum((r) => r.decisions.kept);
  const originalChars = sum((r) => r.originalChars);
  const summaryChars = sum((r) => r.summaryChars);

  return {
    folds: results.length,
    identifierRate: idTotal ? idKept / idTotal : 1,
    identifiersLost: idTotal - idKept,
    decisionRate: decTotal ? decKept / decTotal : 1,
    decisionsLost: decTotal - decKept,
    ratio: summaryChars ? originalChars / summaryChars : Infinity,
  };
}

/** Human-readable report. */
export function renderReport(results) {
  const agg = summarizeEvaluations(results);
  if (!agg) return "No compaction archives found yet — nothing has been folded.";
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `${agg.folds} fold(s), compression ${agg.ratio.toFixed(1)}:1`,
    `identifiers kept: ${pct(agg.identifierRate)} (${agg.identifiersLost} lost)`,
    `decisions kept:   ${pct(agg.decisionRate)} (${agg.decisionsLost} lost)`,
  ];
  const worstIds = results.flatMap((r) => r.identifiers.lost).slice(0, 15);
  if (worstIds.length) lines.push(`\nexamples of lost identifiers: ${worstIds.join(", ")}`);
  const worstDecisions = results.flatMap((r) => r.decisions.lost).slice(0, 3);
  if (worstDecisions.length) {
    lines.push("\nlost decisions:");
    for (const d of worstDecisions) lines.push(`  · ${d.slice(0, 160)}`);
  }
  return lines.join("\n");
}
