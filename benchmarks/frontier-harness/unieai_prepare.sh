#!/usr/bin/env bash
# Copyright (c) 2026 UnieAI. All rights reserved.
#
# Stage everything the FrontierHarness runner needs on the host, outside the repo:
#
#   $UNIEAI_BENCH_CACHE/runtime/node          node 22 (linux-x64), runs dsh in task containers
#   $UNIEAI_BENCH_CACHE/runtime/dsh           @deepseek-ai/dsh from agent-runtime's package-lock.json
#   $UNIEAI_BENCH_CACHE/runtime/codex/<label> static musl codex builds (bin/codex, path/rg)
#   $UNIEAI_BENCH_CACHE/tasks/terminal-bench  terminal-bench/terminal-bench-2-1 (Harbor registry)
#   $UNIEAI_BENCH_CACHE/tasks/deep-swe        datacurve-ai/deep-swe at the eval's reproduction ref
#
# The runtime directory is bind-mounted read-only into every task container at
# /opt/unieai-bench, so no trial installs anything from the network.
#
# Idempotent: existing pieces are kept unless --force is given.
#   bash unieai_prepare.sh [--force] [--unieai-code-version 0.0.27]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CACHE=${UNIEAI_BENCH_CACHE:-$HOME/.cache/unieai-frontier-harness}
RUNTIME=$CACHE/runtime
NODE_MAJOR=22
UNIEAI_CODE_VERSION=${UNIEAI_CODE_VERSION:-0.0.27}
OPENAI_CODEX_VERSION=${OPENAI_CODEX_VERSION:-latest}
DEEP_SWE_REF=435ee89ec2f2e2289f33b0da4f992f0b7b7266b9
TB_DATASET=terminal-bench/terminal-bench-2-1
HARBOR=${HARBOR:-harbor}
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --unieai-code-version) UNIEAI_CODE_VERSION=$2; shift 2 ;;
    --openai-codex-version) OPENAI_CODEX_VERSION=$2; shift 2 ;;
    --harbor) HARBOR=$2; shift 2 ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$RUNTIME/codex" "$CACHE/pkgs" "$CACHE/tasks"
say() { printf '[prepare] %s\n' "$*" >&2; }

