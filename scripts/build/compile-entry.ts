#!/usr/bin/env bun
/**
 * Entry point for the standalone `bun build --compile` binary.
 *
 * The npm launcher (bin/cli.mjs) sets CLAUDE_CONFIG_DIR + injects MACRO via the
 * bunfig `preload`. A compiled binary honors neither, so we replicate both here
 * BEFORE importing preload/CLI: set env defaults, then dynamically import so the
 * assignments land before preload/CLI read them.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Version is frozen at compile time via `--define process.env.COMPILE_VERSION`
// (no package.json on disk next to the binary for preload.ts to read).
process.env.CLAUDE_CODE_LOCAL_VERSION ||= process.env.COMPILE_VERSION || '0.0.0'
process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ||= '@unieai/code'

// Mirror bin/cli.mjs: isolate state under ~/.unieai unless overridden.
if (!process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR =
    process.env.UNIEAI_CONFIG_DIR || join(homedir(), '.unieai')
}
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

// Do NOT set CALLER_DIR: launched directly, cwd is already the user's dir and
// preload only chdir()s when CALLER_DIR is present.

await import('../../preload.ts')
await import('../../src/entrypoints/cli.tsx')
