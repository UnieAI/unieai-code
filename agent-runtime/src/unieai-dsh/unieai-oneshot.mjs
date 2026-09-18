// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-oneshot.mjs — a single model call with no tools, for the client's
 * temporary structured threads.
 *
 * The TUI generates thread titles (and other small structured answers) on a
 * hidden, ephemeral thread it starts read-only with approvals off, then reads
 * one JSON object back. Routing that through dsh would hand a title prompt an
 * agent loop with a shell, and dsh's permission mode is process-wide, so the
 * thread could not honestly be reported read-only. These turns are instead
 * one gateway call: no tools at all, which is what read-only means here.
 *
 * `outputSchema` becomes the chat `response_format` (json_schema) plus an
 * instruction to answer with the JSON object only, since gateways and models
 * differ in whether they enforce the format; code fences are stripped.
 */
import { loadCredentials } from "../config.mjs";

/** The JSON object in `text`: fenced or bare, else the text unchanged. */
export function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : trimmed;
}

export function oneShotMessages(prompt, outputSchema) {
  const messages = [];
  if (outputSchema) {
    messages.push({
      role: "system",
      content:
        "Reply with only one JSON object that matches this JSON schema, with no prose and no code fences:\n" +
        JSON.stringify(outputSchema),
    });
  }
  messages.push({ role: "user", content: String(prompt ?? "") });
  return messages;
}

/**
 * The model call, reading the signed-in account on each use (a Studio sync
 * may have rotated the key).
 */
export function createOneShotModel({ fetchImpl = globalThis.fetch, credentials = loadCredentials, timeoutMs = 60_000 } = {}) {
  return async function oneShot({ model, prompt, outputSchema = null, signal } = {}) {
    const account = credentials();
    if (!account?.gatewayBaseUrl || !account?.gatewayApiKey) throw new Error("not signed in to UnieAI");
    const body = {
      model,
      messages: oneShotMessages(prompt, outputSchema),
      max_tokens: 512,
      ...(outputSchema
        ? { response_format: { type: "json_schema", json_schema: { name: "output", schema: outputSchema, strict: true } } }
        : {}),
    };
    const response = await fetchImpl(`${account.gatewayBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${account.gatewayApiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // Reported below.
    }
    if (!response.ok) throw new Error(`model call failed (HTTP ${response.status})${json?.error?.message ? `: ${String(json.error.message).slice(0, 200)}` : ""}`);
    const content = json?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : String(content ?? "");
    return outputSchema ? extractJsonObject(text) : text.trim();
  };
}

/** An engine (server.mjs shape) whose every turn is one oneShot call. */
export function createOneShotEngine({ oneShot, model, onText }) {
  return {
    async send(text, { abortSignal, outputSchema = null } = {}) {
      const answer = await oneShot({ model, prompt: text, outputSchema, signal: abortSignal });
      if (answer) onText(answer);
      return { text: answer };
    },
  };
}
