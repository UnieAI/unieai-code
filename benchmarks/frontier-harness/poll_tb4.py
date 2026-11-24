import json, glob, os, time, sys

TASKS = [
    "wal-recovery-ordering",
    "mvcc-lsm-compaction",
    "nextjs-performance",
    "payments-pipeline-fix",
    "session-window-debug",
    "ontology-kg-querying",
    "vf2-speedup-networkx",
    "math-eval-grader",
]
ARMS = ["dsh-unieai", "openai-codex"]
BASE = "runs/tb4-winsub-ab/records"
START = time.time()
LIMIT = 4.5 * 3600


def records():
    out = {}
    for p in sorted(glob.glob(f"{BASE}/*/*__t1.json")):
        try:
            d = json.load(open(p))
        except Exception as e:
            continue
        arm = d.get("arm")
        st = d.get("status")
        name = None
        # derive task from filename
        for t in TASKS:
            if t in os.path.basename(p):
                name = t
        if name and arm:
            out[(name, arm)] = d
    return out


while True:
    recs = records()
    done_raw = {t: {a: recs.get((t, a)) for a in ARMS} for t in TASKS}

    # print snapshot
    print("=" * 80)
    for t in TASKS:
        line = [t]
        for a in ARMS:
            d = recs.get((t, a))
            if d:
                line.append(f"{a}:{d.get('status')}/reward={d.get('reward')}")
            else:
                line.append(f"{a}:NO_REC")
        print(" | ".join(line))
    print(f"elapsed={int(time.time() - START)}s")

    all_complete = all(
        any(
            recs.get((t, a)) and recs[(t, a)].get("status") in ("success", "failure")
            for a in ARMS
        )
        for t in TASKS
    )
    # actually require both arms complete
    all_complete = all(
        all(
            recs.get((t, a)) and recs[(t, a)].get("status") in ("success", "failure")
            for a in ARMS
        )
        for t in TASKS
    )

    if all_complete:
        print("RUN COMPLETE: all 8 tasks x both arms done")
        sys.exit(0)
    if time.time() - START > LIMIT:
        print("TIMEOUT: 4.5h elapsed")
        sys.exit(1)
    time.sleep(90)
