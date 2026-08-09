/**
 * portable-exec.mjs — launching child processes the same way on every OS.
 *
 * Windows is the awkward one, in three ways:
 *
 *  1. `npm i -g @unieai/code` installs a `unieai.cmd` shim (the package's `bin`
 *     points at a .js entry, so there is no `unieai.exe` anywhere on PATH), and
 *     since CVE-2024-27980 Node refuses to spawn a .cmd/.bat without a shell.
 *  2. When you do pass `shell: true`, Node performs NO escaping — it joins argv
 *     with spaces and hands the string to cmd.exe. A workspace path containing
 *     a space then arrives as two arguments.
 *  3. There is no `sh`, so `sh -c <command>` — the way the bash tool has always
 *     run things — cannot work at all.
 *
 * On macOS/Linux none of this applies and we spawn directly; routing those
 * platforms through a shell would only reintroduce (2) for paths with spaces.
 *
 * Shared with the VS Code extension (sdks/vscode/src/processUtil.ts imports
 * this module) so the quoting rules live in exactly one place.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const IS_WIN = process.platform === "win32";

/** Quote one argv entry for a cmd.exe command line.
 *
 * Backslashes are only special immediately before a quote, so the MSVCRT rules
 * the callee re-splits with need them doubled there (and in a trailing run,
 * which would otherwise escape our own closing quote). Wrapping in quotes also
 * stops cmd treating `& | < > ^` as operators. Two known limits, both benign
 * for the arguments we pass: `%VAR%` still expands inside quotes, and a command
 * containing an ODD number of quote characters can leave cmd's quote tracking
 * open across a later operator. */
export function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  return `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** PATHEXT-aware lookup, so we can tell a real .exe from an npm .cmd shim. */
export function resolveExecutable(file) {
  if (!IS_WIN) return undefined;
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const alreadyExt = exts.some((e) => file.toLowerCase().endsWith(e.toLowerCase()));
  const bases =
    path.isAbsolute(file) || file.includes("\\") || file.includes("/")
      ? [path.resolve(file)]
      : (process.env.PATH || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, file));

  for (const base of bases) {
    for (const candidate of alreadyExt ? [base] : exts.map((e) => base + e)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not there; keep looking */
      }
    }
  }
  return undefined;
}

const WIN_TRIPLE = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

/** Find the native binary that an npm `.cmd` shim would end up spawning.
 *
 * Purely an optimization, and guarded by existsSync: reaching the .exe directly
 * skips the cmd.exe + node hop, which means no quoting hazards, no flashing
 * console window, and — most importantly — kill() reaching the real process so
 * the Stop button works. If the layout does not match (pnpm's isolated store,
 * a vendored build), we return undefined and go through the shim as before. */
function nativeBinaryBehindShim(shimPath) {
  const triple = WIN_TRIPLE[process.arch];
  if (!triple) return undefined;
  const dir = path.dirname(shimPath);
  const suffix = path.join("vendor", triple, "bin", "codex.exe");
  const candidates = [
    path.join(dir, "node_modules", `@unieai/code-${process.platform}-${process.arch}`, suffix),
    path.join(dir, "node_modules", "@unieai", "code", suffix),
  ];
  return candidates.find((c) => existsSync(c));
}

/** Decide how to launch `file` with `args` on the current platform.
 *
 * Returns `{ file, args, shell }` ready to hand to spawn/execFile. Only the
 * .cmd/.bat fallback sets `shell`, and in that case both the executable and
 * every argument come back pre-quoted, because Node will not quote them. */
export function prepareExec(file, args = []) {
  if (!IS_WIN) return { file, args, shell: false };

  const resolved = resolveExecutable(file);
  if (resolved && /\.(exe|com)$/i.test(resolved)) {
    return { file: resolved, args, shell: false };
  }
  if (resolved) {
    const native = nativeBinaryBehindShim(resolved);
    if (native) return { file: native, args, shell: false };
  }
  return {
    file: quoteForCmd(resolved ?? file),
    args: args.map(quoteForCmd),
    shell: true,
  };
}

/** argv for running `cmd` through a one-shot system shell.
 *
 * Windows has no `sh`; `cmd.exe /d /s /c` is the equivalent (/d skips AutoRun
 * registry hooks, /s keeps the rest of the line verbatim). */
export function shellArgv(cmd) {
  return IS_WIN
    ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", cmd]
    : ["sh", "-c", cmd];
}

/**
 * argv for running `cmd` inside the sandbox helper.
 *
 * The sandbox defaults to a read-only filesystem, which is the wrong policy for
 * a coding agent: the `edit`/`write` tools already mutate the workspace, so a
 * bash tool that cannot write is not safer — it just breaks the half of the job
 * that needs a shell (repro scripts, `pip install -e .`, test runs that write
 * artifacts) and teaches the model that the workspace is read-only, at which
 * point it stops trying to fix anything at all. `workspace-write` keeps the
 * boundary that matters (outside the workspace stays read-only, and denials
 * still escalate through the approval channel).
 */
export function sandboxArgv(sandboxBin, cmd) {
  return [sandboxBin, "sandbox", "-c", 'sandbox_mode="workspace-write"', "--", ...shellArgv(cmd)];
}
