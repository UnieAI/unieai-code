# UnieAI Code for VS Code

Launch the UnieAI Code agent in a VS Code terminal, right next to your editor.

## Features

- **Open UnieAI Code** (`cmd+escape` / `ctrl+escape`): opens the `unieai` TUI in a split terminal (focuses the existing one if already open).
- **Open in new tab** (`cmd+shift+escape`): always opens a fresh terminal.
- **Insert At-Mentioned** (`cmd+alt+k`): types the active file (and selected line range) into the composer as `@path#L1-L2`.
- Editor-title button to launch UnieAI Code from any file.

## Requirements

The `unieai` CLI must be installed and on your PATH (or set `unieai-code.executablePath`):

```sh
curl -fsSL https://raw.githubusercontent.com/UnieAI/Unieai-Code-Publish/main/install.sh | sh
```

Sign in with `unieai login` (UnieAI Studio), or just launch — the onboarding flow will walk you through it.

## Settings

- `unieai-code.executablePath` — path to the `unieai` binary (default: `unieai`).
