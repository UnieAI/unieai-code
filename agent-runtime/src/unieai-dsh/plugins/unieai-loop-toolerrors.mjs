// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-toolerrors.mjs — make tool-call errors actionable.
 *
 * dsh answers a call to a missing tool with just `unknown tool "X"`, and a
 * schema violation with `invalid arguments: …`. A model that guessed a tool
 * name or a parameter shape has nothing to correct itself with, and tends to
 * retry the same call. On `tools/post-execute` this plugin appends to such
 * error results:
 *   - UNKNOWN_TOOL: the nearest available tool name(s) and the tool list;
 *   - INVALID_ARGS: the tool's parameter summary (required first).
 * The result stays an error with its original `error.info`; only the
 * model-facing content grows. Nested (run_code) dispatches are left alone.
 *
 * Loaded through the uac patch as an `insert` row (see config.mjs).
 */
export const name = "unieai-loop-toolerrors";
export const inject = ["tools"];

const MAX_LISTED_TOOLS = 80;
const MAX_LISTED_PARAMS = 24;
const MAX_DESCRIPTION = 90;

export function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

const normalizeName = (value) => String(value).toLowerCase().replace(/^(?:functions?|tools?)[.:/]/, "").replace(/[\s_\-.]+/g, "");

/** Up to three names close to `wanted`, best first. */
export function nearestNames(wanted, names) {
  const target = normalizeName(wanted);
  if (!target) return [];
  const scored = [];
  for (const candidate of names) {
    const normalized = normalizeName(candidate);
    let score = editDistance(target, normalized);
    if (normalized === target) score = 0;
    else if (normalized.includes(target) || target.includes(normalized)) score = Math.min(score, 1);
    const tolerance = Math.max(2, Math.floor(Math.max(target.length, normalized.length) / 3));
    if (score <= tolerance) scored.push({ candidate, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate)).slice(0, 3).map((entry) => entry.candidate);
}

export function unknownToolHint(wanted, names) {
  if (names.length === 0) return null;
  const nearest = nearestNames(wanted, names);
  const lines = [];
  if (nearest.length > 0) lines.push(`Did you mean ${nearest.map((n) => `"${n}"`).join(" or ")}?`);
  const listed = names.slice(0, MAX_LISTED_TOOLS);
  const more = names.length > listed.length ? ` (+${names.length - listed.length} more)` : "";
  lines.push(`Available tools: ${listed.join(", ")}${more}.`);
  lines.push("Call one of these exact names.");
  return lines.join("\n");
}

function typeOf(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 8).map((value) => JSON.stringify(value)).join("|");
  if ("const" in schema) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.map(typeOf).join("|");
  const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
  if (type === "array") return `array<${typeOf(schema.items)}>`;
  return type ?? "any";
}

export function parameterSummary(toolName, parameters) {
  const properties = parameters?.properties;
  if (!properties || typeof properties !== "object") return null;
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const keys = Object.keys(properties).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  if (keys.length === 0) return `"${toolName}" takes no parameters; call it with {}.`;
  const lines = keys.slice(0, MAX_LISTED_PARAMS).map((key) => {
    const schema = properties[key] ?? {};
    const description = typeof schema.description === "string" ? schema.description.replace(/\s+/g, " ").trim() : "";
    const short = description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description;
    return `- ${key} (${typeOf(schema)}${required.has(key) ? ", required" : ""})${short ? `: ${short}` : ""}`;
  });
  if (keys.length > MAX_LISTED_PARAMS) lines.push(`- … ${keys.length - MAX_LISTED_PARAMS} more optional parameters`);
  const closed = parameters.additionalProperties === false ? " No other parameters are accepted." : "";
  return `Parameters of "${toolName}" (pass them as one JSON object):\n${lines.join("\n")}${closed}`;
}

export function apply(ctx) {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (!result?.isError || exec.parent !== undefined) return decision;
    // Leave results another policy already rewrote.
    if (decision?.kind !== "accept" || Object.hasOwn(decision, "content") || Object.hasOwn(decision, "value")) return decision;
    const code = result.error?.info?.code;
    let hint = null;
    try {
      if (code === "UNKNOWN_TOOL") {
        const names = ctx.tools.schemas(exec.agent).map((schema) => schema.name);
        hint = unknownToolHint(exec.name, names);
      } else if (code === "INVALID_ARGS") {
        const tool = ctx.tools.get(exec.name, exec.agent);
        hint = tool ? parameterSummary(tool.name, tool.parameters) : null;
      }
    } catch (error) {
      ctx.logger.warn(`${name}: could not build a hint for "${exec.name}": ${error?.message ?? error}`);
    }
    if (!hint) return decision;
    return { ...decision, content: [...result.content, { type: "text", text: `\n${hint}` }] };
  });
}
