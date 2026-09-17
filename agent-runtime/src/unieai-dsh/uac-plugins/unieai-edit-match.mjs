// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-match.mjs — pure line matching and diff helpers shared by the
 * unieai-edit-* and unieai-apply-patch plugins. No dsh imports.
 *
 * The matching is codex's `seek_sequence` (codex-rs/apply-patch/src/
 * seek_sequence.rs): compare whole lines, strictest level first — exact, then
 * ignoring trailing whitespace, then ignoring surrounding whitespace, then also
 * mapping typographic punctuation and odd spaces to ASCII.
 */

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;
const ODD_SPACES = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

/** codex `normalise`: trim, then ASCII-fold punctuation and spaces. */
export function normalise(line) {
  return line
    .trim()
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(ODD_SPACES, " ");
}

/** Rust `trim_end` / `trim` treat all Unicode whitespace; JS trim does too. */
export const TIERS = [
  { name: "exact", key: (l) => l },
  { name: "ignoring trailing whitespace", key: (l) => l.trimEnd() },
  { name: "ignoring leading/trailing whitespace", key: (l) => l.trim() },
  { name: "normalizing unicode punctuation", key: normalise },
];

function matchesAt(lines, keys, i, key) {
  for (let j = 0; j < keys.length; j++) {
    if (key(lines[i + j]) !== keys[j]) return false;
  }
  return true;
}

/**
 * codex `seek_sequence`: the first index >= start where `pattern` matches, at
 * the strictest level that matches anywhere. With `eof`, the search starts at
 * the last possible position (NormalizeToLf behaviour) — so an end-of-file
 * chunk only ever matches at the very end.
 *
 * @returns {number} index, or -1
 */
export function seekSequence(lines, pattern, start = 0, eof = false) {
  return seekSequenceTier(lines, pattern, start, eof).index;
}

/** {@link seekSequence}, also reporting the level (0-3) that matched. */
export function seekSequenceTier(lines, pattern, start = 0, eof = false) {
  if (pattern.length === 0) return { index: start, tier: 0 };
  if (pattern.length > lines.length) return { index: -1, tier: -1 };
  const from = eof ? lines.length - pattern.length : start;
  const last = lines.length - pattern.length;
  for (let t = 0; t < TIERS.length; t++) {
    const tier = TIERS[t];
    const keys = pattern.map(tier.key);
    for (let i = from; i <= last; i++) {
      if (matchesAt(lines, keys, i, tier.key)) return { index: i, tier: t };
    }
  }
  return { index: -1, tier: -1 };
}

/**
 * Every index where `pattern` matches, at the strictest level that matches at
 * all. A looser level never adds matches once a stricter one found any.
 *
 * @returns {{indices:number[], tier:number, tierName:string|null}}
 */
export function findAllMatches(lines, pattern) {
  if (pattern.length === 0 || pattern.length > lines.length) return { indices: [], tier: -1, tierName: null };
  const last = lines.length - pattern.length;
  for (let t = 0; t < TIERS.length; t++) {
    const tier = TIERS[t];
    const keys = pattern.map(tier.key);
    const indices = [];
    for (let i = 0; i <= last; i++) {
      if (matchesAt(lines, keys, i, tier.key)) indices.push(i);
    }
    if (indices.length) return { indices, tier: t, tierName: tier.name };
  }
  return { indices: [], tier: -1, tierName: null };
}

