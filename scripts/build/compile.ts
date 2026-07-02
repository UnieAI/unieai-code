#!/usr/bin/env bun
/**
 * Produce standalone, single-file executables via `bun build --compile`.
 *
 * Unlike the npm `dist/` bundle (scripts/build/bundle.ts), these binaries embed
 * the Bun runtime + all first-party code + all bundleable npm deps, so end users
 * need NEITHER npm NOR bun on PATH — they download one file and run it. This is
 * what the GitHub Release + install.sh path ships.
 *
 * Entry is scripts/build/compile-entry.ts, which replicates the env setup that
 * bin/cli.mjs + the bunfig `preload` do at runtime (CLAUDE_CONFIG_DIR, MACRO).
 *
 * Usage:
 *   bun run scripts/build/compile.ts                # all targets -> dist-bin/
 *   bun run scripts/build/compile.ts bun-linux-x64  # one target (CI matrix)
 */
import { rmSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outdir = join(root, 'dist-bin')
const entry = join(root, 'scripts', 'build', 'compile-entry.ts')

const pkg = JSON.parse(await Bun.file(join(root, 'package.json')).text())
const version: string = pkg.version

// Optional deps loaded via dynamic import() and NOT installed in node_modules
// (the "undeclared-optional deps" the npm bundle keeps external). `--compile`
// tries to resolve every bare import at build time, so these must stay external
// or the build fails. The code already wraps each in try/catch, so a compiled
// binary simply runs without them (no image resize via sharp, no OTLP exporters,
// no 3P-provider SDKs unless the user installs them alongside).
const EXTERNAL = [
  'sharp',
  'fflate',
  'cacache',
  'plist',
  'cli-highlight',
  '@azure/identity',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@aws-sdk/credential-providers',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@anthropic-ai/mcpb',
  'audio-capture-napi',
  'image-processor-napi',
  'url-handler-napi',
  '@opentelemetry/exporter-*',
]

// target -> output binary name (matches install.sh's os/arch mapping).
const TARGETS: Record<string, string> = {
  'bun-darwin-arm64': 'unieai-macos-arm64',
  'bun-darwin-x64': 'unieai-macos-x64',
  'bun-linux-x64': 'unieai-linux-x64',
  'bun-linux-arm64': 'unieai-linux-arm64',
  'bun-windows-x64': 'unieai-windows-x64.exe',
}

const only = process.argv[2]
if (only && !TARGETS[only]) {
  console.error(`Unknown target "${only}". Known: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}
const targets = only ? { [only]: TARGETS[only] } : TARGETS

if (!only) rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

for (const [target, outname] of Object.entries(targets)) {
  const outfile = join(outdir, outname)
  const args = [
    'build',
    '--compile',
    `--target=${target}`,
    ...EXTERNAL.flatMap((e) => ['--external', e]),
    // Bake the version at build time: the binary has no package.json next to it,
    // so preload.ts's disk read would otherwise fall back to 0.0.0.
    '--define',
    `process.env.COMPILE_VERSION=${JSON.stringify(version)}`,
    entry,
    '--outfile',
    outfile,
  ]
  console.log(`Compiling ${target} -> ${outname} (v${version})`)
  const proc = Bun.spawnSync(['bun', ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (!proc.success) {
    console.error(`Failed to compile ${target}`)
    process.exit(1)
  }
}

console.log(`Done. Binaries in ${outdir}`)
