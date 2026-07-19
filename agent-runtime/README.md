# @unieai/code-agent-runtime

The coding engine behind **UnieAI Code** — a lightweight agent runtime that turns
an OpenAI-compatible model gateway into a capable coding agent.

It drives one conversation on the [`@unieai/agent-core`](../third_party/unieai-agent-core)
loop and adds the coding layer on top: sandboxed shell / file tools, a completion
contract that verifies work before finishing, fuzzy-matching edits, and session
persistence. The same runtime powers the TUI and the VS Code extension.

## What it does

- **Real repo work, not just codegen.** The agent explores with `bash`/`read`,
  edits with fuzzy-matching `edit`/`write`, and verifies its own changes before
  declaring done.
- **Works with open models.** Built for gateways serving Qwen / MiniMax / GLM and
  friends — with empty-response resampling, `<think>` stripping, stall detection,
  and torn-history repair so open-model quirks don't derail a turn.
- **Verification built into the tools.** After a Python edit the tool itself
  reports a syntax check and flags un-fixed sibling code paths, at the moment of
  the edit — not as an afterthought.

On SWE-bench Lite (300 issues, pass@1, Qwen3.6-35B-A3B) this took resolved rate
from 27.7% to **46.0%** over a few iterations, while staying ~2× cheaper per task
than a stock codex harness. See [`benchmarks/RESULTS.md`](../benchmarks/RESULTS.md).

## Quick start

```js
import { createEngine } from "@unieai/code-agent-runtime";

const engine = createEngine({
  workspace: process.cwd(),
  model: "Qwen3.6-35B-A3B",
  expectsMutation: true,               // action turn → completion contract on
  onText: (d) => process.stdout.write(d),
  requestApproval: async () => "accept",
});

await engine.send("Fix the failing test in src/parser.js");
```

Requires a signed-in UnieAI gateway (`unieai login`) — credentials are read from
`~/.unieai/unieai.json`. Node ≥ 20.

## Layout

- `src/engine.mjs` — one conversation on the agent-core loop; coding identity,
  completion contract, tool wiring.
- `src/tools.mjs` — bash / read / write / edit (sandboxed; smart-verifying edits).
- `src/session.mjs`, `src/config.mjs` — session persistence and gateway credentials.
- `bin/tui.mjs` — the slim terminal UI.

The generic agent loop lives in `@unieai/agent-core` (git submodule); coding-specific
mechanisms live here. Versioning is `ucX.Y.Z-acA.B.C` — this package's version
paired with the agent-core version it runs on.
