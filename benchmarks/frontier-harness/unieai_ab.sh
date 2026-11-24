#!/usr/bin/env bash
# Copyright (c) 2026 UnieAI. All rights reserved.
#
# One-command FrontierHarness A/B of the uac harness: a base git ref against
# the working tree, each with its own dsh (from that tree's agent-runtime
# package-lock.json) and its own UnieAI plugin pack, on the same tasks, model
# and gateway, interleaved so both arms see the same gateway conditions.
#
#   bash unieai_ab.sh --model unieai/DeepSeek-V4-Flash-Vision-Exp \
#        [--base HEAD] [--tasks unieai_tasks.txt] [--out runs/<name>] \
#        [--concurrency 4] [--smoke] [-- <extra unieai_run.py args>]
#
#   arm dsh-unieai      = <base>'s agent-runtime/src + <base>'s dsh
#   arm dsh-unieai-fix  = working tree's agent-runtime/src + working tree's dsh
#
# Both packs are copied into <out>/pack-{base,new} first, so editing the tree
# while it runs changes nothing. Re-running with the same --out resumes.
# The score (pass counts, exact McNemar, tokens) is printed at the end and
# written to <out>/summary.json.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CACHE=${UNIEAI_BENCH_CACHE:-$HOME/.cache/unieai-frontier-harness}
RUNTIME=$CACHE/runtime
PY=${UNIEAI_BENCH_PYTHON:-$CACHE/venv/bin/python}

BASE=HEAD
MODEL=
TASKS=$HERE/unieai_tasks.txt
OUT=
CONCURRENCY=4
SMOKE=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --tasks) TASKS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --concurrency) CONCURRENCY=$2; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n 2,19p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODEL" ] || { echo "--model is required (e.g. unieai/DeepSeek-V4-Flash-Vision-Exp)" >&2; exit 2; }
[ "$SMOKE" = 1 ] && TASKS=$HERE/unieai_smoke_tasks.txt
base_sha=$(git -C "$REPO" rev-parse --short=10 "$BASE")
OUT=${OUT:-$HERE/runs/ab-$(date +%Y-%m-%d)-$base_sha-vs-tree}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
say() { printf '[ab] %s\n' "$*" >&2; }

# The gateway must answer for this model before hours of containers start.
key=$(python3 -c "import json,os,pathlib;print(json.loads(pathlib.Path(os.environ.get('UNIEAI_CREDENTIALS',pathlib.Path.home()/'.unieai/unieai.json')).read_text())['gateway_api_key'])")
code=$(curl -s -m 90 -o /dev/null -w '%{http_code}' "${UNIEAI_BENCH_GATEWAY_URL:-https://api.unieai.com/v1}/chat/completions" \
  -H "Authorization: Bearer $key" -H 'content-type: application/json' \
  -d "{\"model\":\"${MODEL#unieai/}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}")
[ "$code" = 200 ] || { say "the gateway answers $code for ${MODEL#unieai/}; not starting"; exit 1; }

# Node, tasks and the working tree's dsh (unieai_prepare.sh is idempotent).
bash "$HERE/unieai_prepare.sh" >&2
NPM="$RUNTIME/node/bin/npm"

# install_dsh <package.json> <package-lock.json>: runtime/dsh-<lock hash>, echoed.
install_dsh() {
  local pkg=$1 lock=$2 want target
  want=$(sha256sum "$lock" | cut -c1-12)
  target="$RUNTIME/dsh-$want"
  if [ ! -f "$target/.complete" ]; then
    say "installing dsh from $lock -> dsh-$want"
    rm -rf "$target" && mkdir -p "$target"
    cp "$pkg" "$target/package.json" && cp "$lock" "$target/package-lock.json"
    (cd "$target" && PATH="$RUNTIME/node/bin:$PATH" "$NPM" ci --no-audit --no-fund --omit=dev --ignore-scripts >/dev/null)
    echo "$want" > "$target/.lock-sha256"
    touch "$target/.complete"
  fi
  echo "dsh-$want"
}

# Packs: <out>/pack-*/src is a copy of agent-runtime/src (config.mjs imports ../config.mjs).
if [ ! -f "$OUT/pack-base/.complete" ]; then
  rm -rf "$OUT/pack-base" && mkdir -p "$OUT/pack-base"
  git -C "$REPO" archive "$BASE" agent-runtime/src agent-runtime/package.json agent-runtime/package-lock.json \
    | tar -x -C "$OUT/pack-base" --strip-components=1
  touch "$OUT/pack-base/.complete"
fi
if [ ! -f "$OUT/pack-new/.complete" ]; then
  rm -rf "$OUT/pack-new" && mkdir -p "$OUT/pack-new"
  cp -r "$REPO/agent-runtime/src" "$REPO/agent-runtime/package.json" "$REPO/agent-runtime/package-lock.json" "$OUT/pack-new/"
  git -C "$REPO" rev-parse HEAD > "$OUT/pack-new/HEAD"
  git -C "$REPO" diff HEAD -- agent-runtime > "$OUT/pack-new/uncommitted.diff"
  touch "$OUT/pack-new/.complete"
fi
dsh_base=$(install_dsh "$OUT/pack-base/package.json" "$OUT/pack-base/package-lock.json")
dsh_new=$(install_dsh "$OUT/pack-new/package.json" "$OUT/pack-new/package-lock.json")
v() { "$RUNTIME/node/bin/node" -p "require('$RUNTIME/$1/node_modules/@deepseek-ai/dsh/package.json').version"; }
say "base $base_sha: dsh $(v "$dsh_base") ($dsh_base)"
say "new  working tree: dsh $(v "$dsh_new") ($dsh_new)"

cd "$HERE"
"$PY" unieai_run.py \
  --arm dsh-unieai,dsh-unieai-fix \
  --tasks "$TASKS" \
  --model "$MODEL" \
  --out "$OUT" \
  --concurrency "$CONCURRENCY" \
  --dsh-plugin-dir "$OUT/pack-base/src/unieai-dsh" \
  --dsh-install "$dsh_base" \
  --dsh-plugin-dir-fix "$OUT/pack-new/src/unieai-dsh" \
  --dsh-install-fix "$dsh_new" \
  "${EXTRA[@]}"

"$PY" unieai_score.py --out "$OUT" --json "$OUT/summary.json"
