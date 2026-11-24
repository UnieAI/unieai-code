#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Re-run trials that died on the gateway, not on the task.

The scorer only treats a trial with zero model usage as an infrastructure
failure. A trial whose agent lost the connection to the gateway, or was rate
limited by it, did use the model and is scored as a plain failure — which
charges an arm for the gateway's state. Those are transport failures, and on
a shared gateway they land on whichever arm sends the most tokens.

This moves such records into ``records/<arm>/retried/`` (kept as evidence,
where the scorer's ``*.json`` glob does not see them) so that re-running the
same ``unieai_run.py`` command runs those trials again. Everything else is
left alone: an ``AgentTimeoutError`` is the agent running out of time and a
``NonZeroAgentExitCodeError`` is the agent exiting badly — both are real
results.

    python unieai_retry_transport.py --out runs/<id> [--also CODE,CODE] [--apply]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

# Failures owned by the gateway or the network in between.
TRANSPORT_EXCEPTIONS = {
    "NetworkConnectionError",
    "ApiRateLimitError",
    "ApiConnectionError",
    "ApiServerError",
}


def transport_failures(out: Path, codes: set[str]) -> list[tuple[Path, dict]]:
    found = []
    for record_path in sorted(out.glob("records/*/*.json")):
        record = json.loads(record_path.read_text())
        if record.get("status") != "failure":
            continue
        if record.get("exception") in codes:
            found.append((record_path, record))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="the run directory")
    parser.add_argument(
        "--also",
        default="",
        help="extra exception names to treat as transport failures",
    )
    parser.add_argument(
        "--apply", action="store_true", help="move the records (default: list them)"
    )
    args = parser.parse_args()

    codes = TRANSPORT_EXCEPTIONS | {
        name.strip() for name in args.also.split(",") if name.strip()
    }
    found = transport_failures(args.out, codes)
    if not found:
        print("no transport failures to retry")
        return 0

    stamp = int(time.time())
    for record_path, record in found:
        print(f"{record['arm']:14} {record['task']:52} {record['exception']}")
        if not args.apply:
            continue
        retired = record_path.parent / "retried" / f"{record_path.stem}.{stamp}.json"
        retired.parent.mkdir(parents=True, exist_ok=True)
        record_path.rename(retired)
    if args.apply:
        print(
            f"\nmoved {len(found)} record(s); re-run the same unieai_run.py command to retry them"
        )
    else:
        print(f"\n{len(found)} record(s) would be retried; pass --apply")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
