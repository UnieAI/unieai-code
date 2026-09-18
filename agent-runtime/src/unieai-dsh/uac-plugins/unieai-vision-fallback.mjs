// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-vision-fallback.mjs — let a text-only model "see" an image.
 *
 * When the session's model takes text only, dsh's `read_image` refuses
 * ("model … does not declare image input"). In FrontierHarness all 7 such
 * calls failed across 4 image tasks and the model then guessed. A UnieAI
 * account usually also has a vision model on the same gateway, so this
 * plugin adds `describe_image`: the image is sent to that model, which
 * returns a detailed description and an exact transcription of any text, and
 * the answer comes back as the tool result.
 *
 * Config (the host sets it only when the default model is text-only):
 *   gatewayBaseUrl  the OpenAI-compatible gateway (`…/v1`)
 *   visionModel     a model on it that accepts images
 *   gatewayKeyRef   credential reference for the key (default UNIEAI_GATEWAY_API_KEY)
 * The key is resolved through `ctx.credentials` per call. A failed
 * `read_image` for lack of image input gets a hint pointing at the tool.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "unieai-vision-fallback";
export const inject = ["tools", "credentials"];

export const DEFAULTS = Object.freeze({
  gatewayKeyRef: "UNIEAI_GATEWAY_API_KEY",
  maxImageBytes: 10 * 1024 * 1024,
  maxTokens: 2_000,
  timeoutMs: 120_000,
});

export const MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
});

export const PROMPT = [
  "You are the eyes of a coding agent that cannot see images. Report what is in this image so the agent can act on it without seeing it.",
  "Answer in this order:",
  "1. VISIBLE TEXT: every piece of text in the image, transcribed exactly, character for character, with line breaks (code, numbers, labels, error messages, hashes, URLs). Write 'none' if there is no text.",
  "2. DESCRIPTION: what the image shows. For charts, tables and diagrams give the structure and every value you can read; for a board game or grid give the exact position of every piece.",
  "3. ANSWER: if the agent asked a question, answer it from what is visible, reading its words the way the image uses them (a label such as 'CODE:' is the code being asked about).",
  "Say explicitly when something is unreadable or ambiguous instead of guessing.",
].join("\n");

/** The data URL of an image file, checked for type and size. */
export async function imageDataUrl(path, { maxBytes = DEFAULTS.maxImageBytes } = {}) {
  const mime = MIME_TYPES[extname(path).toLowerCase()];
  if (!mime) throw new Error(`not a supported image type: ${path} (png, jpg, gif, webp, bmp)`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`not a file: ${path}`);
  if (info.size > maxBytes) throw new Error(`image is ${info.size} bytes; the limit is ${maxBytes}`);
  const bytes = await readFile(path);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Ask the vision model about one image; returns its text answer. */
export async function describeImage({ gatewayBaseUrl, visionModel, key, dataUrl, question, maxTokens, timeoutMs, fetchImpl = globalThis.fetch }) {
  const text = question ? `${PROMPT}\n\nThe agent's question: ${question}` : PROMPT;
  const response = await fetchImpl(`${gatewayBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: visionModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: dataUrl } }] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // Reported with the status below.
  }
  if (!response.ok) {
    const detail = json?.error?.message ?? "";
    throw new Error(`the vision model ${visionModel} failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
  }
  const answer = json?.choices?.[0]?.message?.content;
  const textAnswer = Array.isArray(answer) ? answer.map((part) => part?.text ?? "").join("") : String(answer ?? "");
  if (!textAnswer.trim()) throw new Error(`the vision model ${visionModel} returned no description`);
  return textAnswer.trim();
}

export function apply(ctx, rawConfig = {}, { fetchImpl = globalThis.fetch } = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  if (!config.gatewayBaseUrl || !config.visionModel) {
    ctx.logger.info(`${name}: no vision model configured; describe_image not offered`);
    return;
  }
  const toolName = "describe_image";

  ctx.tools.register(
    defineTool({
      name: toolName,
      description:
        "See an image file (screenshot, photo, chart, board position, scanned text) even though you cannot read images yourself: " +
        `a vision model (${config.visionModel}) looks at it and returns a precise description and an exact transcription of any text. ` +
        "Ask a specific question for the details you need. The description can still contain mistakes; verify what matters.",
      parameters: {
        path: { type: "string", required: true, description: "Path of the image file (png, jpg, gif, webp, bmp); relative paths resolve against the working directory." },
        question: { type: "string", description: "What you need to know from the image, e.g. 'the exact FEN of this chess position'." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            model: { type: "string", required: true },
            description: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Description of ${value.path} by ${value.model} (a model's reading, not the pixels):\n\n${value.description}` },
        ],
      },
      presentCall: (args) => ({ card: "generic", title: `Describe image ${args.path}` }),
      async execute(args, exec) {
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        const path = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
        const key = (await ctx.credentials.resolve(credentialRef(config.gatewayKeyRef)))?.value;
        if (!key) throw new Error("no gateway key is configured for the vision model");
        const dataUrl = await imageDataUrl(path, { maxBytes: config.maxImageBytes });
        const description = await describeImage({ ...config, key, dataUrl, question: args.question, fetchImpl });
        return { path: args.path, model: config.visionModel, description };
      },
    }),
  );

  // Point a refused read_image at the fallback.
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== "read_image" || !result?.isError || decision?.kind !== "accept") return decision;
    if (!/does not declare image input|image input/i.test(result.error?.message ?? "")) return decision;
    if (Object.hasOwn(decision, "content")) return decision;
    return {
      ...decision,
      content: [...result.content, { type: "text", text: `\nThis model cannot view images. Use ${toolName} with the same path to get a description from a vision model.` }],
    };
  });
}