# ── node ────────────────────────────────────────────────────────────────────
if [ "$FORCE" = 1 ] || [ ! -x "$RUNTIME/node/bin/node" ]; then
  version=$(curl -fsSL https://nodejs.org/dist/index.json \
    | python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$NODE_MAJOR.')))")
  say "node $version"
  rm -rf "$RUNTIME/node" "$RUNTIME/node-$version-linux-x64"
  curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" | tar -xJ -C "$RUNTIME"
  mv "$RUNTIME/node-$version-linux-x64" "$RUNTIME/node"
fi
NODE="$RUNTIME/node/bin/node"
NPM="$RUNTIME/node/bin/npm"
export PATH="$RUNTIME/node/bin:$PATH"

# ── CA bundle (some task images ship none; codex's rustls needs one) ──────
mkdir -p "$RUNTIME/certs"
cp -L /etc/ssl/certs/ca-certificates.crt "$RUNTIME/certs/ca-certificates.crt"

# ── dsh (same resolution UnieAI Code ships: agent-runtime's lockfile) ───────
# Installed into dsh-<lock hash>; `dsh` is a relative symlink, swapped atomically
# so trials already running on an older install keep their files.
lock="$REPO/agent-runtime/package-lock.json"
want=$(sha256sum "$lock" | cut -c1-12)
target="$RUNTIME/dsh-$want"
if [ "$FORCE" = 1 ] || [ ! -f "$target/.complete" ]; then
  say "dsh from $lock -> dsh-$want"
  rm -rf "$target"
  mkdir -p "$target"
  cp "$REPO/agent-runtime/package.json" "$lock" "$target/"
  (cd "$target" && "$NPM" ci --no-audit --no-fund --omit=dev --ignore-scripts >/dev/null)
  echo "$want" > "$target/.lock-sha256"
  touch "$target/.complete"
fi
if [ -d "$RUNTIME/dsh" ] && [ ! -L "$RUNTIME/dsh" ]; then
  old="$RUNTIME/dsh-legacy-$(date +%s)"
  mv "$RUNTIME/dsh" "$old"
  say "kept the previous unversioned install at $old (remove it once no trial uses it)"
fi
ln -sfn "dsh-$want" "$RUNTIME/dsh.tmp" && mv -T "$RUNTIME/dsh.tmp" "$RUNTIME/dsh"
say "dsh $("$NODE" -p "require('$RUNTIME/dsh/node_modules/@deepseek-ai/dsh/package.json').version") (dsh-$want)"

# ── codex payloads ──────────────────────────────────────────────────────────
# stage_codex <npm spec> <label>: unpack the linux-x64 platform package and keep
# its musl binary plus the ripgrep it ships (or the upstream one as a fallback).
stage_codex() {
  local spec=$1 label=$2 dest="$RUNTIME/codex/$2" tgz dir vendor
  if [ "$FORCE" != 1 ] && [ -x "$dest/bin/codex" ]; then return 0; fi
  tgz=$(cd "$CACHE/pkgs" && npm pack --silent "$spec" 2>/dev/null | tail -1) || return 1
  [ -n "$tgz" ] && [ -f "$CACHE/pkgs/$tgz" ] || return 1
  dir="$CACHE/pkgs/${tgz%.tgz}"
  rm -rf "$dir" && mkdir -p "$dir" && tar -xzf "$CACHE/pkgs/$tgz" -C "$dir"
  vendor="$dir/package/vendor/x86_64-unknown-linux-musl"
  [ -x "$vendor/bin/codex" ] || { say "no musl codex in $spec"; return 1; }
  rm -rf "$dest" && mkdir -p "$dest/bin" "$dest/path"
  cp "$vendor/bin/codex" "$dest/bin/codex"
  for rg in "$vendor/codex-path/rg" "$vendor/path/rg"; do
    [ -x "$rg" ] && cp "$rg" "$dest/path/rg" && break
  done
  echo "$spec" > "$dest/SOURCE"
  say "codex $label <- $spec ($("$dest/bin/codex" --version 2>/dev/null | head -1))"
}

if [ "$OPENAI_CODEX_VERSION" = latest ]; then
  OPENAI_CODEX_VERSION=$(npm view @openai/codex version)
fi
stage_codex "@openai/codex@$OPENAI_CODEX_VERSION-linux-x64" "openai-$OPENAI_CODEX_VERSION"
if stage_codex "@unieai/code@$UNIEAI_CODE_VERSION-linux-x64" "unieai-$UNIEAI_CODE_VERSION"; then
  :
else
  say "@unieai/code@$UNIEAI_CODE_VERSION-linux-x64 is not published yet; re-run later"
fi
# Borrow upstream ripgrep for payloads that ship none (codex looks for rg on PATH).
for dest in "$RUNTIME"/codex/*/; do
  if [ ! -x "$dest/path/rg" ] && [ -x "$RUNTIME/codex/openai-$OPENAI_CODEX_VERSION/path/rg" ]; then
    cp "$RUNTIME/codex/openai-$OPENAI_CODEX_VERSION/path/rg" "$dest/path/rg"
  fi
done

# ── tasks ───────────────────────────────────────────────────────────────────
if [ "$FORCE" = 1 ] || [ ! -d "$CACHE/tasks/terminal-bench/terminal-bench-2-1" ]; then
  say "downloading $TB_DATASET"
  rm -rf "$CACHE/tasks/terminal-bench"
  "$HARBOR" datasets download "$TB_DATASET" -o "$CACHE/tasks/terminal-bench" >/dev/null
fi
if [ ! -d "$CACHE/tasks/deep-swe/.git" ]; then
  say "cloning datacurve-ai/deep-swe"
  git clone --quiet --filter=blob:none --no-checkout https://github.com/datacurve-ai/deep-swe "$CACHE/tasks/deep-swe"
fi
git -C "$CACHE/tasks/deep-swe" checkout --quiet "$DEEP_SWE_REF"
say "deep-swe at $(git -C "$CACHE/tasks/deep-swe" rev-parse HEAD)"

missing=0
while read -r id; do
  case "$id" in
    terminal-bench/*) dir="$CACHE/tasks/terminal-bench/terminal-bench-2-1/${id#terminal-bench/}" ;;
    datacurve/*) dir="$CACHE/tasks/deep-swe/tasks/${id#datacurve/}" ;;
    *) continue ;;
  esac
  [ -f "$dir/task.toml" ] || { say "missing task $id ($dir)"; missing=1; }
done < "$HERE/unieai_tasks.txt"
[ "$missing" = 0 ] && say "all $(grep -c / "$HERE/unieai_tasks.txt") tasks present"
say "cache ready at $CACHE"
