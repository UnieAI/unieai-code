import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStructure, readSpilled, spillIfLarge } from "./tool-output-store.mjs";

/** An API page shaped like the real thing: one line, thousands of records. */
function apiPage(count = 10_000) {
  const records = Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    department: i % 3 === 0 ? "eng" : i % 3 === 1 ? "sales" : "support",
    created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  return JSON.stringify(records);
}

test("a record array is recognized, with its count and fields", () => {
  const shape = describeStructure(apiPage(10_000));
  assert.equal(shape.kind, "json-records");
  assert.equal(shape.count, 10_000);
  assert.deepEqual(shape.fields, ["id", "name", "email", "department", "created_at"]);
});

test("a single-array envelope is unwrapped to its payload", () => {
  const shape = describeStructure(JSON.stringify({ items: [{ a: 1 }, { a: 2 }], next: null }));
  assert.equal(shape.kind, "json-records");
  assert.equal(shape.path, "items");
  assert.equal(shape.count, 2);
});

test("plain text and unparseable data stay text", () => {
  assert.equal(describeStructure("just some log output").kind, "text");
  assert.equal(describeStructure("{ not json").kind, "text");
  assert.equal(describeStructure("").kind, "text");
});

test("spilling 10k records previews the SHAPE, not thousands of characters of data", () => {
  const out = spillIfLarge(apiPage(10_000), { id: "fetch" });
  assert.equal(out.spilled, true);
  assert.equal(out.kind, "json-records");
  assert.match(out.modelText, /10000 records/);
  assert.match(out.modelText, /fields: id, name, email, department, created_at/);
  // The whole point: the preview must be tiny compared to the payload.
  assert.ok(out.modelText.length < 2000, `preview was ${out.modelText.length} chars`);
  // And it must not be a raw character slice of the array.
  assert.ok(!out.modelText.includes("user-500"), "preview leaked bulk record data");
});

test("the preview tells the model to query rather than pull everything", () => {
  const out = spillIfLarge(apiPage(10_000), { id: "fetch" });
  assert.match(out.modelText, /Do NOT try to read all of this/);
  assert.match(out.modelText, /offset, limit/);
  assert.match(out.modelText, /fields/);
});

test("records are paged as valid JSON, not cut mid-record", () => {
  const { id } = spillIfLarge(apiPage(10_000), { id: "fetch" });
  const r = readSpilled(id, { offset: 0, limit: 3 });
  assert.equal(r.ok, true);

  const body = r.text.slice(r.text.indexOf("["));
  const page = JSON.parse(body); // would throw on a character-sliced payload
  assert.equal(page.length, 3);
  assert.equal(page[0].id, 0);
  assert.match(r.text, /showing 0–2/);
});

test("paging walks the whole set and reports where to continue", () => {
  const { id } = spillIfLarge(apiPage(10_000), { id: "fetch" });
  const first = readSpilled(id, { offset: 0, limit: 50 });
  assert.match(first.text, /next page: offset 50/);

  const last = readSpilled(id, { offset: 9_990, limit: 50 });
  const page = JSON.parse(last.text.slice(last.text.indexOf("[")));
  assert.equal(page.length, 10, "the tail page is short, not padded");
  assert.ok(!last.text.includes("next page"), "no continuation past the end");
});

test("field projection is how a page gets small", () => {
  const { id } = spillIfLarge(apiPage(10_000), { id: "fetch" });
  const full = readSpilled(id, { offset: 0, limit: 100 });
  const projected = readSpilled(id, { offset: 0, limit: 100, fields: "id,name" });

  const page = JSON.parse(projected.text.slice(projected.text.indexOf("[")));
  assert.deepEqual(Object.keys(page[0]), ["id", "name"]);
  assert.ok(projected.text.length < full.text.length / 2, "projection must actually shrink the page");
});

test("grep filters RECORDS, which a line filter could never do on one long line", () => {
  const { id } = spillIfLarge(apiPage(300), { id: "fetch" });
  const r = readSpilled(id, { grep: "sales", limit: 5 });
  const page = JSON.parse(r.text.slice(r.text.indexOf("[")));
  assert.ok(page.length > 0);
  assert.ok(page.every((rec) => rec.department === "sales"));
  assert.match(r.text, /of 300/, "it should say how many of the total matched");
});

test("a regex grep works on records too", () => {
  const { id } = spillIfLarge(apiPage(300), { id: "fetch" });
  const r = readSpilled(id, { grep: "/user-1[0-9]@/", limit: 20 });
  const page = JSON.parse(r.text.slice(r.text.indexOf("[")));
  assert.ok(page.length > 0);
  assert.ok(page.every((rec) => /user-1[0-9]@/.test(rec.email)));
});

test("a grep matching nothing says so instead of returning the whole set", () => {
  const { id } = spillIfLarge(apiPage(300), { id: "fetch" });
  const r = readSpilled(id, { grep: "no-such-department" });
  assert.match(r.text, /0 matching record\(s\) of 300/);
});

test("plain text output still pages by line as before", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${i % 2 ? "ERROR" : "ok"}`).join("\n");
  const out = spillIfLarge(lines, { id: "bash" });
  assert.equal(out.kind, "text");
  const r = readSpilled(out.id, { grep: "ERROR" });
  assert.ok(r.text.includes("ERROR"));
  assert.ok(!r.text.includes("line 0 ok"), "non-matching lines are dropped");
});

test("small outputs are untouched and never spill", () => {
  const out = spillIfLarge(JSON.stringify([{ a: 1 }]), { id: "fetch" });
  assert.equal(out.spilled, false);
  assert.equal(out.modelText, '[{"a":1}]');
});
