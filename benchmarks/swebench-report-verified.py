#!/usr/bin/env python3
"""SWE-bench Verified — stage 3: join eval reports with trajectory cost data.

    /tmp/sweb/bin/python benchmarks/swebench-report-verified.py

Prints one row per (model, arm): resolved rate, empty-patch rate, tokens and
wall-clock cost. Cost comes from the trajectories (agent-core: meta.json usage;
codex-stock: the turn.completed usage line in codex-stdout.jsonl).
"""
import json, os, glob, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(REPO, "benchmarks", "results")
MODELS = sys.argv[1:] or ["Qwen3.6-35B-A3B", "GLM-5.2", "DeepSeek-V4-Flash-0731", "MiniMax-M2"]
ARMS = ["agent-core", "codex-stock"]


def eval_report(model, arm):
    """swebench writes <model_name_or_path>.<run_id>.json into the cwd it ran from."""
    name = f"unieai-{arm}-{model}".replace("/", "__")
    for pat in (f"{name}.verified100-{model}-{arm}.json",
                f"*{arm}-{model}*.json"):
        for p in glob.glob(os.path.join(REPO, pat)):
            try:
                return json.load(open(p))
            except Exception:
                pass
    return None


def costs(model, arm):
    toks, secs, steps = [], [], []
    for d in glob.glob(os.path.join(RES, f"traj-verified-{model}", f"{arm}-*")):
        t = os.path.join(d, "timing.json")
        if os.path.exists(t):
            secs.append(json.load(open(t))["seconds"])
        m = os.path.join(d, "meta.json")
        if arm == "agent-core" and os.path.exists(m):
            try:
                meta = json.load(open(m))
                if isinstance(meta.get("usage"), dict):
                    toks.append(meta["usage"].get("total_tokens") or 0)
                if meta.get("steps"):
                    steps.append(meta["steps"])
            except Exception:
                pass
        elif arm == "codex-stock":
            f = os.path.join(d, "codex-stdout.jsonl")
            if os.path.exists(f):
                tot = 0
                for line in open(f, errors="ignore"):
                    if '"turn.completed"' in line:
                        try:
                            u = json.loads(line).get("usage", {})
                            tot += (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0) + (u.get("reasoning_output_tokens") or 0)
                        except Exception:
                            pass
                if tot:
                    toks.append(tot)
    avg = lambda xs: (sum(xs) / len(xs)) if xs else 0
    return avg(toks), avg(secs), sum(secs) / 3600, avg(steps)


rows = []
for model in MODELS:
    for arm in ARMS:
        pred = os.path.join(RES, f"swebench-preds-verified-{model}", f"{arm}.jsonl")
        if not os.path.exists(pred):
            continue
        preds = [json.loads(l) for l in open(pred) if l.strip()]
        if not preds:
            continue
        empty = sum(1 for p in preds if not p["model_patch"].strip())
        rep = eval_report(model, arm)
        resolved = len(rep.get("resolved_ids", [])) if rep else None
        tok, sec, hours, steps = costs(model, arm)
        rows.append({
            "model": model, "arm": arm, "n": len(preds),
            "resolved": resolved,
            "pct": (100.0 * resolved / len(preds)) if resolved is not None else None,
            "empty_pct": 100.0 * empty / len(preds),
            "tok": tok, "sec": sec, "hours": hours, "steps": steps,
        })

hdr = f"{'model':<24} {'arm':<12} {'n':>4} {'resolved':>10} {'empty%':>7} {'tok/題':>9} {'秒/題':>7} {'步/題':>6} {'agent時數':>9}"
print(hdr)
print("-" * len(hdr))
for r in rows:
    res = f"{r['resolved']}={r['pct']:.1f}%" if r["resolved"] is not None else "(未評分)"
    print(f"{r['model']:<24} {r['arm']:<12} {r['n']:>4} {res:>10} {r['empty_pct']:>6.0f}% "
          f"{r['tok']/1000:>8.0f}k {r['sec']:>6.0f}s {r['steps']:>6.0f} {r['hours']:>8.1f}h")
