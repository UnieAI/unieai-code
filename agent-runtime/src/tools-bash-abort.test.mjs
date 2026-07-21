import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

// A fake sandbox binary that always "denies": exits 1 printing the phrase the
// denial detector looks for, without running the wrapped command at all.
function makeDenyingSandbox(dir) {
  const bin = join(dir, "deny-sandbox");
  writeFileSync(bin, "#!/bin/sh\necho 'Operation not permitted' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  return bin;
}

test("late approval after abort does NOT run the command unsandboxed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bash-abort-"));
  try {
    const sandboxBin = makeDenyingSandbox(dir);
    const t = await buildCodingTools({ workspace: dir, sandboxBin })();
    const marker = join(dir, "should-not-exist.txt");

    const ctrl = new AbortController();
    const r = await t.executors.bash(
      { cmd: `touch '${marker}'` },
      {
        abortSignal: ctrl.signal,
        // Simulates the user clicking "allow" AFTER the loop abandoned the call:
        // the loop has already aborted the per-call signal by the time this resolves.
        requestApproval: async () => {
          ctrl.abort();
          return "accept";
        },
      }
    );

    assert.equal(r.ok, false);
    assert.match(r.modelText, /NOT executed|abandoned/i);
    assert.equal(existsSync(marker), false, "the unsandboxed rerun must not have fired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timely approval still runs the command unsandboxed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bash-ok-"));
  try {
    const sandboxBin = makeDenyingSandbox(dir);
    const t = await buildCodingTools({ workspace: dir, sandboxBin })();
    const marker = join(dir, "created.txt");

    const r = await t.executors.bash(
      { cmd: `touch '${marker}'` },
      { abortSignal: new AbortController().signal, requestApproval: async () => "accept" }
    );

    assert.equal(r.ok, true);
    assert.match(r.modelText, /approved, unsandboxed/);
    assert.equal(existsSync(marker), true, "approved rerun executed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
