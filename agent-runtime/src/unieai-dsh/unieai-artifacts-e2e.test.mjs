// Copyright (c) 2026 UnieAI. All rights reserved.
// End to end: publish_artifact inside a real dsh (headless), loaded through
// uac's own patch, against a scripted model and the in-memory ava stub, with
// an isolated UNIEAI_HOME holding a fake Rabi login. Two turns: the first
// loads the bundled artifact skill and publishes a page; the second publishes
// the edited page (same path: updated in place) and lists.
// UNIEAI_E2E_DUMP=1 prints the tool results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStub } from "../../scripts/unieai-ava-artifacts-stub.mjs";
import { installedDshBin, renderPatch, selectPlugins } from "./config.mjs";

const MODEL = "scripted-model";
const KEY = "rk-e2e-desktop-key";

/** An OpenAI chat-completions server whose replies come from `script(body, index)`. */
async function scriptedModel(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw);
      const title = !body.tools && JSON.stringify(body.messages).includes("Generate the session title");
      const reply = title ? { text: "Title" } : script(body, requests.length);
      if (!title) requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (reply.text) send({ role: "assistant", content: reply.text });
      (reply.calls ?? []).forEach((call, index) =>
        send({ tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] }),
      );
      send({}, reply.calls?.length ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

async function runTurn({ model, unieaiHome, dshHome, work, prompt }) {
  writeFileSync(
    join(dshHome, "settings.yaml"),
    [
      "llm-pi-ai:",
      "  providers:",
      "    unieai:",
      "      apiKeyEnv: UNIEAI_GATEWAY_API_KEY",
      "      api: openai-completions",
      `      baseURL: ${JSON.stringify(model.url)}`,
      "      retryPolicy:",
      "        mode: normal",
      "        maxRetries: 0",
      "      models:",
      `        - id: ${MODEL}`,
      "agent-default-model:",
      "  provider: unieai",
      `  model: ${MODEL}`,
      "",
    ].join("\n"),
  );
  // uac's own patch (what prepareDsh writes), minus the ACP route and persona.
  const patch = join(dshHome, "uac.patch.yml");
  const body = renderPatch({ defaultModel: MODEL, acp: false, persona: false, home: unieaiHome, plugins: selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-skills" }), artifacts: true });
  writeFileSync(patch, ["- id: agent-default-model", "  config:", "    provider: unieai", `    model: ${MODEL}`, ""].join("\n") + body);
  const child = spawn(process.execPath, [installedDshBin(), "--profile", "headless", "--patch", patch, "--json", "-"], {
    cwd: work,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      UNIEAI_HOME: unieaiHome,
      CODEX_HOME: unieaiHome,
      DSH_TELEMETRY_DISABLED: "1",
      DSH_PERMISSION_MODE: "danger-full-access",
      UNIEAI_GATEWAY_API_KEY: "model-key",
      UNIEAI_DSH_PLUGINS: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(prompt);
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stderr };
}

const toolTexts = (body) =>
  body.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("")));
const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name);
const page = (text) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Release Notes</title><style>:root{--bg:#fff}body{background:var(--bg)}</style></head><body><h1>${text}</h1></body></html>`;

test("a uac turn publishes a page, a later turn updates it in place and lists it", { timeout: 180_000 }, async () => {
  const stub = await startStub({ apiKey: KEY });
  const root = mkdtempSync(join(tmpdir(), "unieai-artifacts-e2e-"));
  const unieaiHome = join(root, "unieai-home");
  const dshHome = join(root, "dsh-home");
  const work = join(root, "work");
  for (const dir of [unieaiHome, dshHome, join(work, ".git"), join(work, "pages")]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(unieaiHome, "unieai.json"),
    JSON.stringify({ account: "rabi", studio_url: stub.url, access_token: "", refresh_token: "", expires_at: 0, gateway_base_url: `${stub.url}/api/desktop/v1`, gateway_api_key: KEY, gateway_base_url_locked: true }),
  );
  writeFileSync(join(work, "pages", "notes.html"), page("v1"));
  const dumps = [];
  try {
    // Turn 1: load the skill, publish.
    const first = await scriptedModel((_body, index) =>
      index === 0
        ? { calls: [{ name: "skill", args: { name: "artifact" } }] }
        : index === 1
          ? { calls: [{ name: "publish_artifact", args: { action: "publish", path: "pages/notes.html", description: "What changed in 1.2", header: { icon: "notes" } } }] }
          : { text: "Published." },
    );
    const run1 = await runTurn({ model: first, unieaiHome, dshHome, work, prompt: "publish the release notes page" });
    first.close();
    assert.equal(run1.code, 0, run1.stderr.slice(-2000));
    assert.ok(toolNames(first.requests[0]).includes("publish_artifact"), `tools: ${toolNames(first.requests[0])}`);
    assert.match(JSON.stringify(first.requests[0]), /artifact/, "the bundled skill is in the catalog");
    const [skillText, published] = toolTexts(first.requests[2]);
    assert.match(skillText, /One self-contained `index.html`/);
    assert.match(published, /^Published a new page: "Release Notes"\nhttp:\/\/127\.0\.0\.1:\d+\/share\/html\/[\w-]+\nid art_1 · version 1 · private · 1 file/);
    dumps.push(`turn 1 publish_artifact -> ${published}`);

    // Turn 2: the page was edited; publish the same path, then list.
    writeFileSync(join(work, "pages", "notes.html"), page("v2"));
    const second = await scriptedModel((_body, index) =>
      index === 0
        ? { calls: [{ name: "publish_artifact", args: { action: "publish", path: "pages/notes.html" } }] }
        : index === 1
          ? { calls: [{ name: "publish_artifact", args: { action: "update_settings", id: "art_1", visibility: "org", header: { description: "For the team" } } }] }
          : index === 2
            ? { calls: [{ name: "publish_artifact", args: { action: "list" } }] }
            : { text: "Updated." },
    );
    const run2 = await runTurn({ model: second, unieaiHome, dshHome, work, prompt: "update the page" });
    second.close();
    assert.equal(run2.code, 0, run2.stderr.slice(-2000));
    const [updated, settings, listed] = toolTexts(second.requests[3]);
    assert.match(settings, /^Updated the settings of artifact art_1: visibility org, header updated\./);
    assert.match(updated, /^Updated the page in place: "Release Notes"[\s\S]*id art_1 · version 2/);
    assert.match(listed, /^1 artifact:\n- "Release Notes" http:\/\/127\.0\.0\.1:\d+\/share\/html\/[\w-]+\n {3}id art_1 · version 2/);
    dumps.push(`turn 2 publish_artifact -> ${updated}`, `turn 2 publish_artifact(update_settings) -> ${settings}`, `turn 2 publish_artifact(list) -> ${listed}`);

    assert.equal(stub.store.size, 1);
    const row = stub.store.get("art_1");
    assert.equal(row.version, 2);
    assert.deepEqual([row.visibility, row.orgId], ["org", "org_a"], "one org: used without asking");
    assert.deepEqual(row.header, { showAuthor: false, description: "For the team" });
    assert.match(Buffer.from(row.files[0].contentBase64, "base64").toString(), /v2/);
    const viewed = await (await fetch(`${stub.url}/share/html/${row.token}`)).text();
    assert.match(viewed, /<h1>v2<\/h1>/);
    const calls = stub.requests.filter((r) => r.path.startsWith("/api/")).map((r) => `${r.method} ${r.path}${r.query} auth=${r.authorized}`);
    assert.deepEqual(calls.map((c) => c.replace(/ auth=true$/, "")), [
      "POST /api/agent-next/artifacts/site",
      "PUT /api/agent-next/artifacts/art_1",
      "PATCH /api/agent-next/artifacts/art_1",
      "GET /api/agent-next/artifacts?mine=1&source=unieai-code",
    ]);
    dumps.push(`ava stub saw: ${calls.join(" | ")}`, `id memory: ${readFileSync(join(unieaiHome, "artifacts.json"), "utf8").trim()}`);
    for (const text of [run1.stderr, run2.stderr, readFileSync(join(unieaiHome, "artifacts.json"), "utf8"), ...first.requests.map(JSON.stringify), ...second.requests.map(JSON.stringify)]) {
      assert.equal(text.includes(KEY), false, "the desktop key never reaches the model, logs or the memory file");
    }
  } finally {
    if (process.env.UNIEAI_E2E_DUMP) console.error(dumps.join("\n\n"));
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  }
});
