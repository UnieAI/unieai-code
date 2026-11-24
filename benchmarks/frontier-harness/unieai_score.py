#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Score a unieai_run.py output directory.

Per task/arm: pass/fail, turns (model calls), tokens, optional cost estimate,
duration. Across arms: pass counts and pairwise exact McNemar tests on tasks
both arms scored.

Canonical cell = first valid trial (success/failure) per (arm, task), as in the
eval (benchmark.json "first valid attempt"). With --trials > 1 the table also
reports pass@k-style counts over valid trials.

The UnieAI gateway reports no price or cached-token detail in its usage
(prompt/completion/total tokens only), so cost is omitted unless --pricing
points at a JSON file: {"fresh_input": $/M, "cache_read": $/M, "output": $/M}.

  unieai_score.py --out runs/smoke [--json summary.json] [--pricing p.json]
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

ARM_ORDER = [
    "openai-codex",
    "unieai-codex",
    "dsh-standard",
    "dsh-unieai",
    "dsh-unieai-fix",
]


def load_records(out: Path) -> list[dict]:
    records = []
    for path in sorted((out / "records").glob("*/*.json")):
        records.append(json.loads(path.read_text()))
    return records


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value (binomial on discordant pairs)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def cost(record: dict, pricing: dict | None) -> float | None:
    if not pricing or record.get("input_tokens") is None:
        return None
    total_in = record.get("input_tokens") or 0
    cached = record.get("cached_tokens") or 0
    out = record.get("output_tokens") or 0
    unit = float(pricing.get("unit_tokens", 1_000_000))
    return (
        (total_in - cached) * pricing["fresh_input"]
        + cached * pricing.get("cache_read", pricing["fresh_input"])
        + out * pricing["output"]
    ) / unit


def fmt_int(value) -> str:
    return "-" if value is None else f"{int(value):,}"


