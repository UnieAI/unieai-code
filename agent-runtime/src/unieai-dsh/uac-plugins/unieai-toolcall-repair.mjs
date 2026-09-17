// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-toolcall-repair.mjs — fix tool names the model got almost right.
 *
 * Open models often call `Read` for `read`, or prefix the name the way
 * another harness taught them (`functions.read`, `default_api:read`). dsh
 * answers those with UNKNOWN_TOOL and a wasted step. unieai-agent-core runs
 * the unique case-insensitive match instead; this plugin does the same one
 * layer earlier, in an `llm/stream` wrapper around agent-loop requests: the
 * name in `tool-call-delta` and `block-end` chunks is rewritten to the one
 * tool in the request that matches
 *   1. case-insensitively, else
 *   2. after dropping a known prefix (`functions.`, `functions:`, `tools.`,
 *      `default_api:`, `default_api.`), case-insensitively.
 * Ambiguous or unmatched names pass through untouched (unieai-loop-toolerrors
 * then lists the candidates).
 *
 * Rewriting the stream, not the dispatch, keeps the recorded assistant message
 * and the executed call identical, so approval, guards and presentation all
 * judge the repaired name.
 */
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";

export const name = "unieai-toolcall-repair";

const PREFIXES = /^(?:functions?|tools?|default_api)[.:]/i;

/** The repaired name, or null when `wanted` should pass through. */
export function repairToolName(wanted, names) {
  if (typeof wanted !== "string" || !wanted || names.includes(wanted)) return null;
  const unique = (candidate) => {
    const lower = candidate.toLowerCase();
    const matches = names.filter((toolName) => toolName.toLowerCase() === lower);
    return matches.length === 1 ? matches[0] : null;
  };
  const cased = unique(wanted);
  if (cased) return cased;
  const stripped = wanted.replace(PREFIXES, "");
  return stripped !== wanted && stripped ? (names.includes(stripped) ? stripped : unique(stripped)) : null;
}

export async function* repairStream(source, names, onRepair = () => {}) {
  const repaired = new Map(); // block index → repaired name
  for await (const chunk of source) {
    if (chunk?.type === "tool-call-delta" && chunk.name) {
      const fixed = repairToolName(chunk.name, names);
      if (fixed) {
        if (!repaired.has(chunk.index)) onRepair(chunk.name, fixed);
        repaired.set(chunk.index, fixed);
        yield { ...chunk, name: fixed };
        continue;
      }
    } else if (chunk?.type === "block-end" && chunk.block?.type === "tool-call") {
      const fixed = repaired.get(chunk.index) ?? repairToolName(chunk.block.name, names);
      if (fixed && fixed !== chunk.block.name) {
        if (!repaired.has(chunk.index)) onRepair(chunk.block.name, fixed);
        yield { ...chunk, block: { ...chunk.block, name: fixed } };
        continue;
      }
    }
    yield chunk;
  }
}

export function apply(ctx) {
  ctx.on("llm/stream", (options, next) => {
    if (!isAgentLoopRequest(options) || !Array.isArray(options.tools) || options.tools.length === 0) return next();
    const names = options.tools.map((tool) => tool.name);
    return repairStream(next(), names, (from, to) => ctx.logger.info(`${name}: tool call "${from}" repaired to "${to}"`));
  });
}
