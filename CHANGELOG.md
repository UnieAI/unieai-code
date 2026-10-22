<!--
How to keep this file up to date (UnieAI Code release step)

1. Before tagging, draft the new section from our own commits since the
   last release tag (upstream Codex commits are left out):

       python3 scripts/unieai_changelog_draft.py --version 0.0.38

2. Rewrite the draft for users (not as commit subjects), merge related
   commits into one bullet, drop internal refactors / tests / CI noise,
   and paste it at the top as "## <version> — <YYYY-MM-DD>".
   If the release merges upstream Codex, add one line
   "Merged upstream Codex through <commit> (<date>)" instead of listing
   upstream's commits.
3. Update the "What's new" list in README.md to the new version's highlights.
4. Commit, then push the `npm-v<version>` tag. The npm-release workflow fails
   at its first job if this file has no "## <version>" heading.

Groups, in this order, only the ones a release needs:
New, Improved, Fixed, uac engine, Login & models.
-->

# Changelog

What changed in each release of UnieAI Code (`@unieai/code`, the `unieai`
binary), newest first. Releases are the `npm-v*` tags of this repository.

UnieAI Code is a fork of [openai/codex](https://github.com/openai/codex). This
file lists only UnieAI's own changes; when a release brings in upstream Codex,
it says how far. Upstream's own changes are listed on the
[openai/codex releases page](https://github.com/openai/codex/releases).

"uac" is the UnieAI agent engine (unieai-agent-core, on deepseek-harness),
the default since 0.0.28; "codex" is the original engine. Switch with `/engine`.

## 0.0.38 — 2026-10-22

- Merged upstream Codex twice: through
  [`66d0de9983`](https://github.com/openai/codex/commit/66d0de9983) (2026-10-20,
  106 commits) and through
  [`067249a283`](https://github.com/openai/codex/commit/067249a283) (2026-10-21,
  35 commits). Notable: `$` mentions rank by what you picked recently, async
  question prompts render as Markdown, Up recalls the prompt given on the
  command line, `/permissions` holds queued prompts until its menu is open,
  the model list is kept when a refresh fails, and a thread keeps its model
  settings when resumed. The Rust toolchain is now 1.99.1.

### New

- **`/usage` for UnieAI Studio plans.** Without a ChatGPT login, `/usage`
  shows your Studio plan: the 5-hour and weekly windows (% used and when they
  reset), extra usage with a switch that asks before it bills API credits,
  credit grants and when they expire, and your wallet with its monthly limit,
  plus Manage plan and Top up credits links. Plan usage also feeds `/status`,
  the composer's usage notice and the 5-hour / weekly status-line items, on
  both engines. Studio spends grants first, then the plan windows, then (with
  extra usage on) the wallet.
- **`/tasks`** (also `/ps`) lists subagents and commands left running in the
  background, with status, run time, tokens, model and last action. Open one
  to see its transcript or recent output, or stop it.
- **Remote Control (uac, preview).** `/remote-control` and
  `unieai remote-control [start|stop|devices|revoke]` show a pairing link and
  QR code so a browser can follow a session, send prompts, answer approvals
  and questions, and interrupt. The connection is end-to-end encrypted: the
  relay only passes ciphertext. While it runs, the status line shows
  "Remote: N viewers". UnieAI's hosted relay is not live yet, and
  `/remote-control` says so. Until it is, Remote Control needs a relay you
  run yourself: `unieai remote-control start --relay <URL>`, or set
  `UNIEAI_REMOTE_RELAY_URL`.
- **Artifacts (uac, preview).** The agent can publish a web page to your
  UnieAI Rabi gallery with `publish_artifact`, and update the same page in
  place when it publishes from the same path again. A bundled artifact skill
  tells it how. `unieai artifact list | open | delete | publish | set` does
  the same from the shell. Artifacts need a Rabi sign-in, and depend on
  Rabi's Artifacts service, which is still rolling out.

### Improved

- The agent tree under the composer shows only live work: running
  subagents, ones waiting on you, failed ones you have not seen, and commands
  still running. Finished work moves to `/tasks`, and a dim
  "N done · /tasks" line counts it. `[tui] agent_tree_show_finished = true`
  brings back the old panel.
- In the agent tree, `o`/Enter opens a subagent or background command, `x`
  stops it after asking, and F6 focuses the tree. Rows show each agent's
  model.
- Commands UnieAI Code cannot serve yet now say "coming soon" instead of
  failing or disappearing: `/app`, `/voice` and `/apps` (unless the provider
  is OpenAI's), `/feedback` without a `[feedback] webhook_url`; and on uac
  `/review`, `/side`, `/btw`, `/memories`, `/plan`, `/hooks`, `/plugins` and
  `/approve`. They are marked "(coming soon)" in the `/` popup.
- `/status` shows a Studio wallet as available credits.

### Fixed

- uac no longer fails every turn with "ACP agent closed the connection" on
  Node 23, Node 22 before 22.18 or Node 24 before 24.2. The engine now starts
  on those versions.
- When the uac engine dies at startup, the error now says how (exit code or
  signal). On macOS, a kill at startup comes with the `xattr` command that
  clears the download quarantine.
- Plan-limit and billing refusals from the UnieAI gateway (out of balance,
  wallet monthly limit, plan window used up) now say what to do (top up,
  raise the limit, or turn on extra usage in `/usage`, with the reset time)
  and are no longer retried. This applies on both engines.

### uac engine

- Several clients can watch one thread: every client gets its updates,
  approvals and questions go to all of them with the first answer winning,
  and a second TUI on the same thread no longer takes over the first one's
  approvals and tools.
- Subagents can be stopped. Commands left running are reported as
  background terminals that can be listed, read and stopped. Each subagent
  reports its own token usage.

### Login & models

- The sign-in screen lists **UnieAI Rabi first**, then UnieAI Studio, your
  company's Studio, and **Connect a model API**.
- **Connect a model API** works without a UnieAI account. Pick OpenAI,
  OpenRouter, DeepSeek, Groq, Together, Mistral, Gemini, a local Ollama or
  LM Studio, or a custom URL (vLLM and other OpenAI-compatible servers).
  Enter the key (cloud presets need one), then filter the models the
  server lists and save. `/model` labels them by provider. From the shell:
  `unieai login --api <PRESET|URL>`, `unieai login api list|remove`. These
  models run on uac; the OpenAI preset also runs on codex.

## 0.0.37 — 2026-10-20

### Improved

- The welcome logo now settles on the UnieAI bunny; each click turns it
  through `>_` to the other UnieAI mark.

### uac engine

- `create_worktree` is available on uac (except in minimal mode). Once a
  session moves into a worktree, shell commands, edits, `apply_patch` and
  `describe_image` work in that directory, and rewind snapshots and restores
  every directory a turn worked in.

## 0.0.36 — 2026-10-20

### New

- **Rewind with files (uac).** Pressing Esc Esc to go back to an earlier
  message now shows which files the removed turns changed, and offers
  "Restore code and conversation", "Restore conversation only" or "Never mind".
  Checkpoints cover changes made by shell commands too. They are stored
  outside your repository.
- **`/context` (uac)** shows what is filling the context window: system
  prompt, tool definitions (built-in, MCP, client), AGENTS.md, skills,
  messages, tool results, compaction summary and free space. It also shows
  the point where compaction starts. It works during a turn.
- **`/loop` and scheduled turns (uac).** `/loop [interval] <prompt>` repeats a
  prompt, `/loop` lists loops and `/loop stop` ends them. A scheduled turn
  shows the prompt you typed as its message.
- **Custom subagents (uac).** Markdown agent definitions in
  `.unieai/agents/*.md` or `~/.unieai/agents/*.md` (`.claude/agents` is read
  too) give a name, a description, optional tools and model, and the prompt
  as the body. The subagent tool offers them as `agent`.
- **Auto approval (uac).** "Approve for me" in `/permissions` turns on auto
  mode: a reviewer model answers the session's approval requests and only
  risky ones reach you. `UNIEAI_AUTO_APPROVAL_MODEL` picks a cheaper
  reviewer model.
- **Background commands report their exit (uac).** When a shell session left
  running in the background exits, the model gets its exit code and unread
  output. If a turn would end while its own build is still running, it waits
  for the build and continues with the result.

### Improved

- The welcome and onboarding animation now turns `>_` into the UnieAI mark
  instead of the OpenAI blossom.

### Fixed

- Opening UnieAI Code from a newer release no longer kills turns that an
  older uac server is running in another terminal. The old server hands
  over its socket, keeps serving its clients and exits when the last one
  leaves.
- Two sessions opened at the same time no longer leave one of them without
  its tools, such as the peer tools.
- Reading another session's thread (`wait_threads`, `read_thread`, `/context`,
  the rewind preview) no longer takes over that session's tool calls and
  approvals.
- Rewind no longer fails with "thread history changed" or cuts the wrong
  turn after `/loop`, scheduled turns, `!command` or `/compact`.
- Session mesh: hop count and turn budget now belong to one conversation,
  so a session that answers many peers no longer ends up unable to reply. A
  peer handle keeps working after that session gets a title.

## 0.0.35 — 2026-10-19

- Merged upstream Codex through
  [`ce0323f2f2`](https://github.com/openai/codex/commit/ce0323f2f2) (2026-10-17).

### New

- **`unieai peers mcp`** lets Claude Code, or any MCP client, talk to the
  UnieAI Code sessions on this machine:
  `claude mcp add unieai-peers -- unieai peers mcp`. Its tools are
  `list_peers`, `send_message`, `wait_for_messages` and `read_messages`. The
  session mesh's permission rules apply to it.

### Improved

- Conversations between sessions now go past the first reply:
  - the hop limit is 10, and a message at the limit is queued instead of lost;
  - a peer can start 5 turns in a row;
  - quick follow-ups are paced instead of left waiting;
  - delivery waits up to 30 s for a uac recipient.
- A reply to a question your session asked is no longer held for your
  approval, even when your session has broader permissions than the peer.
- The 👍/👎 feedback picker no longer opens by itself after a turn.
  `/feedback` still opens it.

### uac engine

- Before a turn ends, the model reviews any todo items still open.

### Fixed

- On the codex engine, a session no longer appears several times in the
  peer list after `/new` or a thread switch.

## 0.0.34 — 2026-10-17

### New

- **Offline install bundles.** Each GitHub Release now has one archive per
  platform. It holds the installed package, the uac engine's dependencies
  and Node.js 22, plus `install.sh` / `install.ps1` and a SHA256SUMS file.
  Use it on machines with no network or no Node.

### uac engine

- Moved to deepseek-harness 0.2.1-rc.2. Web search and `describe_image` now
  also start where no credentials file exists.
- Edits are no longer refused as "stale" after a shell command read or
  changed the file. `apply_patch` matches against the file as it is now. In a
  test run these refusals were 11 of 13 failed edits.
- A message you send while the agent works now tells the model to weigh it
  against the work in hand and add it to the todo list, instead of dropping
  the step in progress.

## 0.0.33 — 2026-09-21

### Fixed

- Upgrading from an older release no longer drops the session to the codex
  engine with "a uac server from another version is running". The new
  server takes over.
- `wait_agents` no longer holds the session for up to ten minutes on
  subagents that have already finished. Waits now last one minute by default
  and three at most.
- Finished subagents leave the panel under the composer. They are still
  listed in the agents overview.

## 0.0.32 — 2026-09-20

### Improved

- The todo list and agent rows now sit under the composer, so they stay in
  place while the turn's output scrolls.

### Fixed

- A message sent just as a turn ends no longer closes the session. On uac it
  becomes a turn of its own. If a steer fails for any other reason, the text
  stays in the composer.
- On uac, interrupting a turn always ends it. Before, every later message
  could be refused for the rest of the session.

### uac engine

- New working rules for the agent, based on benchmark failure modes. They are
  off by default until scored; `UNIEAI_PERSONA_RIGOR=1` turns them on.

## 0.0.31 — 2026-09-20

### Improved

- Hints name the binary you have (`unieai resume`), and `/status` names the
  engine running the session.
- A finished checklist leaves the panel once every item is ticked. The
  transcript keeps the record.

### Fixed

- Hosted sign-in opens the browser again.
- Messages typed during a turn no longer get stuck under "Messages to be
  submitted after next tool call". Any left over when the turn ends go back
  to the composer.
- On uac, one `/permissions` change no longer blocks switching tasks,
  forking, `/cd` or later permission changes.
- uac reports the engine's real error detail instead of "Internal error".
- Intel Macs: 0.0.30 shipped without its darwin-x64 package. A release now
  fails if any package it published is missing from the registry.

### Login & models

- Signing in to Rabi no longer revokes the UnieAI Agent Desktop app's key,
  and the app no longer revokes ours. The key is now named "UnieAI Code".
- Studio custom models (agents in their own right) no longer appear in the
  model menu.

## 0.0.30 — 2026-09-20

### uac engine

- Peers work on uac. A peer's message is shown once, as a peer message, not
  as your own prompt.
- The agent row shows how full the context is, and automatic compaction
  shows as "Compacting context".
- A message typed during a turn the engine started itself (a goal round, a
  subagent result) is delivered instead of staying pending.
- Messages sent during a turn now carry their images. Image notes name
  their `[Image #N]` placeholder.
- After an update, a uac server left running by the previous release is
  replaced instead of reused.

## 0.0.29 — 2026-09-19

### New

- The update prompt works: it reads the latest release from npm, and after
  "Update now" UnieAI Code restarts on the new version.
- The sign-in screen appears when there are no UnieAI credentials, instead of
  starting a session whose requests all fail.

### uac engine

- `/model`, `/permissions`, `-s` / `-a`, `!command` and `/cd` work on uac
  threads, and token usage is reported in `/status` and the context meter.
- MCP servers from `config.toml` reach the model. So does UnieAI Studio's
  MCP server for your account, with knowledge-base search, SQL connections
  and Studio skills. `UNIEAI_STUDIO_MCP=0` turns Studio's server off.
- Subagents are agent threads you can open with Alt+Left / Alt+Right, as on
  codex. The model's todo list is the plan checklist, and `/goal` works.
  Turns the engine starts on its own are shown.
- The model can ask you questions (`ask_user_question`) in the question UI.
- A message sent during a turn stays pending until the model takes it, as on
  codex.
- Images from `-i` or a paste reach the model. A text-only model reads them
  through `describe_image`.
- `--oss` / `--local-provider` run on the local model server.
- If the default `node` is older than 22, UnieAI Code finds Node 22+ under
  nvm, fnm, volta, asdf, Homebrew or /usr/local. If there is none, it says
  why and what to install.
- The session-mesh task tools (`publish_task`, `claim_task`, `report_task`,
  `list_tasks`) are available on uac.
- This machine's credentials are redacted from what the model reads.
- Commands uac cannot serve (`/review`, `/side`, `/btw`, `/memories`, `/plan`)
  are hidden on uac, and Shift+Tab opens the engine picker there.
- Harness fixes from benchmark failures, such as services that must outlive
  the agent and a half-time reminder to produce a working result.

## 0.0.28 — 2026-09-18

- Merged upstream Codex through
  [`2833985d88`](https://github.com/openai/codex/commit/2833985d88) (2026-09-17).

### New

- uac is the default engine. `/engine` lists one uac entry per mode
  (standard, ptc, cordis, minimal), and `/engine ptc` also works.
- Project config, skills, rules, agents and hooks live in `.unieai/`. A
  project with only `.codex/` keeps working, and a warning appears when both
  exist.
- Session mesh is on by default: sessions on one machine can message each
  other. A message to a session with broader permissions waits for its
  user's approval.

### uac engine

- uac now looks like codex in the TUI: text between tool calls, "Explored"
  groups for reads and searches, and exit codes on command cards. Sessions
  get titles.
- Web search, `describe_image` for text-only models, and `wait_agents`.
- Codex's strengths were ported into the engine as UnieAI plugins:
  `exec_command` / `write_stdin`, fuzzy edit rescue, `apply_patch`, loop
  guards and context-overflow handling. The plugins come from
  UnieAI/uac-plugins.
- Fixed uac crashing at startup after a global install (0.0.27).

### Login & models

- **UnieAI Rabi login:** `unieai login --rabi`, or the third option on the
  sign-in screen. A Rabi account runs on the uac engine.
- Context windows come from Studio's model registry, with a 128k default.
  When the gateway rejects a turn as too long, the session compacts and
  continues, and the limit is remembered.
- Each model's input types and context window come from the gateway, so
  images are not sent to text-only models.

## 0.0.27 — 2026-09-17

- Merged upstream Codex through
  [`b0659c5386`](https://github.com/openai/codex/commit/b0659c5386) (2026-09-17).

### New

- **`/engine [codex|uac]`** switches to the new uac engine, which ships in
  `@unieai/code` and needs Node.js 22.
- `features.token_budget.auto_compact_retain_tokens` sets how much recent
  history compaction keeps verbatim.

### Fixed

- Sandboxed commands no longer fail with "mountinfo path is not absolute" on
  hosts running Docker or snapd.
- The composer placeholder, the archived-session prompt and the default
  provider are UnieAI's again after the upstream merge.
- The agent tree row goes back to idle when a turn ends.

### Login & models

- The model list stays in sync with your Studio account on every launch.
  `unieai login sync` refreshes it on demand.

## 0.0.26 — 2026-08-28

### Fixed

- The session banner is back to the single `>_ UnieAI Code (vX)` line, and
  `--version` no longer says `codex-cli`.

## Earlier

Releases 0.0.16 – 0.0.25 (`npm-v0.0.16` … `npm-v0.0.25`, July – August 2026)
and the earlier `cli-v*` releases are not written up here. See
`git log npm-v0.0.25` or the tags on GitHub.
