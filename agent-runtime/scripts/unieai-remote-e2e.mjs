#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-e2e.mjs — Remote Control end to end against the real uac
 * server (real dsh), in an isolated home:
 *
 *   fake model gateway ← dsh ← uac server ⇄ bridge ⇄ reference relay ⇄ headless browser
 *                                   ⇅
 *                             TUI-like socket client
 *
 * It pairs a browser from the pairing link, reads the thread, starts a turn
 * from the browser, streams the items, has the model ask to run a command,
 * approves it from the browser while the TUI-like client is also asked,
 * checks the first answer won, and checks that every frame the relay carried
 * was ciphertext plus routing metadata.
 *
 *   node agent-runtime/scripts/unieai-remote-e2e.mjs
 *
 * With UNIEAI_E2E_GATEWAY_URL and UNIEAI_E2E_GATEWAY_KEY (and optionally
 * UNIEAI_E2E_MODEL) it uses that gateway instead of the fake model; the key
 * is only passed through, never printed. The real ~/.unieai is never used.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSocketClient } from "../src/app-server/unieai-socket-client.mjs";
import { createRemoteClient, parsePairingLink } from "../src/app-server/unieai-remote-client.mjs";
import { startRemoteRelay, stubValidator } from "../src/remote-relay/unieai-remote-relay.mjs";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
const say = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}
const check = (ok, message) => {
  if (!ok) throw new Error(`FAILED: ${message}`);
  say(`  ✓ ${message}`);
};

const PROMPT = "Create the marker file for the remote-control test.";
const MARKER = "remote-e2e-marker.txt";

// --- A fake OpenAI-compatible model: one tool call, then an answer --------------

function startFakeModel() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://model");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "fake-model", object: "model" }] }));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push(body);
    const tools = (body.tools ?? []).map((tool) => tool.function ?? tool);
    const last = body.messages?.at(-1);
    const sentToolCall = body.messages?.some((message) => message.role === "assistant" && message.tool_calls?.length);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const shell = tools.find((tool) => tool.name === "exec_command") ?? tools.find((tool) => tool.name === "bash");
    // A title or other tool-less call, or the turn after the command ran.
    if (!shell || sentToolCall || last?.role === "tool") {
      for (const word of ["The ", "marker ", "file ", "is ", "in ", "place."]) {
        send({ content: word });
        await wait(15);
      }
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    send({ content: "I will create it now." });
    const props = shell.parameters?.properties ?? {};
    const args = { [props.cmd ? "cmd" : "command"]: `echo created-from-remote > ${MARKER}` };
    // Ask for wider access than the sandbox gives: that is what needs the
    // user's approval under workspace-write.
    const escalations = props.sandbox_permissions?.enum ?? [];
    if (escalations.length) {
      args.sandbox_permissions = escalations.at(-1);
      args.justification = "The remote-control test needs to run this command outside the sandbox.";
    }
    send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: shell.name, arguments: JSON.stringify(args) } }] });
    send({}, "tool_calls");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

// --- Run --------------------------------------------------------------------------

const scratch = process.env.UNIEAI_E2E_DIR || tmpdir();
const home = mkdtempSync(join(scratch, "rc-"));
const workdir = join(home, "work");
mkdirSync(workdir);
const socketPath = join(home, "uac.sock");
const real = Boolean(process.env.UNIEAI_E2E_GATEWAY_URL && process.env.UNIEAI_E2E_GATEWAY_KEY);
const model = real ? null : await startFakeModel();
const modelId = real ? process.env.UNIEAI_E2E_MODEL || "" : "fake-model";
writeFileSync(
  join(home, "unieai.json"),
  JSON.stringify({
    account: "rabi",
    studio_url: "https://agent.example.test",
    access_token: "e2e-desktop-key",
    refresh_token: "",
    expires_at: 9_999_999_999,
    gateway_base_url: real ? process.env.UNIEAI_E2E_GATEWAY_URL : model.url,
    gateway_api_key: real ? process.env.UNIEAI_E2E_GATEWAY_KEY : "fake-key",
    available_models: modelId ? [{ id: modelId }] : [],
  }),
  { mode: 0o600 },
);
const frames = [];
const relay = await startRemoteRelay({ validateHost: stubValidator, onFrame: (direction, frame) => frames.push({ direction, frame }) });
say(`home ${home}`);
say(`relay ${relay.url}  model ${real ? "real gateway" : model.url}`);

