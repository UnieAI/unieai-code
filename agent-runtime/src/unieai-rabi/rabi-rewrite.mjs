// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * rabi-rewrite.mjs — the name mapping from the upstream harness to Rabi.
 *
 * The Rabi packages (@unieai/rabi, @unieai/rabi-*, @unieai/cordis, ...) are
 * the upstream harness packages republished under UnieAI names. The fork is
 * made on the built packages, not on the upstream source, so upstream merges
 * stay clean: scripts/unieai-rabi-fork.mjs downloads the exact versions the
 * lockfile pins and passes every text file through rewriteText().
 *
 * Two mappings live here:
 *
 *  - rewriteText(): the full rename, for package files we ship. Package
 *    scopes, the harness name, and every `dsh` name segment (dsh-session,
 *    DSH_HOME, resolveDshHome, --dsh-font-size, __dsh_shell_idle, ...)
 *    become rabi. English words that merely contain the letters
 *    (spreadsheet, handshake, $ZodShape, threedshadow) are left alone, and so
 *    are long base64 runs, where a match is chance and an edit corrupts the
 *    embedded font or image.
 *
 *  - rewritePackageNames(): only package names, for data a user already has
 *    on disk (sessions record which plugin wrote an entry). A session also
 *    holds the user's own words and paths, which a full rename would change.
 */

/** Scope and harness names; order matters (longest first). */
const LITERAL_RULES = [
  ["@deepseek-ai/dsh", "@unieai/rabi"],
  ["@deepseek-ai/", "@unieai/"],
  // Escaped inside a regex or JSON string: @deepseek-ai\/dsh-session.
  ["@deepseek-ai\\/dsh", "@unieai\\/rabi"],
  ["@deepseek-ai\\/", "@unieai\\/"],
  // Flattened into a path or slug: deepseek-ai-dsh-tool-web.
  ["deepseek-ai-dsh", "unieai-rabi"],
  // Bundler-mangled package names: _deepseek_ai_dsh_client_store.
  ["deepseek_ai_dsh", "unieai_rabi"],
  ["deepseek_ai_", "unieai_"],
  // Markdown anchors made from headings: #deepseek-aidsh-host-...
  ["deepseek-aidsh", "unieairabi"],
  ["github.com/deepseek-harness/deepseek-harness", "github.com/UnieAI/rabi-harness"],
  ["github.com/deepseek-ai/deepseek-harness", "github.com/UnieAI/rabi-harness"],
  ["github.com/deepseek-ai", "github.com/UnieAI"],
  ["deepseek-harness", "rabi-harness"],
  ["deepseek_harness", "rabi_harness"],
  ["DeepSeek Harness", "Rabi Harness"],
  ["DeepSeek-Harness", "Rabi-Harness"],
  ["DeepseekHarness", "RabiHarness"],
  ["DEEPSEEK_HARNESS", "RABI_HARNESS"],
];

/**
 * A `dsh` name segment, by case:
 *  - dsh: not preceded by a lowercase letter (`threedshadow`, `spreadsheet`)
 *    unless that letter is the n/t/r of an escape (`\ndsh`), and not followed
 *    by one (`xn--krdsherad`, a public-suffix entry; `dshow`).
 *  - Dsh: a camelCase segment; not followed by a lowercase letter
 *    (`Dshell` would be a word).
 *  - DSH: an all-caps segment; may run into a capitalised word
 *    (`isDSHRemoteError`, `DSHInspector`) but not into more capitals.
 */
const SEGMENT = new RegExp(
  [
    String.raw`(?:(?<![a-z])|(?<=\\[ntr]))dsh(?![a-z])`,
    String.raw`Dsh(?![a-z])`,
    String.raw`(?<![A-Z])DSH(?![A-Z])`,
    String.raw`(?<![A-Z])DSH(?=[A-Z][a-z])`,
  ].join("|"),
  "g",
);
const SEGMENT_CASE = { dsh: "rabi", Dsh: "Rabi", DSH: "RABI" };

/** A run of base64 alphabet this long is data, not a name. */
const BASE64_RUN = /[A-Za-z0-9+/]{120,}={0,2}/g;

function replaceLiterals(text) {
  for (const [from, to] of LITERAL_RULES) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  return text;
}

function replaceSegments(text) {
  return text.replace(SEGMENT, (match) => SEGMENT_CASE[match]);
}

/** The full rename, applied outside base64 runs. */
export function rewriteText(text) {
  let out = "";
  let last = 0;
  for (const run of text.matchAll(BASE64_RUN)) {
    out += replaceSegments(replaceLiterals(text.slice(last, run.index)));
    out += run[0];
    last = run.index + run[0].length;
  }
  return out + replaceSegments(replaceLiterals(text.slice(last)));
}

/** A path segment (file or directory name) under the full rename. */
export function rewritePathSegment(name) {
  return replaceSegments(replaceLiterals(name));
}

/** Only package names: @deepseek-ai/dsh-x → @unieai/rabi-x, @deepseek-ai/x → @unieai/x. */
export function rewritePackageNames(text) {
  return text.split("@deepseek-ai/dsh").join("@unieai/rabi").split("@deepseek-ai/").join("@unieai/");
}

/** The Rabi name of an upstream package name. */
export function rabiPackageName(name) {
  return rewritePackageNames(name);
}

/**
 * Leftover upstream names in text after the rename: what a scan of the
 * shipped packages would still find. Words that only contain the letters
 * (spreadsheet) are not leftovers; base64 runs are reported separately by
 * the caller because they are data.
 */
export function findLeftovers(text) {
  const found = [];
  const stripped = text.replace(BASE64_RUN, "");
  for (const re of [/deepseek[-_]?ai/gi, /deepseek[-_ ]?harness/gi, SEGMENT]) {
    re.lastIndex = 0;
    for (const m of stripped.matchAll(re)) {
      found.push(stripped.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30));
      if (found.length >= 20) return found;
    }
  }
  return found;
}
