#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-uac-live-check.mjs — drive a real uac server (and the real dsh it
 * pins) through the app-server protocol, the way the TUI does, against the
 * signed-in account's gateway.
 *
 * Unit tests run the engine against a fake ACP agent, so a dsh upgrade that
 * changes the patch schema, the prompt variables or the session format passes
 * them and still fails on the first real turn. This is the check to run after
 * moving the dsh pin and before a release.
 *
 *   node scripts/unieai-uac-live-check.mjs [--model <id>] [--keep]
 *
 * It copies `~/.unieai/unieai.json` into a throwaway CODEX_HOME (the user's
 * own home and daemon socket are never touched), then checks: a turn that
 * runs a tool and edits a file, a steer into a running turn, /compact, the
 * turn history, rewinding a turn with its files, and fork. Exits non-zero
 * when any step fails.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrames, newClientKey } from "../src/app-server/ws.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const keep = args.includes("--keep");
const account = process.env.UNIEAI_CREDENTIALS || join(homedir(), ".unieai", "unieai.json");
if (!existsSync(account)) {
  console.error(`no ${account}: sign in with \`unieai login\` first`);
  process.exit(2);
}
const model = flag("--model") || JSON.parse(readFileSync(account, "utf8")).available_models?.[0]?.id;
const TURN_TIMEOUT_MS = Number(flag("--turn-timeout-ms")) || 240_000;

// A short root: the server's control sockets live next to its own and unix
// socket paths are capped near 100 bytes.
const root = mkdtempSync(join(tmpdir(), "uac-live-"));
const codexHome = join(root, "home");
const work = join(root, "work");
mkdirSync(codexHome, { recursive: true });
mkdirSync(work, { recursive: true });
copyFileSync(account, join(codexHome, "unieai.json"));
writeFileSync(join(codexHome, "config.toml"), `model = ${JSON.stringify(model)}\n`);
const socketPath = join(root, "app.sock");

const serverLog = [];
const server = spawn(process.execPath, [join(here, "..", "bin", "unieai-uac-server.mjs")], {
  cwd: work,
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    UNIEAI_APP_SERVER_SOCKET: socketPath,
    UNIEAI_SANDBOX: "danger-full-access",
    UNIEAI_UAC_IDLE_EXIT_MS: "600000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (chunk) => serverLog.push(...chunk.toString().split("\n").filter(Boolean)));

/** A JSON-RPC client over the server's WebSocket-on-unix-socket. */
async function connectClient() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openClient();
    } catch (error) {
      if (attempt > 120 || server.exitCode !== null) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function openClient() {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    const send = (message) => {
      // Clients must mask (RFC 6455 §5.3).
      const body = Buffer.from(JSON.stringify(message));
      const mask = randomBytes(4);
      const masked = Buffer.from(body.map((byte, i) => byte ^ mask[i % 4]));
      let header;
      if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
      else if (body.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(body.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeUInt32BE(body.length, 6);
      }
      socket.write(Buffer.concat([header, mask, masked]));
    };
    const client = {
      request(method, params) {
        const id = nextId++;
        send({ id, method, params });
        return new Promise((ok, fail) => pending.set(id, { ok, fail, method }));
      },
      notify: (method, params) => send({ method, params }),
      /** Resolve with the first notification `match` accepts. */
      waitFor(match, timeoutMs = TURN_TIMEOUT_MS) {
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => {
            listeners.delete(listener);
            fail(new Error(`timed out after ${timeoutMs} ms`));
          }, timeoutMs);
          const listener = (message) => {
            if (!match(message)) return;
            clearTimeout(timer);
            listeners.delete(listener);
            ok(message);
          };
          listeners.add(listener);
        });
      },
      seen: [],
      close: () => socket.destroy(),
    };
    socket.on("connect", () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!/101 Switching Protocols/.test(buffer.subarray(0, end).toString())) {
          reject(new Error("the server refused the websocket upgrade"));
          return;
        }
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        resolve(client);
      }
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const message = JSON.parse(frame.data.toString());
        if (message.id !== undefined && !message.method) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter?.fail(new Error(`${waiter.method}: ${message.error.message}`));
          else waiter?.ok(message.result);
        } else if (message.method) {
          // A server request (approval): this run grants full access, so accept.
          if (message.id !== undefined) send({ id: message.id, result: { decision: "accept" } });
          client.seen.push(message);
          for (const listener of [...listeners]) listener(message);
        }
      }
    });
    socket.on("error", reject);
  });
}

