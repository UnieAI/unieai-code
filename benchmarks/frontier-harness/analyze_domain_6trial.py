import json
import glob
import os
from math import comb
from collections import defaultdict

DOMAINS = {
    "finance": ("runs/rsi-iter4-finance-ab", "runs/rsi-iter4-finance-ab"),
    "medbio": ("runs/rsi-iter4-medbio-ab", "runs/rsi-iter4-medbio-ab"),
}


def load(out):
    recs = []
    for arm in ["dsh-unieai", "dsh-unieai-fix"]:
        for f in glob.glob(os.path.join(out, "records", arm, "*.json")):
            d = json.load(open(f))
            d["arm"] = arm
            d["task_short"] = d["task"].split("/")[-1]
            recs.append(d)
    return recs


def verdict(r):
    if r["status"] == "success":
        return "PASS"
    if r["status"] == "failure":
        return "FAIL"
    return "INFRA"


def mcnemar(b, f):
    """b, f = counts of base-only, fix-only discordant pairs."""
    m = b + f
    if m == 0:
        return (1.0, 1.0)
    k = min(b, f)
    tail = sum(comb(m, i) for i in range(k + 1)) / 2**m
    return (2 * tail, tail)  # (two-sided, one-sided base>fix)


def analyze(out, name):
    recs = load(out)
    # group by (task, trial)
    pairs = defaultdict(dict)
    for r in recs:
        pairs[(r["task"], r["trial"])][r["arm"]] = r

    tasks = sorted({t for (t, _) in pairs})
    trials = sorted({tr for (_, tr) in pairs})

    # per-task per-arm: passes / trials, token sum, median-token
    per_task = {}
    for t in tasks:
        per_task[t] = {}
        for arm in ["dsh-unieai", "dsh-unieai-fix"]:
            cell = [pairs[(t, tr)][arm] for tr in trials if arm in pairs[(t, tr)]]
            valid = [c for c in cell if c["status"] in ("success", "failure")]
            passed = sum(c["status"] == "success" for c in valid)
            toks = [c["input_tokens"] + c["output_tokens"] for c in valid]
            toks_sorted = sorted(toks)
            n = len(toks_sorted)
            med = (toks_sorted[n // 2] + toks_sorted[(n - 1) // 2]) / 2 if n else 0
            per_task[t][arm] = {
                "pass": passed,
                "trials_valid": len(valid),
                "trials_all": len(cell),
                "sum_tokens": sum(toks),
                "median_tokens": med,
            }

    # matched per-trial verdicts, per task (list of (trial, base, fix))
    matched = {}
    discordant = []
    n_both = n_b_only = n_f_only = 0
    for t in tasks:
        rows = []
        for tr in trials:
            b = pairs[(t, tr)].get("dsh-unieai")
            f = pairs[(t, tr)].get("dsh-unieai-fix")
            if b is None or f is None:
                continue
            bv = verdict(b)
            fv = verdict(f)
            if bv == "INFRA" or fv == "INFRA":
                continue
            rows.append((tr, bv, fv))
            n_both += 1
            if bv == "PASS" and fv != "PASS":
                n_b_only += 1
                discordant.append((t, tr, "base"))
            elif fv == "PASS" and bv != "PASS":
                n_f_only += 1
                discordant.append((t, tr, "fix"))
        matched[t] = rows

    p_two, p_one = mcnemar(n_b_only, n_f_only)

    # token totals per arm over all valid trials (sum + median of trial sums)
    arm_sum = {}
    arm_med = {}
    for arm in ["dsh-unieai", "dsh-unieai-fix"]:
        toks = [
            r["input_tokens"] + r["output_tokens"]
            for r in recs
            if r["arm"] == arm and r["status"] in ("success", "failure")
        ]
        s = sorted(toks)
        n = len(s)
        arm_sum[arm] = sum(s)
        arm_med[arm] = (s[n // 2] + s[(n - 1) // 2]) / 2 if n else 0

    # overall pass incl. infra in denominator (all valid here)
    overall = {}
    for arm in ["dsh-unieai", "dsh-unieai-fix"]:
        rr = [r for r in recs if r["arm"] == arm]
        valid = [r for r in rr if r["status"] in ("success", "failure")]
        passed = sum(r["status"] == "success" for r in valid)
        overall[arm] = {
            "passed": passed,
            "valid": len(valid),
            "all": len(rr),
            "pass_valid": passed / len(valid) if valid else None,
            "pass_all": passed / len(rr) if rr else None,
        }

    return {
        "domain": name,
        "tasks": tasks,
        "trials": trials,
        "per_task": per_task,
        "matched": matched,
        "mcnemar": {
            "n_pairs": n_both,
            "base_only": n_b_only,
            "fix_only": n_f_only,
            "discordant": discordant,
            "p_two": p_two,
            "p_one_base_gt_fix": p_one,
        },
        "arm_total_tokens": arm_sum,
        "arm_median_tokens": arm_med,
        "overall": overall,
    }


if __name__ == "__main__":
    out = {}
    for name, (path, _) in DOMAINS.items():
        out[name] = analyze(path, name)
        a = out[name]
        oa, ob = a["overall"]["dsh-unieai"], a["overall"]["dsh-unieai-fix"]
        print(
            f"\n===== {name.upper()} ({len(a['tasks'])} tasks x {len(a['trials'])} trials) ====="
        )
        print(
            f"overall valid: base {oa['passed']}/{oa['valid']}={oa['pass_valid'] * 100:.1f}%  "
            f"fix {ob['passed']}/{ob['valid']}={ob['pass_valid'] * 100:.1f}%  "
            f"(infra-incl base {oa['passed']}/{oa['all']}={oa['pass_all'] * 100:.1f}%, fix {ob['passed']}/{ob['all']}={ob['pass_all'] * 100:.1f}%)"
        )
        for t in a["tasks"]:
            bp = a["per_task"][t]["dsh-unieai"]
            fp = a["per_task"][t]["dsh-unieai-fix"]
            print(
                f"  {t:44s} base {bp['pass']}/{bp['trials_valid']} fix {fp['pass']}/{fp['trials_valid']}  "
                f"tok base {bp['sum_tokens']:,} fix {fp['sum_tokens']:,}"
            )
        m = a["mcnemar"]
        print(
            f"  matched pairs n={m['n_pairs']}  base-only={m['base_only']} fix-only={m['fix_only']}  "
            f"two-sided p={m['p_two']:.4f} one-sided(base>fix) p={m['p_one_base_gt_fix']:.4f}"
        )
        for d in m["discordant"]:
            print(f"    discordant: {d[0].split('/')[-1]} t{d[1]} -> {d[2]}")
        tb, tf = (
            a["arm_total_tokens"]["dsh-unieai"],
            a["arm_total_tokens"]["dsh-unieai-fix"],
        )
        mb, mf = (
            a["arm_median_tokens"]["dsh-unieai"],
            a["arm_median_tokens"]["dsh-unieai-fix"],
        )
        print(
            f"  tokens sum base {tb:,} fix {tf:,} delta {(tf - tb) / tb * 100:+.2f}%  "
            f"median base {mb:,.0f} fix {mf:,.0f}"
        )
    json.dump(out, open("a_domain_6trial.json", "w"), indent=1)
    print("\nsaved a_domain_6trial.json")
