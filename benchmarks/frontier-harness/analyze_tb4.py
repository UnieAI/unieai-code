#!/usr/bin/env python3
"""Analyze a TB4 (Terminal-Bench 4.0) canonical 3-arm run.

Reads runs/<dir>/records/<arm>/<task>__tQ.json for every arm. Each record has
arm/task/trial/status/reward/turns/input_tokens/output_tokens/cached_tokens/
duration_seconds. Verdict semantics match the rest of the harness:
  valid = status in {success, failure}; INFRA = status == "infra_invalid".
PASS = valid and reward >= 1.

Usage:
  python analyze_tb4.py --out runs/tb4-3arm-ab --json runs/tb4-3arm-ab/summary.json
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def parse(path: Path) -> dict:
    rec = json.loads(path.read_text())
    return {
        "arm": rec.get("arm"),
        "task": rec.get("task"),
        "trial": rec.get("trial"),
        "status": rec.get("status"),
        "reward": rec.get("reward"),
        "turns": rec.get("turns"),
        "in": rec.get("input_tokens"),
        "out": rec.get("output_tokens"),
        "cached": rec.get("cached_tokens") or 0,
        "dur": rec.get("duration_seconds"),
        "version": rec.get("agent_version"),
    }


def is_valid(r: dict) -> bool:
    return r["status"] in ("success", "failure")


def is_pass(r: dict) -> bool:
    return is_valid(r) and (r["reward"] or 0) >= 1


def mcnemar_2sided(b: int, c: int) -> float:
    """Exact two-sided McNemar on discordant pairs b (base-only) / c (fix-only)."""
    n = b + c
    if n == 0:
        return 1.0
    # exact two-tailed: sum of probabilities of outcomes as or more extreme than observed
    p = 0.0
    from math import comb

    for k in range(n + 1):
        # binomial P(k) with p=0.5
        p_k = comb(n, k) * (0.5**n)
        if p_k <= comb(n, b) * (0.5**n) + 1e-12:
            p += p_k
    return min(1.0, p)


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--json", default=None)
    ap.add_argument("--arms", default=None, help="comma list to restrict")
    a = ap.parse_args()

    out = Path(a.out)
    recdir = out / "records"
    if not recdir.is_dir():
        raise SystemExit(f"no records dir at {recdir} (unfinished run?)")

    arms = a.arms.split(",") if a.arms else None
    # discover per-record-ready arms
    arm_dirs = sorted(p for p in recdir.iterdir() if p.is_dir())
    if arms:
        arm_dirs = [p for p in arm_dirs if p.name in arms]

    records = []
    for armdir in arm_dirs:
        for f in sorted(armdir.glob("*.json")):
            r = parse(f)
            records.append(r)

    if not records:
        raise SystemExit("no parsed records")

    all_arms = sorted({r["arm"] for r in records})
    tasks = sorted({r["task"] for r in records})
    print(f"records={len(records)} arms={all_arms} tasks={len(tasks)}")

    # per arm/task aggregate
    agg = defaultdict(
        lambda: {
            "pass": 0,
            "valid": 0,
            "infra": 0,
            "sum_in": 0,
            "sum_out": 0,
            "sum_cached": 0,
            "turns": [],
            "durs": [],
            "per": [],
        }
    )
    for r in records:
        k = (r["arm"], r["task"])
        c = agg[k]
        c["per"].append(r)
        if r["status"] == "infra_invalid":
            c["infra"] += 1
        if is_valid(r):
            c["valid"] += 1
        if is_pass(r):
            c["pass"] += 1
        c["sum_in"] += r["in"] or 0
        c["sum_out"] += r["out"] or 0
        if r["turns"] is not None:
            c["turns"].append(r["turns"])
        if r["dur"] is not None:
            c["durs"].append(r["dur"])

    per_task = []
    for arm, task in sorted(agg):
        c = agg[(arm, task)]
        per_task.append(
            {
                "arm": arm,
                "task": task,
                "pass": c["pass"],
                "valid": c["valid"],
                "infra": c["infra"],
                "n_trials": len(c["per"]),
                "tokens": c["sum_in"] + c["sum_out"] - c["sum_cached"],
                "tokens_raw": c["sum_in"] + c["sum_out"],
                "median_turns": med(c["turns"]),
                "median_dur_s": med(c["durs"]),
            }
        )

    # arm totals (denominator = all trials incl infra)
    arm_tot = {}
    for arm in all_arms:
        valid = sum(1 for r in records if r["arm"] == arm and is_valid(r))
        infra = sum(
            1 for r in records if r["arm"] == arm and r["status"] == "infra_invalid"
        )
        passed = sum(1 for r in records if r["arm"] == arm and is_pass(r))
        tot_tok = sum(
            (r["in"] or 0) + (r["out"] or 0) - (r["cached"] or 0)
            for r in records
            if r["arm"] == arm
        )
        per_tok = [
            (r["in"] or 0) + (r["out"] or 0) - (r["cached"] or 0)
            for r in records
            if r["arm"] == arm and is_valid(r)
        ]
        arm_tot[arm] = {
            "n": sum(1 for r in records if r["arm"] == arm),
            "valid": valid,
            "infra": infra,
            "pass": passed,
            "valid_rate": valid / max(1, sum(1 for r in records if r["arm"] == arm)),
            "pass_rate_valid": passed / max(1, valid),
            "pass_rate_all": passed
            / max(1, sum(1 for r in records if r["arm"] == arm)),
            "tokens": tot_tok,
            "median_tokens": med(per_tok),
            "median_turns": med(
                [
                    r["turns"]
                    for r in records
                    if r["arm"] == arm and r["turns"] is not None and is_valid(r)
                ]
            ),
        }

    # pairwise matched McNemar by task (canonical trial per task)
    pair = {}
    base_arm = (
        "dsh-standard"
        if "dsh-standard" in all_arms
        else (all_arms[0] if all_arms else None)
    )
    for fix in all_arms:
        if fix == base_arm:
            continue
        b = c = both = neither = 0
        discord = []
        for task in tasks:
            rbase = next(
                (
                    r
                    for r in records
                    if r["arm"] == base_arm and r["task"] == task and is_valid(r)
                ),
                None,
            )
            rfix = next(
                (
                    r
                    for r in records
                    if r["arm"] == fix and r["task"] == task and is_valid(r)
                ),
                None,
            )
            if rbase is None or rfix is None:
                continue
            pb, pf = is_pass(rbase), is_pass(rfix)
            if pb and not pf:
                b += 1
                discord.append((task, "base-only"))
            elif pf and not pb:
                c += 1
                discord.append((task, "fix-only"))
            elif pb and pf:
                both += 1
            else:
                neither += 1
        pair[f"{base_arm}__{fix}"] = {
            "base_only": b,
            "fix_only": c,
            "both": both,
            "neither": neither,
            "n_discordant": b + c,
            "mcneMar_2sided": mcnemar_2sided(b, c),
            "discordant": discord,
        }

    summary = {
        "records": len(records),
        "arms": all_arms,
        "tasks": tasks,
        "per_task": per_task,
        "arm_totals": arm_tot,
        "pairwise": pair,
    }
    if a.json:
        Path(a.json).write_text(json.dumps(summary, indent=2) + "\n")
        print(f"wrote {a.json}")

    # console table
    print("\n== arm totals ==")
    for arm in all_arms:
        t = arm_tot[arm]
        print(
            f"  {arm:14s} n={t['n']:3d} valid={t['valid']:3d}/{t['n']} infra={t['infra']:2d} "
            f"PASS={t['pass']:3d} ({t['pass_rate_all'] * 100:5.1f}%) legacy-valid-rate={t['valid_rate'] * 100:5.1f}% "
            f"tok={t['tokens']:,} medTok={t['median_tokens']:,} medTurns={t['median_turns']}"
        )
    for k, v in pair.items():
        print(
            f"  {k}: base-only={v['base_only']} fix-only={v['fix_only']} "
            f"both={v['both']} neither={v['neither']} p2={v['mcneMar_2sided']:.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
