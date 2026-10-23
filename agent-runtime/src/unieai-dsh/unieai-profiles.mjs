// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-profiles.mjs — per-model harness profiles for the uac engine.
 *
 * A profile is the set of non-weight settings uac loads for one model:
 * persona level, extra persona lines, plugin set, tool guidance and skills.
 * The format belongs to UnieAI's harness lab (unieai-harness-lab, "hlab"):
 * `agent-runtime/profiles/profile.schema.json` is a copy of its schema plus
 * the optional `match:` list (glob patterns for model families). See
 * docs/unieai/harness-profiles.md.
 *
 * Which profile a model gets (resolveProfile):
 *   1. `UNIEAI_HARNESS_PROFILE`: `off` (none), or the path of a YAML file,
 *      applied to every model whatever its status;
 *   2. `$UNIEAI_HOME/profiles/<model>.yaml` (a user override);
 *   3. a bundled profile (agent-runtime/profiles/) whose `model` is the id;
 *   4. a bundled profile whose `match:` globs match the id; the pattern with
 *      the most literal characters wins, and a tie applies none.
 * Steps 2-4 apply only `status: adopted` profiles. An invalid profile is
 * skipped with a warning; nothing here throws on a bad file.
 *
 * How uac applies one (config.mjs renderPatch / prepareDsh), exactly as the
 * lab's dsh adapter does from outside (adapters/dsh.py, dsh_patch.py):
 *   persona.level   `rigor` turns on the persona's rigor rules, the switch
 *                   UNIEAI_PERSONA_RIGOR=1 sets (`0` forces them off);
 *                   other levels add nothing;
 *   persona.extra,  rendered by profileInstructions() and appended inside
 *   tool_guidance   the patch's personaPrefix by appendPersona(), byte for
 *                   byte what the lab's render_instructions(p, {}) and
 *                   append_persona() produce;
 *   plugins         the plugin selection (profilePluginChoice); a set
 *                   UNIEAI_DSH_PLUGINS still wins, so A/B runs keep working;
 *   skills          SKILL.md files (skillMarkdown) in a directory unieai-skills
 *                   reads below user and project skills, above bundled ones.
 *
 * In-process contract (for the lab and tests): config.mjs exports
 *
 *   renderUacConfig({ model, profile, baseUrl, modelInfo, skillsDir, env, ... })
 *     model    model id as the gateway serves it (no provider prefix)
 *     profile  a profile object: applied as given, any status (invalid throws);
 *              null: no profile; undefined: resolved for `model` as above
 *   -> { settings,   dsh settings.yaml text
 *        patch,      dsh patch YAML text (the profile applied)
 *        plugins,    ids of the selected UnieAI plugins
 *        profile,    { model, status, profile_sha, source, path } or null;
 *                    profile_sha is the lab's profile_sha(), 12 hex chars
 *        skillFiles  { "<name>/SKILL.md": text } to write under skillsDir }
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unieaiHome } from "../config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Profiles that ship with UnieAI Code. Only `status: adopted` ones apply. */
export const BUNDLED_PROFILES_DIR = join(here, "..", "..", "profiles");

/** The lab's schema (copied; see its `$comment`). Null when missing: then no profile validates. */
export const PROFILE_SCHEMA = (() => {
  try {
    return JSON.parse(readFileSync(join(BUNDLED_PROFILES_DIR, "profile.schema.json"), "utf8"));
  } catch {
    return null;
  }
})();

export const PROFILE_ENV = "UNIEAI_HARNESS_PROFILE";

const BEHAVIOR_KEYS = ["persona", "plugins", "tool_guidance", "skills"];

// ── Python string semantics ─────────────────────────────────────────────────
// The lab is Python; these reproduce str.strip(), str.splitlines() and
// json.dumps(sort_keys=True) so text and hashes come out identical.

const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const PY_LSTRIP = new RegExp(`^[${PY_SPACE}]+`);

export const pyStrip = (text) => String(text).replace(PY_STRIP, "");
const pyLstrip = (text) => String(text).replace(PY_LSTRIP, "");

