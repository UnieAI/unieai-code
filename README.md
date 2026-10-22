# UnieAI Code

> A locally-run coding agent for your own models — terminal, editor, or embedded.

[![GitHub Stars](https://img.shields.io/github/stars/UnieAI/unieai-code?style=social)](https://github.com/UnieAI/unieai-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/UnieAI/unieai-code)](https://github.com/UnieAI/unieai-code/issues)

<p align="center">
  <a href="#whats-new">What's new</a> · <a href="#what-you-get">What you get</a> · <a href="#quick-start">Quick Start</a> · <a href="#commands">Commands</a> · <a href="#configuration">Config</a> · <a href="#repository-structure">Structure</a> · <a href="#contributing">Contributing</a>
</p>

---

**UnieAI Code** is a coding agent that navigates real repositories — it explores your
code, runs commands, edits files, and verifies its own changes — running against your
own [UnieAI Studio](https://studio.demo.unieai.com) model gateway (Qwen, MiniMax, GLM,
and other open models). Nothing leaves your environment except the model calls you
already make.

It comes in three forms:

| Surface | What it is |
|---|---|
| **CLI** (`unieai`) | A fast Rust terminal agent — interactive TUI or scripted `unieai exec` for CI. |
| **Engine** (`@unieai/code-agent-runtime`) | The coding runtime as an npm library, to embed in your own tools. |
| **VS Code extension** | An in-editor chat panel powered by the same engine. |

The CLI runs a session on one of two engines, picked with `/engine`: **uac**
(unieai-agent-core on deepseek-harness, the default) or **codex**. The embeddable engine
runs on [`@unieai/agent-core`](third_party/unieai-agent-core) — our shared agent loop,
also used by UnieAI Studio.

## What's new

**0.0.38** (2026-10-22) — highlights:

- **Connect a model API** — sign in with UnieAI Rabi (now first), UnieAI Studio, or no
  UnieAI account at all: OpenAI, OpenRouter, DeepSeek, Groq, Together, Mistral, Gemini,
  Ollama, LM Studio or any OpenAI-compatible URL (`unieai login --api <PRESET|URL>`).
- **`/usage` for Studio plans** — 5-hour and weekly windows, extra usage and your wallet;
  billing refusals now say what to do and are not retried.
- **`/tasks`** — subagents and background commands, to open or stop; the agent tree
  under the composer now shows only live work.
- **Fixed on Node 23** — uac turns no longer fail with "ACP agent closed the connection"
  on Node 23 (or 22 before 22.18, 24 before 24.2).
- **Previews** — Remote Control (`/remote-control`, end-to-end encrypted; the hosted
  relay is not live yet) and Artifacts (`publish_artifact`, `unieai artifact`; needs
  a Rabi sign-in).

Every release, newest first: [CHANGELOG.md](CHANGELOG.md).

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

**macOS / Linux / Windows** (needs Node.js 22+):

```shell
npm install -g @unieai/code
```

Installs the `unieai` command. For a machine with no network or no Node, each
[GitHub Release](https://github.com/UnieAI/unieai-code/releases) has an offline bundle
per platform: unpack it and run `sh install.sh` (Windows: `install.ps1`). Pin a version
with `npm install -g @unieai/code@<version>`.

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
endpoint — the inference gateway is auto-derived (`studio.` → `api.`). For a UnieAI
Rabi account, use `unieai login --rabi` (runs on the uac engine). `unieai login sync`
refreshes the model list from your account.

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
| `unieai login` / `logout` | Manage UnieAI Studio (or `--rabi`) credentials |
| `unieai mcp` | Manage external MCP servers |
| `unieai peers mcp` | Let Claude Code or another MCP client talk to your sessions |
| `unieai sandbox` | Run a command in the sandbox |
| `unieai doctor` | Diagnose install, config, auth, and runtime health |
| `unieai update` | Update to the latest version |

UnieAI's own slash commands in the TUI (alongside the usual `/model`, `/permissions`,
`/compact`, `/resume`, … — see [docs/slash_commands.md](./docs/slash_commands.md)):

| Command | Description |
|---------|-------------|
| `/engine [codex\|uac]` | Switch the agent engine for new sessions (uac modes: `/engine ptc`, …) |
| `/context` | Show what is using the context window (uac) |
| `/loop [interval] <prompt>` | Repeat a prompt; `/loop` lists loops, `/loop stop` ends them (uac) |
| `/peers` / `/peer` | Browse or message other UnieAI Code sessions on this machine |
| Esc Esc | Rewind to an earlier message; on uac, optionally restore the files too |

## Configuration

CLI config lives in `~/.unieai/config.toml` (approval policy, sandbox, models, MCP
servers, skills). See the [Config Reference](./docs/config.md); run `unieai doctor` to
diagnose issues.

## Repository Structure

```
├── codex-rs/                     # Rust CLI (TUI, exec, sandbox, app-server)
├── agent-runtime/                # @unieai/code-agent-runtime — engines (npm), incl. the uac server
│   ├── bin/unieai-uac-server.mjs #   uac: drives deepseek-harness for the TUI
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
The CLI is a Rust project; the engines are Node (≥ 22 for uac). Each release adds an
entry to [CHANGELOG.md](CHANGELOG.md) — see the note at its top. Clone with submodules:

```shell
git clone --recursive https://github.com/UnieAI/unieai-code.git
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