/** Split text into lines; a final newline does not make an extra line. */
export function splitLines(text) {
  if (text === "") return { lines: [], trailingNewline: false };
  const lines = text.split("\n");
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

export function joinLines(lines, trailingNewline) {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

const READ_PREFIX = /^\s*\d+: ?/;

/**
 * dsh `read` shows lines as `12: text`; models copy the prefix into
 * old_string. Strip it only when every non-blank line carries one.
 * @returns {string|null} the stripped text, or null when it does not apply
 */
export function stripReadLineNumbers(text) {
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.trim() !== "");
  if (nonBlank.length === 0 || !nonBlank.every((l) => READ_PREFIX.test(l))) return null;
  // `12: ` then the original text; a blank source line reads as `12: `.
  return lines.map((l) => (l.trim() === "" ? l : l.replace(/^\s*\d+: ?/, ""))).join("\n");
}

const leadingWs = (line) => /^\s*/.exec(line)[0];

function indentUnit(indents, fallback) {
  const lens = [...new Set(indents.map((w) => w.length))].sort((x, y) => x - y);
  let unit = 0;
  for (let k = 1; k < lens.length; k++) {
    const d = lens[k] - lens[k - 1];
    if (d > 0 && (unit === 0 || d < unit)) unit = d;
  }
  return unit || fallback;
}

/**
 * Re-indent `newLines` when the match only held after trimming: each
 * indentation the model used on a matched line maps to the file's indentation
 * of that line; deeper levels keep the mapped prefix and convert the rest
 * between tabs and spaces.
 */
export function reindent(newLines, patternLines, fileLines) {
  const map = new Map();
  for (let j = 0; j < patternLines.length; j++) {
    if (patternLines[j].trim() === "") continue;
    const m = leadingWs(patternLines[j]);
    if (!map.has(m)) map.set(m, leadingWs(fileLines[j]));
  }
  if ([...map].every(([m, f]) => m === f)) return newLines;
  const keys = [...map.keys()].sort((x, y) => y.length - x.length);
  const fileIndents = [...map.values()];
  const fileTabs = fileIndents.some((w) => w.includes("\t"));
  const modelUnit = indentUnit(keys.filter((k) => !k.includes("\t")), 4);
  const fileUnit = indentUnit(fileIndents.filter((w) => !w.includes("\t")), 4);
  return newLines.map((line) => {
    if (line.trim() === "") return line;
    const ws = leadingWs(line);
    const body = line.slice(ws.length);
    if (map.has(ws)) return map.get(ws) + body;
    const key = keys.find((k) => ws.startsWith(k));
    if (key === undefined) return line;
    let extra = ws.slice(key.length);
    if (fileTabs && /^ +$/.test(extra)) extra = "\t".repeat(Math.max(1, Math.round(extra.length / modelUnit)));
    else if (!fileTabs && /^\t+$/.test(extra)) extra = " ".repeat(extra.length * fileUnit);
    return map.get(key) + extra + body;
  });
}

/**
 * Plan a whole-line fuzzy replacement of `oldString` in `content` (both LF).
 *
 * @returns {{ok:true, content:string, tier:string, lines:number[], stripped:boolean}
 *          |{ok:false, reason:"not-found"|"ambiguous"|"no-change", lines?:number[], tier?:string}}
 */
export function planFuzzyEdit(content, oldString, newString, { replaceAll = false } = {}) {
  const file = splitLines(content);
  const attempts = [{ old: oldString, neu: newString, stripped: false }];
  const strippedOld = stripReadLineNumbers(oldString);
  if (strippedOld !== null) {
    const strippedNew = stripReadLineNumbers(newString);
    attempts.push({ old: strippedOld, neu: strippedNew ?? newString, stripped: true });
  }
  for (const attempt of attempts) {
    let pattern = attempt.old.split("\n");
    let replacement = attempt.neu === "" ? [] : attempt.neu.split("\n");
    let found = findAllMatches(file.lines, pattern);
    // A trailing newline in old_string means "through the end of that line".
    if (!found.indices.length && pattern.length > 1 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.length && replacement[replacement.length - 1] === "") replacement = replacement.slice(0, -1);
      found = findAllMatches(file.lines, pattern);
    }
    // Leading blank lines the model added around the snippet.
    if (!found.indices.length) {
      let lo = 0;
      let hi = pattern.length;
      while (lo < hi && pattern[lo].trim() === "") lo++;
      while (hi > lo && pattern[hi - 1].trim() === "") hi--;
      if (lo > 0 || hi < pattern.length) {
        if (hi > lo) {
          const trimmedPattern = pattern.slice(lo, hi);
          const r = findAllMatches(file.lines, trimmedPattern);
          if (r.indices.length) {
            pattern = trimmedPattern;
            let rlo = 0;
            let rhi = replacement.length;
            while (rlo < rhi && replacement[rlo].trim() === "") rlo++;
            while (rhi > rlo && replacement[rhi - 1].trim() === "") rhi--;
            replacement = replacement.slice(rlo, rhi);
            found = r;
          }
        }
      }
    }
    if (!found.indices.length) continue;
    const lineNumbers = found.indices.map((i) => i + 1);
    if (found.indices.length > 1 && !replaceAll) {
      return { ok: false, reason: "ambiguous", lines: lineNumbers, tier: found.tierName };
    }
    // Apply bottom-up, skipping overlapping matches.
    const chosen = [];
    for (const i of found.indices) {
      if (chosen.length && i < chosen[chosen.length - 1] + pattern.length) continue;
      chosen.push(i);
    }
    const out = file.lines.slice();
    for (const i of chosen.slice().reverse()) {
      const lines = found.tier >= 2 ? reindent(replacement, pattern, file.lines.slice(i, i + pattern.length)) : replacement;
      out.splice(i, pattern.length, ...lines);
    }
    const next = joinLines(out, file.trailingNewline);
    if (next === content) return { ok: false, reason: "no-change", lines: lineNumbers, tier: found.tierName };
    return { ok: true, content: next, tier: found.tierName, lines: chosen.map((i) => i + 1), stripped: attempt.stripped };
  }
  return { ok: false, reason: "not-found" };
}

