import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WIN, prepareExec, quoteForCmd, shellArgv } from "./portable-exec.mjs";

test("quoteForCmd wraps arguments so cmd.exe cannot split or interpret them", () => {
  assert.equal(quoteForCmd("C:\\Users\\Foo Bar\\proj"), '"C:\\Users\\Foo Bar\\proj"');
  // A trailing backslash must not escape our own closing quote.
  assert.equal(quoteForCmd("C:\\dir\\"), '"C:\\dir\\\\"');
  // Embedded quotes get the MSVCRT escaping the callee re-splits with.
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  // Operators survive as literal text rather than becoming cmd operators.
  assert.equal(quoteForCmd("a & b | c"), '"a & b | c"');
  assert.equal(quoteForCmd(""), '""');
});

test("shellArgv picks the shell that exists on this platform", () => {
  const argv = shellArgv("echo hi");
  assert.equal(argv[argv.length - 1], "echo hi");
  if (IS_WIN) {
    assert.match(argv[0], /cmd\.exe$/i);
    assert.deepEqual(argv.slice(1, -1), ["/d", "/s", "/c"]);
  } else {
    assert.deepEqual(argv, ["sh", "-c", "echo hi"]);
  }
});

test("shellArgv actually runs a command with spaces and quotes intact", async () => {
  const [file, ...args] = shellArgv('echo "a b"');
  const out = await new Promise((done) =>
    execFile(file, args, (err, stdout) => done(String(stdout || ""))),
  );
  assert.match(out, /a b/);
});

test("prepareExec leaves POSIX spawns alone (no shell, no requoting)", { skip: IS_WIN }, () => {
  const spec = prepareExec("/usr/local/bin/unieai", ["--cd", "/Users/x/My Project"]);
  assert.deepEqual(spec, {
    file: "/usr/local/bin/unieai",
    args: ["--cd", "/Users/x/My Project"],
    shell: false,
  });
});

test("prepareExec spawns a resolved native binary directly", { skip: !IS_WIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pexec-"));
  const exe = join(dir, "unieai.exe");
  writeFileSync(exe, "");
  const spec = prepareExec(exe, ["app-server"]);
  assert.equal(spec.shell, false, "a real .exe needs no shell");
  assert.deepEqual(spec.args, ["app-server"], "and therefore no quoting");
});

test("prepareExec routes an npm .cmd shim through a shell, pre-quoted", { skip: !IS_WIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pexec-"));
  const shim = join(dir, "unieai.cmd");
  writeFileSync(shim, "@echo off\r\n");
  const spec = prepareExec(shim, ["--cd", "C:\\Users\\Foo Bar\\proj"]);
  assert.equal(spec.shell, true, "Node refuses to spawn .cmd without a shell");
  assert.equal(spec.file, `"${shim}"`);
  assert.deepEqual(spec.args, ["--cd", '"C:\\Users\\Foo Bar\\proj"']);
});
