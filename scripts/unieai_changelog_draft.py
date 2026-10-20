#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Print a draft CHANGELOG.md section for UnieAI Code's next release.

Lists our own commits since the last `npm-v*` tag, leaving out everything
that came from upstream openai/codex (any commit reachable from
`upstream/main`), sorted into CHANGELOG's groups by a guess from the
subject. If the range merges upstream, it prints the "Merged upstream Codex
through ..." line for the newest upstream commit merged.

The output is a starting point, not the entry: rewrite it for users, merge
related commits, drop internal/test/CI noise, then paste it at the top of
CHANGELOG.md.

    python3 scripts/unieai_changelog_draft.py                 # since last tag
    python3 scripts/unieai_changelog_draft.py --version 0.0.38
    python3 scripts/unieai_changelog_draft.py --since npm-v0.0.36 --to npm-v0.0.37

Run `git fetch upstream main` first so that upstream commits are recognised.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys

GROUPS = ["New", "Improved", "Fixed", "uac engine", "Login & models", "Probably skip"]


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip() if result.returncode == 0 else ""


def is_ancestor(commit: str, ref: str) -> bool:
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", commit, ref], capture_output=True
        ).returncode
        == 0
    )


def guess_group(subject: str) -> str:
    s = subject.lower()
    if re.match(r"^(ci|test|tests|chore|build|refactor)\b[:(]", s) or "tests compile" in s:
        return "Probably skip"
    if re.match(r"^(login|auth)\b", s) or "model list" in s or "rabi" in s:
        return "Login & models"
    if re.match(r"^uac\b", s) or "dsh" in s:
        return "uac engine"
    if re.match(r"^(fix|fixes)\b", s) or re.search(r"\b(no longer|stop|fix|again)\b", s):
        return "Fixed"
    if re.match(r"^(add|feat|new)\b", s) or re.search(r"\badd\b", s):
        return "New"
    return "Improved"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", help="version for the heading (default: <next>)")
    parser.add_argument("--since", help="start ref (default: newest npm-v* tag before --to)")
    parser.add_argument("--to", help="end ref (default: HEAD)")
    parser.add_argument("--upstream", default="upstream/main", help="upstream ref to exclude")
    args = parser.parse_args()

    to_given = args.to is not None
    args.to = args.to or "HEAD"
    since = args.since
    if not since:
        since = git("describe", "--tags", "--abbrev=0", "--match", "npm-v*", args.to, check=False)
        # --to is itself a release tag: draft that release, not the empty range after it.
        if to_given and since and git("rev-parse", f"{since}^{{commit}}") == git("rev-parse", f"{args.to}^{{commit}}"):
            since = git(
                "describe", "--tags", "--abbrev=0", "--match", "npm-v*", f"{args.to}^", check=False
            )
    if not since:
        sys.exit("no npm-v* tag found; pass --since")

    exclude: list[str] = []
    if git("rev-parse", "--verify", "--quiet", args.upstream, check=False):
        exclude = ["--not", args.upstream]
    else:
        print(
            f"warning: {args.upstream} not found; upstream commits are NOT excluded "
            "(run `git fetch upstream main`)",
            file=sys.stderr,
        )

    log = git(
        "log", "--no-merges", "--format=%h%x09%s", f"{since}..{args.to}", *exclude
    )
    commits = [line.split("\t", 1) for line in log.splitlines() if line]

    # Upstream merged in this range: second parents of merges that upstream contains.
    merged_upstream: list[tuple[str, str]] = []
    if exclude:
        merges = git("log", "--merges", "--format=%H %P", f"{since}..{args.to}")
        for line in merges.splitlines():
            parts = line.split()
            for parent in parts[2:]:
                if is_ancestor(parent, args.upstream):
                    merged_upstream.append(
                        (git("show", "-s", "--format=%ct", parent), parent)
                    )

    version = args.version or "<next>"
    print(f"## {version} — {dt.date.today().isoformat()}")
    print()
    print(f"<!-- draft from {len(commits)} commit(s) in {since}..{args.to}, upstream {'excluded' if exclude else 'NOT excluded'} -->")
    print()
    if merged_upstream:
        _, newest = max(merged_upstream)
        short = git("rev-parse", "--short=10", newest)
        date = git("show", "-s", "--format=%cs", newest)
        print("- Merged upstream Codex through")
        print(f"  [`{short}`](https://github.com/openai/codex/commit/{short}) ({date}).")
        print()

    grouped: dict[str, list[tuple[str, str]]] = {g: [] for g in GROUPS}
    for sha, subject in commits:
        grouped[guess_group(subject)].append((sha, subject))
    for group in GROUPS:
        if not grouped[group]:
            continue
        print(f"### {group}")
        print()
        for sha, subject in grouped[group]:
            print(f"- {subject} ({sha})")
        print()
    if not commits:
        print("(no UnieAI commits in this range)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
