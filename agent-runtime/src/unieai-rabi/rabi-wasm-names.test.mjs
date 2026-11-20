// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import test from "node:test";
import { rewriteWasmNames, wasmNames } from "./rabi-wasm-names.mjs";

/** A module importing env.dsh_cb (func) and exporting dsh_run (func) plus memory. */
function sampleModule() {
  const name = (s) => [s.length, ...Buffer.from(s)];
  const section = (id, body) => [id, body.length, ...body];
  const type = section(1, [1, 0x60, 0, 0]);
  const imports = section(2, [1, ...name("env"), ...name("dsh_cb"), 0, 0]);
  const funcs = section(3, [1, 0]);
  const memory = section(5, [1, 0, 1]);
  const exports = section(7, [2, ...name("dsh_run"), 0, 1, ...name("memory"), 2, 0]);
  const code = section(10, [1, 4, 0, 0x10, 0, 0x0b]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...imports, ...funcs, ...memory, ...exports, ...code]);
}

test("renames imports and exports and the result is a valid module", async () => {
  const renamed = rewriteWasmNames(sampleModule(), (n) => n.replace(/^dsh_/, "rabi_"));
  assert.deepEqual(wasmNames(renamed), ["env", "rabi_cb", "rabi_run", "memory"]);
  let called = 0;
  const { instance } = await WebAssembly.instantiate(renamed, { env: { rabi_cb: () => called++ } });
  instance.exports.rabi_run();
  assert.equal(called, 1);
});

test("returns the same buffer when nothing changes", () => {
  const mod = sampleModule();
  assert.equal(rewriteWasmNames(mod, (n) => n), mod);
});
