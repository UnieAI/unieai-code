# UnieAI Code

> A powerful, locally-run coding agent — built on Rust, designed for developers.

[![GitHub Stars](https://img.shields.io/github/stars/UnieAI/unieai-code?style=social)](https://github.com/UnieAI/unieai-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/UnieAI/unieai-code)](https://github.com/UnieAI/unieai-code/issues)

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md)

<p align="center">
  <a href="#features">Features</a> · <a href="#quick-start">Quick Start</a> · <a href="#commands">Commands</a> · <a href="#desktop-app">Desktop</a> · <a href="#configuration">Config</a> · <a href="#contributing">Contributing</a> · <a href="#docs">Docs</a>
</p>

---

UnieAI Code is a locally-run coding agent that runs directly in your terminal. It can help with complex coding tasks, code reviews, debugging, and more — all within your local environment.

**Based on Codex CLI**, rebranded and extended with UnieAI Studio integration, enterprise features, and more.

---

## Features

| Feature | Description |
|---------|-------------|
| **Interactive TUI** | Full terminal UI with markdown rendering, thinking blocks, tool output display, and streaming responses |
| **Non-interactive Mode** | Run `codex exec` or `codex review` for CI/CD pipelines and scripted automation |
| **Multi-Auth** | Sign in with UnieAI Studio (device code), ChatGPT, API key, or access token |
| **Enterprise Studio** | Cloud or on-prem UnieAI Studio support with auto-derived inference gateway |
| **Desktop App** | Native macOS / Windows desktop app (`codex app`) |
| **VS Code Extension** | Native chat panel in VS Code |
| **MCP Integration** | Run and manage external MCP servers as Codex tools |
| **Plugin System** | Install, manage, and build Codex plugins |
| **Skills** | Extensible skill definitions with conditional activation |
| **Session Management** | Resume, fork, archive, and delete past sessions |
| **Multi-Agent** | Collaborative agent orchestration with cloud task management |
| **Web Search** | Live web search with `--search` flag |
| **Sandboxing** | Exec commands within a secure sandbox environment |
| **App Server** | Backend for desktop / IDE integrations with streaming, approvals, and interrupt support |
| **Cloud Tasks** | Browse and apply changes from Codex Cloud (`codex cloud`) |
| **Rollout Tracing** | Feature rollout trace replay for debugging |
| **Auto-Updates** | Built-in `codex update` for seamless version upgrades |

---

## Quick Start

### Install

**macOS / Linux:**

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

**Windows:**

```shell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

**Via npm:**

```shell
npm install -g @openai/codex
```

**Via Homebrew:**

```shell
brew install --cask codex
```

Alternatively, download the latest binary from [GitHub Releases](https://github.com/openai/codex/releases/latest).

### Run

```shell
codex          # Start interactive session
codex "fix all type errors"  # Start with a prompt
```

### Sign In

Run `codex login` and choose your auth method:

- **UnieAI Studio** — device code flow (default)
- **ChatGPT** — sign in with your ChatGPT account (Plus / Pro / Business)
- **API Key** — use an API key directly
- **Access Token** — use an access token

For enterprise deployments, set `UNIEAI_STUDIO_URL` or use `--unieai-studio-url` to specify your on-prem Studio endpoint. The inference gateway is auto-derived (e.g. `studio.` → `api.`) or can be manually configured.

---

## Commands

### Interactive Session

```shell
codex [OPTIONS] [PROMPT]
```

Launches the interactive TUI. Supports `--approval-policy`, `--search`, `--no-alt-screen`, and more.

### Session Management

| Command | Description |
|---------|-------------|
| `codex resume` | Resume a previous session (picker or `--last`) |
| `codex fork` | Fork a previous session (picker or `--last`) |
| `codex archive` | Archive a saved session |
| `codex delete` | Permanently delete a session |
| `codex unarchive` | Restore an archived session |

### Non-Interactive Mode

| Command | Description |
|---------|-------------|
| `codex exec [OPTIONS] PROMPT` | Run agent non-interactively |
| `codex review [OPTIONS] --diff PATH` | Run a code review non-interactively |
| `codex apply` | Apply the latest diff from a Codex session as `git apply` |

### Authentication

| Command | Description |
|---------|-------------|
| `codex login` | Sign in (UnieAI Studio / ChatGPT / API Key / Access Token) |
| `codex login --unieai` | Sign in to UnieAI Studio |
| `codex login --chatgpt` | Sign in with ChatGPT |
| `codex login --api-key` | Sign in with API key |
| `codex login --access-token` | Sign in with access token |
| `codex login --device-code` | Sign in via device code |
| `codex logout` | Remove stored credentials |
| `codex login --status` | Check current login status |

### Tooling

| Command | Description |
|---------|-------------|
| `codex mcp` | Manage external MCP servers |
| `codex mcp-server` | Run Codex as an MCP server (stdio) |
| `codex plugin` | Manage Codex plugins |
| `codex doctor` | Diagnose local installation, config, auth, and runtime health |
| `codex update` | Update to the latest version |
| `codex completion` | Generate shell completion scripts |
| `codex sandbox` | Run commands in a Codex-provided sandbox |
| `codex app-server` | Run the app server (experimental) |
| `codex remote-control` | Manage app-server daemon with remote control |
| `codex cloud` | Browse and apply changes from Codex Cloud |

---

## Desktop App

Launch the native desktop app from the CLI:

```shell
codex app [PATH]
```

Opens the Codex Desktop (macOS / Windows) in the specified workspace directory. The app installer is downloaded automatically if missing.

---

## Configuration

Config is managed via `~/.codex/config.toml` (or `$CODEX_CONFIG_DIR/config.toml`).

See [Config Reference](./docs/config.md) for all available options, including:

- `approval-policy` — when to request human approval
- `sandbox` — sandbox configuration
- `exec-policy` — execution policy settings
- `skills` — skill configuration
- `mcp` — MCP server configuration
- Model and provider settings

Run `codex doctor` to diagnose config issues.

---

## Contributing

See [docs/contributing.md](./docs/contributing.md) for development setup, build instructions, and contribution guidelines.

### Building from Source

This is a Rust project managed with Bazel. See [docs/install.md](./docs/install.md) for detailed build instructions.

---

## Docs

| Doc | Link |
|-----|------|
| Getting Started | [docs/getting-started.md](./docs/getting-started.md) |
| Installing & Building | [docs/install.md](./docs/install.md) |
| Configuration | [docs/config.md](./docs/config.md) |
| Authentication | [docs/authentication.md](./docs/authentication.md) |
| Execution Policy | [docs/execpolicy.md](./docs/execpolicy.md) |
| Skills | [docs/skills.md](./docs/skills.md) |
| Slash Commands | [docs/slash_commands.md](./docs/slash_commands.md) |
| Contributing | [docs/contributing.md](./docs/contributing.md) |
| Open Source Fund | [docs/open-source-fund.md](./docs/open-source-fund.md) |

---

## Repository Structure

```
├── codex-cli/          # npm package and CLI entrypoint
├── codex-rs/           # Rust crates (main codebase)
│   ├── cli/            # CLI binary and subcommands
│   ├── tui/            # Terminal UI (TUI) implementation
│   ├── core/           # Core agent logic
│   ├── app-server/     # App server backend
│   ├── config/         # Configuration management
│   ├── skills/         # Skills system
│   ├── hooks/          # Hook system
│   ├── memories/       # Memory system
│   ├── plugin/         # Plugin system
│   ├── exec/           # Non-interactive execution
│   ├── login/          # Authentication
│   ├── tools/          # Tool implementations
│   ├── sandboxing/     # Sandboxing
│   └── ...
├── sdk/                # Python and TypeScript SDKs
├── docs/               # Documentation
└── scripts/            # Build and release scripts
```

---

## License

This repository is licensed under the [Apache-2.0 License](LICENSE).
