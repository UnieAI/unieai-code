#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Build UnieAI Code offline install bundles from the staged npm tarballs.

`npm install -g @unieai/code` needs the registry twice: once for the CLI and
its platform binary, and again for the uac engine's dependencies
(deepseek-harness and its native modules). An offline bundle carries all of
it, plus the Node.js runtime uac runs on, so a machine with no network (or no
Node) installs from one archive:

  unieai-code-<version>-<platform>/
    package/          @unieai/code, installed: bin/codex.js, vendor/<target>/
                      (native binary), agent-runtime/, node_modules/ (dsh and
                      its native modules for <platform>)
    node/             Node.js 22 for <platform>
    unieai | unieai.cmd   launcher (runs package/bin/codex.js with node/)
    install.sh | install.ps1
    README.txt

Every bundle is built on one Linux host: npm installs another platform's
optional native packages when given --os/--cpu/--libc.

  scripts/unieai_offline_bundle.py --version 0.0.34 \\
      --npm-dir dist/npm --out dist/offline [--platform linux-x64 ...]

`--npm-dir` holds the stage job's codex-npm-<version>.tgz and
codex-npm-<platform>-<version>.tgz. Without it the tarballs are fetched with
`npm pack` from the registry (the published release).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

NODE_MAJOR = 22

# npm platform tag -> (vendor target, node dist name, npm --os, --cpu, --libc)
PLATFORMS = {
    "linux-x64": ("x86_64-unknown-linux-musl", "linux-x64", "linux", "x64", "glibc"),
    "linux-arm64": ("aarch64-unknown-linux-musl", "linux-arm64", "linux", "arm64", "glibc"),
    "darwin-x64": ("x86_64-apple-darwin", "darwin-x64", "darwin", "x64", None),
    "darwin-arm64": ("aarch64-apple-darwin", "darwin-arm64", "darwin", "arm64", None),
    "win32-x64": ("x86_64-pc-windows-msvc", "win-x64", "win32", "x64", None),
    "win32-arm64": ("aarch64-pc-windows-msvc", "win-arm64", "win32", "arm64", None),
}

UNIX_LAUNCHER = """#!/bin/sh
# Copyright (c) 2026 UnieAI. All rights reserved.
# UnieAI Code (offline bundle): the bundled Node.js runs the CLI and its uac engine.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
root=$(cd "$(dirname "$self")" && pwd)
exec "$root/node/bin/node" "$root/package/bin/codex.js" "$@"
"""

WINDOWS_LAUNCHER = """@echo off
rem Copyright (c) 2026 UnieAI. All rights reserved.
rem UnieAI Code (offline bundle): the bundled Node.js runs the CLI and its uac engine.
"%~dp0node\\node.exe" "%~dp0package\\bin\\codex.js" %*
"""

INSTALL_SH = """#!/bin/sh
# Copyright (c) 2026 UnieAI. All rights reserved.
# Install this UnieAI Code offline bundle without the network.
#
#   sh install.sh            # -> ~/.local/share/unieai-code/<version>, ~/.local/bin/unieai
#   UNIEAI_INSTALL_DIR=/opt/unieai UNIEAI_BIN_DIR=/usr/local/bin sh install.sh
set -eu
src=$(cd "$(dirname "$0")" && pwd)
version=$(cat "$src/VERSION")
prefix=${UNIEAI_INSTALL_DIR:-$HOME/.local/share/unieai-code}
bindir=${UNIEAI_BIN_DIR:-$HOME/.local/bin}
dest=$prefix/$version
if [ "$src" != "$dest" ]; then
  mkdir -p "$prefix"
  rm -rf "$dest.tmp"
  cp -R "$src" "$dest.tmp"
  rm -rf "$dest"
  mv "$dest.tmp" "$dest"
fi
mkdir -p "$bindir"
ln -sfn "$dest/unieai" "$bindir/unieai"
# macOS marks downloaded files; the bundled binaries are not notarized apps.
if command -v xattr >/dev/null 2>&1; then xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true; fi
echo "UnieAI Code $version installed: $bindir/unieai -> $dest/unieai"
case ":$PATH:" in *":$bindir:"*) ;; *) echo "Add $bindir to your PATH to run \\`unieai\\`." ;; esac
"$bindir/unieai" --version
"""

INSTALL_PS1 = """# Copyright (c) 2026 UnieAI. All rights reserved.
# Install this UnieAI Code offline bundle without the network.
#   powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $src 'VERSION')).Trim()
$prefix = if ($env:UNIEAI_INSTALL_DIR) { $env:UNIEAI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'UnieAI\\unieai-code' }
$dest = Join-Path $prefix $version
if ($src -ne $dest) {
  New-Item -ItemType Directory -Force -Path $prefix | Out-Null
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $src $dest
}
$bin = Join-Path $prefix 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content -Path (Join-Path $bin 'unieai.cmd') -Value "@echo off`r`n`"$dest\\unieai.cmd`" %*" -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
  Write-Host "Added $bin to your user PATH (open a new terminal)."
}
Write-Host "UnieAI Code $version installed: $bin\\unieai.cmd"
& (Join-Path $dest 'unieai.cmd') --version
"""

