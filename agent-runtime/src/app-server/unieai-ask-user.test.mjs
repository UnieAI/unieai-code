// Copyright (c) 2026 UnieAI. All rights reserved.
// dsh's questions through codex's request_user_input screen, and back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateAgainstSchema, SCHEMA_DIR } from "./schema-check.mjs";
import { dshAnswers, protocolQuestions, questionDetails } from "./unieai-ask-user.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skip = existsSync(join(repoRoot, SCHEMA_DIR, "ServerRequest.json")) ? false : "no generated schemas";

const questions = [
  { id: "db", question: "Which database?", header: "Database choice", options: [{ label: "Postgres", description: "what prod runs" }, { label: "SQLite" }] },
  { id: "name", question: "What should the service be called?" },
  { id: "plan", question: "Approve this plan?", detail: "# Plan\n1. do it", options: [{ label: "Approve" }, { label: "Revise" }] },
];

test("dsh's questions are the client's, each with a free-form answer", { skip }, () => {
  const asked = protocolQuestions(questions);
  assert.deepEqual(asked[0], {
    id: "db",
    header: "Database cho",
    question: "Which database?",
    isOther: true,
    isSecret: false,
    options: [
      { label: "Postgres", description: "what prod runs" },
      { label: "SQLite", description: "" },
    ],
  });
  assert.equal(asked[1].options, null);
  const request = { id: -1, method: "item/tool/requestUserInput", params: { threadId: "t", turnId: "u", itemId: "i", questions: asked, isBlocking: true, autoResolutionMs: null } };
  const result = validateAgainstSchema("ServerRequest", request, { repoRoot });
  assert.equal(result.ok, true, result.problems.join("\n"));
});

test("the client's answers become dsh's: picked labels, and typed text as custom", () => {
  const response = {
    answers: {
      db: { answers: ["SQLite", "user_note: only for tests"] },
      name: { answers: ["user_note: billing-api"] },
      plan: { answers: [] },
    },
  };
  assert.deepEqual(dshAnswers(questions, response), [
    { id: "db", selected: ["SQLite"], custom: "only for tests" },
    { id: "name", selected: [], custom: "billing-api" },
    { id: "plan", selected: [] },
  ]);
  assert.deepEqual(questionDetails(questions), ["# Plan\n1. do it"]);
});
