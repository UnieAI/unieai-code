// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-common.mjs — small helpers shared by the unieai-* dsh plugins.
 * Not a plugin itself.
 */
import { createHash } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * A secret by reference: dsh's credential store when the profile has one,
 * else the environment variable of that name (dsh's headless profile).
 */
export async function resolveCredential(ctx, ref) {
  // A real context throws on reading a service it did not inject; ask reflect.
  const store = ctx.reflect ? ctx.reflect.get("credentials") : ctx.credentials;
  if (store) return (await store.resolve(credentialRef(ref)))?.value ?? null;
  return process.env[ref] || null;
}

/**
 * A model-visible note from a plugin. The source kind is the plugin's own name
 * (dsh 0.2 refuses the retired generic `plugin` kind), which keeps it from being
 * rendered as a human prompt; `notice` gives UIs a one-line summary.
 */
export function pluginNotice(plugin, text, summary) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: plugin, form: "notice", summary: String(summary).slice(0, 120) },
  });
}

/** Joined text of the `text` blocks of a content array. */
export function textOfBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Every input token the provider saw for one call (uncached + cached). */
export function inputTokensOf(usage) {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/** A positive integer from config, then env, then the default. */
export function positiveInt(value, fallback) {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * The newest `assistant/message` event of `turn`, or null when the turn has
 * none yet. Scans back from the log head and stops at the turn's start.
 */
export function lastAssistantEventInTurn(session, turn) {
  for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === "assistant/message" && event.data?.turn === turn) return event;
    // Scanning backwards, the first turn/start is this turn's (or an older one).
    if (event.type === "turn/start") return null;
  }
  return null;
}