const PY_LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\x0b\\x0c\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");
export function pySplitlines(text) {
  const lines = String(text).split(PY_LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** json.dumps(value, sort_keys=True): ", " and ": " separators, non-ASCII escaped. */
export function pyJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${pyJson(key)}: ${pyJson(value[key])}`).join(", ")}}`;
}

// ── the profile itself ──────────────────────────────────────────────────────

export function defaultProfile(model) {
  return {
    schema_version: 1,
    model,
    status: "unmeasured",
    harness: null,
    persona: { level: "standard", extra: [] },
    plugins: { base: "default", enable: [], disable: [] },
    tool_guidance: [],
    skills: [],
    provenance: { parent: null, edits: [], lessons: [], run: null },
    measurements: [],
  };
}

/** Every key filled with its default, as the lab's normalize() does. */
export function normalizeProfile(profile) {
  const base = defaultProfile(profile?.model || "unknown");
  const out = structuredClone(profile ?? {});
  for (const [key, value] of Object.entries(base)) {
    if (!(key in out) || (out[key] === null && key !== "harness")) out[key] = structuredClone(value);
  }
  for (const key of ["persona", "plugins", "provenance"]) {
    for (const [sub, value] of Object.entries(base[key])) if (!(sub in out[key])) out[key][sub] = structuredClone(value);
  }
  return out;
}

/** The identity of a profile's behaviour: the lab's profile_sha() (notes, status, measurements excluded). */
export function profileSha(profile) {
  const p = normalizeProfile(profile);
  const body = Object.fromEntries(BEHAVIOR_KEYS.map((key) => [key, p[key] ?? null]));
  return createHash("sha256").update(pyJson(body), "utf8").digest("hex").slice(0, 12);
}

// A small JSON Schema check covering the keywords profile.schema.json uses.
const codePoints = (text) => [...text].length;
const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

function checkSchema(schema, value, where, errors) {
  const at = where || "(root)";
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => TYPE_CHECKS[type]?.(value))) {
      errors.push(`${at}: expected ${types.join(" or ")}`);
      return;
    }
  }
  if ("const" in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && codePoints(value) < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && codePoints(value) > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at}: items are not unique`);
    if (schema.items) value.forEach((item, index) => checkSchema(schema.items, item, `${where ? `${where}/` : ""}${index}`, errors));
  }
  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: '${key}' is required`);
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) checkSchema(sub, item, `${where ? `${where}/` : ""}${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${key}'`);
    }
  }
}

/**
 * Why `profile` is not a valid profile (empty when it is): the schema, the
 * lab's extra checks, and one of uac's own: dsh interpolates the persona
 * strictly, so text that lands in it may not contain `{{`.
 */
export function validateProfile(profile) {
  if (!PROFILE_SCHEMA) return [`${join(BUNDLED_PROFILES_DIR, "profile.schema.json")} is missing`];
  const errors = [];
  checkSchema(PROFILE_SCHEMA, profile, "", errors);
  if (errors.length || !TYPE_CHECKS.object(profile)) return errors;
  const names = (profile.skills ?? []).map((skill) => skill.name);
  if (new Set(names).size !== names.length) errors.push("skills: duplicate skill names");
  const tools = (profile.tool_guidance ?? []).map((entry) => entry.tool);
  if (new Set(tools).size !== tools.length) errors.push("tool_guidance: duplicate tool entries");
  const disabled = new Set(profile.plugins?.disable ?? []);
  const both = (profile.plugins?.enable ?? []).filter((id) => disabled.has(id));
  if (both.length) errors.push(`plugins: both enabled and disabled: ${both.sort().join(", ")}`);
  const persona = [
    ...(profile.persona?.extra ?? []),
    ...(profile.tool_guidance ?? []).map((entry) => entry.text),
    ...(profile.skills ?? []).map((skill) => `${skill.name} ${skill.description}`),
  ];
  if (persona.some((text) => text.includes("{{"))) errors.push("persona: `{{` would be read as a dsh prompt variable");
  return errors;
}

let yamlModule = null;
/** dsh's own YAML parser (dsh-settings depends on `yaml`): no dependency of ours. */
function yaml() {
  if (yamlModule) return yamlModule;
  const require = createRequire(import.meta.url);
  try {
    const dsh = require.resolve("@deepseek-ai/dsh/package.json");
    const settings = createRequire(dsh).resolve("@deepseek-ai/dsh-settings/package.json");
    yamlModule = createRequire(settings)("yaml");
  } catch {
    yamlModule = require("yaml");
  }
  return yamlModule;
}

/** `{ profile }` from a YAML (or JSON) file, or `{ error }`; never throws. */
export function loadProfileFile(path) {
  let data;
  try {
    data = yaml().parse(readFileSync(path, "utf8"), { uniqueKeys: false });
  } catch (error) {
    return { error: `${path}: ${error.code === "ENOENT" ? "no such file" : error.message.split("\n")[0]}` };
  }
  if (!TYPE_CHECKS.object(data)) return { error: `${path}: not a mapping` };
  const errors = validateProfile(data);
  if (errors.length) return { error: `${path}: invalid profile: ${errors.join("; ")}` };
  return { profile: data };
}

