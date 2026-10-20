<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->
# Artifacts from UnieAI Code (draft for review with ava)

Status: draft, 2026-10-20. Owner of hosting: ava (agent.unieai.com). Owner of the
client tool and skill: unieai-code.

## Goal

The coding agent can publish a page it wrote (a report, dashboard, diagram, small
app) to a private URL, update it in place later, and the user finds it in ava's
gallery (Office ▸ 作品) next to ava's own artifacts.

## What ava already has (reused as is)

- `html_shares` storage (snapshot of the entry HTML + up to 48 dependencies),
  versioned with token + `expectedVersion` CAS, revoke keeps a tombstone.
- Visibility private / org / public; public requires `public_confirmed_at`.
- `artifacts` index (kind `site`), covers in S3.
- Viewer: `<iframe srcDoc sandbox="allow-scripts" credentialless>`; raw files
  served with `CSP: sandbox allow-scripts; default-src 'none'; connect-src 'none'`.
- Limits in `lib/agent-next/html-share-policy.ts` (4 MiB/file, 12 MiB deps,
  48 deps, 16 MiB/share, 20 active shares and 256 MiB per user).

## What ava adds

1. **Scope.** A new API-key scope `artifacts`. Desktop keys minted for the client
   name "UnieAI Code" get it by default; existing keys don't change. It allows
   only the routes below.
2. **Direct upload routes** (bearer key, no Origin required, same guard as
   `htmlShareMutationGuard`):

   | Method | Path | Body | Returns |
   | --- | --- | --- | --- |
   | POST | `/api/agent-next/artifacts/site` | `{title, description?, entry:"index.html", files:[{path, mime?, contentBase64}], visibility:"private"\|"org"}` | `{id, viewerUrl, version}` |
   | PUT | `/api/agent-next/artifacts/:id` | same as POST + `expectedVersion` | `{id, viewerUrl, version}` or 409 with the current version |
   | GET | `/api/agent-next/artifacts?mine=1&source=unieai-code` | – | `[{id, title, url, version, updatedAt}]` (exists; add filters) |
   | GET | `/api/agent-next/artifacts/:id` | – | metadata + files (so the agent can read before it rewrites) |
   | DELETE | `/api/agent-next/artifacts/:id` | – | 204 (revoke, tombstone) |

   - `id` is the index row; `viewerUrl` is `/share/html/<token>` (the token is
     the URL).
   - `html_shares` rows today cascade with an `agent_next_sessions` row; direct
     uploads have no session, so ava gives them their own owner/cascade path
     (implementation detail on ava's side, the API does not change).
   - The server runs the same preflight and limits as html-share and writes the
     same `html_shares` row + `artifacts` index row with `source = "unieai-code"`.
   - `public` is never accepted from the API: making a page public stays a
     confirmation in ava's web UI.
   - Errors are JSON `{error:{code, message}}`, with codes for `too_large`,
     `external_ref` (path of the offending reference), `quota_exceeded`,
     `version_conflict`.
3. **Viewer header (decided 2026-10-20).** A shared or public page is shown under
   a header bar from ava's viewer, as on Claude's published artifacts: the title,
   a one-line description, an icon, the author, and a "Made with UnieAI" mark,
   with ava's own controls (open, copy link, report). The publisher adjusts it:
   the routes accept `header: {title?, description?, icon?, showAuthor?}`, and
   the same fields are editable in ava's web UI. The page's own HTML never draws
   or hides the header; it lives outside the sandboxed iframe.
4. **Decided 2026-10-20:** existing desktop keys do not get `artifacts` (a user
   re-grants); Code artifacts share ava's per-user quota and the 20-active cap is
   raised; inline-only in v1.
5. **Later:** serve raw page bytes from a dedicated usercontent origin; an
   allow-list of CDNs (cdnjs, jsdelivr), which needs both a preflight change and
   a CSP change (raw files are served with `default-src 'none'; connect-src
   'none'`), so it ships together with the usercontent origin.

## What unieai-code adds

- A `publish_artifact` tool (uac plugin; codex engine via the same server
  method): `publish({path | files, title, description, id?})`, `list()`,
  `read(id)`, `delete(id)` (delete only when the user asks). On 409 it reads
  the current version, merges, and retries once.
- `unieai artifact list | open <id> | delete <id>` in the CLI.
- An `artifact` skill that teaches the model:
  - when to publish (a page for others to read or use; not for code that belongs
    in the repo) and to say the link once;
  - one self-contained `index.html`, everything inlined (no external http(s)
    references, per ava's preflight); a 2–4 word `<title>`;
  - colour tokens on `:root` with a dark-mode override, an explicit body
    background, works at phone width with a 16px gutter;
  - size budget under the html-share limits; images as small inline SVG/PNG;
  - update in place: republish with the same id, never a new page for an edit.
- Auth: the Rabi device-grant key (already stored by `unieai login --rabi`).
  A Studio-only user is told to link a Rabi account until single sign-on
  (integration plan, phase 2) lands.

## Client implementation (unieai-code)

Built against an in-memory stub of the routes above
(`agent-runtime/scripts/unieai-ava-artifacts-stub.mjs`) until ava ships them.

- **Tool:** `publish_artifact` (actions `publish | list | read | delete`) is a
  uac host plugin, `agent-runtime/src/unieai-dsh/unieai-artifacts.mjs`, with
  the logic in `unieai-artifacts-core.mjs`. It is not in uac-plugins because
  it reads the UnieAI Code login, which Studio's runtime does not have.
  `UNIEAI_DSH_PLUGINS` must name `unieai-artifacts` when it narrows the set.
- **Engines:** uac only. The tool needs the Rabi key, and a Rabi login already
  runs on uac only (Rabi's relay has no Responses API), so a codex-engine
  session never has a key to publish with. Revisit with Studio single sign-on.
- **Local checks:** the limits above, and external http(s) references in
  HTML, CSS and ESM, each reported with what to inline instead.
- **Conflicts:** a 409 returns the current version to the model; with
  `merge: true` the tool lays its files over the current version's (same path
  wins) and retries once.
- **Id memory:** `$UNIEAI_HOME/artifacts.json`, workspace (git root) → path →
  `{id, account, version, viewerUrl, title}`, shared by the tool and the CLI.
  Not the project's `.unieai/`: ids belong to the account and `.unieai/` is
  checked into repositories.
- **Skill:** `artifact`, bundled in `agent-runtime/src/unieai-dsh/skills/`
  (passed to `unieai-skills` as `bundledSkillDir`, so a user or project skill of
  the same name wins).
- **CLI:** `unieai artifact list | open <id> | delete <id> | publish <path>
  [--title] [--description] [--id] [--force]`
  (`codex-rs/login/src/unieai_artifacts.rs`, `codex-rs/cli/src/unieai_artifact.rs`).

## Open questions

1. Should the `artifacts` scope also be granted to existing "UnieAI Agent
   Desktop" keys?
2. Per-user quota of 20 active shares: do Code artifacts count against the same
   quota, or get their own?
3. Is `org` visibility allowed from the API, or only private?
4. Do we want the CDN allow-list in v1 (many generated pages use chart libs), or
   inline-only first?
