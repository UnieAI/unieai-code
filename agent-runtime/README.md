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
- `bin/app-server.mjs` — serves the CLI's app-server protocol from this engine.
- `bin/uac-app-server.mjs`, `src/dsh/` — the `uac` engine (see below).

## `/engine`: codex or unieai-agent-core (uac)

In the `unieai` TUI, `/engine` (or `/engine codex|uac`) picks the engine for new
sessions and relaunches onto it. The choice is saved in `$CODEX_HOME/engine`;
`UNIEAI_ENGINE=codex|uac` overrides it for one launch.

`uac` runs deepseek-harness (`dsh --profile acp`) behind `bin/uac-app-server.mjs`:
engine methods drive dsh over the Agent Client Protocol, everything else is
forwarded to the Rust app-server. The TUI starts it detached on
`$CODEX_HOME/uac/app-server.sock` (log: `$CODEX_HOME/uac/server.log`) and falls
back to codex if it cannot start.

- dsh is the pinned `@deepseek-ai/dsh` dependency (override with
  `UNIEAI_DSH_BIN`: its `bin.js` or an executable).
- dsh gets a private home, `$CODEX_HOME/uac/dsh-home`. Its `settings.yaml` and
  `.credentials.yaml` are rewritten from `unieai.json` before each new thread.
- Models follow the Studio account: every TUI launch (and `unieai login sync`)
  refreshes `unieai.json` from Studio's `/api/config`.
- ACP covers prompting and cancelling. Everything else runs through
  `src/dsh/uac-control.mjs`, a plugin loaded into dsh that listens on a private
  socket next to the app-server's: steering a running turn, manual compaction,
  history (for resume and the transcript), and fork at a turn boundary (thread
  fork, and prompt edit / `thread/revert` as fork-minus-later-turns).
- uac threads are indexed in `$CODEX_HOME/uac/threads.json` (ids, titles, the
  dsh session behind each), so `/resume`, rename and archive work across
  restarts. Conversation content stays in dsh's session log.
- Not supported: `review/start` and thread goals. Approvals are per call;
  "allow for session" is remembered per tool by the bridge.
