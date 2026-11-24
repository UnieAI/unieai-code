# Copyright (c) 2026 UnieAI. All rights reserved.
"""Harbor agents for the local FrontierHarness Eval reproduction.

Three arms, one model (served by the UnieAI gateway):

* ``unieai_agents:UnieaiCodexAgent``  -> ``unieai-codex``: UnieAI Code (codex fork)
  ``exec`` with approvals/sandbox bypassed, a ``[model_providers.unieai]`` entry
  pointing at the gateway (wire_api = responses).
* ``unieai_agents:UnieaiDshAgent``    -> ``dsh-standard``: stock deepseek-harness,
  ``dsh --profile headless --json`` (the headless profile composes the standard
  tool set on the host plane), gateway declared in ``settings.yaml``,
  ``DSH_PERMISSION_MODE=danger-full-access``.
* ``unieai_agents:UnieaiDshPluginAgent`` -> ``dsh-unieai``: the same plus UnieAI's
  plugin pack (``plugin_dir``) and the settings/patch rendered by that pack's
  ``config.mjs`` (or an explicit ``patch_path``).

Nothing is installed from the network inside the task container: the host's
runtime cache (see ``unieai_prepare.sh``) is bind-mounted read-only at
``/opt/unieai-bench`` by the runner, and uploaded as a fallback when it is not.

The gateway key is read from the host environment (``UNIEAI_BENCH_GATEWAY_KEY``)
and passed to the harness process through the exec environment only; it is never
written into a command line, a config file under ``/logs``, or the trial config.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, override

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.codex import Codex, CodexOptions
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CACHE = Path(
    os.environ.get("UNIEAI_BENCH_CACHE", Path.home() / ".cache/unieai-frontier-harness")
)
HOST_RUNTIME = Path(os.environ.get("UNIEAI_BENCH_RUNTIME", CACHE / "runtime"))
RUNTIME = PurePosixPath("/opt/unieai-bench")
WORK = PurePosixPath("/installed-agent")
AGENT_DIR = EnvironmentPaths.agent_dir

KEY_ENV = "UNIEAI_BENCH_GATEWAY_KEY"
URL_ENV = "UNIEAI_BENCH_GATEWAY_URL"
DEFAULT_GATEWAY = "https://api.unieai.com/v1"


def gateway_url() -> str:
    return os.environ.get(URL_ENV) or DEFAULT_GATEWAY


def gateway_key() -> str:
    key = os.environ.get(KEY_ENV, "")
    if not key:
        raise RuntimeError(
            f"{KEY_ENV} is not set; the runner exports it from ~/.unieai/unieai.json"
        )
    return key


def account_file() -> Path:
    """The signed-in account: $UNIEAI_CREDENTIALS (another Studio's login), else ~/.unieai."""
    return Path(
        os.environ.get("UNIEAI_CREDENTIALS") or Path.home() / ".unieai" / "unieai.json"
    )


def account_model(model: str) -> dict[str, Any]:
    """The model as the signed-in account records it (id, context window, modalities).

    Read from ~/.unieai/unieai.json, which `unieai login sync` fills from
    Studio. Every arm declares the same facts, so a difference between arms is
    the harness and not its metadata.
    """
    path = account_file()
    try:
        models = json.loads(path.read_text()).get("available_models") or []
    except (OSError, ValueError):
        models = []
    entry = next((m for m in models if m.get("id") == model), {})
    window = model_context_window(model)
    return {
        "id": model,
        **({"context_window": window} if window else {}),
        **(
            {"input_modalities": entry["input_modalities"]}
            if entry.get("input_modalities")
            else {}
        ),
    }


def model_context_window(model: str) -> int | None:
    """The model's context window as the signed-in account records it.

    Without it codex uses its fallback metadata (272k) and never compacts, so
    a gateway serving a 131k model rejects the turn mid-run. The value comes
    from ~/.unieai/unieai.json, which `unieai login sync` fills from Studio's
    model registry; ``UNIEAI_BENCH_CONTEXT_WINDOW`` overrides it.
    """
    override = os.environ.get("UNIEAI_BENCH_CONTEXT_WINDOW")
    if override:
        return int(override)
    path = account_file()
    try:
        models = json.loads(path.read_text()).get("available_models") or []
    except (OSError, ValueError):
        return None
    for entry in models:
        if entry.get("id") == model and entry.get("context_window"):
            return int(entry["context_window"])
    return None


def bare_model(model_name: str | None) -> str:
    if not model_name:
        raise ValueError("a model name is required (-m unieai/<model>)")
    return model_name.split("/", 1)[1] if "/" in model_name else model_name


def yaml_quote(value: Any) -> str:
    return json.dumps(str(value))


async def ensure_runtime(
    agent: BaseInstalledAgent, env: BaseEnvironment, rel: str, probe: str
) -> None:
    """Make ``/opt/unieai-bench/<rel>`` available: mounted by the runner, else uploaded."""
    target = RUNTIME / rel
    check = await env.exec(
        command=f"test -e {shlex.quote(str(target / probe))}", user="root"
    )
    if check.return_code == 0:
        return
    source = HOST_RUNTIME / rel
    if not (source / probe).exists():
        raise RuntimeError(f"{source / probe} is missing; run unieai_prepare.sh first")
    agent.logger.warning("runtime %s is not mounted; uploading %s (slow)", rel, source)
    await env.exec(command=f"mkdir -p {shlex.quote(str(target))}", user="root")
    await env.upload_dir(source, str(target))
    await env.exec(command=f"chmod -R a+rX {shlex.quote(str(RUNTIME))}", user="root")


async def prepare_workdir(agent: BaseInstalledAgent, env: BaseEnvironment) -> None:
    await agent.exec_as_root(
        env,
        command=f"mkdir -p {WORK} {AGENT_DIR} && chmod 1777 {WORK} && chmod a+rwx {AGENT_DIR}",
    )


def task_timeout_sec(logs_dir: Path) -> float | None:
    """The agent time limit of the task this trial runs, as harbor applies it.

    harbor enforces it from outside and never tells the agent; the trial's
    config.json (next to the agent log dir) names the task, whose task.toml
    holds `[agent] timeout_sec`, scaled by the trial's timeout_multiplier.
    """
    import tomllib

    try:
        config = json.loads((Path(logs_dir).parent / "config.json").read_text())
        task = Path(config["task"]["path"]) / "task.toml"
        seconds = tomllib.loads(task.read_text()).get("agent", {}).get("timeout_sec")
        multiplier = config.get("timeout_multiplier") or 1.0
        return float(seconds) * float(multiplier) if seconds else None
    except (OSError, KeyError, TypeError, ValueError):
        return None


async def upload_text(
    env: BaseEnvironment, content: str, remote: str, mode: str = "600"
) -> None:
    with tempfile.TemporaryDirectory(prefix="unieai-bench-") as tmp:
        path = Path(tmp) / PurePosixPath(remote).name
        path.write_text(content)
        await env.upload_file(path, remote)
    await env.exec(command=f"chmod {mode} {shlex.quote(remote)}", user="root")
    if env.default_user is not None:
        await env.exec(
            command=f"chown {env.default_user} {shlex.quote(remote)}", user="root"
        )


# ── unieai-codex ────────────────────────────────────────────────────────────


class UnieaiCodexOptions(CodexOptions):
    payload: str | None = Field(
        default=None,
        description="Directory under runtime/codex holding bin/codex (e.g. unieai-0.0.27). "
        "Defaults to $UNIEAI_BENCH_CODEX_PAYLOAD.",
    )
    unified_exec: bool = Field(
        default=True, description="Pass --enable unified_exec, as the eval did."
    )


class UnieaiCodexAgent(Codex):
    """UnieAI Code (codex fork) in ``exec`` mode against the UnieAI gateway."""

    options_model = UnieaiCodexOptions
    _HOME = WORK / "codex-home"

    @staticmethod
    @override
    def name() -> str:
        return "unieai-codex"

    @property
    def _payload(self) -> str:
        payload = getattr(self.options, "payload", None) or os.environ.get(
            "UNIEAI_BENCH_CODEX_PAYLOAD"
        )
        if not payload:
            raise ValueError(
                "no codex payload selected (agent kwarg payload= or UNIEAI_BENCH_CODEX_PAYLOAD)"
            )
        return payload

    @property
    def _bin(self) -> str:
        return str(RUNTIME / "codex" / self._payload / "bin" / "codex")

    @override
    def get_version_command(self) -> str | None:
        return f"{self._bin} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        line = next((l.strip() for l in stdout.splitlines() if l.strip()), "")
        return line  # "unieai 0.0.27" or "codex-cli 0.154.0": keep the product name

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await prepare_workdir(self, environment)
        await ensure_runtime(self, environment, f"codex/{self._payload}", "bin/codex")
        await self.exec_as_agent(environment, command=f"{self._bin} --version")

    def _config_toml(self, model: str) -> str:
        window = model_context_window(model)
        return "\n".join(
            [
                f"model = {yaml_quote(model)}",
                'model_provider = "unieai"',
                # The account's window, so auto-compaction happens before the
                # gateway rejects the request (see model_context_window).
                *([f"model_context_window = {window}"] if window else []),
                "",
                # Replaces the built-in `unieai` provider (see
                # model-provider-info merge rules), so the fork keeps its gateway
                # model profile; UNIEAI_API_KEY makes it skip unieai.json.
                "[model_providers.unieai]",
                'name = "UnieAI"',
                f"base_url = {yaml_quote(gateway_url())}",
                'env_key = "UNIEAI_API_KEY"',
                'wire_api = "responses"',
                "",
            ]
        )

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        model = bare_model(self.model_name)
        home = str(self._HOME)
        env = {
            "CODEX_HOME": home,
            "UNIEAI_HOME": home,
            "UNIEAI_API_KEY": gateway_key(),
        }
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {home} {AGENT_DIR}/sessions && "
                f"ln -sfn {AGENT_DIR}/sessions {home}/sessions"
            ),
        )
        await upload_text(environment, self._config_toml(model), f"{home}/config.toml")
        await upload_text(
            environment, instruction, f"{WORK}/instruction.md", mode="644"
        )

        flags = self.build_cli_flags()
        enable = (
            "--enable unified_exec "
            if getattr(self.options, "unified_exec", True)
            else ""
        )
        rg_path = RUNTIME / "codex" / self._payload / "path"
        await self.exec_as_agent(
            environment,
            command=(
                # Keep the task image's PATH; ripgrep goes after it.
                f'export PATH="$PATH:{rg_path}"; '
                # Images without a CA bundle: point rustls at ours.
                f"[ -s /etc/ssl/certs/ca-certificates.crt ] || export SSL_CERT_FILE={RUNTIME}/certs/ca-certificates.crt; "
                f"{self._bin} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "
                f"--model {shlex.quote(model)} --json {enable}{flags + ' ' if flags else ''}"
                f'-- "$(cat {WORK}/instruction.md)" '
                f"2>&1 </dev/null | tee {AGENT_DIR / self._OUTPUT_FILENAME}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        usage = codex_usage(self.logs_dir)
        if usage:
            context.n_input_tokens = usage["input_tokens"]
            context.n_cache_tokens = usage["cached_tokens"]
            context.n_output_tokens = usage["output_tokens"]
        context.metadata = {
            **(context.metadata or {}),
            "harness": self.name(),
            "payload": self._payload,
            "turns": (usage or {}).get("turns"),
        }


def codex_usage(agent_dir: Path) -> dict[str, int] | None:
    """Per-call usage from the rollout: token_count events carry last_token_usage."""
    files = sorted((agent_dir / "sessions").rglob("rollout-*.jsonl"))
    if not files:
        return None
    totals = {"input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "turns": 0}
    last_total = None
    for path in files:
        for line in path.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = event.get("payload") or {}
            if event.get("type") != "event_msg" or payload.get("type") != "token_count":
                continue
            info = payload.get("info") or {}
            total = info.get("total_token_usage")
            last = info.get("last_token_usage")
            if not last or total == last_total:
                continue  # repeated snapshot (rate-limit refresh), not a new call
            last_total = total
            totals["turns"] += 1
            totals["input_tokens"] += int(last.get("input_tokens") or 0)
            totals["cached_tokens"] += int(last.get("cached_input_tokens") or 0)
            totals["output_tokens"] += int(last.get("output_tokens") or 0)
    return totals


# ── dsh-standard / dsh-unieai ───────────────────────────────────────────────


class UnieaiDshOptions(InstalledAgentOptions):
    preset: str = Field(
        default="standard",
        description="Agent preset. 0.1.6's headless profile has no preset roster and "
        "composes the standard tool set directly, so only 'standard' is supported.",
    )
    tools_mode: str | None = Field(
        default=None, description="DSH_TOOLS_MODE (e.g. ptc); unset for standard."
    )
    dsh_install: str = Field(
        default="dsh",
        description="dsh install under the runtime dir (dsh-<lock hash> from "
        "unieai_prepare.sh); arms of an A/B across dsh versions each name their own.",
    )


class UnieaiDshAgent(BaseInstalledAgent):
    """Stock deepseek-harness, one-shot headless run."""

    options_model = UnieaiDshOptions
    _HOME = WORK / "dsh-home"
    _NODE = RUNTIME / "node/bin/node"
    SESSIONS = AGENT_DIR / "dsh-sessions"

    @staticmethod
    @override
    def name() -> str:
        return "dsh-standard"

    @property
    def _dsh_install(self) -> str:
        return getattr(self.options, "dsh_install", None) or "dsh"

    @property
    def _BIN(self) -> PurePosixPath:
        return RUNTIME / self._dsh_install / "node_modules/@deepseek-ai/dsh/lib/bin.js"

    @override
    def get_version_command(self) -> str | None:
        return f"{self._NODE} {self._BIN} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip() if stdout.strip() else stdout

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if getattr(self.options, "preset", "standard") != "standard":
            raise ValueError("only the standard preset is wired for dsh 0.1.6 headless")
        await prepare_workdir(self, environment)
        await ensure_runtime(self, environment, "node", "bin/node")
        await ensure_runtime(
            self,
            environment,
            self._dsh_install,
            "node_modules/@deepseek-ai/dsh/lib/bin.js",
        )
        await self.exec_as_agent(
            environment, command=f"{self._NODE} {self._BIN} --version"
        )

    # Stock provider declaration: what renderSettings wrote before UnieAI's
    # tuning (no retry policy, no shell budget, no context window).
    def render_settings(self, model: str) -> str:
        return "\n".join(
            [
                "llm-pi-ai:",
                "  providers:",
                "    unieai:",
                '      displayName: "UnieAI"',
                "      apiKeyEnv: UNIEAI_GATEWAY_API_KEY",
                "      api: openai-completions",
                f"      baseURL: {yaml_quote(gateway_url())}",
                "      compat:",
                "        supportsDeveloperRole: false",
                "        maxTokensField: max_tokens",
                "      models:",
                f"        - id: {yaml_quote(model)}",
                *self._model_metadata_lines(model),
                "agent-default-model:",
                "  provider: unieai",
                f"  model: {yaml_quote(model)}",
                "",
            ]
        )

    @staticmethod
    def _model_metadata_lines(model: str) -> list[str]:
        """What the account says about the model, as settings.yaml states it."""
        entry = account_model(model)
        lines = []
        if entry.get("context_window"):
            lines.append(f"          contextWindow: {entry['context_window']}")
        modalities = [
            m for m in entry.get("input_modalities", []) if m in ("text", "image")
        ]
        if modalities:
            lines.append(f"          input: [{', '.join(modalities)}]")
        return lines

    def render_base_patch(self, model: str) -> str:
        # The route (headless reads agentDefaultModel), and session logs written
        # straight into /logs/agent so they survive an agent timeout.
        return "\n".join(
            [
                "- id: agent-default-model",
                "  config:",
                "    provider: unieai",
                f"    model: {yaml_quote(model)}",
                "- id: session-persistence-jsonl",
                "  config:",
                f"    root: {yaml_quote(self.SESSIONS)}",
                "",
            ]
        )

    async def extra_patches(
        self, environment: BaseEnvironment, model: str
    ) -> list[str]:
        return []

    def arm_env(self) -> dict[str, str]:
        return {}

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        model = bare_model(self.model_name)
        home = str(self._HOME)
        await self.exec_as_agent(
            environment, command=f"mkdir -p {home} {self.SESSIONS}"
        )
        await upload_text(
            environment, self.render_settings(model), f"{home}/settings.yaml"
        )
        base_patch = f"{WORK}/dsh-base.patch.yml"
        await upload_text(
            environment, self.render_base_patch(model), base_patch, mode="644"
        )
        await upload_text(
            environment, instruction, f"{WORK}/instruction.md", mode="644"
        )
        patches = [base_patch, *await self.extra_patches(environment, model)]

        env = {
            "DSH_HOME": home,
            "DSH_TELEMETRY_DISABLED": "1",
            "DSH_PERMISSION_MODE": "danger-full-access",
            "UNIEAI_GATEWAY_API_KEY": gateway_key(),
            **self.arm_env(),
        }
        tools_mode = getattr(self.options, "tools_mode", None)
        if tools_mode:
            env["DSH_TOOLS_MODE"] = tools_mode
        patch_args = " ".join(f"--patch {shlex.quote(p)}" for p in patches)
        await self.exec_as_agent(
            environment,
            command=(
                f"{self._NODE} {self._BIN} --profile headless {patch_args} --json - "
                f"<{WORK}/instruction.md >{AGENT_DIR}/dsh-stream.jsonl 2>{AGENT_DIR}/dsh-stderr.txt; "
                f"rc=$?; echo $rc >{AGENT_DIR}/dsh-exit-code.txt; "
                f"tail -c 2000 {AGENT_DIR}/dsh-stderr.txt; exit $rc"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        usage = dsh_usage(self.logs_dir)
        if usage:
            context.n_input_tokens = usage["input_tokens"]
            context.n_cache_tokens = usage["cached_tokens"]
            context.n_output_tokens = usage["output_tokens"]
        context.metadata = {
            **(context.metadata or {}),
            "harness": self.name(),
            "turns": (usage or {}).get("turns"),
            "usage_source": (usage or {}).get("source"),
        }


def decompress_dsh_sessions(agent_dir: Path) -> Path | None:
    """Write ``dsh-session.jsonl`` (the eval's name) from the zstd session log."""
    out = agent_dir / "dsh-session.jsonl"
    if out.exists():
        return out
    logs = sorted((agent_dir / "dsh-sessions").rglob("session*.jsonl*"))
    main = [p for p in logs if p.name.endswith(".zstd")] or logs
    if not main:
        return None
    chunks = []
    for path in main:
        if path.suffix == ".zstd":
            if not shutil.which("zstd"):
                return None
            result = subprocess.run(["zstd", "-dcq", str(path)], capture_output=True)
            chunks.append(result.stdout.decode(errors="replace"))
        else:
            chunks.append(path.read_text(errors="replace"))
    out.write_text("".join(chunks))
    return out


def dsh_usage(agent_dir: Path) -> dict[str, Any] | None:
    """Model calls and tokens: assistant/message usage in the session log, else the --json stream."""
    usage = {"input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "turns": 0}
    session = None
    try:
        session = decompress_dsh_sessions(agent_dir)
    except OSError:
        session = None
    if session is not None:
        for line in session.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "assistant/message":
                continue
            data = event.get("data") if isinstance(event.get("data"), dict) else event
            u = data.get("usage") or {}
            if not isinstance(u, dict) or not (
                u.get("inputTokens") or u.get("outputTokens")
            ):
                continue
            usage["turns"] += 1
            cached = int(u.get("cacheReadTokens") or 0)
            usage["input_tokens"] += int(u.get("inputTokens") or 0) + cached
            usage["cached_tokens"] += cached
            usage["output_tokens"] += int(u.get("outputTokens") or 0)
        if usage["turns"]:
            usage["source"] = "session"
            return usage
    stream = agent_dir / "dsh-stream.jsonl"
    if not stream.exists():
        return None
    for line in stream.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            event.get("type") == "status"
            and event.get("phase") == "step_end"
            and event.get("usage")
        ):
            u = event["usage"]
            usage["turns"] += 1
            cached = int(u.get("cacheReadTokens") or 0)
            usage["input_tokens"] += int(u.get("inputTokens") or 0) + cached
            usage["cached_tokens"] += cached
            usage["output_tokens"] += int(u.get("outputTokens") or 0)
    usage["source"] = "stream"
    return usage if usage["turns"] else None


class UnieaiDshPluginOptions(UnieaiDshOptions):
    plugin_dir: str | None = Field(
        default=None,
        description="Host directory with UnieAI's dsh pack (config.mjs, plugins/). "
        "Default: agent-runtime/src/unieai-dsh, or $UNIEAI_BENCH_DSH_PLUGIN_DIR.",
    )
    patch_path: str | None = Field(
        default=None,
        description="Host patch file to use instead of rendering one with the pack's config.mjs. "
        "{{UNIEAI_DSH_DIR}} / {{UNIEAI_DSH_URL}} expand to the pack's container path / file URL.",
    )
    plugins: str | None = Field(
        default=None, description="UNIEAI_DSH_PLUGINS selection (all/off/comma list)."
    )
    deadline_share: float | None = Field(
        default=None,
        description="Give unieai-loop-guard this share of the task's agent timeout as its deadline "
        "(UNIEAI_TURN_DEADLINE_MS). Off by default: harbor's wall clock is invisible to the agent.",
    )
    persona_rigor: bool = Field(
        default=False,
        description="Render the pack with UNIEAI_PERSONA_RIGOR=1 (the measured-failure persona rules).",
    )


class UnieaiDshPluginAgent(UnieaiDshAgent):
    """dsh-standard plus UnieAI's plugin pack."""

    options_model = UnieaiDshPluginOptions
    OVERLAY = WORK / "dsh-overlay"

    @staticmethod
    @override
    def name() -> str:
        return "dsh-unieai"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._rendered: dict[str, Any] | None = None

    @property
    def _plugin_dir(self) -> Path:
        chosen = (
            getattr(self.options, "plugin_dir", None)
            or os.environ.get("UNIEAI_BENCH_DSH_PLUGIN_DIR")
            or REPO / "agent-runtime/src/unieai-dsh"
        )
        return Path(chosen).resolve()

    @property
    def _container_pack(self) -> PurePosixPath:
        return self.OVERLAY / "src" / self._plugin_dir.name

    def _render(self, model: str) -> dict[str, Any]:
        """Settings and patch from the pack's own config.mjs, rewritten for the container."""
        if self._rendered is not None:
            return self._rendered
        env = {
            **os.environ,
            "UNIEAI_DSH_PLUGINS": getattr(self.options, "plugins", None) or "all",
        }
        env.pop("UNIEAI_PERSONA_RIGOR", None)
        if getattr(self.options, "persona_rigor", False):
            env["UNIEAI_PERSONA_RIGOR"] = "1"
        env.pop(KEY_ENV, None)
        result = subprocess.run(
            [
                str(HOST_RUNTIME / "node/bin/node"),
                str(HERE / "unieai_render_dsh.mjs"),
                str(self._plugin_dir / "config.mjs"),
                model,
                gateway_url(),
                json.dumps(account_model(model)),
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"rendering the dsh pack failed: {result.stderr.strip()[-2000:]}"
            )
        rendered = json.loads(result.stdout)
        host_url = self._plugin_dir.as_uri()
        for key in ("settings", "patch"):
            text = rendered.get(key) or ""
            text = text.replace(host_url, f"file://{self._container_pack}")
            rendered[key] = text.replace(
                str(self._plugin_dir), str(self._container_pack)
            )
        self._rendered = rendered
        return rendered

    @override
    def render_settings(self, model: str) -> str:
        settings = self._render(model).get("settings")
        return settings or super().render_settings(model)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        pack = self._plugin_dir
        if not pack.is_dir():
            raise RuntimeError(f"dsh plugin dir {pack} does not exist")
        # The pack imports @deepseek-ai/*: give it a node_modules to resolve from,
        # and ../config.mjs (agent-runtime/src/config.mjs) when it is a src/ child.
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {self._container_pack} && "
                f"ln -sfn {RUNTIME}/{self._dsh_install}/node_modules {self.OVERLAY}/node_modules"
            ),
        )
        with tempfile.TemporaryDirectory(prefix="unieai-dsh-pack-") as tmp:
            staged = Path(tmp) / pack.name
            shutil.copytree(
                pack,
                staged,
                ignore=shutil.ignore_patterns("*.test.mjs", "node_modules"),
            )
            await environment.upload_dir(staged, str(self._container_pack))
        sibling = pack.parent / "config.mjs"
        if sibling.is_file():
            await environment.upload_file(
                sibling, str(self._container_pack.parent / "config.mjs")
            )
        await environment.exec(command=f"chmod -R a+rX {self.OVERLAY}", user="root")

    @override
    async def extra_patches(
        self, environment: BaseEnvironment, model: str
    ) -> list[str]:
        explicit = getattr(self.options, "patch_path", None) or os.environ.get(
            "UNIEAI_BENCH_DSH_PATCH"
        )
        if explicit:
            text = Path(explicit).read_text()
            text = text.replace("{{UNIEAI_DSH_DIR}}", str(self._container_pack))
            text = text.replace("{{UNIEAI_DSH_URL}}", f"file://{self._container_pack}")
        else:
            text = self._render(model).get("patch") or ""
        if not text.strip():
            return []
        remote = f"{WORK}/dsh-unieai.patch.yml"
        await upload_text(environment, text, remote, mode="644")
        # Keep a copy with the evidence (it holds no secret).
        (self.logs_dir / "dsh-unieai.patch.yml").write_text(text)
        return [remote]

    @override
    def arm_env(self) -> dict[str, str]:
        env = {"UNIEAI_DSH_PLUGINS": getattr(self.options, "plugins", None) or "all"}
        # The deadline the loop guard works to, as a share of the task's
        # limit (the rest is for the wrap-up, a commit, and dsh's shutdown).
        # Without it unieai-loop-guard has no clock: runs hit harbor's wall
        # clock mid-search without ever writing their output (db-wal-recovery,
        # gcode-to-text in the 2026-09-17 run).
        share = getattr(self.options, "deadline_share", None)
        limit = task_timeout_sec(self.logs_dir) if share else None
        if limit:
            env["UNIEAI_TURN_DEADLINE_MS"] = str(int(limit * float(share) * 1000))
        return env

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        rendered = self._rendered or {}
        context.metadata = {
            **(context.metadata or {}),
            "plugins": rendered.get("plugins"),
            "plugin_dir": str(self._plugin_dir),
            "renderer": rendered.get("renderer"),
        }


__all__ = [
    "UnieaiCodexAgent",
    "UnieaiDshAgent",
    "UnieaiDshPluginAgent",
    "codex_usage",
    "dsh_usage",
]
