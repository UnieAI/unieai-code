/**
 * processUtil.ts — spawn and stop the `unieai` CLI portably.
 *
 * The launch strategy itself (Windows PATHEXT resolution, cmd.exe quoting, the
 * `sh` vs `cmd.exe` split) lives in agent-runtime's portable-exec.mjs so the
 * extension and the agent-core tool layer cannot drift apart; esbuild bundles
 * it, the same way agentCoreBackend.ts pulls in engine.mjs.
 */
import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
  SpawnOptionsWithoutStdio,
} from "node:child_process"
// @ts-expect-error — JS ESM from the agent-runtime package (bundled by esbuild)
import { IS_WIN, prepareExec } from "../../../agent-runtime/src/portable-exec.mjs"

const prepare = prepareExec as (
  file: string,
  args: string[],
) => { file: string; args: string[]; shell: boolean }
const isWin = IS_WIN as boolean

/** Spawn the CLI, picking the safest launch strategy for the platform. */
export function spawnCli(
  file: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  const spec = prepare(file, args)
  return spawn(spec.file, spec.args, {
    ...options,
    ...(spec.shell ? { shell: true } : {}),
    windowsHide: true,
  })
}

/** Stop a spawned CLI, including the cmd.exe wrapper case on Windows.
 *
 * `kill()` on Windows terminates only the direct child, which for a .cmd shim
 * is the shell — the CLI underneath would keep running (and keep holding the
 * session) after the user hit Stop. */
export function killTree(child: ChildProcess | undefined | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (!isWin || child.pid == null) {
    child.kill("SIGTERM")
    return
  }
  try {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
    killer.on("error", () => child.kill())
  } catch {
    child.kill()
  }
}

/** Render `bin` as a command line to type into an interactive terminal.
 *
 * `shell` is the user's default shell (`vscode.env.shell`). PowerShell — the
 * VS Code default on Windows — evaluates a bare quoted string as a literal and
 * just echoes it, so an absolute path there needs the call operator. A bare
 * name is left unquoted so PATHEXT can resolve `unieai` to `unieai.cmd`. */
export function terminalCommand(bin: string, shell: string): string {
  if (!/[\s"'&|<>^()$`\\]/.test(bin)) {
    return bin
  }
  if (!isWin) {
    return `'${bin.replace(/'/g, `'\\''`)}'`
  }
  const quoted = `"${bin.replace(/"/g, '""')}"`
  return /pwsh|powershell/i.test(shell) ? `& ${quoted}` : quoted
}
