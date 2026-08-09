import { test } from "node:test";
import assert from "node:assert/strict";
import { localSandboxBackend, dockerExecBackend, resolveBackend } from "./exec-backend.mjs";

test("the local backend wraps commands in the sandbox and can escalate", () => {
  const b = localSandboxBackend("/opt/unieai");
  const argv = b.argv("ls -la");
  assert.equal(argv[0], "/opt/unieai");
  assert.ok(argv.includes("sandbox"));
  assert.ok(argv.some((a) => String(a).includes("workspace-write")));
  // The escalation path exists locally: the user can approve running unsandboxed.
  assert.ok(typeof b.escalatedArgv === "function");
});

test("the docker backend execs into the container at the workdir", () => {
  const argv = dockerExecBackend({ container: "c1" }).argv("pytest tests/");
  assert.deepEqual(argv.slice(0, 4), ["docker", "exec", "-w", "/testbed"]);
  assert.ok(argv.includes("c1"));
  assert.match(argv[argv.length - 1], /pytest tests\//);
});

test("the container boundary has no escalation path", () => {
  // Nothing weaker to fall back to, so a denial must not pretend to ask the user.
  assert.equal(dockerExecBackend({ container: "c1" }).escalatedArgv, null);
});

test("a shared bind mount stops the container creating files the host cannot write", () => {
  // Real failure: root inside the container wrote __pycache__ and edited files
  // the host user then could not touch — 42 "Permission denied" and 10 EACCES in
  // one 100-instance run, with the model manually working around it.
  const argv = dockerExecBackend({ container: "c1" }).argv("python -c 'import x'");
  assert.ok(argv.includes("PYTHONDONTWRITEBYTECODE=1"));
  assert.match(argv[argv.length - 1], /^umask 000; /);
});

test("a container that owns its filesystem outright keeps the plain command", () => {
  const argv = dockerExecBackend({ container: "c1", shareWithHost: false }).argv("make");
  assert.ok(!argv.includes("PYTHONDONTWRITEBYTECODE=1"));
  assert.equal(argv[argv.length - 1], "make");
});

test("caller-supplied env survives, and can override the defaults", () => {
  const argv = dockerExecBackend({ container: "c1", env: { FOO: "bar", PYTHONDONTWRITEBYTECODE: "0" } }).argv("env");
  assert.ok(argv.includes("FOO=bar"));
  assert.ok(argv.includes("PYTHONDONTWRITEBYTECODE=0"));
  assert.ok(!argv.includes("PYTHONDONTWRITEBYTECODE=1"));
});

test("a container id is required", () => {
  assert.throws(() => dockerExecBackend({}), /requires a container/);
});

test("resolveBackend falls back to the local sandbox", () => {
  assert.equal(resolveBackend(null, "unieai").kind, "local");
  assert.equal(resolveBackend(undefined, "unieai").kind, "local");
  // An already-built backend is passed through untouched.
  const b = dockerExecBackend({ container: "c1" });
  assert.equal(resolveBackend(b, "unieai"), b);
});
