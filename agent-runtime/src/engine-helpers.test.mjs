import { test } from "node:test";
import assert from "node:assert/strict";
import { realUserTask } from "./engine.mjs";

test("realUserTask skips synthetic wrappers and finds the actual task", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "<project_instructions>\nrepo rules here\n</project_instructions>" },
    { role: "user", content: "<context_update>\nCurrent date: 2026-07-22\n</context_update>" },
    { role: "user", content: "fix the CSV parser dropping the last row" },
    { role: "assistant", content: "on it" },
  ];
  assert.equal(realUserTask(messages), "fix the CSV parser dropping the last row");
});

test("realUserTask skips the rolling compaction summary", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "<conversation_summary>\n## Objective\nolder stuff\n</conversation_summary>" },
    { role: "user", content: "the real follow-up question" },
  ];
  assert.equal(realUserTask(messages), "the real follow-up question");
});

test("realUserTask returns empty when only synthetic messages exist", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "<project_instructions>\nrules\n</project_instructions>" },
  ];
  assert.equal(realUserTask(messages), "");
});

test("realUserTask handles plain sessions unchanged", () => {
  assert.equal(realUserTask([{ role: "user", content: "hello" }]), "hello");
  assert.equal(realUserTask([]), "");
});