const serverLog = [];
const uac = spawn(process.execPath, [join(RUNTIME, "bin/unieai-uac-server.mjs")], {
  cwd: workdir,
  env: { ...process.env, CODEX_HOME: home, UNIEAI_HOME: home, UNIEAI_APP_SERVER_SOCKET: socketPath, UNIEAI_UAC_IDLE_EXIT_MS: "600000", UNIEAI_E2E_GATEWAY_KEY: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
uac.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

let exitCode = 1;
let phone = null;
let tui = null;
try {
  await until(() => existsSync(socketPath), "the uac server's socket", 30_000);
  say("uac server is up");
  tui = connectSocketClient(socketPath);
  await tui.call("initialize", { clientInfo: { name: "e2e-tui", version: "0" }, capabilities: {} });
  const { thread } = await tui.call("thread/start", { cwd: workdir, sandbox: "workspace-write", approvalPolicy: "untrusted", ...(modelId ? { model: modelId } : {}) });
  say(`TUI started thread ${thread.id}`);

  const started = await tui.call("unieai/remote/start", { relayUrl: relay.relayUrl });
  const shown = started.link.replace(/psk=[^&]+/, "psk=<secret>").replace(/join=[^&]+/, "join=<token>");
  say(`pairing link: ${shown}`);
  check(new URL(started.link).search === "", "the link keeps every secret in the fragment");

  // The headless browser.
  const host = parsePairingLink(started.link);
  const seen = { notes: [], asked: [] };
  let answerApproval = null;
  phone = createRemoteClient({
    host,
    psk: host.psk,
    deviceName: "e2e headless browser",
    onNotification: (method, params) => seen.notes.push([method, params]),
    onRequest: (method, params) =>
      new Promise((resolve) => {
        seen.asked.push({ method, params });
        answerApproval = resolve;
      }),
    onPaired: (device) => (seen.device = device),
  });
  await phone.connect();
  check(Boolean(seen.device?.deviceId), `paired as ${seen.device?.deviceId}`);
  const read = await phone.request("thread/read", { threadId: thread.id, includeTurns: true });
  check(read.thread.id === thread.id, "the browser read the thread");

  await phone.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: PROMPT }] });
  say("browser started a turn");
  const tuiAsk = await tui.next((m) => m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval", { timeoutMs: 120_000 });
  await until(() => seen.asked.length > 0, "the browser to be asked");
  say(`approval asked of both: ${tuiAsk.params.command ?? tuiAsk.method}`);
  answerApproval({ decision: "accept" });
  say("browser approved");
  const resolved = await tui.next((m) => m.method === "serverRequest/resolved");
  check(resolved.params.requestId === tuiAsk.id, "the TUI was told the approval was answered elsewhere (serverRequest/resolved)");
  tui.send({ id: tuiAsk.id, result: { decision: "decline" } });

  await until(() => seen.notes.some(([method]) => method === "turn/completed"), "the turn to complete", 120_000);
  const text = seen.notes.filter(([m]) => m === "item/agentMessage/delta").map(([, p]) => p.delta).join("");
  say(`streamed to the browser: ${JSON.stringify(text)}`);
  const kinds = [...new Set(seen.notes.filter(([m]) => m === "item/completed").map(([, p]) => p.item.type))];
  say(`items completed on the browser: ${kinds.join(", ")}`);
  check(seen.notes.filter(([m]) => m === "item/agentMessage/delta").length > 1, "the answer streamed in deltas");
  const marker = join(workdir, MARKER);
  check(existsSync(marker) && readFileSync(marker, "utf8").includes("created-from-remote"), "the approved command ran (first answer won: accept, not the TUI's late decline)");
  check(tui.messages.some((m) => m.method === "turn/completed"), "the TUI watched the same turn");

  // What the relay saw.
  const secrets = [PROMPT, MARKER, thread.id, "requestApproval", "turn/start", "agentMessage", host.psk, host.hostKey, seen.device.publicKey, "e2e headless browser"];
  const leaks = frames.filter(({ frame }) => secrets.some((secret) => JSON.stringify(frame).includes(secret)));
  const fields = new Set(frames.flatMap(({ frame }) => Object.keys(frame)));
  const types = {};
  for (const { frame } of frames) types[frame.t] = (types[frame.t] ?? 0) + 1;
  say(`relay carried ${frames.length} frames: ${JSON.stringify(types)}; fields: ${[...fields].sort().join(",")}`);
  say(`sample data frame at the relay: ${JSON.stringify(frames.find(({ frame }) => frame.t === "d").frame).slice(0, 160)}…`);
  check(leaks.length === 0, "no frame at the relay contains the prompt, command, thread id, method names, keys or device name");
  check([...fields].every((field) => ["t", "cid", "seq", "ack", "b", "mode", "code", "state"].includes(field)), "frames carry only routing fields and ciphertext");
  if (model) say(`model requests: ${model.requests.length}`);
  say("E2E PASSED");
  exitCode = 0;
} catch (error) {
  say(error.stack || error.message);
  if (model) say(`model requests: ${model.requests.length}; last messages: ${JSON.stringify(model.requests.at(-1)?.messages?.slice(-2) ?? []).slice(0, 1500)}`);
  say("--- uac server log (tail) ---");
  say(serverLog.join("").split("\n").slice(-40).join("\n"));
} finally {
  await phone?.close().catch(() => {});
  tui?.close();
  uac.kill("SIGINT");
  await new Promise((resolve) => uac.once("exit", resolve).once("error", resolve));
  await relay.close();
  model?.server.close();
  if (!process.env.UNIEAI_E2E_KEEP) rmSync(home, { recursive: true, force: true });
}
process.exit(exitCode);