README = """UnieAI Code {version} — offline install bundle ({platform})

Everything needed is in this folder: the CLI, its uac engine
(deepseek-harness {dsh}) with its native modules, and Node.js {node}.
Nothing is downloaded during install.

  Linux / macOS:  sh install.sh
  Windows:        powershell -ExecutionPolicy Bypass -File install.ps1

Then run `unieai` (sign in with `unieai login`; a self-hosted gateway works
with `unieai login --api-key`). To run without installing: ./unieai (unieai.cmd on Windows).
"""


def log(message: str) -> None:
    print(f"[offline] {message}", file=sys.stderr, flush=True)


def run(cmd: list[str], **kwargs) -> None:
    subprocess.run(cmd, check=True, **kwargs)


def node_release(cache: Path) -> str:
    """Newest Node.js 22 release version (e.g. v22.20.0)."""
    with urllib.request.urlopen("https://nodejs.org/dist/index.json", timeout=60) as response:
        releases = json.load(response)
    return next(r["version"] for r in releases if r["version"].startswith(f"v{NODE_MAJOR}."))


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        log(f"downloading {url}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(url, timeout=600) as response, tmp.open("wb") as out:
            shutil.copyfileobj(response, out)
        tmp.rename(dest)
    return dest


def verify_node(archive: Path, version: str, cache: Path) -> None:
    sums = fetch(f"https://nodejs.org/dist/{version}/SHASUMS256.txt", cache / f"SHASUMS256-{version}.txt").read_text()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if f"{digest}  {archive.name}" not in sums:
        raise SystemExit(f"{archive.name}: sha256 does not match nodejs.org's SHASUMS256.txt")


def stage_node(platform: str, version: str, cache: Path, dest: Path) -> None:
    dist = PLATFORMS[platform][1]
    windows = platform.startswith("win32")
    name = f"node-{version}-{dist}.{'zip' if windows else 'tar.xz'}"
    archive = fetch(f"https://nodejs.org/dist/{version}/{name}", cache / name)
    verify_node(archive, version, cache)
    with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
        if windows:
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp)
        else:
            with tarfile.open(archive) as tf:
                tf.extractall(tmp, filter="tar")
        (Path(tmp) / f"node-{version}-{dist}").rename(dest)
    # The bundle runs node, not npm: drop the package manager it ships with.
    for extra in ("lib/node_modules/npm", "lib/node_modules/corepack", "node_modules/npm", "node_modules/corepack"):
        shutil.rmtree(dest / extra, ignore_errors=True)
    for shim in ("bin/npm", "bin/npx", "bin/corepack", "npm", "npx", "npm.cmd", "npx.cmd", "npm.ps1", "npx.ps1", "corepack", "corepack.cmd"):
        (dest / shim).unlink(missing_ok=True)


def npm_tarballs(version: str, platform: str, npm_dir: Path | None, cache: Path) -> tuple[Path, Path]:
    if npm_dir:
        root = npm_dir / f"codex-npm-{version}.tgz"
        payload = npm_dir / f"codex-npm-{platform}-{version}.tgz"
        for path in (root, payload):
            if not path.exists():
                raise SystemExit(f"{path} is missing")
        return root, payload
    found = []
    for spec in (f"@unieai/code@{version}", f"@unieai/code@{version}-{platform}"):
        out = subprocess.run(["npm", "pack", "--silent", spec], cwd=cache, check=True, capture_output=True, text=True)
        found.append(cache / out.stdout.strip().splitlines()[-1])
    return found[0], found[1]


LOCKFILE = Path(__file__).resolve().parent.parent / "agent-runtime" / "package-lock.json"


def check_against_lockfile(node_modules: Path) -> None:
    """Fail when an installed package is not at a version agent-runtime's lockfile holds."""
    if not LOCKFILE.exists():
        log(f"no {LOCKFILE}; installed versions not checked")
        return
    locked: dict[str, set[str]] = {}
    for path, entry in json.loads(LOCKFILE.read_text())["packages"].items():
        if path:
            locked.setdefault(path.rsplit("node_modules/", 1)[-1], set()).add(entry.get("version"))
    drift = []
    for manifest in node_modules.rglob("package.json"):
        rel = manifest.parent.relative_to(node_modules.parent).as_posix()
        name = rel.rsplit("node_modules/", 1)[-1]
        if name.count("/") > (1 if name.startswith("@") else 0) or name not in locked:
            continue
        try:
            version = json.loads(manifest.read_text()).get("version")
        except (OSError, ValueError):
            continue
        if version not in locked[name]:
            drift.append(f"{rel}@{version} (lockfile: {', '.join(sorted(locked[name]))})")
    if drift:
        raise SystemExit("installed packages differ from agent-runtime/package-lock.json: " + "; ".join(sorted(drift)[:20]))


