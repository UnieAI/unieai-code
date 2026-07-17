const esbuild = require("esbuild")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(`    ${location.file}:${location.line}:${location.column}:`)
      })
      console.log("[watch] build finished")
    })
  },
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  })
  // Webview bundle (chat panel) — browser platform, bundles `marked`.
  const webviewCtx = await esbuild.context({
    entryPoints: ["src/webview/chat.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: false,
    platform: "browser",
    outfile: "media/chat.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  })
  if (watch) {
    await Promise.all([ctx.watch(), webviewCtx.watch()])
  } else {
    await ctx.rebuild()
    await webviewCtx.rebuild()
    await ctx.dispose()
    await webviewCtx.dispose()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
