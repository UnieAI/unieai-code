#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Export FrontierHarness results as plotting-ready raw data, ours beside the
public FrontierHarness Eval v1.0 configurations.

  unieai_export_raw.py --out <dir> \\
      --run "uac-dsh0.1.6=runs/X:dsh-unieai" \\
      --run "uac-dsh0.2.1=runs/X:dsh-unieai-fix" \\
      --run "uac-dsh0.2.1+patches=runs/Y:dsh-unieai-fix"

Writes into <dir>:
  per_task.csv     one row per (harness, task): source, model, version,
                   status, success, reward, turns, input/output tokens,
                   duration; public rows have no per-task tokens (the public
                   data does not publish them).
  summary.csv      one row per harness: passes, pass rate, token and turn
                   means/medians, median duration -- ours over our tasks,
                   public from the published aggregates (all 30 tasks).
  common_tasks.csv the per-task pass matrix (1/0) over tasks every harness
                   has a valid result for.
  raw.json         all of the above plus the source manifests.

`--run` is label=<run dir>:<arm>; the run is scored with unieai_score.py.

`solution_lookup` marks a trial whose agent fetched the benchmark's own
repository (its solution or tests) and got content back: its pass is not
evidence of the harness, and summary.csv also reports passes without it.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics as st
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC = HERE / "runs/public/frontier-harness-eval-data.json"
VALID = ("success", "failure")
# The benchmarks' own repositories: fetching these reads the task's answer.
BENCHMARK_REPOS = (
    "harbor-framework/terminal-bench",
    "laude-institute/terminal-bench",
    "datacurve-ai/deep-swe",
    "frontier-harness-eval",
)


def solution_lookup(trial_dir: str | None) -> bool:
    """Whether the agent fetched a benchmark repository and got a real answer back."""
    if not trial_dir:
        return False
    stream = Path(trial_dir) / "agent" / "dsh-stream.jsonl"
    if not stream.exists():
        return False
    pending = set()
    for line in stream.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "tool_call" and any(
            r in json.dumps(event.get("input")) for r in BENCHMARK_REPOS
        ):
            pending.add(event.get("callId"))
        elif event.get("type") == "tool_result" and event.get("callId") in pending:
            if (
                event.get("status") == "completed"
                and len(str(event.get("result", ""))) > 300
            ):
                return True
    return False


