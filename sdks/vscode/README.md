# UnieAI Code for VS Code

Chat with the UnieAI coding agent in a panel next to your editor — it reads your
workspace, runs commands, and edits files, powered by the same engine as the CLI.

## Features

- **Chat panel** in the activity bar: ask for a fix, a refactor, an explanation —
  the agent explores your repo and makes the changes, streaming its work as it goes.
- **Runs on your models.** Uses your UnieAI Studio gateway (Qwen / MiniMax / GLM
  and other open models), no separate account needed.
- **Approvals & sandbox.** Shell commands run sandboxed; anything riskier asks first.
- **At-mention the current file** (`cmd+alt+k` / `ctrl+alt+k`): drops the active
  file and selected lines into the composer as `@path#L1-L2`.

## Getting started

1. Install the extension.
2. Sign in to UnieAI Studio when prompted (device-code flow), or run `unieai login`
   in a terminal.
3. Open the **UnieAI Code** panel from the activity bar and start chatting.

## Settings

- `unieai-code.executablePath` — path to the `unieai` binary, used for the sandbox
  (default: `unieai`). Install it with:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/UnieAI/Unieai-Code-Publish/main/install.sh | sh
  ```

Built on [`@unieai/code-agent-runtime`](https://github.com/UnieAI/unieai-code/tree/main/agent-runtime).
