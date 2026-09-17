#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-sync-uac-plugins.mjs — vendor UnieAI/uac-plugins into agent-runtime.
 *
 * The uac engine loads its dsh plugins from src/unieai-dsh/uac-plugins/, a
 * committed copy of the plugin modules in https://github.com/UnieAI/uac-plugins
 * (a private repo the release build cannot fetch). Tests and test kits are not
 * copied. UPSTREAM records the commit the copy came from.
 *
 *   node scripts/unieai-sync-uac-plugins.mjs [<uac-plugins checkout>]   # copy
 *   node scripts/unieai-sync-uac-plugins.mjs --check [<checkout>]       # verify
 *
 * The checkout defaults to $UAC_PLUGINS_DIR, else ../../uac-plugins next to
 * this repository. It must be clean so UPSTREAM names exactly what was copied.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(runtimeRoot, "src", "unieai-dsh", "uac-plugins");
const REPO = "https://github.com/UnieAI/uac-plugins";

const args = process.argv.slice(2);
const check = args.includes("--check");
const source = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.env.UAC_PLUGINS_DIR ?? join(runtimeRoot, "..", "..", "uac-plugins"));

const git = (...gitArgs) => execFileSync("git", ["-C", source, ...gitArgs], { encoding: "utf8" }).trim();

/** Files the engine needs: plugin modules (no tests or test kits) and NOTICE. */
function vendoredFiles(dir) {
  const src = readdirSync(join(dir, "src"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs") && !file.endsWith("-testkit.mjs"))
    .sort();
  return { src, notice: existsSync(join(dir, "NOTICE")) };
}

if (!existsSync(join(source, "src", "unieai-catalog.mjs"))) {
  console.error(`not a uac-plugins checkout: ${source}\nclone ${REPO} there or pass its path`);
  process.exit(2);
}
const dirty = git("status", "--porcelain", "--", "src", "NOTICE");
if (dirty) {
  console.error(`uac-plugins checkout has uncommitted changes:\n${dirty}`);
  process.exit(2);
}
const commit = git("rev-parse", "HEAD");
const upstream = `${REPO}\n${commit}\n`;
const { src, notice } = vendoredFiles(source);

if (check) {
  const problems = [];
  const recorded = existsSync(join(target, "UPSTREAM")) ? readFileSync(join(target, "UPSTREAM"), "utf8") : "";
  if (recorded !== upstream) problems.push(`UPSTREAM is not ${commit}`);
  for (const file of src) {
    const vendored = join(target, file);
    if (!existsSync(vendored) || readFileSync(vendored, "utf8") !== readFileSync(join(source, "src", file), "utf8")) {
      problems.push(`${file} differs`);
    }
  }
  const extra = readdirSync(target).filter((file) => file.endsWith(".mjs") && !src.includes(file));
  for (const file of extra) problems.push(`${file} is not in uac-plugins`);
  if (problems.length > 0) {
    console.error(`vendored uac-plugins is out of date:\n  ${problems.join("\n  ")}\nrun: node scripts/unieai-sync-uac-plugins.mjs`);
    process.exit(1);
  }
  console.log(`vendored uac-plugins matches ${commit}`);
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of src) copyFileSync(join(source, "src", file), join(target, file));
if (notice) copyFileSync(join(source, "NOTICE"), join(target, "NOTICE"));
writeFileSync(join(target, "UPSTREAM"), upstream);
console.log(`vendored ${src.length} modules from uac-plugins ${commit}`);