/** Line numbers (1-based) where literal `needle` starts in `content`. */
export function literalLineNumbers(content, needle, limit = 20) {
  const out = [];
  if (!needle) return out;
  let at = content.indexOf(needle);
  while (at >= 0 && out.length < limit) {
    out.push(content.slice(0, at).split("\n").length);
    at = content.indexOf(needle, at + needle.length);
  }
  return out;
}

function bigrams(text) {
  const s = normalise(text).replace(/\s+/g, " ");
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

function dice(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) common++;
  return (2 * common) / (a.size + b.size);
}

/**
 * The window of the file most similar to `oldString`, for a not-found hint.
 * @returns {{start:number, end:number, score:number, firstDiff:number|null, others:number[]}|null}
 *   1-based inclusive line range
 */
export function closestWindow(content, oldString, { maxLines = 20000 } = {}) {
  const file = splitLines(content).lines;
  let pattern = splitLines(oldString).lines;
  while (pattern.length && pattern[0].trim() === "") pattern.shift();
  while (pattern.length && pattern[pattern.length - 1].trim() === "") pattern.pop();
  if (!file.length || !pattern.length) return null;
  // Large files: score only on the first pattern line.
  if (file.length > maxLines) pattern = pattern.slice(0, 1);
  const n = Math.min(pattern.length, file.length);
  const pat = pattern.slice(0, n).map(bigrams);
  const fileGrams = new Array(file.length);
  const gramsAt = (i) => (fileGrams[i] ??= bigrams(file[i]));
  const scored = [];
  for (let i = 0; i + n <= file.length; i++) {
    // Cheap gate on the first line, then the full window.
    const first = dice(gramsAt(i), pat[0]);
    if (n > 1 && first < 0.3) {
      scored.push({ i, score: first / n });
      continue;
    }
    let total = first;
    for (let j = 1; j < n; j++) total += dice(gramsAt(i + j), pat[j]);
    scored.push({ i, score: total / n });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const best = scored[0];
  if (!best || best.score < 0.4) return null;
  let firstDiff = null;
  for (let j = 0; j < n; j++) {
    if (normalise(file[best.i + j]) !== normalise(pattern[j])) { firstDiff = j; break; }
  }
  const others = [];
  for (const s of scored.slice(1)) {
    if (others.length >= 2 || s.score < best.score - 0.15) break;
    if (Math.abs(s.i - best.i) >= n) others.push(s.i + 1);
  }
  return {
    start: best.i + 1,
    end: best.i + n,
    score: best.score,
    firstDiff: firstDiff === null ? null : { line: best.i + firstDiff + 1, file: file[best.i + firstDiff], wanted: pattern[firstDiff] },
    lines: file.slice(best.i, best.i + n),
    others,
  };
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Model-facing hint for a failed match. */
export function notFoundHint(content, oldString, { maxShown = 8 } = {}) {
  const w = closestWindow(content, oldString);
  if (!w) return "No similar lines exist in the file; re-read it before retrying.";
  const shown = w.lines.slice(0, maxShown).map((l, k) => `${String(w.start + k).padStart(6)}  ${clip(l)}`);
  if (w.lines.length > maxShown) shown.push(`       … (${w.lines.length - maxShown} more lines)`);
  const parts = [
    `Closest match is lines ${w.start}-${w.end} (${Math.round(w.score * 100)}% similar):`,
    ...shown,
  ];
  if (w.firstDiff) {
    parts.push(
      `First difference at line ${w.firstDiff.line}:`,
      `  file has:        ${JSON.stringify(clip(w.firstDiff.file))}`,
      `  old_string has:  ${JSON.stringify(clip(w.firstDiff.wanted))}`,
    );
  }
  if (w.others.length) parts.push(`Other similar places start at line ${w.others.join(", ")}.`);
  parts.push("Copy the current text of those lines exactly (without line-number prefixes) and retry.");
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Unified diff                                                        */
/* ------------------------------------------------------------------ */

/** Edit script between two line arrays: [{op:' '|'-'|'+', a, b, text}]. */
export function diffLines(a, b, { maxCells = 4_000_000 } = {}) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ op: " ", a: i, b: i, text: a[i] });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n * m > maxCells) {
    am.forEach((t, i) => ops.push({ op: "-", a: pre + i, text: t }));
    bm.forEach((t, j) => ops.push({ op: "+", b: pre + j, text: t }));
  } else if (n || m) {
    // LCS table over the middle, row-major, Uint32.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ op: " ", a: pre + i, b: pre + j, text: am[i] });
        i++; j++;
      } else if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        ops.push({ op: "-", a: pre + i, text: am[i] });
        i++;
      } else {
        ops.push({ op: "+", b: pre + j, text: bm[j] });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) {
    const ia = a.length - suf + k;
    const ib = b.length - suf + k;
    ops.push({ op: " ", a: ia, b: ib, text: a[ia] });
  }
  return ops;
}