// ── resolution ──────────────────────────────────────────────────────────────

const globRegExp = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** How specific a glob is: its literal characters. */
export const globSpecificity = (pattern) => pattern.replace(/[*?]/g, "").length;

/** The specificity of the best `match:` pattern of `profile` for `model`, or -1. */
export function matchSpecificity(profile, model) {
  let best = -1;
  for (const pattern of profile.match ?? []) if (globRegExp(pattern).test(model)) best = Math.max(best, globSpecificity(pattern));
  return best;
}

/** A model id that can name a file: no path separators, nothing hidden. */
const fileSafe = (model) => typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(model);

/** Bundled profiles as `{ file, path, profile }`; invalid ones reported through `warn`. */
export function loadBundledProfiles(dir = BUNDLED_PROFILES_DIR, warn = () => {}) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    const path = join(dir, file);
    const { profile, error } = loadProfileFile(path);
    if (error) warn(`profile skipped: ${error}`);
    else out.push({ file, path, profile });
  }
  return out;
}

/** Which bundled entry applies to `model`: `{ entry, source }`, `{ ambiguous: [...] }`, or null. */
export function pickBundled(entries, model) {
  const exact = entries.filter(({ profile }) => profile.model === model);
  if (exact.length > 1) return { ambiguous: exact.map((entry) => entry.file) };
  if (exact.length === 1) return { entry: exact[0], source: "bundled" };
  let best = -1;
  let winners = [];
  for (const entry of entries) {
    const score = matchSpecificity(entry.profile, model);
    if (score > best) [best, winners] = [score, [entry]];
    else if (score === best && score >= 0) winners.push(entry);
  }
  if (winners.length > 1) return { ambiguous: winners.map((entry) => entry.file) };
  return winners.length === 1 ? { entry: winners[0], source: "bundled-match" } : null;
}

export function profileIdentity(profile, { source = "explicit", path = null } = {}) {
  return { model: profile.model, status: profile.status, profile_sha: profileSha(profile), source, path };
}

/**
 * The profile uac applies to `model`: `{ profile, identity }`, or null for
 * none. `warn(message)` hears about every file skipped and why.
 */
export function resolveProfile(model, { env = process.env, home = unieaiHome(), bundledDir = BUNDLED_PROFILES_DIR, warn = () => {} } = {}) {
  const forced = String(env[PROFILE_ENV] ?? "").trim();
  if (forced === "off" || forced === "none") return null;
  if (forced) {
    const { profile, error } = loadProfileFile(forced);
    if (error) {
      warn(`${PROFILE_ENV} names an unusable profile, so none is applied: ${error}`);
      return null;
    }
    return { profile, identity: profileIdentity(profile, { source: "env", path: forced }) };
  }
  if (fileSafe(model)) {
    const path = join(home, "profiles", `${model}.yaml`);
    if (existsSync(path)) {
      const { profile, error } = loadProfileFile(path);
      if (error) warn(`profile skipped: ${error}`);
      else if (profile.status !== "adopted") warn(`profile skipped: ${path} is ${profile.status}, not adopted (${PROFILE_ENV}=<path> forces it)`);
      else return { profile, identity: profileIdentity(profile, { source: "user", path }) };
    }
  }
  const adopted = loadBundledProfiles(bundledDir, warn).filter(({ profile }) => profile.status === "adopted");
  const picked = pickBundled(adopted, model);
  if (picked?.ambiguous) {
    warn(`profile: bundled profiles ${picked.ambiguous.join(", ")} match ${model} equally well; none is applied`);
    return null;
  }
  if (!picked) return null;
  return { profile: picked.entry.profile, identity: profileIdentity(picked.entry.profile, { source: picked.source, path: picked.entry.path }) };
}

/**
 * Problems with a profiles directory as shipped (for tests): invalid files,
 * a file not named `<model>.yaml`, two profiles for one model, and model ids
 * two profiles' `match:` patterns claim equally (whatever their status).
 */
export function checkBundledProfiles(dir = BUNDLED_PROFILES_DIR) {
  const problems = [];
  const entries = loadBundledProfiles(dir, (message) => problems.push(message));
  for (const { file, profile } of entries) if (file !== `${profile.model}.yaml`) problems.push(`${file}: model is ${profile.model}; name the file ${profile.model}.yaml`);
  const probes = new Set();
  for (const { profile } of entries) {
    probes.add(profile.model);
    for (const pattern of profile.match ?? []) {
      probes.add(pattern.replace(/\*/g, "").replace(/\?/g, "x"));
      probes.add(pattern.replace(/[*?]/g, "x"));
    }
  }
  for (const probe of probes) {
    const picked = pickBundled(entries, probe);
    if (picked?.ambiguous) problems.push(`${probe}: matched equally by ${picked.ambiguous.join(", ")}`);
  }
  return problems;
}

