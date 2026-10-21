// Copyright (c) 2026 UnieAI. All rights reserved.
// Self-hosted model servers on the uac engine: what dsh's settings declare,
// where each model is routed, and how the Studio-only features behave
// without a Studio sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAcpConnection } from "./acp-client.mjs";
import { createDshEngine, createDshHost } from "./engine.mjs";
import {
  SELF_HOSTED_CONTEXT_WINDOW,
  loadSelfHostedProviders,
  pickVisionRoute,
  renderPatch,
  renderSettings,
  routeModel,
  selectPlugins,
  selfHostedKeyEnv,
  selfHostedProviderSpec,
  writeDshAccount,
} from "./config.mjs";
import { createOneShotModel } from "./unieai-oneshot.mjs";
import { studioMcpServer } from "./unieai-mcp-servers.mjs";

/** A UnieAI home with the given self-hosted servers and (optionally) a Studio login. */
function makeHome({ servers = [], studio = null, config = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "uac-self-hosted-"));
  if (servers.length) writeFileSync(join(home, "unieai-self-hosted.json"), JSON.stringify({ version: 1, providers: servers }));
  if (studio) writeFileSync(join(home, "unieai.json"), JSON.stringify(studio));
  if (config) writeFileSync(join(home, "config.toml"), config);
  return home;
}

/** Runs `fn` with UNIEAI_HOME at `home` (loadCredentials reads it). */
function withHome(home, fn) {
  const saved = process.env.UNIEAI_HOME;
  process.env.UNIEAI_HOME = home;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.UNIEAI_HOME;
    else process.env.UNIEAI_HOME = saved;
  }
}

const LOCAL = {
  id: "local",
  base_url: "http://localhost:11434/v1",
  models: [{ id: "qwen2.5:0.5b" }, { id: "llava", vision: true, context_window: 8192 }],
};
const GPU = {
  id: "gpu",
  base_url: "http://gpu-box:8000/v1",
  api_key: "sk-stored-secret",
  models: [{ id: "Qwen/Qwen3-8B", context_window: 40960 }],
};
const STUDIO = {
  studio_url: "https://studio.example",
  access_token: "",
  refresh_token: "",
  expires_at: 0,
  gateway_base_url: "https://gw.example/v1",
  gateway_api_key: "sk-gateway",
  available_models: [{ id: "DeepSeek-V4-Flash", context_window: 131072 }],
};

test("loadSelfHostedProviders reads the file the CLI writes", () => {
  const home = makeHome({ servers: [LOCAL, GPU] });
  const servers = loadSelfHostedProviders(home);
  assert.deepEqual(servers.map((s) => s.id), ["local", "gpu"]);
  assert.equal(servers[1].apiKey, "sk-stored-secret");
  assert.deepEqual(servers[0].models[1], { id: "llava", contextWindow: 8192, vision: true });
  assert.deepEqual(loadSelfHostedProviders(join(home, "missing")), []);
  rmSync(home, { recursive: true, force: true });
});

test("routeModel: <server>/<model> runs on that server, anything else on the gateway", () => {
  const servers = loadSelfHostedProviders(makeHome({ servers: [LOCAL, GPU] }));
  assert.deepEqual(
    (({ provider, model }) => ({ provider, model }))(routeModel("gpu/Qwen/Qwen3-8B", servers)),
    { provider: "gpu", model: "Qwen/Qwen3-8B" },
  );
  assert.equal(routeModel("local/qwen2.5:0.5b", servers).provider, "local");
  assert.equal(routeModel("DeepSeek-V4-Flash", servers).provider, "unieai");
  // A gateway id with a slash whose prefix is no server stays on the gateway.
  assert.deepEqual(
    (({ provider, model }) => ({ provider, model }))(routeModel("openai/gpt-oss-120b", servers)),
    { provider: "unieai", model: "openai/gpt-oss-120b" },
  );
  assert.equal(routeModel("local/not-served", servers).provider, "unieai");
});

test("settings: a self-hosted-only setup declares no gateway, each server with its own key env var", () => {
  const [local, gpu] = loadSelfHostedProviders(makeHome({ servers: [LOCAL, GPU] }));
  const yaml = renderSettings({
    baseUrl: null,
    models: [],
    defaultModel: "qwen2.5:0.5b",
    defaultProvider: "local",
    providers: [selfHostedProviderSpec(local), selfHostedProviderSpec(gpu)],
  });
  assert.doesNotMatch(yaml, /\n {4}unieai:\n/);
  assert.match(yaml, /\n {4}local:\n {6}displayName: "local \(self-hosted\)"\n {6}apiKeyEnv: UNIEAI_SELF_HOSTED_LOCAL_API_KEY\n {6}api: openai-completions\n {6}baseURL: "http:\/\/localhost:11434\/v1"/);
  assert.match(yaml, new RegExp(`- id: "qwen2.5:0.5b"\\n {10}contextWindow: ${SELF_HOSTED_CONTEXT_WINDOW}\\n`), "an unknown window gets the conservative default");
  assert.match(yaml, /- id: "llava"\n {10}contextWindow: 8192\n {10}input: \[text, image\]/);
  assert.match(yaml, /\n {4}gpu:\n[\s\S]*apiKeyEnv: UNIEAI_SELF_HOSTED_GPU_API_KEY/);
  assert.match(yaml, /agent-default-model:\n {2}provider: local\n {2}model: "qwen2.5:0.5b"/);
  assert.doesNotMatch(yaml, /sk-stored-secret/, "keys never reach settings.yaml");
  assert.equal(selfHostedKeyEnv("my-box_2"), "UNIEAI_SELF_HOSTED_MY_BOX_2_API_KEY");
});

