#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-rabi-fork.mjs — republish the upstream harness packages as Rabi.
 *
 * The uac engine runs on the upstream harness (MIT; native addons BSD-3).
 * UnieAI ships it as Rabi: @unieai/rabi (the CLI, bin `rabi`), @unieai/rabi-*
 * for every harness package, and @unieai/<name> for the scope's other
 * packages (cordis, schemastery, the native addons, ...). The fork is made on
 * the published packages, at exactly the versions rabi-upstream/package-lock.json
 * pins, so the upstream source can be merged as it is.
 *
 * Upgrading: set the version in rabi-upstream/package.json, run
 * `npm install --package-lock-only` there, build, publish, then move
 * agent-runtime's @unieai/rabi dependencies to the new version.
 *
 *   node scripts/unieai-rabi-fork.mjs build [--out DIR] [--lock FILE]
 *       Download every upstream tarball rabi-upstream's lockfile pins (integrity
 *       checked), rename (src/unieai-rabi/rabi-rewrite.mjs), drop source maps,
 *       pin internal dependencies to the exact forked versions, and write
 *       DIR/packages/<name>/ plus DIR/manifest.json. Fails if a scan of the
 *       result still finds an upstream name outside binary files.
 *   node scripts/unieai-rabi-fork.mjs scan DIR
 *       Rescan a built DIR and print the report.
 *   node scripts/unieai-rabi-fork.mjs publish DIR [--registry URL] [--tag TAG] [--dry-run]
 *       Publish DIR/packages/* in dependency order. A version already on the
 *       registry is skipped if identical (same file list and sizes), and
 *       reported as a conflict otherwise.
 *   node scripts/unieai-rabi-fork.mjs relock DIR [--registry URL] [--lock FILE]
 *       Point agent-runtime's package-lock.json entries for the forked
 *       packages at the registry (default npmjs), with the integrity it
 *       serves. Run after publish and after moving the @unieai/rabi pin.
 *
 * WebAssembly modules get their import and export names renamed too, since
 * the renamed JS glue calls them by name (src/unieai-rabi/rabi-wasm-names.mjs).
 *
 * LICENSE files are kept as they are: they carry the upstream copyright,
 * which the MIT and BSD licenses require every copy to keep.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLeftovers, rabiPackageName, rewritePathSegment, rewriteText } from "../src/unieai-rabi/rabi-rewrite.mjs";
import { rewriteWasmNames } from "../src/unieai-rabi/rabi-wasm-names.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_SCOPE = "@deepseek-ai/";
const BINARY_EXT = /\.(node|wasm|woff2?|ttf|otf|png|avif|jpe?g|gif|ico|webp|zst|gz|br|zip|pdf)$/i;
const README = /^README(\.[a-z0-9]+)?\.(md|ya?ml)$/i;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--")) opts[arg.slice(2)] = rest[++i];
    else opts._.push(arg);
  }
  return { command, opts };
}

/** Every @deepseek-ai package the lockfile pins: name → { version, resolved, integrity }. */
export function pinnedUpstream(lock) {
  const pins = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const name = key.split("node_modules/").pop();
    if (!name.startsWith(UPSTREAM_SCOPE)) continue;
    const prior = pins.get(name);
    if (prior && prior.version !== entry.version) {
      throw new Error(`lockfile pins two versions of ${name}: ${prior.version} and ${entry.version}`);
    }
    if (!entry.resolved || !entry.integrity) throw new Error(`lockfile entry ${key} has no resolved/integrity`);
    pins.set(name, { version: entry.version, resolved: entry.resolved, integrity: entry.integrity });
  }
  return pins;
}

async function fetchTarball(pin, cacheDir) {
  const file = join(cacheDir, createHash("sha256").update(pin.resolved).digest("hex").slice(0, 24) + ".tgz");
  const [algo, expected] = pin.integrity.split(/-(.*)/s);
  const verify = (buf) => createHash(algo).update(buf).digest("base64") === expected;
  if (existsSync(file) && verify(readFileSync(file))) return file;
  const res = await fetch(pin.resolved);
  if (!res.ok) throw new Error(`GET ${pin.resolved}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!verify(buf)) throw new Error(`integrity mismatch for ${pin.resolved}`);
  writeFileSync(file, buf);
  return file;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Rename files and directories bottom-up so parents move after children. */
function renamePaths(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) renamePaths(path);
    const renamed = rewritePathSegment(entry.name);
    if (renamed !== entry.name) renameSync(path, join(dir, renamed));
  }
}

const isBinary = (path, buf) => BINARY_EXT.test(path) || buf.subarray(0, 8192).includes(0);
const stripSourceMapComment = (text) =>
  text.replace(/^\/\/# sourceMappingURL=.*$/gm, "").replace(/\/\*# sourceMappingURL=[^*]*\*\//g, "");

function readmeFor(name, description) {
  return [
    `# ${name}`,
    "",
    description ? `${description}\n` : "",
    "Part of Rabi, the agent harness UnieAI Code runs on. Installed as a dependency of `@unieai/rabi`;",
    "not meant to be used on its own.",
    "",
    "See LICENSE for the license and copyright of this package.",
    "",
  ].join("\n");
}