def build(platform: str, version: str, npm_dir: Path | None, out: Path, node_version: str, cache: Path) -> Path:
    target, _dist, os_name, cpu, libc = PLATFORMS[platform]
    windows = platform.startswith("win32")
    name = f"unieai-code-{version}-{platform}"
    work = out / name
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    root_tgz, payload_tgz = npm_tarballs(version, platform, npm_dir, cache)

    with tarfile.open(root_tgz) as tf:
        tf.extractall(work, filter="tar")  # -> work/package
    package = work / "package"
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        with tarfile.open(payload_tgz) as tf:
            tf.extractall(tmp, filter="tar")
        shutil.move(str(Path(tmp) / "package" / "vendor"), str(package / "vendor"))
    if not (package / "vendor" / target / "bin" / ("codex.exe" if windows else "codex")).exists():
        raise SystemExit(f"{payload_tgz.name} has no {target} binary")

    # The platform payload is already in vendor/; installing it again through
    # the alias would need the registry at install time.
    manifest = json.loads((package / "package.json").read_text())
    manifest.pop("optionalDependencies", None)
    manifest.pop("devDependencies", None)
    (package / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
    flags = [f"--os={os_name}", f"--cpu={cpu}"] + ([f"--libc={libc}"] if libc else [])
    log(f"{platform}: npm install ({' '.join(flags)})")
    # The package's dependencies pin every lockfile package exactly
    # (build_npm_package.py). A fresh npm cache per bundle: every tarball is
    # downloaded and checked against the registry's integrity, never taken
    # from a cache an earlier step could have left behind.
    with tempfile.TemporaryDirectory(dir=out) as npm_cache:
        run(
            ["npm", "install", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund", "--no-package-lock",
             f"--cache={npm_cache}", *flags],
            cwd=package,
            stdout=subprocess.DEVNULL,
        )
    check_against_lockfile(package / "node_modules")
    dsh_version = json.loads((package / "node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]

    stage_node(platform, node_version, cache, work / "node")
    (work / "VERSION").write_text(f"{version}\n")
    (work / "README.txt").write_text(README.format(version=version, platform=platform, dsh=dsh_version, node=node_version))
    if windows:
        (work / "unieai.cmd").write_text(WINDOWS_LAUNCHER.replace("\n", "\r\n"))
        (work / "install.ps1").write_text(INSTALL_PS1)
    else:
        for file, text in (("unieai", UNIX_LAUNCHER), ("install.sh", INSTALL_SH)):
            (work / file).write_text(text)
            (work / file).chmod(0o755)

    if windows:
        archive = out / f"{name}.zip"
        archive.unlink(missing_ok=True)
        log(f"{platform}: zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for path in sorted(work.rglob("*")):
                if path.is_symlink():
                    raise SystemExit(f"{path}: a symlink cannot go into a Windows zip")
                zf.write(path, path.relative_to(out))
    else:
        archive = out / f"{name}.tar.gz"
        log(f"{platform}: tar.gz")
        run(["tar", "-czf", str(archive), "-C", str(out), name])
    shutil.rmtree(work)
    log(f"{platform}: {archive.name} ({archive.stat().st_size / 1e6:.0f} MB, dsh {dsh_version}, node {node_version})")
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True, help="npm version, e.g. 0.0.34")
    parser.add_argument("--npm-dir", type=Path, help="directory with the staged codex-npm-*.tgz (default: npm pack from the registry)")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--platform", action="append", choices=sorted(PLATFORMS), help="repeatable; default: all")
    parser.add_argument("--node-version", help=f"Node.js release (default: newest v{NODE_MAJOR})")
    parser.add_argument("--cache", type=Path, help="download cache (default: <out>/.cache)")
    args = parser.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    cache = (args.cache or out / ".cache").resolve()
    cache.mkdir(parents=True, exist_ok=True)
    node_version = args.node_version or node_release(cache)
    npm_dir = args.npm_dir.resolve() if args.npm_dir else None
    archives = [build(p, args.version, npm_dir, out, node_version, cache) for p in (args.platform or list(PLATFORMS))]

    sums = out / f"unieai-code-{args.version}-offline-SHA256SUMS.txt"
    lines = [f"{hashlib.sha256(a.read_bytes()).hexdigest()}  {a.name}" for a in archives]
    sums.write_text("\n".join(lines) + "\n")
    log(f"wrote {sums.name}")


if __name__ == "__main__":
    main()
