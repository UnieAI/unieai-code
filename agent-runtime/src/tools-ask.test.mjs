import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodingTools } from "./tools.mjs";

async function askTool() {
  const t = await buildCodingTools({ workspace: process.cwd() })();
  return t.executors.ask;
}

test("ask is registered as a tool", async () => {
  const t = await buildCodingTools({ workspace: process.cwd() })();
  assert.ok(t.schemas.some((s) => s.function.name === "ask"));
});

test("ask is declared interactive (exempt from the loop's tool timeout)", async () => {
  const t = await buildCodingTools({ workspace: process.cwd() })();
  assert.ok(Array.isArray(t.interactiveTools) && t.interactiveTools.includes("ask"));
});

test("ask returns the user's choice", async () => {
  const ask = await askTool();
  const seen = [];
  const r = await ask(
    { question: "Which package manager?", options: ["npm", "pnpm", "bun"] },
    { requestQuestion: async (q) => { seen.push(q); return "pnpm"; } }
  );
  assert.equal(r.ok, true);
  assert.match(r.modelText, /chose: pnpm/);
  assert.deepEqual(seen[0].options, ["npm", "pnpm", "bun"]);
});

test("ask fails closed when no question channel is available", async () => {
  const ask = await askTool();
  const r = await ask({ question: "x?", options: ["a", "b"] }, {});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /unavailable|make the best decision/i);
});

test("ask treats a dismissal as 'decide yourself, don't re-ask'", async () => {
  const ask = await askTool();
  const r = await ask({ question: "x?", options: ["a", "b"] }, { requestQuestion: async () => null });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /dismissed|do not ask again/i);
});

test("ask validates its inputs", async () => {
  const ask = await askTool();
  assert.equal((await ask({ options: ["a", "b"] }, { requestQuestion: async () => "a" })).ok, false);
  assert.equal((await ask({ question: "x?", options: ["only"] }, { requestQuestion: async () => "only" })).ok, false);
});
