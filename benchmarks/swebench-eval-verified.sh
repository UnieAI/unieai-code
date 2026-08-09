#!/usr/bin/env bash
# SWE-bench Verified — stage 2: official docker evaluation of generated predictions.
#
#   bash benchmarks/swebench-eval-verified.sh [MODEL ...]
#
# Evaluates every arm found under benchmarks/results/swebench-preds-verified-<MODEL>/.
# cache_level=env keeps disk bounded (instance images are removed after each run).
set -uo pipefail
cd "$(dirname "$0")/.."
PY=/tmp/sweb/bin/python
WORKERS=${EVAL_WORKERS:-8}
MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=(Qwen3.6-35B-A3B GLM-5.2 DeepSeek-V4-Flash-0731 MiniMax-M2)
fi

# This box also hosts live UnieAI Studio containers, so never prune globally:
# only images in swebench's own namespace are ever removed, and only when the
# disk gets tight.
free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }
reclaim_if_tight() {
  local avail; avail=$(free_gb)
  echo "--- disk free: ${avail}G"
  if [ "$avail" -lt "${DISK_FLOOR_GB:-45}" ]; then
    echo "--- reclaiming swebench images (free ${avail}G < floor)"
    docker images --format '{{.Repository}}:{{.Tag}}' | grep '^swebench/sweb\.' | xargs -r docker rmi -f >/dev/null 2>&1
    echo "--- disk free after: $(free_gb)G"
  fi
}

# PRED_SUF selects a variant prediction set (e.g. "-fix" for the post-bugfix
# re-run) so its reports never overwrite the baseline's.
SUF=${PRED_SUF:-}
for M in "${MODELS[@]}"; do
  for F in benchmarks/results/swebench-preds-verified-"$M$SUF"/*.jsonl; do
    [ -s "$F" ] || continue
    ARM=$(basename "$F" .jsonl)
    RUN_ID="verified100-${M}${SUF}-${ARM}"
    echo "=== evaluating $M / $ARM ($(wc -l < "$F") predictions) ==="
    reclaim_if_tight
    $PY -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Verified \
      --predictions_path "$F" \
      --run_id "$RUN_ID" \
      --max_workers "$WORKERS" \
      --cache_level env \
      --clean False 2>&1 | tail -25
  done
done
echo "=== done; reports written to ./*.json (swebench writes <model>.<run_id>.json in cwd) ==="