test("writeDshAccount: self-hosted alone is enough; keys go to the owner-only credential store", () => {
  const home = makeHome({ servers: [LOCAL, { ...GPU, api_key: undefined, api_key_env: "GPU_KEY" }] });
  const dshHome = join(home, "dsh");
  const account = withHome(home, () => writeDshAccount({ env: { DSH_HOME: dshHome, GPU_KEY: "sk-from-env" } }));
  assert.equal(account.defaultModel, "local/qwen2.5:0.5b");
  assert.deepEqual(account.defaultRoute, { provider: "local", model: "qwen2.5:0.5b" });
  assert.deepEqual(account.models, ["local/qwen2.5:0.5b", "local/llava", "gpu/Qwen/Qwen3-8B"]);
  assert.equal(account.gatewayBaseUrl, null);
  // Text-only default with a vision model on the same server: describe_image goes there.
  assert.deepEqual(account.vision, { visionModel: "llava", visionBaseUrl: "http://localhost:11434/v1", visionKeyRef: "UNIEAI_SELF_HOSTED_LOCAL_API_KEY" });

  const settings = readFileSync(join(dshHome, "settings.yaml"), "utf8");
  assert.doesNotMatch(settings, /\n {4}unieai:\n/);
  assert.doesNotMatch(settings, /sk-from-env/);
  const credentials = readFileSync(join(dshHome, ".credentials.yaml"), "utf8");
  assert.match(credentials, /UNIEAI_SELF_HOSTED_GPU_API_KEY: "sk-from-env"/);
  assert.match(credentials, /UNIEAI_SELF_HOSTED_LOCAL_API_KEY: "none"/, "dsh refuses a keyless provider: a placeholder");
  assert.doesNotMatch(credentials, /UNIEAI_GATEWAY_API_KEY/, "dsh rejects the whole store over an empty value");
  rmSync(home, { recursive: true, force: true });
});

