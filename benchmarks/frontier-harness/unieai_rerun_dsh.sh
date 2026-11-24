#!/usr/bin/env bash
# Copyright (c) 2026 UnieAI. All rights reserved.
#
# Re-run both dsh arms once the codex arm finishes, so all three arms in the
# run share one set of model facts (context window and modalities from the
# signed-in account) and the current plugin pack.
#
# The earlier records are kept under records/<arm>/pre-model-metadata/, where
# the scorer's records/<arm>/*.json glob does not see them.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="${1:?usage: unieai_rerun_dsh.sh <run dir>}"
PACK_SRC="$HERE/../../agent-runtime/src/unieai-dsh"
VENV="$HOME/.cache/unieai-frontier-harness/venv/bin/python"

echo "[$(date +%H:%M)] waiting for the running arm to finish"
while pgrep -f "[u]nieai_run.py" >/dev/null; do sleep 60; done

echo "[$(date +%H:%M)] refreshing the harness snapshot and the dsh pack"
cp "$HERE"/unieai_agents.py "$HERE"/unieai_render_dsh.mjs "$HERE"/unieai_run.py \
   "$HERE"/unieai_score.py "$HERE"/unieai_retry_transport.py "$RUN/harness-snapshot/"
rm -rf "$RUN/dsh-pack/src/unieai-dsh"
mkdir -p "$RUN/dsh-pack/src"
cp -r "$PACK_SRC" "$RUN/dsh-pack/src/unieai-dsh"
find "$RUN/dsh-pack/src/unieai-dsh" -name '*.test.mjs' -delete
(cd "$PACK_SRC" && git -C . rev-parse HEAD 2>/dev/null) > "$RUN/dsh-pack/PACK_COMMIT" || true

for arm in dsh-standard dsh-unieai; do
  mkdir -p "$RUN/records/$arm/pre-model-metadata"
  mv "$RUN/records/$arm"/*.json "$RUN/records/$arm/pre-model-metadata/" 2>/dev/null
done

echo "[$(date +%H:%M)] re-running both dsh arms"
exec "$VENV" "$RUN/harness-snapshot/unieai_run.py" \
  --arm dsh-standard,dsh-unieai --tasks all --trials 1 --concurrency 2 \
  --codex-payload unieai-0.0.26 \
  --dsh-plugin-dir "$RUN/dsh-pack/src/unieai-dsh" \
  --out "$RUN"
