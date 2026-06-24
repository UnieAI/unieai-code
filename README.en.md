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

UnieAI Code is an AI coding CLI integrated with **UnieAI Studio**: sessions, multi-project navigation, branch / Worktree launch, code changes and diffs, permission review, model provider management, and Computer Use — all from the terminal.

<p align="center">
  <a href="#recent-updates">Recent Updates</a> · <a href="#install-the-cli">Install CLI</a> · <a href="#run-the-cli-from-source">From Source</a> · <a href="#more-documentation">More Docs</a>
</p>

---

## Recent Updates

- **npm package ~98% smaller**: publishing used to bundle the entire source tree (`docs/`, `packages/`, tests, …) — about **116 MB / 3200 files**. It now ships only the `bun build`-bundled, minified `dist/` — about **2.2 MB / ~340 files** (still executed by bun at runtime). `dist/` is built automatically during `prepublishOnly`, is in `.gitignore`, and is never committed; local development still runs straight from `src/` so edits take effect immediately.
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
./bin/cli.mjs
```

> Development runs straight from `src/` (edits take effect immediately). On publish, `prepublishOnly` runs `bun run build` to generate `dist/` (gitignored, never committed).

See [environment variables](docs/en/guide/env-vars.md) and [global usage](docs/en/guide/global-usage.md) for more configuration options.

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
| [IM integration](docs/im/) | Chat remotely, switch projects, and approve permissions via Telegram / Feishu / WeChat / DingTalk |
| [Computer Use](docs/en/features/computer-use.md) | Computer control (screenshot, mouse, keyboard) |
| [Global usage](docs/en/guide/global-usage.md) | Launch the CLI from any directory |
| [FAQ](docs/en/guide/faq.md) | Common error troubleshooting |
| [Project structure](docs/en/reference/project-structure.md) | Code directory overview |

---

## Tech Stack

| Category | Technology |
|------|------|
| Language | TypeScript |
| Local runtime | [Bun](https://bun.sh) |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| Protocols | MCP, LSP |

## Acknowledgments

Thanks to the following open-source projects for the foundation and inspiration:

- [React](https://github.com/facebook/react): frontend engineering and component UI ecosystem.
- [opencode](https://github.com/sst/opencode): upstream open-source base.
- [cc-switch](https://github.com/farion1231/cc-switch): model provider configuration reference.
