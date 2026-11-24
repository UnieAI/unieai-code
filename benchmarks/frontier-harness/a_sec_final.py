import re
from math import comb

txt = open("runs/rsi-sec17-ab/score_full.txt").read()
rows = []
for line in txt.splitlines():
    m = re.match(
        r"\|\s*(terminal-bench/[^|]+)\s*\|\s*(dsh-unieai-fix|dsh-unieai)\s*\|\s*([A-Za-z]+)\s*\|\s*([0-9.]+|-)\s*\|",
        line,
    )
    if m:
        parts = [p.strip() for p in line.strip().strip("|").split("|")]

        def num(i):
            try:
                return int(parts[i].replace(",", ""))
            except ValueError:
                return 0

        rows.append(
            (m.group(1), m.group(2), m.group(3), num(4), num(5), num(7), num(8))
        )
by = {}
for t, a, r, tn, it, ot, dur in rows:
    by[(t, a)] = (r, tn, it + ot, it, ot, dur)
tasks = sorted({t for t, _ in by})
print(f"{'task':40s} {'base':10s} {'fix':10s} {'bTok':>11s} {'fTok':>11s} {'dB%':>6s}")
lines = []
tokB = tokF = 0
for t in tasks:
    br = by.get((t, "dsh-unieai"))
    fr = by.get((t, "dsh-unieai-fix"))
    if not br or not fr:
        lines.append((t, br, fr, 0, 0, 0))
        continue
    bt = br[1] + br[2]
    ft = fr[1] + fr[2]
    tokB += bt
    tokF += ft
    db = (ft - bt) / bt * 100 if bt else 0
    print(f"{t:40s} {br[0]:10s} {fr[0]:10s} {bt:11,} {ft:11,} {db:+6.1f}%")
    lines.append((t, br, fr, bt, ft, db))
both = [l for l in lines if l[1] and l[2] and l[1][0] != "INFRA" and l[2][0] != "INFRA"]
onlyB = [l for l in both if l[1][0] == "PASS" and l[2][0] != "PASS"]
onlyF = [l for l in both if l[2][0] == "PASS" and l[1][0] != "PASS"]
b, f = len(onlyB), len(onlyF)
m = b + f
k = min(b, f)
two = 2 * sum(comb(m, i) for i in range(k + 1)) / 2**m if m else 1
one = sum(comb(m, i) for i in range(k + 1)) / 2**m if m else 1
print(f"\nvalid pairs n={len(both)}  base-only={b} fix-only={f}")
print("  base-only:", [l[0].split("/")[-1] for l in onlyB])
print("  fix-only :", [l[0].split("/")[-1] for l in onlyF])
print(f"  two-sided p={two:.4f}  one-sided(base>fix) p={one:.4f}")
basePass = sum(1 for l in lines if l[1] and l[1][0] == "PASS")
baseValid = sum(1 for l in lines if l[1] and l[1][0] != "INFRA")
fixPass = sum(1 for l in lines if l[2] and l[2][0] == "PASS")
fixValid = sum(1 for l in lines if l[2] and l[2][0] != "INFRA")
N = len(tasks)
print(
    f"\nbase pass {basePass}/{baseValid}={basePass / baseValid:.3f} valid (infra-incl {basePass}/{N}={basePass / N:.3f})"
)
print(
    f"fix  pass {fixPass}/{fixValid}={fixPass / fixValid:.3f} valid (infra-incl {fixPass}/{N}={fixPass / N:.3f})"
)
print(
    f"total canonical tokens base={tokB:,} fix={tokF:,} delta={(tokF - tokB) / tokB * 100:+.2f}%"
)
import json

json.dump(
    {
        "rows": [
            [l[0], l[1][0] if l[1] else "?", l[2][0] if l[2] else "?", l[3], l[4]]
            for l in lines
        ],
        "mcnemar": {
            "n_pair": len(both),
            "base_only": b,
            "fix_only": f,
            "p_two": two,
            "p_one": one,
        },
        "base_pass_valid": [basePass, baseValid],
        "fix_pass_valid": [fixPass, fixValid],
        "N": N,
        "tokB": tokB,
        "tokF": tokF,
    },
    open("a_sec_final.json", "w"),
    indent=1,
)
print("saved a_sec_final.json")