function rewritePackageJson(pkg, versions) {
  delete pkg.repository;
  delete pkg.homepage;
  delete pkg.bugs;
  delete pkg.gitHead;
  delete pkg.funding;
  pkg.version = versions.get(pkg.name);
  // Upstream's build and prepack scripts point into its monorepo; only the
  // hooks that run when a user installs the package still mean something.
  if (pkg.scripts) {
    const kept = Object.fromEntries(Object.entries(pkg.scripts).filter(([name]) => /^(pre|post)?install$/.test(name)));
    if (Object.keys(kept).length) pkg.scripts = kept;
    else delete pkg.scripts;
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    if (field === "devDependencies") {
      delete pkg.devDependencies;
      continue;
    }
    for (const dep of Object.keys(deps)) {
      if (versions.has(dep)) deps[dep] = versions.get(dep);
      else if (dep.startsWith("@unieai/rabi") || dep.startsWith(UPSTREAM_SCOPE)) {
        throw new Error(`${pkg.name} depends on ${dep}, which the lockfile does not pin`);
      }
    }
  }
  pkg.publishConfig = { access: "public" };
  return pkg;
}

/** Scan a built tree: upstream names left in text, and binaries that still carry them. */
export function scanTree(packagesDir) {
  const leftovers = [];
  const binaries = [];
  for (const file of walk(packagesDir)) {
    const rel = relative(packagesDir, file);
    if (findLeftovers(rel).length) leftovers.push({ file: rel, context: ["(path)"] });
    const buf = readFileSync(file);
    if (isBinary(file, buf)) {
      const latin = buf.toString("latin1");
      if (/@deepseek-ai\/|deepseek-harness|(?<![a-z])dsh[-_./]/.test(latin)) binaries.push(rel);
      continue;
    }
    const context = findLeftovers(buf.toString("utf8"));
    if (context.length) leftovers.push({ file: rel, context });
  }
  return { leftovers, binaries };
}

async function build(opts) {
  const lockPath = resolve(opts.lock ?? join(runtimeRoot, "rabi-upstream", "package-lock.json"));
  const outDir = resolve(opts.out ?? join(runtimeRoot, ".rabi-fork"));
  const pins = pinnedUpstream(JSON.parse(readFileSync(lockPath, "utf8")));
  const cacheDir = join(outDir, "cache");
  const packagesDir = join(outDir, "packages");
  rmSync(packagesDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(packagesDir, { recursive: true });

  const versions = new Map([...pins].map(([name, pin]) => [rabiPackageName(name), pin.version]));
  const names = [...pins.keys()].sort();
  console.error(`forking ${names.length} packages from ${relative(process.cwd(), lockPath)}`);

  const manifest = await mapLimit(names, 12, async (name) => {
    const pin = pins.get(name);
    const tarball = await fetchTarball(pin, cacheDir);
    const rabiName = rabiPackageName(name);
    const dir = join(packagesDir, rabiName.replace("/", "__"));
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1", "--no-same-owner"]);

    let removedMaps = 0;
    for (const file of walk(dir)) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      if (file.endsWith(".map")) {
        rmSync(file);
        removedMaps++;
        continue;
      }
      if (README.test(base)) {
        rmSync(file);
        continue;
      }
      const buf = readFileSync(file);
      if (file.endsWith(".wasm")) {
        // Entry points the (renamed) JS glue calls by name.
        const renamed = rewriteWasmNames(buf, rewriteText);
        if (renamed !== buf) writeFileSync(file, renamed);
        continue;
      }
      if (isBinary(file, buf) || base === "LICENSE" || /^LICEN[CS]E(\.|$)/i.test(base)) continue;
      const text = buf.toString("utf8");
      const rewritten = rewriteText(/\.(m?js|cjs|css)$/.test(file) ? stripSourceMapComment(text) : text);
      if (rewritten !== text) writeFileSync(file, rewritten);
    }
    renamePaths(dir);

    const pkgPath = join(dir, "package.json");
    const pkg = rewritePackageJson(JSON.parse(readFileSync(pkgPath, "utf8")), versions);
    if (pkg.name !== rabiName) throw new Error(`${name} renamed to ${pkg.name}, expected ${rabiName}`);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    writeFileSync(join(dir, "README.md"), readmeFor(pkg.name, pkg.description));
    if (Array.isArray(pkg.files) && !pkg.files.some((f) => /^README/i.test(f))) pkg.files.push("README.md");
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    return {
      upstream: name,
      upstreamVersion: pin.version,
      name: pkg.name,
      version: pkg.version,
      dir: relative(outDir, dir),
      deps: Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter((d) => versions.has(d)),
      removedMaps,
    };
  });

  const scan = scanTree(packagesDir);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ lockfile: lockPath, packages: manifest, scan }, null, 2) + "\n");
  report(scan);
  console.error(`wrote ${manifest.length} packages to ${packagesDir}`);
  if (scan.leftovers.length) process.exitCode = 1;
}

