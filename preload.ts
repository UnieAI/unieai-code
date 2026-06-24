// Read the real version/name from the package.json shipped alongside this file
// (it sits at the package root, next to preload.ts). Without this MACRO.VERSION
// was frozen at a hardcoded literal, so `unieai --version` lied and the
// auto-updater compared the npm `latest` against a stale baseline — meaning it
// never noticed a newer published version. The env vars still win for local
// dev / CI overrides.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pkgVersion = '0.0.0';
let pkgName = '@unieai/code';
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof pkg.version === 'string') pkgVersion = pkg.version;
  if (typeof pkg.name === 'string') pkgName = pkg.name;
} catch {
  // Fall back to defaults if package.json can't be read (shouldn't happen in a
  // normal install, but never block startup over it).
}

const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? pkgVersion;
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? pkgName;
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
// Switch to the current workspace
if (process.env.CALLER_DIR) {
  process.chdir(process.env.CALLER_DIR);
}