/**
 * A unified diff (`@@ -a,b +c,d @@` hunks) between two texts.
 * @returns {{text:string, added:number, removed:number, truncated:boolean}}
 */
export function unifiedDiff(before, after, { context = 3, maxLines = 80, path = null } = {}) {
  const a = splitLines((before ?? "").replace(/\r\n/g, "\n")).lines;
  const b = splitLines((after ?? "").replace(/\r\n/g, "\n")).lines;
  const ops = diffLines(a, b);
  let added = 0;
  let removed = 0;
  const changed = [];
  const aPos = [];
  const bPos = [];
  let ca = 0;
  let cb = 0;
  ops.forEach((o, k) => {
    aPos.push(ca);
    bPos.push(cb);
    if (o.op !== "+") ca++;
    if (o.op !== "-") cb++;
    if (o.op === "+") added++;
    if (o.op === "-") removed++;
    if (o.op !== " ") changed.push(k);
  });
  if (!changed.length) return { text: "", added, removed, truncated: false };
  // Group changes whose context windows touch.
  const groups = [];
  for (const k of changed) {
    const g = groups[groups.length - 1];
    if (g && k - g.end <= context * 2 + 1) g.end = k;
    else groups.push({ start: k, end: k });
  }
  const out = path ? [`--- a/${path}`, `+++ b/${path}`] : [];
  let truncated = false;
  for (const g of groups) {
    const from = Math.max(0, g.start - context);
    const to = Math.min(ops.length - 1, g.end + context);
    const slice = ops.slice(from, to + 1);
    const aStart = aPos[from];
    const bStart = bPos[from];
    const aLen = slice.filter((o) => o.op !== "+").length;
    const bLen = slice.filter((o) => o.op !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) out.push(`${o.op}${o.text}`);
  }
  let lines = out;
  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    lines = [...lines.slice(0, maxLines), `… (${omitted} more diff lines omitted)`];
    truncated = true;
  }
  return { text: lines.join("\n"), added, removed, truncated };
}
