/**
 * schema-check.mjs — validate what we send against the Rust protocol's own schema.
 *
 * The failure mode this exists for: the client drops any message it cannot
 * deserialize, silently, by design (app-server-client/src/remote.rs answers
 * `Err(_) => None`). A missing required field therefore looks exactly like an
 * engine that did nothing — no error on either side, no log line, nothing to
 * search for. Two independent implementations of one protocol WILL drift, and
 * the openspec design for this transport lists that drift as its first risk with
 * "a shared contract test suite run against both backends" as the answer.
 *
 * The schema is generated from the Rust types themselves
 * (`codex-rs/app-server-protocol/schema/json/`, written by `just
 * write-app-server-schema`), so it cannot disagree with them — which is the
 * whole point of checking against it rather than against a hand-written list.
 *
 * Deliberately not a complete JSON Schema implementation. It covers what these
 * schemas actually use — $ref, type, required, properties, enum, anyOf/oneOf,
 * items — and reports the FIRST concrete disagreement with a path, because a
 * validator whose output is a wall of union branches is one nobody reads.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Where the generated schemas live, relative to the repo root. */
export const SCHEMA_DIR = "codex-rs/app-server-protocol/schema/json";

export function loadSchema(name, { repoRoot }) {
  const path = join(repoRoot, SCHEMA_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveRef(ref, root) {
  const key = String(ref).replace(/^#\/definitions\//, "");
  const found = root.definitions?.[key];
  if (!found) throw new Error(`schema $ref not found: ${ref}`);
  return found;
}

function typeMatches(declared, value) {
  const types = Array.isArray(declared) ? declared : [declared];
  return types.some((t) => {
    switch (t) {
      case "null": return value === null;
      case "string": return typeof value === "string";
      case "boolean": return typeof value === "boolean";
      case "integer": return Number.isInteger(value);
      case "number": return typeof value === "number";
      case "array": return Array.isArray(value);
      case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
      default: return true;
    }
  });
}

/**
 * @returns {string[]} problems, empty when the value conforms.
 */
function check(schema, value, root, path, seen) {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    // Recursive types exist in this schema; visiting one twice at the same path
    // means the shape is satisfied as far as this check can tell.
    const key = `${path}::${schema.$ref}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return check(resolveRef(schema.$ref, root), value, root, path, seen);
  }

  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    const attempts = branches.map((b) => check(b, value, root, path, new Set(seen)));
    if (attempts.some((problems) => problems.length === 0)) return [];
    // Report the branch that got closest, rather than every branch's complaint.
    const best = attempts.reduce((a, b) => (b.length < a.length ? b : a));
    return best;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    return [`${path}: expected ${JSON.stringify(schema.type)}, got ${value === null ? "null" : typeof value}`];
  }

  const problems = [];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}.${key}: required by the protocol, not sent`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) problems.push(...check(sub, value[key], root, `${path}.${key}`, seen));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...check(schema.items, item, root, `${path}[${i}]`, seen)));
  }
  return problems;
}

/**
 * Validate `value` against the named generated schema.
 *
 * Returns `{ ok, problems, skipped }`. `skipped` is true when the schema is not
 * on disk — the generated files are checked in, but a build that has not run
 * `just write-app-server-schema` should report a gap rather than a pass.
 */
export function validateAgainstSchema(name, value, { repoRoot }) {
  const root = loadSchema(name, { repoRoot });
  if (!root) return { ok: false, skipped: true, problems: [`schema ${name}.json is not present`] };
  const problems = check(root, value, root, name, new Set());
  return { ok: problems.length === 0, skipped: false, problems };
}
