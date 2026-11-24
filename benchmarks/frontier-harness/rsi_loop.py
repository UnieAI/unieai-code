#!/usr/bin/env python
"""rsi_loop.py — the RSI closed-loop driver for the FrontierHarness bench.

Loop:  new data -> iterate harness -> better solving -> harder problems.

Commands
--------
summarize   Per-task table + pass rate for an arm in a run (the "new data").
diff        Paired per-task comparison of two arms (optionally in two runs),
            with exact two-sided McNemar p.
failures    The failing / infra tasks of an arm on a tier; write a task file
            to feed a targeted re-run.
delta       Per-task base-vs-candidate comparison for one arm: pass-rate,
            flipped task list (gained / lost), net.
iterate     One closed-loop cycle: take base run -> target arm failures ->
            re-run them (optionally with a harness patch) into a candidate
            run -> merge -> score -> report delta and (optional) significance
            vs a reference arm.  Exits 0 when the candidate strictly improved
            the target arm pass count on the tier (no regression).

Escalation is manual by choosing `--tasks` tier files: `unieai_tasks.txt` (30)
-> `unieai_tasks_tb89_ds9.txt` (98) -> the wider platform suite.  `iterate`
prints a hint with the next tier file once the current tier has no failing
terminal tasks left (or when `--next-tier` is given).

Record semantics match unieai_score.py: valid = status in (success, failure);
PASS = valid and reward >= 1; INFRA = status == "infra_invalid".
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import subprocess
import sys

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unieai_run.py")
SCORER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unieai_score.py")
PY = os.environ.get(
    "UNIEAI_BENCH_PY", "/home/ubuntu/.cache/unieai-frontier-harness/venv/bin/python"
)


# ---------------------------------------------------------------- records ---
def task_file_to_id(task: str) -> str:
    return task.replace("/", "__")


def record_path(run_dir: str, arm: str, task: str, trial: int = 1) -> str:
    return os.path.join(
        run_dir, "records", arm, f"{task_file_to_id(task)}__t{trial}.json"
    )


def load_records(run_dir: str, arm: str):
    """Load every record json for an arm.  Returns {task: record (first valid)}."""
    rec = {}
    pat = os.path.join(run_dir, "records", arm, "*__t*.json")
    for p in sorted(glob.glob(pat)):
        task_id = (
            os.path.basename(p)[: -len("__t1.json")]
            if p.endswith("__t1.json")
            else os.path.basename(p).split("__t")[0]
        )
        try:
            j = json.load(open(p))
        except Exception:
            continue
        task = j.get("task") or task_id.replace("__", "/")
        rec.setdefault(task, j)  # first file wins (lowest trial id in sorted order)
    return rec


def classify(rec):
    """-> 'PASS' | 'fail' | 'INFRA' | None"""
    if not rec:
        return None
    st = rec.get("status")
    if st == "infra_invalid":
        return "INFRA"
    if st in ("success", "failure"):
        return "PASS" if (rec.get("reward") or 0) >= 1 else "fail"
    return None


def load_tier(path: str):
    return [l.strip() for l in open(path) if l.strip() and not l.startswith("#")]


def mcnemar(a_only: int, b_only: int) -> float:
    """Exact two-sided McNemar p-value (binomial on the discordant pair)."""
    n = a_only + b_only
    if n == 0:
        return 1.0
    k = min(a_only, b_only)
    # two-sided = 2 * P[X <= k] under H0: p=0.5, capped at 1.
    p = 0.0
    for i in range(0, k + 1):
        p += math.comb(n, i) * (0.5**n)
    return min(1.0, 2 * p)


def status_rank(s):
    return {"PASS": 1, "fail": 0, "INFRA": -1, None: -2}[s]


# ---------------------------------------------------------------- subcmds ---
def cmd_summarize(args):
    recs = load_records(args.run, args.arm)
    tasks = load_tier(args.tasks) if args.tasks else sorted(recs)
    row = []
    for t in tasks:
        s = classify(recs.get(t))
        r = recs.get(t) or {}
        row.append(
            (
                t,
                s,
                r.get("turns"),
                r.get("duration_seconds"),
                r.get("input_tokens", 0),
                r.get("output_tokens", 0),
            )
        )
    print(f"#{'task':50} {'st':6} tur dur  in-tok  out-tok")
    passed = valid = infra = 0
    for t, s, tur, dur, it, ot in row:
        if s == "PASS":
            passed += 1
        if s in ("PASS", "fail"):
            valid += 1
        if s == "INFRA":
            infra += 1
        dur = f"{dur:.0f}" if isinstance(dur, (int, float)) else "-"
        print(f"{t:52} {str(s):6} {tur or '-':>3} {dur:>4} {it:>8} {ot:>8}")
    tot_in = sum(r[4] for r in row)
    tot_out = sum(r[5] for r in row)
    print(
        f"\narm={args.arm}  pass={passed}/{len(row)}  valid={valid}  infra={infra}"
        f"  passrate(valid)={passed / valid:.3f}"
        if valid
        else ""
    )
    print(f"tokens: input ~{tot_in:,}  output ~{tot_out:,}  run={args.run}")
    return 0


def cmd_diff(args):
    a = load_records(args.run, args.arm)
    b = load_records(args.ref_run or args.run, args.ref_arm or args.arm)
    tasks = load_tier(args.tasks) if args.tasks else sorted(set(a) | set(b))
    a_only = b_only = pass_a = pass_b = both = 0
    print(f"#{'task':50} {args.arm:12} {args.ref_arm or args.arm}")
    for t in tasks:
        sa = classify(a.get(t))
        sb = classify(b.get(t))
        if sa == "PASS":
            pass_a += 1
        if sb == "PASS":
            pass_b += 1
        if sa in ("PASS", "fail") and sb in ("PASS", "fail"):
            both += 1
            if sa == "fail" and sb == "PASS":
                a_only += 1
            if sa == "PASS" and sb == "fail":
                b_only += 1
        mark = ">"
        if sa == "PASS" and sb == "PASS":
            mark = "="
        if sa == "fail" and sb == "fail":
            mark = "!"
        print(f"{t:52} {str(sa):12} {str(sb):12} {mark}")
    print(
        f"\n{args.arm}={pass_a}/{len(tasks)}  {args.ref_arm or args.arm}={pass_b}/{len(tasks)}"
        f"  common_valid={both}  {args.arm}-only={a_only}  {args.ref_arm or args.arm}-only={b_only}"
        f"  mcnemar_p={mcnemar(a_only, b_only):.4f}"
    )
    return 0


def cmd_failures(args):
    recs = load_records(args.run, args.arm)
    tasks = load_tier(args.tasks) if args.tasks else sorted(recs)
    fails = [
        (t, classify(recs.get(t))) for t in tasks if classify(recs.get(t)) != "PASS"
    ]
    for t, s in fails:
        print(f"{t}\t{s}")
    if args.out:
        with open(args.out, "w") as f:
            for t, s in fails:
                f.write(t + "\n")
        print(f"\nwrote {len(fails)} task(s) to {args.out}")
    print(f"{len(fails)} task(s) not passed (of {len(tasks)})")
    return 0


def cmd_delta(args):
    base = load_records(args.base, args.arm)
    cand = load_records(args.cand, args.arm)
    tasks = load_tier(args.tasks) if args.tasks else sorted(set(base) | set(cand))
    gained, lost, passed = [], [], 0
    for t in tasks:
        sb = classify(base.get(t))
        sc = classify(cand.get(t))
        if sc == "PASS":
            passed += 1
        if sb != "PASS" and sc == "PASS":
            gained.append(t)
        if sb == "PASS" and sc != "PASS":
            lost.append(t)
    print(f"delta {args.arm}: {args.base} -> {args.cand}")
    print(f"  pass-rate(candidate, first-valid): {passed}/{len(tasks)}")
    print(f"  gained(fail->PASS): {len(gained)}")
    for t in gained:
        print(f"    + {t}")
    print(f"  lost(PASS->fail): {len(lost)}")
    for t in lost:
        print(f"    - {t}")
    net = len(gained) - len(lost)
    print(f"  net: {net:+d}  improved: {net > 0 and not lost or (net > 0)}")
    return 0 if net > 0 and not lost else 1


def _run_batch(args):
    cmd = [
        PY,
        RUNNER,
        "--arm",
        args.arm,
        "--tasks",
        args.task_file,
        "--trials",
        str(args.trials),
        "--concurrency",
        str(args.concurrency),
        "--model",
        args.model,
        "--out",
        args.out,
    ]
    if args.dsh_patch:
        cmd += ["--dsh-patch", args.dsh_patch]
    if args.dsh_plugin_dir:
        cmd += ["--dsh-plugin-dir", args.dsh_plugin_dir]
    print(" ".join(cmd))
    return subprocess.run(cmd).returncode


def cmd_iterate(args):
    base = load_records(args.run, args.arm)
    tasks = load_tier(args.tasks)
    # 1. new data: failing / infra on the tier.
    fails = [t for t in tasks if classify(base.get(t)) != "PASS"]
    # regression guard: if supplied, include those (they must stay PASS).
    guard = []
    if args.guard_file:
        guard = load_tier(args.guard_file)
    elif args.guard:
        passes = [t for t in tasks if classify(base.get(t)) == "PASS"]
        guard = passes[: args.guard]
    targeted = sorted(set(fails) | set(guard))
    print(f"RSI iterate: {args.run} arm={args.arm} tier={len(tasks)} tasks")
    print(f"  failing:{len(fails)}  guard:{len(guard)}  targeted:{len(targeted)}")
    if not targeted:
        print(
            "  tier fully passed -> escalate to a harder tier "
            f"({'see ' + args.next_tier if args.next_tier else 'pick a larger --tasks file'})."
        )
        return 0
    with open(args.worklist, "w") as f:
        for t in targeted:
            f.write(t + "\n")
    print(f"  worklist -> {args.worklist}")
    rc = _run_batch(args)
    if rc != 0:
        print("  candidate run failed", file=sys.stderr)
        return rc
    # score candidate (only informative for the arm it contains)
    subprocess.run([PY, SCORER, "--out", args.out])
    # 2/3. delta (base vs candidate on the tier)
    return cmd_delta(
        argparse.Namespace(base=args.run, cand=args.out, arm=args.arm, tasks=args.tasks)
    )


def main():
    p = argparse.ArgumentParser(
        prog="rsi_loop", description="RSI closed loop for the FrontierHarness bench."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp, with_out=False):
        sp.add_argument("--run", required=True)
        sp.add_argument("--arm", required=True)
        sp.add_argument("--tasks", help="tier task file.")
        if with_out:
            sp.add_argument(
                "--out",
                required=True,
                help="candidate run dir (records preserved on resume).",
            )
        sp.add_argument("--model", default="unieai/DeepSeek-V4-Flash-Vision-Exp")
        sp.add_argument("--concurrency", type=int, default=2)
        sp.add_argument("--trials", type=int, default=1)

    s = sub.add_parser("summarize")
    add_common(s)
    s.set_defaults(fn=cmd_summarize)
    s = sub.add_parser("diff")
    add_common(s)
    s.add_argument("--ref-run")
    s.add_argument("--ref-arm")
    s.set_defaults(fn=cmd_diff)
    s = sub.add_parser("failures")
    add_common(s)
    s.add_argument("--out", help="write failing task ids here.")
    s.set_defaults(fn=cmd_failures)
    s = sub.add_parser("delta")
    s.add_argument("--base", required=True)
    s.add_argument("--cand", required=True)
    s.add_argument("--arm", required=True)
    s.add_argument("--tasks", required=True)
    s.set_defaults(fn=cmd_delta)
    s = sub.add_parser("iterate")
    add_common(s, with_out=True)
    s.add_argument("--dsh-patch")
    s.add_argument("--dsh-plugin-dir")
    s.add_argument("--worklist", default="rsi-worklist.txt")
    s.add_argument(
        "--guard",
        type=int,
        default=0,
        help="N previously-passing tasks to re-run as regression guard.",
    )
    s.add_argument("--guard-file")
    s.add_argument("--next-tier")
    s.set_defaults(fn=cmd_iterate)

    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