test("writeDshAccount: with Studio too, both catalogs are declared and config.toml picks the default", () => {
  const home = makeHome({ servers: [GPU], studio: STUDIO, config: 'model = "gpu/Qwen/Qwen3-8B"\n' });
  const dshHome = join(home, "dsh");
  const account = withHome(home, () => writeDshAccount({ env: { DSH_HOME: dshHome } }));
  assert.deepEqual(account.defaultRoute, { provider: "gpu", model: "Qwen/Qwen3-8B" });
  assert.deepEqual(account.models, ["gpu/Qwen/Qwen3-8B", "DeepSeek-V4-Flash"]);
  const settings = readFileSync(join(dshHome, "settings.yaml"), "utf8");
  assert.match(settings, /\n {4}unieai:\n[\s\S]*- id: "DeepSeek-V4-Flash"/);
  assert.doesNotMatch(settings, /- id: "gpu\/Qwen/, "the gateway does not declare the server's model");
  assert.match(settings, /\n {4}gpu:\n[\s\S]*- id: "Qwen\/Qwen3-8B"\n {10}contextWindow: 40960/);
  const credentials = readFileSync(join(dshHome, ".credentials.yaml"), "utf8");
  assert.match(credentials, /UNIEAI_GATEWAY_API_KEY: "sk-gateway"/);
  assert.match(credentials, /UNIEAI_SELF_HOSTED_GPU_API_KEY: "sk-stored-secret"/);

  // Without the config.toml choice Studio's first model stays the default.
  writeFileSync(join(home, "config.toml"), "");
  const studioFirst = withHome(home, () => writeDshAccount({ env: { DSH_HOME: dshHome } }));
  assert.deepEqual(studioFirst.defaultRoute, { provider: "unieai", model: "DeepSeek-V4-Flash" });
  rmSync(home, { recursive: true, force: true });
});

test("writeDshAccount: neither a sign-in nor a server is an error that says how to fix it", () => {
  const home = makeHome();
  assert.throws(() => withHome(home, () => writeDshAccount({ env: { DSH_HOME: join(home, "dsh") } })), /--self-hosted/);
  // A model only the (absent) gateway could serve falls back to a server's.
  const withServer = makeHome({ servers: [LOCAL], config: 'model = "DeepSeek-V4-Flash"\n' });
  const account = withHome(withServer, () => writeDshAccount({ env: { DSH_HOME: join(withServer, "dsh") } }));
  assert.equal(account.defaultModel, "local/qwen2.5:0.5b");
  rmSync(home, { recursive: true, force: true });
  rmSync(withServer, { recursive: true, force: true });
});

test("vision fallback prefers what the gateway has, and is off when nothing can see", () => {
  const servers = loadSelfHostedProviders(makeHome({ servers: [LOCAL] }));
  const catalog = [
    { id: "DeepSeek-V4-Flash", input_modalities: ["text"] },
    { id: "Qwen-VL", input_modalities: ["text", "image"] },
    { id: "local/qwen2.5:0.5b", input_modalities: ["text"] },
  ];
  assert.deepEqual(pickVisionRoute({ catalog, defaultModel: "DeepSeek-V4-Flash", selfHosted: servers, gatewayBaseUrl: "https://gw/v1" }), {
    visionModel: "Qwen-VL",
    visionBaseUrl: null,
    visionKeyRef: null,
  });
  assert.equal(pickVisionRoute({ catalog: catalog.filter((m) => m.id !== "Qwen-VL"), defaultModel: "local/qwen2.5:0.5b", selfHosted: servers }), null);

  const plugins = selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-vision-fallback,unieai-web-search" });
  const patch = renderPatch({
    defaultModel: "qwen2.5:0.5b",
    defaultProvider: "local",
    plugins,
    gatewayBaseUrl: null,
    visionModel: "llava",
    visionBaseUrl: "http://localhost:11434/v1",
    visionKeyRef: "UNIEAI_SELF_HOSTED_LOCAL_API_KEY",
  });
  assert.match(patch, /- id: acp\n {2}config:\n {4}provider: local\n {4}model: "qwen2.5:0.5b"/);
  assert.match(patch, /gatewayBaseUrl: "http:\/\/localhost:11434\/v1"[\s\S]*visionModel: "llava"[\s\S]*gatewayKeyRef: "UNIEAI_SELF_HOSTED_LOCAL_API_KEY"/);
  // No gateway: web search keeps only the user's own search keys (Brave,
  // Tavily, SerpAPI), and offers no tool when there are none.
  assert.doesNotMatch(patch, /gatewayBaseUrl: "https/);
});

test("Studio's MCP server is not attached without a Studio sign-in", () => {
  assert.equal(studioMcpServer({ gatewayBaseUrl: "", gatewayApiKey: "" }), null);
});

test("thread titles of a self-hosted model are asked of its server, with its key", async () => {
  const calls = [];
  const oneShot = createOneShotModel({
    credentials: () => ({ signedIn: false, gatewayBaseUrl: "", gatewayApiKey: "" }),
    route: (model) => (model === "gpu/Qwen/Qwen3-8B" ? { baseUrl: "http://gpu-box:8000/v1", apiKey: "sk-stored-secret", model: "Qwen/Qwen3-8B" } : null),
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.authorization, model: JSON.parse(init.body).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Fix the build"}' } }] }), { status: 200 });
    },
  });
  const answer = await oneShot({ model: "gpu/Qwen/Qwen3-8B", prompt: "title?", outputSchema: { type: "object" } });
  assert.equal(answer, '{"title":"Fix the build"}');
  assert.deepEqual(calls, [{ url: "http://gpu-box:8000/v1/chat/completions", auth: "Bearer sk-stored-secret", model: "Qwen/Qwen3-8B" }]);
  // A gateway model without a sign-in still fails plainly.
  await assert.rejects(oneShot({ model: "DeepSeek-V4-Flash", prompt: "x" }), /not signed in/);
});

test("switching a thread to another server's model selects it on that provider", async () => {
  const value = (provider, id) => JSON.stringify([provider, id]);
  const options = [{ id: "model", type: "select", currentValue: value("local", "qwen2.5:0.5b"), options: [
    { value: value("local", "qwen2.5:0.5b") },
    { value: value("gpu", "Qwen/Qwen3-8B") },
    { value: value("unieai", "DeepSeek-V4-Flash") },
  ] }];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const client = createAcpConnection({ input: toClient, output: toAgent });
  const agent = createAcpConnection({ input: toAgent, output: toClient });
  const selected = [];
  agent.onRequest("session/new", () => ({ sessionId: "s1", configOptions: options }));
  agent.onRequest("session/set_config_option", (params) => {
    selected.push(params.value);
    return { configOptions: options };
  });
  agent.onRequest("session/prompt", () => ({ stopReason: "end_turn" }));
  const host = createDshHost({ connect: async () => client, connectControl: async () => ({ request: async () => ({}), close() {} }) });
  const servers = loadSelfHostedProviders(makeHome({ servers: [LOCAL, GPU] }));
  const route = (slug) => {
    const { provider, model } = routeModel(slug, servers);
    return { provider, model };
  };
  const engine = createDshEngine({ host, workspace: "/w", model: "qwen2.5:0.5b", provider: "local", routeModel: route });
  await engine.send("hi");
  await engine.configure({ model: "gpu/Qwen/Qwen3-8B" });
  await engine.configure({ model: "DeepSeek-V4-Flash" });
  assert.deepEqual(selected.slice(-2), [value("gpu", "Qwen/Qwen3-8B"), value("unieai", "DeepSeek-V4-Flash")]);
});
