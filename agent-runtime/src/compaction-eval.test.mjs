import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFold,
  extractDecisions,
  extractIdentifiers,
  renderReport,
  summarizeEvaluations,
} from "./compaction-eval.mjs";

const FOLDED = [
  { role: "user", content: "the ws listener in exec-server/src/ws.rs:88 has no auth" },
  {
    role: "assistant",
    content:
      "I switched to loopback because exposing it publicly would be an unauthenticated exec surface. " +
      "Updated tunnelShape and set MAX_RETRIES to 3000.",
  },
];

test("paths, file:line, symbols, and numbers are identified", () => {
  const ids = extractIdentifiers(FOLDED.map((m) => m.content).join("\n"));
  assert.ok(ids.has("exec-server/src/ws.rs:88") || ids.has("exec-server/src/ws.rs"));
  assert.ok(ids.has("tunnelShape"));
  assert.ok(ids.has("MAX_RETRIES") || ids.has("3000"));
});

test("ordinary prose is not mistaken for identifiers", () => {
  const ids = extractIdentifiers("We looked at the problem and then fixed it properly.");
  assert.equal(ids.size, 0, `false positives: ${[...ids].join(", ")}`);
});

test("decision sentences are picked out, narration is not", () => {
  const decisions = extractDecisions(
    "I opened the file and read it.\nI switched to loopback because public exposure is unsafe.",
  );
  assert.equal(decisions.length, 1);
  assert.match(decisions[0], /switched to loopback/);
});

test("a faithful summary scores well even though it rewords", () => {
  const result = evaluateFold({
    folded: FOLDED,
    summary:
      "Chose loopback for exec-server/src/ws.rs:88 because a public listener would be unauthenticated exec. " +
      "tunnelShape updated; MAX_RETRIES is 3000.",
  });
  assert.ok(result.identifiers.rate > 0.8, `identifier rate was ${result.identifiers.rate}`);
  assert.equal(result.decisions.rate, 1, "a reworded decision must still count as kept");
});

test("a summary that drops the identifiers is scored down and names them", () => {
  const result = evaluateFold({ folded: FOLDED, summary: "Made the listener safer." });
  assert.ok(result.identifiers.rate < 0.3);
  assert.ok(result.identifiers.lost.some((s) => s.includes("ws.rs") || s === "tunnelShape"));
});

test("a dropped decision is reported with its text, so it can be judged", () => {
  const result = evaluateFold({ folded: FOLDED, summary: "Touched some files." });
  assert.equal(result.decisions.kept, 0);
  assert.match(result.decisions.lost[0], /because/);
});

test("the compression ratio is reported alongside retention", () => {
  const result = evaluateFold({ folded: FOLDED, summary: "short" });
  assert.ok(result.ratio > 10, "a tiny summary of a long fold is a high ratio");
  assert.ok(result.originalChars > result.summaryChars);
});

test("an empty fold does not produce a divide-by-zero or a false failure", () => {
  const result = evaluateFold({ folded: [], summary: "" });
  assert.equal(result.identifiers.rate, 1, "nothing to keep means nothing was lost");
  assert.equal(result.decisions.rate, 1);
});

test("aggregation weights folds by size rather than averaging rates", () => {
  const big = evaluateFold({
    folded: [{ role: "user", content: Array.from({ length: 20 }, (_, i) => `symbolName${i}`).join(" ") }],
    summary: "",
  });
  const small = evaluateFold({ folded: [{ role: "user", content: "aVariable" }], summary: "aVariable" });

  const agg = summarizeEvaluations([big, small]);
  assert.equal(agg.folds, 2);
  // 1 kept of 21 — a naive mean of the two rates would report ~50%.
  assert.ok(agg.identifierRate < 0.2, `weighted rate was ${agg.identifierRate}`);
});

test("the report states the numbers and shows examples", () => {
  const result = evaluateFold({ folded: FOLDED, summary: "Made the listener safer." });
  const report = renderReport([result]);
  assert.match(report, /identifiers kept:/);
  assert.match(report, /decisions kept:/);
  assert.match(report, /compression/);
  assert.match(report, /examples of lost identifiers/);
});

test("no archives is said plainly rather than reported as a perfect score", () => {
  assert.match(renderReport([]), /No compaction archives found/);
  assert.equal(summarizeEvaluations([]), null);
});
