// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-dsh-launch.mjs — run dsh's CLI on any Node the package supports.
 *
 *   node unieai-dsh-launch.mjs <dsh bin.js> [dsh arguments…]
 *
 * dsh's `bin.js` starts only `if (import.meta.main)`. Node 23, Node 22 before
 * 22.18 and Node 24 before 24.2 never set `import.meta.main`, so there dsh exits
 * at once with status 0 and no output, and uac could only say "ACP agent closed
 * the connection". Importing the module and calling its exported `runCli`
 * starts it the same way everywhere; imported, its own `import.meta.main` is
 * false, so it never runs twice.
 */
import { pathToFileURL } from "node:url";

const [node, , bin, ...args] = process.argv;
if (!bin) {
  process.stderr.write("usage: unieai-dsh-launch.mjs <dsh bin.js> [args…]\n");
  process.exit(2);
}
// commander reads process.argv as [node, script, ...args]: make dsh's bin.js the script.
process.argv = [node, bin, ...args];
const { runCli } = await import(pathToFileURL(bin).href);
if (typeof runCli !== "function") {
  process.stderr.write(`${bin} does not export runCli; this dsh cannot be started by UnieAI Code\n`);
  process.exit(1);
}
await runCli();
