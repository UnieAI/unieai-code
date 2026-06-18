#!/usr/bin/env node
/**
 * Cross-platform launcher for UnieAI Code.
 *
 * Replaces the bash-only `claude-haha` launcher so the `unieai` command works
 * from cmd / PowerShell / Git Bash / macOS / Linux. npm generates the
 * `.cmd` / `.ps1` shims around this Node entry automatically. It mirrors the
 * env setup of the old bash launcher and then runs the TUI with `bun`.
 *
 * Requirement: `bun` must be installed and on PATH (same as before).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'

const env = { ...process.env }

// Remember where the user launched from; preload.ts chdir()s back to it.
if (!env.CALLER_DIR) env.CALLER_DIR = process.cwd()

// Keep state (sessions / login / theme / MCP) isolated from upstream Claude
// Code. Honors CLAUDE_CONFIG_DIR or UNIEAI_CONFIG_DIR; defaults to ~/.unieai.
if (!env.CLAUDE_CONFIG_DIR) {
  env.CLAUDE_CONFIG_DIR = env.UNIEAI_CONFIG_DIR || join(homedir(), '.unieai')
}
mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })

const args = process.argv.slice(2)

// --env-file handling (mirror of the bash launcher).
const bunArgs = []
if (env.CC_HAHA_SKIP_DOTENV === '1') {
  bunArgs.push(`--env-file=${isWindows ? 'NUL' : '/dev/null'}`)
} else if (existsSync(join(rootDir, '.env'))) {
  bunArgs.push(`--env-file=${join(rootDir, '.env')}`)
}

const entry =
  env.CLAUDE_CODE_FORCE_RECOVERY_CLI === '1'
    ? join(rootDir, 'src', 'localRecoveryCli.ts')
    : join(rootDir, 'src', 'entrypoints', 'cli.tsx')

// On Windows, `bun` resolves to bun.exe; passing the explicit name lets Node's
// PATH lookup find it without a shell (so paths with spaces stay intact).
const bunBin = isWindows ? 'bun.exe' : 'bun'

const child = spawn(bunBin, [...bunArgs, entry, ...args], {
  stdio: 'inherit',
  cwd: rootDir,
  env,
})

child.on('error', (err) => {
  process.stderr.write(
    `Failed to launch UnieAI Code. Is 'bun' installed and on PATH?\n` +
      `Install: https://bun.sh\n${err.message}\n`,
  )
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
