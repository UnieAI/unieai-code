#!/usr/bin/env bun
/**
 * Produce the published `dist/` bundle.
 *
 * UnieAI Code runs on the Bun runtime (it uses Bun.* APIs throughout), so this
 * is a Bun-target bundle — minified and code-split — NOT a Node build. It exists
 * only to shrink the npm tarball: instead of shipping ~38 MB of raw `src/`, we
 * ship one minified `dist/` (~7 MB). `bin/cli.mjs` / `bin/claude-haha` prefer
 * `dist/cli.js` when present and fall back to `src/entrypoints/cli.tsx` for
 * local development (no build needed to hack on the source).
 *
 * `--packages external` keeps every npm dependency out of the bundle (npm
 * installs them normally); only first-party `src/` + sibling `adapters/` are
 * bundled. `with { type: 'text' }` asset imports (computer-use helpers, provider
 * prompts) are inlined at build time, so `runtime/` does not need to ship.
 */
import type { BunPlugin } from 'bun'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outdir = join(root, 'dist')

// First-party code resolved via the `src/*` tsconfig alias plus the two local
// stub aliases must be BUNDLED; everything else bare (npm packages, node:
// builtins, undeclared-optional deps like sharp/fflate loaded via dynamic
// import) stays EXTERNAL and is resolved from node_modules at runtime. We can't
// use `packages: 'external'` because it would also externalize the non-relative
// `src/...` alias imports (390+ of them) and break the bundle.
const STUB_ALIASES = new Set(['@ant/claude-for-chrome-mcp', 'color-diff-napi'])
const externalizeNpm: BunPlugin = {
  name: 'externalize-npm',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path
      // Relative / absolute / first-party alias / stub aliases -> let Bun
      // resolve and bundle (returning undefined uses default resolution, which
      // honors tsconfig `paths`).
      if (p.startsWith('.') || p.startsWith('/')) return undefined
      if (p === 'src' || p.startsWith('src/')) return undefined
      if (STUB_ALIASES.has(p)) return undefined
      // Everything else bare (npm packages, node:/bun: builtins) -> external.
      return { path: p, external: true }
    })
  },
}

rmSync(outdir, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [
    join(root, 'src', 'entrypoints', 'cli.tsx'),
    join(root, 'src', 'localRecoveryCli.ts'),
  ],
  outdir,
  target: 'bun',
  format: 'esm',
  minify: true,
  splitting: true,
  sourcemap: 'none',
  plugins: [externalizeNpm],
  naming: {
    entry: '[name].js',
    chunk: 'chunks/[name]-[hash].js',
    asset: 'assets/[name]-[hash].[ext]',
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

let bytes = 0
for (const output of result.outputs) bytes += output.size
console.log(
  `Bundled ${result.outputs.length} file(s) into dist/ (${(bytes / 1_000_000).toFixed(1)} MB).`,
)