/** The server log line: `profile: <model> adopted sha=<12> (<source>)`, or `profile: none`. */
export function profileLogLine(identity) {
  if (!identity) return "profile: none";
  return `profile: ${identity.model} ${identity.status} sha=${identity.profile_sha} (${identity.source})`;
}

// ── applying it ─────────────────────────────────────────────────────────────

/** The persona text a profile adds: the lab's render_instructions(p, {}, inline_skills=False). */
export function profileInstructions(profile) {
  if (!profile) return "";
  const p = normalizeProfile(profile);
  const parts = [];
  const extra = (p.persona.extra ?? []).filter((line) => pyStrip(line)).map(pyStrip);
  if (extra.length) parts.push(extra.map((line) => `- ${line}`).join("\n"));
  const guidance = p.tool_guidance ?? [];
  if (guidance.length) parts.push(`## Tool guidance\n${guidance.map((entry) => `- \`${entry.tool}\`: ${pyStrip(entry.text)}`).join("\n")}`);
  const skills = p.skills ?? [];
  if (skills.length) parts.push(`## Skills available\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * `text` added at the end of the patch's `personaPrefix` block, or as a
 * system-prompt row when there is none: the lab's append_persona(). A patch
 * row replaces the row's whole config, so the text goes inside uac's own row.
 */
export function appendPersona(patch, text) {
  text = pyStrip(text);
  if (!text) return patch;
  const lines = pySplitlines(patch);
  for (let i = 0; i < lines.length; i += 1) {
    if (pyStrip(lines[i]) !== "personaPrefix: |") continue;
    const indent = lines[i].length - pyLstrip(lines[i]).length + 2;
    let j = i + 1;
    while (j < lines.length && (!pyStrip(lines[j]) || lines[j].length - pyLstrip(lines[j]).length >= indent)) j += 1;
    while (j > i + 1 && !pyStrip(lines[j - 1])) j -= 1;
    const block = ["", ...pySplitlines(text).map((line) => (line ? " ".repeat(indent) + line : ""))];
    return `${[...lines.slice(0, j), ...block, ...lines.slice(j)].join("\n")}\n`;
  }
  const row = ["- id: system-prompt", "  config:", "    includeRuntimeContext: true", "    personaPrefix: |"];
  row.push(...pySplitlines(text).map((line) => (line ? `      ${line}` : "")));
  return `${pyStrip(patch) ? `${patch.replace(/\n+$/, "")}\n` : ""}${row.join("\n")}\n`;
}

/**
 * Whether the persona's rigor rules are on: UNIEAI_PERSONA_RIGOR (`1` on,
 * `0` off) when set, else the profile's `persona.level` is `rigor`.
 */
export function personaRigor(profile, env = process.env) {
  const flag = String(env.UNIEAI_PERSONA_RIGOR ?? "").trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return profile?.persona?.level === "rigor";
}

/**
 * The plugin choice a profile makes, in UNIEAI_DSH_PLUGINS form (a comma list,
 * `off` for none), or null when it keeps the default set: the lab's
 * resolve_plugins(), applied the way its dsh adapter sets the env var.
 */
export function profilePluginChoice(profile, { catalog, defaults = catalog }) {
  if (!profile) return null;
  const plugins = normalizeProfile(profile).plugins;
  const base = plugins.base ?? "default";
  if (base === "default" && !(plugins.enable ?? []).length && !(plugins.disable ?? []).length) return null;
  const chosen = base === "all" ? [...catalog] : base === "none" ? [] : [...defaults];
  for (const id of plugins.enable ?? []) if (!chosen.includes(id)) chosen.push(id);
  const disabled = new Set(plugins.disable ?? []);
  const kept = chosen.filter((id) => !disabled.has(id));
  return kept.length ? kept.join(",") : "off";
}

/** A skill as SKILL.md: the lab's skill_markdown(). */
export function skillMarkdown(skill) {
  return `---\nname: ${skill.name}\ndescription: ${pyJson(skill.description)}\n---\n\n${pyStrip(skill.body)}\n`;
}

/** `{ "<name>/SKILL.md": text }` for a profile's skills. */
export function profileSkillFiles(profile) {
  return Object.fromEntries((profile?.skills ?? []).map((skill) => [`${skill.name}/SKILL.md`, skillMarkdown(skill)]));
}

/** Write `files` (relative path -> text) under `dir`. */
export function writeSkillFiles(dir, files) {
  for (const [relative, text] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