def fmt_num(value, digits=0) -> str:
    return "-" if value is None else f"{value:,.{digits}f}"


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--out", required=True)
    p.add_argument("--json", default=None, help="write the summary as JSON here")
    p.add_argument("--pricing", default=None)
    args = p.parse_args()

    out = Path(args.out)
    pricing = json.loads(Path(args.pricing).read_text()) if args.pricing else None
    records = load_records(out)
    if not records:
        print(f"no records under {out}/records")
        return 1

    by_cell: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in records:
        r["cost_usd"] = cost(r, pricing)
        by_cell[(r["arm"], r["task"])].append(r)
    arms = [a for a in ARM_ORDER if any(k[0] == a for k in by_cell)] + sorted(
        {k[0] for k in by_cell} - set(ARM_ORDER)
    )
    tasks = sorted({k[1] for k in by_cell})

    canonical: dict[tuple[str, str], dict] = {}
    for key, cell in by_cell.items():
        cell.sort(key=lambda r: r.get("trial", 1))
        valid = [r for r in cell if r["status"] in ("success", "failure")]
        canonical[key] = valid[0] if valid else cell[-1]

    # ── per task ──────────────────────────────────────────────────────────
    print("## Per task (canonical = first valid trial)\n")
    header = [
        "task",
        "arm",
        "result",
        "reward",
        "turns",
        "input tok",
        "cached",
        "output tok",
    ]
    if pricing:
        header.append("cost $")
    header += ["duration s", "agent s", "trials v/all", "note"]
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for task in tasks:
        for arm in arms:
            r = canonical.get((arm, task))
            if r is None:
                continue
            cell = by_cell[(arm, task)]
            valid = sum(x["status"] in ("success", "failure") for x in cell)
            result = {"success": "PASS", "failure": "fail"}.get(r["status"], "INFRA")
            note = r.get("reason") or r.get("exception") or ""
            row = [
                task,
                arm,
                result,
                fmt_num(r.get("reward"), 2) if r.get("reward") is not None else "-",
                fmt_int(r.get("turns")),
                fmt_int(r.get("input_tokens")),
                fmt_int(r.get("cached_tokens")),
                fmt_int(r.get("output_tokens")),
            ]
            if pricing:
                row.append(fmt_num(r.get("cost_usd"), 4))
            row += [
                fmt_num(r.get("duration_seconds") or r.get("wall_seconds")),
                fmt_num(r.get("agent_seconds")),
                f"{valid}/{len(cell)}",
                note,
            ]
            print("| " + " | ".join(str(x) for x in row) + " |")

    # ── per arm ───────────────────────────────────────────────────────────
    summary = {"arms": {}, "pairs": [], "tasks": tasks}
    print("\n## Per arm\n")
    head = [
        "arm",
        "passed",
        "valid",
        "infra",
        "pass rate",
        "median turns",
        "median input tok",
        "median output tok",
        "total tokens",
    ]
    if pricing:
        head += ["total cost $", "cost / pass $"]
    head += ["median duration s", "version"]
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for arm in arms:
        cells = [canonical[(arm, t)] for t in tasks if (arm, t) in canonical]
        valid = [c for c in cells if c["status"] in ("success", "failure")]
        passed = sum(c["status"] == "success" for c in valid)
        infra = len(cells) - len(valid)
        tokens = sum(
            (c.get("input_tokens") or 0) + (c.get("output_tokens") or 0) for c in cells
        )
        total_cost = sum(c["cost_usd"] or 0 for c in cells) if pricing else None
        versions = sorted(
            {str(c.get("agent_version")) for c in cells if c.get("agent_version")}
        )
        stats = {
            "passed": passed,
            "valid": len(valid),
            "infra_invalid": infra,
            "expected": len(tasks),
            "pass_rate": passed / len(valid) if valid else None,
            "median_turns": median([c.get("turns") for c in valid]),
            "median_input_tokens": median([c.get("input_tokens") for c in valid]),
            "median_output_tokens": median([c.get("output_tokens") for c in valid]),
            "total_tokens": tokens,
            "total_cost_usd": total_cost,
            "cost_per_pass_usd": (total_cost / passed)
            if (pricing and passed)
            else None,
            "median_duration_seconds": median(
                [c.get("duration_seconds") for c in valid]
            ),
            "versions": versions,
        }
        summary["arms"][arm] = stats
        row = [
            arm,
            passed,
            len(valid),
            infra,
            "-" if stats["pass_rate"] is None else f"{stats['pass_rate']:.1%}",
            fmt_num(stats["median_turns"]),
            fmt_int(stats["median_input_tokens"]),
            fmt_int(stats["median_output_tokens"]),
            fmt_int(tokens),
        ]
        if pricing:
            row += [fmt_num(total_cost, 3), fmt_num(stats["cost_per_pass_usd"], 3)]
        row += [fmt_num(stats["median_duration_seconds"]), ", ".join(versions)]
        print("| " + " | ".join(str(x) for x in row) + " |")

    # ── pairwise McNemar ──────────────────────────────────────────────────
    if len(arms) > 1:
        print("\n## Pairwise (tasks valid in both arms; exact McNemar)\n")
        print("| A | B | n | A pass | B pass | A only | B only | p |")
        print("|---|---|---|---|---|---|---|---|")
        for i, a in enumerate(arms):
            for b in arms[i + 1 :]:
                both = [
                    t
                    for t in tasks
                    if canonical.get((a, t), {}).get("status") in ("success", "failure")
                    and canonical.get((b, t), {}).get("status")
                    in ("success", "failure")
                ]
                pa = {t: canonical[(a, t)]["status"] == "success" for t in both}
                pb = {t: canonical[(b, t)]["status"] == "success" for t in both}
                a_only = sum(pa[t] and not pb[t] for t in both)
                b_only = sum(pb[t] and not pa[t] for t in both)
                pval = mcnemar_exact(a_only, b_only)
                summary["pairs"].append(
                    {
                        "a": a,
                        "b": b,
                        "n": len(both),
                        "a_pass": sum(pa.values()),
                        "b_pass": sum(pb.values()),
                        "a_only": a_only,
                        "b_only": b_only,
                        "p_mcnemar": pval,
                    }
                )
                print(
                    f"| {a} | {b} | {len(both)} | {sum(pa.values())} | {sum(pb.values())} | "
                    f"{a_only} | {b_only} | {pval:.3f} |"
                )
        print(
            "\np < 0.05 needs at least 6 discordant tasks all in one direction; "
            "on 30 tasks treat anything else as noise."
        )

    summary["canonical"] = [canonical[k] for k in sorted(canonical)]
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=2, default=str) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