def score(run_dir: Path) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".json") as tmp:
        subprocess.run(
            [
                sys.executable,
                str(HERE / "unieai_score.py"),
                "--out",
                str(run_dir),
                "--json",
                tmp.name,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return json.loads(Path(tmp.name).read_text())


def ours(label: str, run_dir: Path, arm: str) -> list[dict]:
    rows = []
    for c in score(run_dir)["canonical"]:
        if c["arm"] != arm:
            continue
        rewards = c.get("rewards") or {}
        rows.append(
            {
                "source": "unieai",
                "harness": label,
                "model": (c.get("model") or "").removeprefix("unieai/"),
                "version": c.get("agent_version"),
                "task": c["task"],
                "suite": c["task"].split("/")[0],
                "status": c["status"],
                "valid": c["status"] in VALID,
                "success": int(c["status"] == "success"),
                "reward": c.get("reward"),
                "partial": rewards.get("partial"),
                "turns": c.get("turns"),
                "input_tokens": c.get("input_tokens"),
                "output_tokens": c.get("output_tokens"),
                "duration_s": c.get("agent_seconds") or c.get("duration_seconds"),
                "exception": c.get("exception"),
                "solution_lookup": solution_lookup(c.get("trial_dir")),
            }
        )
    return rows


def public() -> tuple[list[dict], list[dict], dict]:
    data = json.loads(PUBLIC.read_text())
    model = (
        data.get("model")
        if isinstance(data.get("model"), str)
        else json.dumps(data.get("model"))
    )
    rows, summary = [], []
    for h in data["harnesses"]:
        for t in h["task_details"]:
            rows.append(
                {
                    "source": "public",
                    "harness": h["name"],
                    "model": model,
                    "version": None,
                    "task": t["id"],
                    "suite": t["id"].split("/")[0],
                    "status": t["status"],
                    "valid": t["status"] in VALID,
                    "success": int(bool(t["success"])),
                    "reward": None,
                    "partial": None,
                    "turns": t.get("turns"),
                    "input_tokens": None,
                    "output_tokens": None,
                    "duration_s": t.get("duration_seconds"),
                    "exception": None,
                    "solution_lookup": None,
                }
            )
        summary.append(
            {
                "source": "public",
                "harness": h["name"],
                "model": model,
                "tasks_valid": h.get("completed"),
                "passed": h.get("successful"),
                "passed_excluding_lookup": None,
                "pass_rate": h.get("pass_rate"),
                "mean_input_tokens": h.get("mean_input_tokens"),
                "median_input_tokens": None,
                "mean_output_tokens": h.get("mean_output_tokens"),
                "mean_turns": h.get("mean_turns"),
                "median_turns": None,
                "median_duration_s": h.get("median_duration_seconds"),
                "total_tokens": None,
                "cost_per_pass_usd": h.get("effective_cost_per_pass"),
                "cache_hit_rate": h.get("cache_hit_rate_typical"),
            }
        )
    return (
        rows,
        summary,
        {k: data[k] for k in ("generated_at", "model", "overview") if k in data},
    )


def summarize(label: str, rows: list[dict]) -> dict:
    valid = [r for r in rows if r["valid"]]
    num = lambda key: [r[key] for r in valid if r[key] is not None]
    mean = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    med = lambda xs: st.median(xs) if xs else None
    return {
        "source": "unieai",
        "harness": label,
        "model": rows[0]["model"] if rows else None,
        "tasks_valid": len(valid),
        "passed": sum(r["success"] for r in valid),
        "passed_excluding_lookup": sum(
            r["success"] for r in valid if not r["solution_lookup"]
        ),
        "pass_rate": round(sum(r["success"] for r in valid) / len(valid), 4)
        if valid
        else None,
        "mean_input_tokens": mean(num("input_tokens")),
        "median_input_tokens": med(num("input_tokens")),
        "mean_output_tokens": mean(num("output_tokens")),
        "mean_turns": mean(num("turns")),
        "median_turns": med(num("turns")),
        "median_duration_s": med(num("duration_s")),
        "total_tokens": sum(num("input_tokens")) + sum(num("output_tokens")),
        "cost_per_pass_usd": None,
        "cache_hit_rate": None,
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--run", action="append", required=True, help="label=<run dir>:<arm>"
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    per_task, summary, manifests = [], [], {}
    for spec in args.run:
        label, _, rest = spec.partition("=")
        run_dir, _, arm = rest.rpartition(":")
        rows = ours(label, Path(run_dir), arm)
        per_task += rows
        summary.append(summarize(label, rows))
        manifests[label] = sorted(str(p) for p in Path(run_dir).glob("manifest-*.json"))
    pub_rows, pub_summary, pub_meta = public()
    per_task += pub_rows
    summary += pub_summary

    harnesses = list(dict.fromkeys(r["harness"] for r in per_task))
    by = {(r["harness"], r["task"]): r for r in per_task}
    tasks = sorted({r["task"] for r in per_task})
    common = [
        t for t in tasks if all(by.get((h, t), {}).get("valid") for h in harnesses)
    ]
    matrix = [
        {"task": t, **{h: by[(h, t)]["success"] for h in harnesses}} for t in common
    ]

    write_csv(args.out / "per_task.csv", per_task)
    write_csv(args.out / "summary.csv", summary)
    write_csv(args.out / "common_tasks.csv", matrix)
    (args.out / "raw.json").write_text(
        json.dumps(
            {
                "per_task": per_task,
                "summary": summary,
                "common_tasks": common,
                "public_meta": pub_meta,
                "manifests": manifests,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"{len(per_task)} rows, {len(harnesses)} harnesses, {len(common)} tasks valid for all -> {args.out}"
    )


if __name__ == "__main__":
    main()
