// The background verifier has to be given the answer the model actually gave.
//
// In "review" goal mode the completion contract runs after the turn ends, off
// the critical path, and its skeptic prompt carries the agent's final report so
// the diff can be judged against what the agent claimed it did. runTurn read
// that report off `result.text`, but runAgentLoop returns `answerText` — so the
// field was always undefined and the skeptic reviewed every turn with an empty
// report. "gate" mode was unaffected: it gets the text from inside the loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-review-answer-"));
process.env.UNIEAI_HOME = HOME;
process.env.AGENT_CORE_WIRE_API = "chat";

const ANSWER = "I renamed the constant and updated its one caller.";

/** Non-streaming requests are the aux-model calls: skeptic, summarizer. */
const auxPrompts = [];
const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (!parsed.stream) {
      auxPrompts.push(String(parsed.messages?.at(-1)?.content ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ACHIEVED" } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
gateway.unref();

writeFileSync(
  join(HOME, "unieai.json"),
  JSON.stringify({
    gateway_base_url: `http://127.0.0.1:${gateway.address().port}`,
    gateway_api_key: "test-key",
    studio_url: "http://127.0.0.1:9",
    available_model_ids: ["big-model", "small-model"],
  }),
  "utf8"
);

const { createEngine } = await import("./engine.mjs");

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * The skeptic only runs on a dirty git workspace: the mutation gate returns
 * early on a clean one, and the diff has to be non-empty. A .txt change keeps
 * the deterministic Python gates out of the way.
 */
function dirtyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "unieai-ws-review-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "notes.txt"), "before\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  writeFileSync(join(dir, "notes.txt"), "after\n", "utf8");
  return dir;
}

/** The verifier is fire-and-forget, so wait for its request to land. */
async function waitForSkeptic(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = auxPrompts.find((p) => p.includes("## Agent's final report"));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("the review-mode skeptic is given the agent's final report", { skip: !gitAvailable && "git unavailable" }, async () => {
  const engine = createEngine({
    workspace: dirtyRepo(),
    model: "big-model",
    expectsMutation: "review", // background verifier, not the blocking gate
  });

  await engine.send("rename the constant");

  const prompt = await waitForSkeptic();
  assert.ok(prompt, "the background verifier never called the model");
  const report = prompt.split("## Agent's final report")[1] ?? "";
  assert.ok(
    report.includes(ANSWER),
    `the skeptic reviewed an empty report instead of the answer; got: ${JSON.stringify(report.trim().slice(0, 120))}`
  );
});