function report(scan) {
  for (const { file, context } of scan.leftovers.slice(0, 40)) console.error(`leftover: ${file}\n    ${context.slice(0, 3).join("\n    ")}`);
  if (scan.leftovers.length > 40) console.error(`... ${scan.leftovers.length - 40} more files`);
  for (const file of scan.binaries) console.error(`binary still names upstream: ${file}`);
  console.error(`scan: ${scan.leftovers.length} text files with upstream names, ${scan.binaries.length} binaries`);
}

/** Dependencies first, so a registry never serves a package whose deps are missing. */
export function publishOrder(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const done = new Set();
  const order = [];
  const visit = (p, stack = new Set()) => {
    if (done.has(p.name) || stack.has(p.name)) return;
    stack.add(p.name);
    for (const dep of p.deps) if (byName.has(dep)) visit(byName.get(dep), stack);
    done.add(p.name);
    order.push(p);
  };
  for (const p of packages) visit(p);
  return order;
}

function publish(opts) {
  const outDir = resolve(opts._[0] ?? join(runtimeRoot, ".rabi-fork"));
  const { packages } = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  const registry = opts.registry ? ["--registry", opts.registry] : [];
  const tag = ["--tag", opts.tag ?? (packages.some((p) => p.version.includes("-")) ? "next" : "latest")];
  const conflicts = [];
  let published = 0;
  let skipped = 0;
  for (const p of publishOrder(packages)) {
    const dir = join(outDir, p.dir);
    let existing = null;
    try {
      existing = execFileSync("npm", ["view", `${p.name}@${p.version}`, "dist.integrity", ...registry], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      existing = null;
    }
    if (existing) {
      // npm pack is deterministic, so the same files give the same integrity.
      const local = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].integrity;
      if (local === existing) skipped++;
      else conflicts.push(`${p.name}@${p.version}: the registry has different contents (${existing})`);
      continue;
    }
    if (opts.dryRun) {
      console.log(`would publish ${p.name}@${p.version}`);
      continue;
    }
    try {
      execFileSync("npm", ["publish", dir, ...tag, ...registry], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    } catch (error) {
      const lines = String(error.stderr ?? "").split("\n").filter((l) => l.startsWith("npm error")).slice(0, 4).join("\n");
      throw new Error(`npm publish ${p.name}@${p.version} failed:\n${lines}`);
    }
    published++;
    console.error(`published ${p.name}@${p.version}`);
  }
  for (const c of conflicts) console.error(`conflict: ${c}`);
  console.error(`published ${published}, already there ${skipped}, conflicts ${conflicts.length}`);
  if (conflicts.length) process.exitCode = 1;
}

/** Rewrite lockfile entries of the forked packages to what `registry` serves. */
async function relock(opts) {
  const outDir = resolve(opts._[0] ?? join(runtimeRoot, ".rabi-fork"));
  const registry = (opts.registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const lockPath = resolve(opts.lock ?? join(runtimeRoot, "package-lock.json"));
  const forked = new Set(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")).packages.map((p) => p.name));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const packuments = new Map();
  let count = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const name = key.split("node_modules/").pop();
    if (!forked.has(name)) continue;
    if (!packuments.has(name)) {
      const res = await fetch(`${registry}/${name.replace("/", "%2f")}`);
      if (!res.ok) throw new Error(`GET ${registry}/${name}: ${res.status}`);
      packuments.set(name, await res.json());
    }
    const dist = packuments.get(name).versions?.[entry.version]?.dist;
    if (!dist) throw new Error(`${name}@${entry.version} is not on ${registry}; publish first`);
    entry.resolved = dist.tarball;
    entry.integrity = dist.integrity;
    count++;
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.error(`relocked ${count} entries in ${relative(process.cwd(), lockPath)} to ${registry}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (command === "build") await build(opts);
  else if (command === "scan") report(scanTree(join(resolve(opts._[0]), "packages")));
  else if (command === "publish") publish(opts);
  else if (command === "relock") await relock(opts);
  else {
    console.error("usage: unieai-rabi-fork.mjs build|scan|publish|relock  (see the header comment)");
    process.exitCode = 2;
  }
}
