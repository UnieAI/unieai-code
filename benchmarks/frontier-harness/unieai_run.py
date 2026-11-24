#!/usr/bin/env python3
# Copyright (c) 2026 UnieAI. All rights reserved.
"""Run the FrontierHarness Eval task set locally with Docker + Harbor.

One Harbor job per (arm, task, trial), scheduled here so that arms interleave
and share gateway load equally, and so that the shared host is never
overcommitted:

* at most --concurrency trials (default 3, hard cap 4 task containers) at once;
* each container is capped at its task.toml cpus / memory_mb (--cpus/--memory limit);
* running trials' task.toml cpus/memory also fit --cpu-budget / --mem-budget-mb;
* the next trial always comes from the arm that has started the fewest.

Example (smoke):
  .venv/bin/python unieai_run.py --arm unieai-codex,dsh-standard \\
      --tasks unieai_smoke_tasks.txt --out runs/smoke

Re-running with the same --out resumes: finished trials are kept, infra
failures are retried. Score with unieai_score.py --out <dir>.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path(
    os.environ.get("UNIEAI_BENCH_CACHE", Path.home() / ".cache/unieai-frontier-harness")
)
RUNTIME = Path(os.environ.get("UNIEAI_BENCH_RUNTIME", CACHE / "runtime"))
TB_DIR = Path(
    os.environ.get(
        "UNIEAI_BENCH_TB_DIR",
        CACHE / "tasks/terminal-bench/terminal-bench-2-1",
    )
)
DS_DIR = CACHE / "tasks/deep-swe/tasks"
GATEWAY = os.environ.get("UNIEAI_BENCH_GATEWAY_URL", "https://api.unieai.com/v1")
DEFAULT_MODEL = "unieai/DeepSeek-V4-Flash-0731"
MAX_CONTAINERS = 4

ARMS = {
    "unieai-codex": "unieai_agents:UnieaiCodexAgent",
    # Upstream OpenAI codex through the same gateway and adapter, as the
    # baseline the fork is measured against (--codex-payload-openai).
    "openai-codex": "unieai_agents:UnieaiCodexAgent",
    "dsh-standard": "unieai_agents:UnieaiDshAgent",
    "dsh-unieai": "unieai_agents:UnieaiDshPluginAgent",
    # A second pack beside dsh-unieai in the same run (A/B of a harness change):
    # same agent, its own --dsh-plugin-dir-fix and optional deadline.
    "dsh-unieai-fix": "unieai_agents:UnieaiDshPluginAgent",
}


def log(msg: str) -> None:
    stamp = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def read_ids(spec: str) -> list[str]:
    if spec in ("all", "full"):
        spec = str(HERE / "unieai_tasks.txt")
    elif spec == "smoke":
        spec = str(HERE / "unieai_smoke_tasks.txt")
    path = Path(spec)
    if path.is_file():
        lines = path.read_text().splitlines()
    else:
        lines = spec.split(",")
    return [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]


def spread_suites(ids: list[str]) -> list[str]:
    """Spread the long DeepSWE tasks evenly among the Terminal-Bench ones, so the
    memory budget (8 GB DeepSWE containers) rarely idles a slot."""
    long = [i for i in ids if i.startswith("datacurve/")]
    short = [i for i in ids if not i.startswith("datacurve/")]
    if not long or not short:
        return ids
    out: list[str] = []
    step = len(short) / len(long)
    for n, task in enumerate(long):
        out.extend(short[round(n * step) : round((n + 1) * step)])
        out.append(task)
    return out


def task_dir(task_id: str) -> Path:
    suite, _, name = task_id.partition("/")
    base = {"terminal-bench": TB_DIR, "datacurve": DS_DIR}.get(suite)
    if base is None:
        raise SystemExit(f"unknown task suite in {task_id!r}")
    path = base / name
    if not (path / "task.toml").is_file():
        raise SystemExit(f"{task_id}: {path}/task.toml missing; run unieai_prepare.sh")
    return path


def sanitize_project(name: str) -> str:
    name = name.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


def gateway_key() -> str:
    key = os.environ.get("UNIEAI_BENCH_GATEWAY_KEY")
    if key:
        return key
    creds = Path(
        os.environ.get("UNIEAI_CREDENTIALS", Path.home() / ".unieai/unieai.json")
    )
    key = json.loads(creds.read_text()).get("gateway_api_key") or ""
    if not key:
        raise SystemExit(f"no gateway_api_key in {creds}")
    return key


def default_codex_payload() -> str:
    """The newest UnieAI Code payload staged, else upstream codex (plumbing only)."""
    staged = sorted(
        p.name for p in (RUNTIME / "codex").glob("*") if (p / "bin/codex").exists()
    )

    def version(name: str) -> tuple[int, ...]:
        return tuple(int(x) for x in re.findall(r"\d+", name.split("-", 1)[1]))

    ours = sorted((n for n in staged if n.startswith("unieai-")), key=version)
    preferred = os.environ.get("UNIEAI_CODE_VERSION", "0.0.27")
    if f"unieai-{preferred}" in ours:
        return f"unieai-{preferred}"
    upstream = sorted((n for n in staged if n.startswith("openai-")), key=version)
    if upstream:
        return upstream[-1]
    if ours:
        return ours[-1]
    raise SystemExit("no codex payload staged; run unieai_prepare.sh")


@dataclass
class Job:
    arm: str
    task: str
    trial: int
    path: Path
    cpus: int
    memory_mb: int
    timeout_s: float
    name: str = ""
    state: str = "pending"
    record: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.name = f"{self.task.replace('/', '__')}__t{self.trial}"


def load_job(arm: str, task: str, trial: int, agent_mult: float) -> Job:
    path = task_dir(task)
    cfg = tomllib.loads((path / "task.toml").read_text())
    env = cfg.get("environment", {})
    agent_t = float(cfg.get("agent", {}).get("timeout_sec", 3600)) * agent_mult
    verifier_t = float(cfg.get("verifier", {}).get("timeout_sec", 900))
    build_t = float(env.get("build_timeout_sec", 600))
    return Job(
        arm,
        task,
        trial,
        path,
        int(env.get("cpus", 1)),
        int(env.get("memory_mb", 2048)),
        agent_t + verifier_t + 2 * build_t + 1800,
    )


class Runner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.out = Path(args.out).resolve()
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.running: dict[str, subprocess.Popen] = {}
        self.stopping = False
        self.active = 0
        self.used_cpus = 0
        self.used_mem = 0
        self.started = {arm: 0 for arm in args.arms}
        # Docker's default address pools are exhausted on this host, so every
        # trial gets a pre-created network with an explicit subnet (one per slot).
        self.free_slots = list(range(args.concurrency))
        self.networks: dict[int, str] = {}
        self.harbor = args.harbor
        self.env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(HERE), os.environ.get("PYTHONPATH", "")]
            ).rstrip(os.pathsep),
            "UNIEAI_BENCH_GATEWAY_KEY": gateway_key(),
            "UNIEAI_BENCH_GATEWAY_URL": GATEWAY,
            "UNIEAI_BENCH_CODEX_PAYLOAD": args.codex_payload,
            "UNIEAI_BENCH_CACHE": str(CACHE),
            "UNIEAI_BENCH_RUNTIME": str(RUNTIME),
            "COLUMNS": "200",
        }
        if args.dsh_plugin_dir:
            self.env["UNIEAI_BENCH_DSH_PLUGIN_DIR"] = str(
                Path(args.dsh_plugin_dir).resolve()
            )
        if args.dsh_patch:
            self.env["UNIEAI_BENCH_DSH_PATCH"] = str(Path(args.dsh_patch).resolve())

    # ── bookkeeping ───────────────────────────────────────────────────────
    def record_path(self, job: Job) -> Path:
        return self.out / "records" / job.arm / f"{job.name}.json"

    def job_dir(self, job: Job) -> Path:
        return self.out / "jobs" / job.arm / job.name

    def finished(self, job: Job) -> bool:
        path = self.record_path(job)
        if not path.exists():
            return False
        try:
            record = json.loads(path.read_text())
        except json.JSONDecodeError:
            return False  # cut short (e.g. a full disk): run it again
        return record.get("status") in ("success", "failure")

    def ensure_network(self, slot: int) -> Path:
        name = f"unieai-fh-{os.getpid()}-{slot}"
        overlay = self.out / "compose" / f"{name}.json"
        if slot not in self.networks:
            exists = (
                subprocess.run(
                    ["docker", "network", "inspect", name], capture_output=True
                ).returncode
                == 0
            )
            if not exists:
                for third in range(slot, 256):
                    subnet = f"{self.args.subnet_prefix}.{third}.0/24"
                    made = subprocess.run(
                        [
                            "docker",
                            "network",
                            "create",
                            "--driver",
                            "bridge",
                            "--subnet",
                            subnet,
                            "--label",
                            "unieai-frontier-harness=1",
                            name,
                        ],
                        capture_output=True,
                        text=True,
                    )
                    if made.returncode == 0:
                        break
                else:
                    raise RuntimeError(f"could not create docker network {name}")
            self.networks[slot] = name
            overlay.parent.mkdir(parents=True, exist_ok=True)
            overlay.write_text(
                json.dumps({"networks": {"default": {"name": name, "external": True}}})
                + "\n"
            )
        return overlay

    def remove_networks(self) -> None:
        for name in self.networks.values():
            subprocess.run(["docker", "network", "rm", name], capture_output=True)
        self.networks.clear()

    def harbor_command(self, job: Job, slot: int = 0) -> list[str]:
        a = self.args
        cmd = [
            self.harbor,
            "run",
            "-y",
            "-q",
            "-p",
            str(job.path),
            "-a",
            ARMS[job.arm],
            "-m",
            a.model,
            "-o",
            str(self.out / "jobs" / job.arm),
            "--job-name",
            job.name,
            "-n",
            "1",
            "-k",
            "1",
            "--cpus",
            "limit",
            "--memory",
            "limit",
            "--mounts",
            json.dumps(
                [
                    {
                        "type": "bind",
                        "source": str(RUNTIME),
                        "target": "/opt/unieai-bench",
                        "read_only": True,
                    }
                ]
            ),
            "--allow-agent-host",
            GATEWAY.split("/")[2],
            "-e",
            "unieai_env:UnieaiDockerEnvironment",
        ]
        if a.agent_timeout_multiplier != 1.0:
            cmd += ["--agent-timeout-multiplier", str(a.agent_timeout_multiplier)]
        if job.arm == "openai-codex":
            if not a.codex_payload_openai:
                raise SystemExit("openai-codex needs --codex-payload-openai")
            cmd += ["--ak", f"payload={a.codex_payload_openai}"]
        if job.arm in ("dsh-unieai", "dsh-unieai-fix") and a.dsh_plugins:
            cmd += ["--ak", f"plugins={a.dsh_plugins}"]
        install = (
            (a.dsh_install_fix or a.dsh_install)
            if job.arm == "dsh-unieai-fix"
            else a.dsh_install
        )
        if job.arm.startswith("dsh-") and install:
            if not (RUNTIME / install / ".complete").exists():
                raise SystemExit(
                    f"runtime/{install} is not a finished dsh install (unieai_prepare.sh)"
                )
            cmd += ["--ak", f"dsh_install={install}"]
        if job.arm == "dsh-unieai-fix":
            if not a.dsh_plugin_dir_fix:
                raise SystemExit("dsh-unieai-fix needs --dsh-plugin-dir-fix")
            cmd += ["--ak", f"plugin_dir={Path(a.dsh_plugin_dir_fix).resolve()}"]
            if a.deadline_share_fix:
                cmd += ["--ak", f"deadline_share={a.deadline_share_fix}"]
            if a.persona_rigor_fix:
                cmd += ["--ak", "persona_rigor=true"]
        return cmd

    # ── one job ───────────────────────────────────────────────────────────
    def run_job(self, job: Job, slot: int) -> None:
        jdir = self.job_dir(job)
        if jdir.exists():
            # A retried infra failure: keep the old attempt for evidence.
            jdir.rename(jdir.with_name(f"{jdir.name}.attempt-{int(time.time())}"))
        jdir.parent.mkdir(parents=True, exist_ok=True)
        overlay = self.ensure_network(slot)
        cmd = self.harbor_command(job, slot)
        env = {**self.env, "UNIEAI_BENCH_NETWORK_OVERLAY": str(overlay)}
        started = time.time()
        log_path = jdir.parent / f"{job.name}.harbor.log"
        rc = None
        with open(log_path, "w") as out:
            proc = subprocess.Popen(
                cmd,
                cwd=HERE,
                env=env,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            with self.lock:
                self.running[job.name + job.arm] = proc
            try:
                rc = proc.wait(timeout=job.timeout_s)
            except subprocess.TimeoutExpired:
                log(
                    f"watchdog: {job.arm} {job.task} exceeded {job.timeout_s:.0f}s; stopping harbor"
                )
                self.terminate(proc)
                rc = -9
            finally:
                with self.lock:
                    self.running.pop(job.name + job.arm, None)
        self.cleanup_containers(jdir)
        record = summarize_trial(jdir, job.arm, job.task, job.trial)
        record.update(
            harbor_exit_code=rc,
            harbor_log=str(log_path.relative_to(self.out)),
            wall_seconds=round(time.time() - started, 1),
            model=self.args.model,
            codex_payload=self.args.codex_payload
            if job.arm == "unieai-codex"
            else self.args.codex_payload_openai
            if job.arm == "openai-codex"
            else None,
        )
        if rc == -9 and record["status"] == "infra_invalid":
            used = record.get("input_tokens") or record.get("output_tokens")
            record["status"] = (
                "failure" if record.get("agent_started") and used else "infra_invalid"
            )
            record["watchdog"] = True
        path = self.record_path(job)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2) + "\n")
        log(
            f"done  {job.arm:<13} {job.task:<50} t{job.trial} -> {record['status']}"
            f" reward={record.get('reward')} turns={record.get('turns')} "
            f"{record.get('duration_seconds') or record['wall_seconds']:.0f}s"
        )

    @staticmethod
    def terminate(proc: subprocess.Popen) -> None:
        try:
            os.killpg(proc.pid, signal.SIGINT)
            proc.wait(timeout=120)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass

    def cleanup_containers(self, jdir: Path) -> None:
        """Remove any container a killed/crashed trial left behind (ours only)."""
        prefixes = [sanitize_project(p.name) for p in jdir.glob("*") if p.is_dir()]
        if not prefixes:
            return
        listing = subprocess.run(
            [
                "docker",
                "ps",
                "-a",
                "--format",
                '{{.ID}} {{.Label "com.docker.compose.project"}}',
            ],
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        stale = [
            line.split()[0]
            for line in listing
            if len(line.split()) == 2
            and any(line.split()[1].startswith(p) for p in prefixes)
        ]
        if stale:
            log(f"removing {len(stale)} leftover container(s) from {jdir.name}")
            subprocess.run(["docker", "rm", "-f", *stale], capture_output=True)
        nets = subprocess.run(
            ["docker", "network", "ls", "--format", "{{.Name}}"],
            capture_output=True,
            text=True,
        ).stdout.split()
        for net in nets:
            if any(net.startswith(p) for p in prefixes):
                subprocess.run(["docker", "network", "rm", net], capture_output=True)

    # ── scheduling ────────────────────────────────────────────────────────
    def run(self, jobs: list[Job]) -> None:
        queues = {
            arm: [j for j in jobs if j.arm == arm and not self.finished(j)]
            for arm in self.args.arms
        }
        total = sum(len(q) for q in queues.values())
        skipped = len(jobs) - total
        log(
            f"{total} trial(s) to run ({skipped} already finished); concurrency {self.args.concurrency}, "
            f"cpu budget {self.args.cpu_budget}, memory budget {self.args.mem_budget_mb} MB"
        )
        threads: list[threading.Thread] = []
        while True:
            with self.lock:
                if self.stopping:
                    break
                live = [arm for arm in self.args.arms if queues[arm]]
                if not live:
                    break
                # Fairness: the arm that has started the fewest goes next, and
                # waits for room rather than letting another arm overtake it.
                arm = min(
                    live, key=lambda a: (self.started[a], self.args.arms.index(a))
                )
                job = queues[arm][0]
                fits = (
                    self.active < self.args.concurrency
                    and self.used_cpus + job.cpus <= max(self.args.cpu_budget, job.cpus)
                    and self.used_mem + job.memory_mb
                    <= max(self.args.mem_budget_mb, job.memory_mb)
                )
                if not fits:
                    self.wake.wait(timeout=5)
                    continue
                queues[arm].pop(0)
                self.active += 1
                slot = self.free_slots.pop(0)
                self.started[arm] += 1
                self.used_cpus += job.cpus
                self.used_mem += job.memory_mb
            log(
                f"start {job.arm:<13} {job.task:<50} t{job.trial} ({job.cpus} cpu, {job.memory_mb} MB)"
            )
            thread = threading.Thread(
                target=self._worker, args=(job, slot), daemon=True
            )
            thread.start()
            threads.append(thread)
            time.sleep(self.args.stagger)
        for thread in threads:
            while thread.is_alive():
                thread.join(timeout=5)
        self.remove_networks()

    def _worker(self, job: Job, slot: int) -> None:
        try:
            self.run_job(job, slot)
        except Exception as exc:  # keep the sweep going; the record says why
            log(f"error {job.arm} {job.task}: {exc!r}")
        finally:
            with self.lock:
                self.active -= 1
                self.free_slots.append(slot)
                self.used_cpus -= job.cpus
                self.used_mem -= job.memory_mb
                self.wake.notify_all()

    def stop(self, *_: object) -> None:
        with self.lock:
            if self.stopping:
                return
            self.stopping = True
            procs = list(self.running.values())
        log(f"stopping: interrupting {len(procs)} harbor process(es)")
        for proc in procs:
            threading.Thread(target=self.terminate, args=(proc,), daemon=True).start()


def summarize_trial(jdir: Path, arm: str, task: str, trial: int) -> dict:
    """Classify one Harbor trial the way the eval does (reward + usage evidence)."""
    record: dict = {
        "arm": arm,
        "task": task,
        "trial": trial,
        "status": "infra_invalid",
        "reward": None,
        "job_dir": str(jdir),
    }
    results = [p for p in jdir.glob("*/result.json")]
    if not results:
        record["reason"] = "no trial result"
        return record
    result_path = max(results, key=lambda p: p.stat().st_mtime)
    res = json.loads(result_path.read_text())
    record["trial_dir"] = str(result_path.parent)
    agent = res.get("agent_result") or {}
    meta = agent.get("metadata") or {}
    exc = res.get("exception_info") or {}
    verifier = res.get("verifier_result") or {}
    rewards = verifier.get("rewards") or {}
    reward = rewards.get("reward")
    execution = res.get("agent_execution") or {}
    agent_started = bool(execution.get("started_at"))

    def seconds(block: dict | None) -> float | None:
        if not block or not block.get("started_at") or not block.get("finished_at"):
            return None
        a = dt.datetime.fromisoformat(block["started_at"])
        b = dt.datetime.fromisoformat(block["finished_at"])
        return round((b - a).total_seconds(), 1)

    record.update(
        reward=reward,
        rewards=rewards or None,
        agent_version=(res.get("agent_info") or {}).get("version"),
        input_tokens=agent.get("n_input_tokens"),
        cached_tokens=agent.get("n_cache_tokens"),
        output_tokens=agent.get("n_output_tokens"),
        turns=meta.get("turns"),
        agent_meta=meta or None,
        exception=exc.get("exception_type"),
        exception_message=(exc.get("exception_message") or "")[:500] or None,
        agent_started=agent_started,
        duration_seconds=seconds(
            {"started_at": res.get("started_at"), "finished_at": res.get("finished_at")}
        ),
        agent_seconds=seconds(execution),
        verifier_seconds=seconds(res.get("verifier")),
    )
    usage = bool(agent.get("n_input_tokens") or agent.get("n_output_tokens"))
    timed_out = exc.get("exception_type") == "AgentTimeoutError"
    # Eval rule: reward + model usage is a quality outcome; a timeout after the
    # agent started is a failure. Stricter here: a trial with no model usage at
    # all (gateway unreachable, harness never called the model) stays
    # infra_invalid so it is retried instead of scored.
    if not usage:
        record["reason"] = (
            "no model usage"
            if agent_started
            else (exc.get("exception_type") or "agent did not start")
        )
    elif reward is not None:
        record["status"] = "success" if float(reward) >= 1 else "failure"
    elif timed_out and agent_started:
        record["status"] = "failure"
    else:
        record["reason"] = "no verifier reward"
    return record


def snapshot_images() -> set[str]:
    out = subprocess.run(
        ["docker", "images", "-q", "--no-trunc"], capture_output=True, text=True
    ).stdout
    return set(out.split())


def task_images(jobs: list[Job]) -> set[str]:
    names = set()
    for job in jobs:
        cfg = tomllib.loads((job.path / "task.toml").read_text())
        image = cfg.get("environment", {}).get("docker_image")
        if image:
            names.add(image)
    return names


def cleanup_images(before: set[str], jobs: list[Job]) -> None:
    """Remove task images this run pulled (those absent before it started)."""
    for image in sorted(task_images(jobs)):
        info = subprocess.run(
            ["docker", "image", "inspect", "-f", "{{.Id}}", image],
            capture_output=True,
            text=True,
        )
        image_id = info.stdout.strip()
        if info.returncode == 0 and image_id not in before:
            done = subprocess.run(
                ["docker", "rmi", image], capture_output=True, text=True
            )
            log(
                f"rmi {image}: {'ok' if done.returncode == 0 else done.stderr.strip()[:120]}"
            )


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--arm",
        default="unieai-codex,dsh-standard,dsh-unieai",
        help=f"comma list of arms: {', '.join(ARMS)}",
    )
    p.add_argument(
        "--tasks", default="all", help="all | smoke | file of ids | comma list of ids"
    )
    p.add_argument("--concurrency", type=int, default=3)
    p.add_argument("--trials", type=int, default=1)
    p.add_argument("--out", required=True)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument(
        "--codex-payload",
        default=None,
        help="runtime/codex/<dir> to run as unieai-codex (default: unieai-$UNIEAI_CODE_VERSION "
        "if staged, else latest upstream)",
    )
    p.add_argument(
        "--dsh-plugin-dir", default=None, help="UnieAI dsh pack for dsh-unieai"
    )
    p.add_argument(
        "--codex-payload-openai",
        default=None,
        help="runtime/codex/<dir> for the openai-codex arm (e.g. openai-0.155.0)",
    )
    p.add_argument(
        "--dsh-plugin-dir-fix", default=None, help="UnieAI dsh pack for dsh-unieai-fix"
    )
    p.add_argument(
        "--deadline-share-fix",
        type=float,
        default=None,
        help="dsh-unieai-fix: share of each task's agent timeout given to the loop guard as its deadline",
    )
    p.add_argument(
        "--persona-rigor-fix",
        action="store_true",
        help="dsh-unieai-fix: render the pack with UNIEAI_PERSONA_RIGOR=1 (the measured-failure persona rules)",
    )
    p.add_argument(
        "--dsh-install",
        default=None,
        help="runtime/<dir> dsh install for the dsh-* arms (default: the dsh symlink)",
    )
    p.add_argument(
        "--dsh-install-fix",
        default=None,
        help="runtime/<dir> dsh install for dsh-unieai-fix (default: --dsh-install)",
    )
    p.add_argument(
        "--dsh-patch",
        default=None,
        help="explicit patch for dsh-unieai (skips config.mjs rendering)",
    )
    p.add_argument(
        "--dsh-plugins",
        default=None,
        help="UNIEAI_DSH_PLUGINS for dsh-unieai (all/off/ids)",
    )
    p.add_argument(
        "--cpu-budget",
        type=int,
        default=6,
        help="sum of task.toml cpus running at once",
    )
    p.add_argument(
        "--mem-budget-mb",
        type=int,
        default=20480,
        help="sum of task.toml memory_mb running at once",
    )
    p.add_argument(
        "--subnet-prefix",
        default="10.213",
        help="first two octets for per-slot trial networks",
    )
    p.add_argument("--agent-timeout-multiplier", type=float, default=1.0)
    p.add_argument(
        "--stagger", type=float, default=10.0, help="seconds between trial starts"
    )
    p.add_argument(
        "--keep-images", action="store_true", help="keep task images this run pulled"
    )
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--harbor", default=str(Path(sys.executable).parent / "harbor"))
    args = p.parse_args()

    args.arms = [a.strip() for a in args.arm.split(",") if a.strip()]
    unknown = [a for a in args.arms if a not in ARMS]
    if unknown:
        p.error(f"unknown arm(s): {unknown}")
    if not 1 <= args.concurrency <= MAX_CONTAINERS:
        p.error(f"--concurrency must be 1..{MAX_CONTAINERS} (shared host)")
    args.codex_payload = args.codex_payload or default_codex_payload()

    ids = spread_suites(read_ids(args.tasks))
    jobs: list[Job] = []
    # Same task order for every arm; the scheduler interleaves arms.
    for trial in range(1, args.trials + 1):
        for task in ids:
            for arm in args.arms:
                jobs.append(load_job(arm, task, trial, args.agent_timeout_multiplier))

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "arms": {a: ARMS[a] for a in args.arms},
        "model": args.model,
        "gateway": GATEWAY,
        "tasks": ids,
        "trials": args.trials,
        "concurrency": args.concurrency,
        "codex_payload": args.codex_payload,
        "codex_payload_source": (RUNTIME / "codex" / args.codex_payload / "SOURCE")
        .read_text()
        .strip()
        if (RUNTIME / "codex" / args.codex_payload / "SOURCE").exists()
        else None,
        "dsh_lock_sha256": (RUNTIME / "dsh/.lock-sha256").read_text().strip()
        if (RUNTIME / "dsh/.lock-sha256").exists()
        else None,
        "dsh_install": os.path.realpath(RUNTIME / "dsh"),
        "dsh_version": json.loads(
            (RUNTIME / "dsh/node_modules/@deepseek-ai/dsh/package.json").read_text()
        )["version"]
        if (RUNTIME / "dsh/node_modules/@deepseek-ai/dsh/package.json").exists()
        else None,
        "codex_version": subprocess.run(
            [str(RUNTIME / "codex" / args.codex_payload / "bin/codex"), "--version"],
            capture_output=True,
            text=True,
        ).stdout.strip(),
        "repo_head": subprocess.run(
            ["git", "-C", str(HERE), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
        ).stdout.strip(),
        "dsh_plugin_dir": args.dsh_plugin_dir,
        "dsh_patch": args.dsh_patch,
        "dsh_plugins": args.dsh_plugins,
        "codex_payload_openai": args.codex_payload_openai,
        "dsh_plugin_dir_fix": args.dsh_plugin_dir_fix,
        "dsh_installs": {
            name: json.loads(
                (
                    RUNTIME / name / "node_modules/@deepseek-ai/dsh/package.json"
                ).read_text()
            )["version"]
            for name in {args.dsh_install, args.dsh_install_fix} - {None}
            if (RUNTIME / name / "node_modules/@deepseek-ai/dsh/package.json").exists()
        },
        "deadline_share_fix": args.deadline_share_fix,
        "persona_rigor_fix": args.persona_rigor_fix,
        "harbor": subprocess.run(
            [args.harbor, "--version"], capture_output=True, text=True
        ).stdout.strip(),
        "argv": sys.argv,
    }
    (out / f"manifest-{int(time.time())}.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )

    runner = Runner(args)
    if args.dry_run:
        for job in jobs:
            print(
                job.arm,
                job.task,
                job.trial,
                "done" if runner.finished(job) else "todo",
                " ".join(runner.harbor_command(job)),
            )
        return 0

    before = snapshot_images()
    signal.signal(signal.SIGINT, runner.stop)
    signal.signal(signal.SIGTERM, runner.stop)
    try:
        runner.run(jobs)
    finally:
        if not args.keep_images:
            cleanup_images(before, jobs)
    log(
        f"finished; score with: {sys.executable} {HERE / 'unieai_score.py'} --out {out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
