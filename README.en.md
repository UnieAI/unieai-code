# UnieAI Code

<p align="center">
  <img src="docs/images/app-icon.png" alt="UnieAI Code" width="240">
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/UnieAI/unieai-code?style=social)](https://github.com/UnieAI/unieai-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/UnieAI/unieai-code)](https://github.com/UnieAI/unieai-code/issues)
[![npm](https://img.shields.io/npm/v/@unieai/code)](https://www.npmjs.com/package/@unieai/code)
[![中文](https://img.shields.io/badge/🇨🇳_中文-Available-blue)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Current-green)](README.en.md)

</div>

UnieAI Code is an AI coding workspace integrated with **UnieAI Studio**: sessions, multi-project navigation, branch / Worktree launch, right-side file changes, code diffs, permission review, model providers, Computer Use, H5 remote access, IM integration, and scheduled tasks in one macOS / Windows app — plus a CLI built from the same source.

<p align="center">
  <a href="#recent-updates">Recent Updates</a> · <a href="#install-the-cli">Install CLI</a> · <a href="#desktop-preview">Desktop Preview</a> · <a href="#install-the-desktop-app">Install Desktop</a> · <a href="#more-documentation">More Docs</a>
</p>

---

## Recent Updates

- **npm package ~98% smaller**: publishing used to bundle the entire source tree (`docs/`, `desktop/`, `packages/`, tests, …) — about **116 MB / 3200 files**. It now ships only the `bun build`-bundled, minified `dist/` — about **2.2 MB / ~340 files** (still executed by bun at runtime). `dist/` is built automatically during `prepublishOnly`, is in `.gitignore`, and is never committed; local development still runs straight from `src/` so edits take effect immediately.
- **Enterprise / on-prem UnieAI Studio integration**: sign in to the cloud or a company-hosted Studio. The inference gateway can be auto-derived from the Studio URL, typed in at login, or overridden with `UNIEAI_GATEWAY_URL` — fixing the case where on-prem login succeeded but API calls failed to route. See [Install the CLI](#install-the-cli).

---

## Install the CLI

`@unieai/code` runs on the [Bun](https://bun.sh) runtime, so make sure bun is installed and on your PATH.

```bash
# Install / upgrade to the latest version
npm install -g @unieai/code

# Verify
unieai --version
```

Run `unieai` to start an interactive session. To reinstall or pin a version:

```bash
npm uninstall -g @unieai/code
npm install -g @unieai/code@latest
```

> The npm package ships only the bundled `dist/` (~2 MB; the JS is still executed by bun) instead of the full source tree.

### Sign in to UnieAI Studio

On first launch you'll be asked to sign in:

- **UnieAI Studio**: use your cloud account (`https://studio.unieai.com`).
- **Company UnieAI Studio**: enter your enterprise / on-prem Studio URL (e.g. `https://studio.demo.unieai.com`).

Enterprise / on-prem deployments often serve inference from a different host than the login URL, so the login flow has an **optional** "Inference gateway URL" step:

- Leave it blank → auto-derived from the Studio URL (`studio.` → `api.`).
- Or type the gateway URL (it usually ends in `/v1`).

You can also override it with an environment variable (it applies to already-logged-in sessions too, no re-login needed):

```bash
export UNIEAI_GATEWAY_URL="https://api.your-company.com/v1"
```

## Run the CLI from Source

For users who want to debug the underlying CLI, server, or local development flow:

```bash
bun install
cp .env.example .env
./bin/claude-haha
```

> Development runs straight from `src/` (edits take effect immediately). On publish, `prepublishOnly` runs `bun run build` to generate `dist/` (gitignored, never committed).

See [environment variables](docs/en/guide/env-vars.md) and [global usage](docs/en/guide/global-usage.md) for more configuration options.

---

## Desktop Preview

The UnieAI Code desktop app brings sessions, multi-project navigation, branch / Worktree controls, right-side file changes, code diffs, permission review, provider setup, and remote access into one graphical workspace for daily development flows beyond the terminal.

<p align="center">
  <a href="https://github.com/UnieAI/unieai-code/releases"><img src="https://img.shields.io/badge/⬇_Download_Desktop-macOS_%7C_Windows-FF7A00?style=for-the-badge" alt="Download Desktop"></a>
  &nbsp;
  <a href="docs/desktop/04-installation.md"><img src="https://img.shields.io/badge/📖_Install_Guide-Guide-gray?style=for-the-badge" alt="Install Guide"></a>
</p>

<table>
  <tr>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/10_desktop_workspace.png" alt="Desktop workspace"><br><b>Desktop Workspace</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/13_workspace_changes_worktree.png" alt="Right-side changes and Worktree"><br><b>Right-side Changes & Worktree</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/02_edit_code.png" alt="Code editing"><br><b>Code Editing & Diff View</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/03_ask_question_and_permission.png" alt="Permission control"><br><b>Permission Review & AI Questions</b></td>
  </tr>
  <tr>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/12_h5_access.png" alt="H5 remote access"><br><b>H5 Remote Access</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/11_token_usage.png" alt="Token usage"><br><b>Token Usage</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/06_settings_computer_use.png" alt="Computer Use"><br><b>Computer Use</b></td>
    <td align="center" width="25%"><img src="docs/images/desktop_ui/08_scheduled_task.png" alt="Scheduled tasks"><br><b>Scheduled Tasks</b></td>
  </tr>
</table>

---

## Install the Desktop App

1. Download the macOS or Windows desktop installer from [Releases](https://github.com/UnieAI/unieai-code/releases).
2. On first launch, sign in to UnieAI Studio or configure your model provider, API key, and default model in Settings.
3. If macOS blocks the app on first open, follow the [desktop installation guide](docs/desktop/04-installation.md) for Gatekeeper steps.

---

## Desktop Highlights

- **Multi-session workspace**: tabs, project switching, terminal entry, and session history in one place.
- **Branch / Worktree launch**: new sessions can pick a repo branch and choose the current working tree or an isolated Worktree.
- **Right-side changes panel**: view changed files, added/removed lines, and workspace status while chatting.
- **Visualized code edits**: inspect the AI's file edits, diffs, and execution steps directly.
- **Permission & confirmation flow**: review dangerous commands, tool calls, and AI questions in one place.
- **Multiple model providers**: UnieAI Studio, Anthropic-compatible APIs, third-party models, and local config.
- **Computer Use**: let the agent screenshot, click, type, and control desktop apps once authorized.
- **H5 remote access**: join the current desktop session from a phone or another device with a one-time token.
- **IM integration**: chat remotely, switch projects, and approve permissions via Telegram / Feishu / WeChat / DingTalk.
- **Scheduled tasks & usage stats**: create scheduled tasks and track local token usage trends.

---

## More Documentation

| Doc | Description |
|------|------|
| [Environment variables](docs/en/guide/env-vars.md) | Full environment variable reference |
| [Third-party models](docs/en/guide/third-party-models.md) | Connect OpenAI / DeepSeek / Ollama and other non-Anthropic models |
| [Contributing & quality gates](docs/en/guide/contributing.md) | Local testing, live-model baselines, PR and release gates |
| [Memory system](docs/en/memory/01-usage-guide.md) | Cross-session persistent memory |
| [Multi-agent system](docs/en/agent/01-usage-guide.md) | Multi-agent orchestration, parallel tasks, and Teams |
| [Skills system](docs/en/skills/01-usage-guide.md) | Extensible capability plugins and custom workflows |
| [Computer Use](docs/en/features/computer-use.md) | Desktop control (screenshot, mouse, keyboard) |
| [Desktop](docs/desktop/) | Tauri 2 + React client — [quick start](docs/desktop/01-quick-start.md) \| [architecture](docs/desktop/02-architecture.md) \| [install guide](docs/desktop/04-installation.md) |
| [Global usage](docs/en/guide/global-usage.md) | Launch the CLI from any directory |
| [FAQ](docs/en/guide/faq.md) | Common error troubleshooting |
| [Project structure](docs/en/reference/project-structure.md) | Code directory overview |

---

## Tech Stack

| Category | Technology |
|------|------|
| Language | TypeScript |
| Desktop app | Tauri 2 |
| Desktop UI | React + Vite |
| Local runtime | [Bun](https://bun.sh) |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| Protocols | MCP, LSP |

## Acknowledgments

Thanks to the following open-source projects for the foundation and inspiration:

- [React](https://github.com/facebook/react): frontend engineering and component UI ecosystem.
- [Tauri](https://github.com/tauri-apps/tauri): cross-platform desktop app capabilities.
- [opencode](https://github.com/sst/opencode): upstream open-source base.
- [cc-switch](https://github.com/farion1231/cc-switch): model provider configuration reference.