const results = [];
async function step(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const userInput = (text) => [{ type: "text", text, text_elements: [] }];
const completedTurn = (threadId) => (m) => m.method === "turn/completed" && m.params?.threadId === threadId;
const agentText = (client, threadId, turnId) =>
  client.seen
    .filter((m) => m.method === "item/completed" && m.params?.threadId === threadId && m.params?.turnId === turnId)
    .map((m) => m.params.item)
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text)
    .join("\n");

let client;
let threadId;
try {
  console.log(`uac live check: model ${model}, home ${codexHome}`);
  client = await connectClient();
  await client.request("initialize", { clientInfo: { name: "unieai-uac-live-check", version: "0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});

  await step("thread/start", async () => {
    const started = await client.request("thread/start", { cwd: work, model, sandbox: "danger-full-access", approvalPolicy: "never" });
    threadId = started.thread.id;
    return threadId;
  });

  await step("a turn runs a tool and writes a file", async () => {
    const done = client.waitFor(completedTurn(threadId));
    const { turn } = await client.request("turn/start", {
      threadId,
      input: userInput("Create a file named hello.txt in the current directory containing exactly the text `uac ok`, then run `cat hello.txt` and reply with its output."),
    });
    const completed = await done;
    if (completed.params.turn?.status !== "completed") throw new Error(`turn ${completed.params.turn?.status}: ${JSON.stringify(completed.params.turn?.error)}`);
    const text = readFileSync(join(work, "hello.txt"), "utf8").trim();
    if (text !== "uac ok") throw new Error(`hello.txt holds ${JSON.stringify(text)}`);
    const tools = client.seen.filter((m) => m.method === "item/completed" && m.params?.turnId === turn.id && m.params.item?.type !== "agentMessage" && m.params.item?.type !== "userMessage" && m.params.item?.type !== "reasoning");
    if (tools.length === 0) throw new Error("no tool item was reported");
    return `${tools.length} tool item(s); answer: ${agentText(client, threadId, turn.id).slice(0, 80).replace(/\s+/g, " ")}`;
  });

  await step("a steer reaches the running turn", async () => {
    const done = client.waitFor(completedTurn(threadId));
    const { turn } = await client.request("turn/start", {
      threadId,
      input: userInput("Run `sleep 8 && echo first-part-done` in the shell and wait for it."),
    });
    await client.waitFor((m) => m.method === "item/started" && m.params?.turnId === turn.id && m.params.item?.type !== "userMessage", 120_000);
    await client.request("turn/steer", {
      threadId,
      expectedTurnId: turn.id,
      input: userInput("Also create a file named steer.txt containing `steered`."),
    });
    await done;
    // A steer that lands after the turn's last step runs as a turn of its own.
    if (!existsSync(join(work, "steer.txt"))) await client.waitFor(completedTurn(threadId));
    if (!existsSync(join(work, "steer.txt"))) throw new Error("steer.txt was never written");
    return "steer.txt written";
  });

  await step("/compact", async () => {
    const done = client.waitFor(completedTurn(threadId));
    await client.request("thread/compact/start", { threadId });
    const completed = await done;
    if (completed.params.turn?.status !== "completed") throw new Error(`compaction turn ${completed.params.turn?.status}: ${JSON.stringify(completed.params.turn?.error)}`);
  });

  await step("the conversation continues after /compact", async () => {
    const done = client.waitFor(completedTurn(threadId));
    const { turn } = await client.request("turn/start", { threadId, input: userInput("What text did you put in hello.txt? Answer with the text only.") });
    const completed = await done;
    if (completed.params.turn?.status !== "completed") throw new Error(`turn ${completed.params.turn?.status}`);
    const answer = agentText(client, threadId, turn.id);
    if (!/uac ok/i.test(answer)) throw new Error(`answer lost the earlier context: ${answer.slice(0, 200)}`);
    return answer.slice(0, 60);
  });

  await step("thread/turns/list", async () => {
    const listed = await client.request("thread/turns/list", { threadId });
    const turns = listed.data ?? listed.turns ?? [];
    if (turns.length < 3) throw new Error(`only ${turns.length} turn(s) listed`);
    return `${turns.length} turns`;
  });

  await step("rewinding a turn restores the files its shell commands changed", async () => {
    const before = readFileSync(join(work, "hello.txt"), "utf8");
    const done = client.waitFor(completedTurn(threadId));
    const { turn } = await client.request("turn/start", {
      threadId,
      input: userInput("Using exec_command only (no edit tools), run exactly: `printf 'rewritten' > hello.txt && mkdir -p made && printf x > made/new.txt` and then reply `done`."),
    });
    const completed = await done;
    if (completed.params.turn?.status !== "completed") throw new Error(`turn ${completed.params.turn?.status}`);
    if (readFileSync(join(work, "hello.txt"), "utf8") === before) throw new Error("the turn did not change hello.txt");
    const preview = await client.request("thread/revert/preview", { threadId, beforeTurnId: turn.id });
    const listed = preview.files.map((file) => `${file.change} ${file.path}`).sort().join(", ");
    if (listed !== "delete made/new.txt, modify hello.txt") throw new Error(`preview: ${JSON.stringify(preview)}`);
    await client.request("thread/revert", { threadId, beforeTurnId: turn.id, restoreFiles: true });
    if (readFileSync(join(work, "hello.txt"), "utf8") !== before) throw new Error("hello.txt was not restored");
    if (existsSync(join(work, "made"))) throw new Error("made/ was not removed");
    const turns = (await client.request("thread/turns/list", { threadId })).data ?? [];
    if (turns.some((listedTurn) => listedTurn.id === turn.id)) throw new Error("the turn is still in the history");
    return `restored: ${listed}`;
  });

  await step("create_worktree moves the session into a new checkout", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...argv) => execFileSync("git", argv, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("-c", "user.name=uac", "-c", "user.email=uac@example.invalid", "commit", "-q", "-m", "base");
    const { thread } = await client.request("thread/start", { cwd: repo, model, sandbox: "danger-full-access", approvalPolicy: "never" });
    const done = client.waitFor(completedTurn(thread.id));
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: userInput("Call create_worktree with name `wt-check` and wait for its result before doing anything else. After it returns, use exec_command to run exactly `printf 'in worktree' > wt.txt && pwd` (a relative path, no workdir) and reply with what pwd printed."),
    });
    const completed = await done;
    if (completed.params.turn?.status !== "completed") throw new Error(`turn ${completed.params.turn?.status}: ${JSON.stringify(completed.params.turn?.error)}`);
    const checkout = join(repo, ".agents", "worktrees", "wt-check");
    if (!existsSync(join(checkout, "base.txt"))) throw new Error(`no checkout at ${checkout}`);
    if (readFileSync(join(checkout, "wt.txt"), "utf8").trim() !== "in worktree") throw new Error("wt.txt was not written in the worktree");
    if (existsSync(join(repo, "wt.txt"))) throw new Error("wt.txt landed in the source checkout");
    if (!git("branch", "--list", "wt-check")) throw new Error("no wt-check branch");
    // Rewinding the turn takes the file back out of the worktree.
    const preview = await client.request("thread/revert/preview", { threadId: thread.id, beforeTurnId: turn.id });
    const listed = preview.files.map((file) => `${file.change} ${file.path}`).join(", ");
    if (!listed.includes("delete .agents/worktrees/wt-check/wt.txt")) throw new Error(`preview: ${JSON.stringify(preview)}`);
    await client.request("thread/revert", { threadId: thread.id, beforeTurnId: turn.id, restoreFiles: true });
    if (existsSync(join(checkout, "wt.txt"))) throw new Error("rewind left wt.txt in the worktree");
    return `pwd: ${agentText(client, thread.id, turn.id).slice(0, 80).replace(/\s+/g, " ")}; rewind: ${listed}`;
  });

  await step("thread/fork", async () => {
    const forked = await client.request("thread/fork", { threadId });
    if (!forked.thread?.id || forked.thread.id === threadId) throw new Error("fork returned no new thread");
    return forked.thread.id;
  });
} catch (error) {
  results.push({ name: "setup", ok: false, detail: error.message });
  console.log(`FAIL setup: ${error.message}`);
} finally {
  client?.close();
  server.kill("SIGTERM");
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nlast uac server log lines:");
    for (const line of serverLog.slice(-30)) console.log(`  ${line}`);
  }
  if (keep) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
