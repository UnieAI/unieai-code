# UnieAI Code

> A locally-run coding agent for your own models — terminal, editor, or embedded.

[![GitHub Stars](https://img.shields.io/github/stars/UnieAI/unieai-code?style=social)](https://github.com/UnieAI/unieai-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/UnieAI/unieai-code)](https://github.com/UnieAI/unieai-code/issues)

<p align="center">
  <a href="#what-you-get">What you get</a> · <a href="#quick-start">Quick Start</a> · <a href="#commands">Commands</a> · <a href="#configuration">Config</a> · <a href="#repository-structure">Structure</a> · <a href="#contributing">Contributing</a>
</p>

---

**UnieAI Code** is a coding agent that navigates real repositories — it explores your
code, runs commands, edits files, and verifies its own changes — running against your
own [UnieAI Studio](https://studio.demo.unieai.com) model gateway (Qwen, MiniMax, GLM,
and other open models). Nothing leaves your environment except the model calls you
already make.

It comes in three forms, all sharing one engine:

| Surface | What it is |
|---|---|
| **CLI** (`unieai`) | A fast Rust terminal agent — interactive TUI or scripted `unieai exec` for CI. |
| **Engine** (`@unieai/code-agent-runtime`) | The coding runtime as an npm library, to embed in your own tools. |
| **VS Code extension** | An in-editor chat panel powered by the same engine. |

Internally the engine runs on [`@unieai/agent-core`](third_party/unieai-agent-core) —
our shared agent loop, also used by UnieAI Studio.

## Why it's good

The agent harness matters as much as the model. On **SWE-bench Lite** (300 real GitHub
issues, single attempt, official test judging) with a 35B open model, iterating on the
harness took the resolved rate from **27.7% → 46.0%** — while staying ~2× cheaper per
task than a stock codex-style harness, and with no regression on HumanEval (99%). Full
data and methodology in [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md).

What drives it: a completion contract that refuses "done" until the work is actually
there and verified, tools that report a syntax check the moment you edit, fuzzy-matching
edits that survive whitespace drift, and open-model resilience (empty-response resampling,
`<think>` stripping, stall detection).

## What you get

| Feature | Description |
|---------|-------------|
| **Interactive TUI** | Terminal UI with markdown, thinking blocks, streaming tool output |
| **Non-interactive mode** | `unieai exec` / `unieai review` for CI/CD and automation |
| **Your models** | UnieAI Studio gateway — cloud or on-prem, open models |
| **VS Code panel** | In-editor chat that reads your workspace and edits files |
| **Sandboxing** | Shell commands run in a sandbox; risky actions ask first |
| **Verification built in** | Edits self-check; the agent proves its work before finishing |
| **MCP integration** | Run and manage external MCP servers as tools |
| **Skills & plugins** | Extensible skill definitions and a plugin system |
| **Sessions** | Resume, fork, archive, and delete past sessions |

## Quick Start

### Install the CLI

**macOS / Linux:**

```shell
curl -fsSL https://www.unieai.com/code/install.sh | sh
```

Installs the `unieai` binary to `~/.local/bin`. (Windows and pinned-version install
options: see [docs/install.md](./docs/install.md).)

### Run

```shell
unieai                          # interactive session
unieai "fix all type errors"    # start with a prompt
```

### Sign in

```shell
unieai login --studio-url https://studio.demo.unieai.com
```

Opens a device-code flow in your browser; once confirmed, your model list is saved to
`~/.unieai/unieai.json`. For on-prem deployments, point `--studio-url` at your Studio
endpoint — the inference gateway is auto-derived (`studio.` → `api.`).

### Use in VS Code

Install the **UnieAI Code** extension from the marketplace, sign in when prompted, and
open the panel from the activity bar.

### Embed the engine

```shell
npm install @unieai/code-agent-runtime
```

See [`agent-runtime/README.md`](agent-runtime/README.md) for the API.

## Commands

```shell
unieai [OPTIONS] [PROMPT]        # interactive TUI
```

| Command | Description |
|---------|-------------|
| `unieai exec PROMPT` | Run the agent non-interactively |
| `unieai review --diff PATH` | Non-interactive code review |
| `unieai resume` / `fork` | Resume or fork a previous session |
| `unieai login` / `logout` | Manage UnieAI Studio credentials |
| `unieai mcp` | Manage external MCP servers |
| `unieai sandbox` | Run a command in the sandbox |
| `unieai doctor` | Diagnose install, config, auth, and runtime health |
| `unieai update` | Update to the latest version |

## Configuration

CLI config lives in `~/.codex/config.toml` (approval policy, sandbox, models, MCP
servers, skills). See the [Config Reference](./docs/config.md); run `unieai doctor` to
diagnose issues.

## Repository Structure

```
├── codex-rs/                     # Rust CLI (TUI, exec, sandbox, app-server)
├── agent-runtime/                # @unieai/code-agent-runtime — the coding engine (npm)
│   ├── src/engine.mjs            #   one turn on the agent-core loop + coding layer
│   └── src/tools.mjs             #   bash / read / write / edit (sandboxed, verifying)
├── third_party/
│   └── unieai-agent-core/        # @unieai/agent-core — shared agent loop (submodule)
├── sdks/vscode/                  # VS Code extension
├── benchmarks/                   # HumanEval + SWE-bench harness and results
├── docs/                         # Documentation
└── sdk/                          # Python and TypeScript SDKs
```

## Contributing

See [docs/contributing.md](./docs/contributing.md) for setup and build instructions.
The CLI is a Rust project; the engine is Node ≥ 20. Clone with submodules:

```shell
git clone --recursive https://github.com/UnieAI/unieai-code.git
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
