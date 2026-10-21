<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->
# Artifacts from UnieAI Code

Status: ava's API is built (ava commit 26d9e43e2, not deployed yet); the
client is built against it and an in-memory stub. Owner of hosting: ava
(agent.unieai.com). Owner of the client tool and skill: unieai-code.

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
- Preflight and limits in `lib/agent-next/html-share-policy.ts`. Its preflight
  already accepts references to jsdelivr, unpkg, cdnjs and Google Fonts and
  refuses every other external reference.

## The API (ava commit 26d9e43e2)

All routes are under `/api/agent-next/artifacts`, take a bearer desktop key
with the `artifacts` scope, and answer errors as `{error:{code, message, …}}`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/site` | `{title, description?, entry?="index.html", files:[{path, mime?, contentBase64}], visibility?="private"\|"org", orgId?, header?:{title?, description?, icon?, showAuthor?}}` | 201 `{id, viewerUrl, version}` |
| PUT | `/:id` | same as POST + `expectedVersion` | `{id, viewerUrl, version}`; 409 `{error:{code:"version_conflict", currentVersion}}`; 409 `not_uploadable` for a page published from an ava chat |
| PATCH | `/:id` | `{visibility?, orgId?, header?}` | visibility and header only (`public` is never accepted from a key) |
| GET | `/:id` | – | owner only: `{id, kind, source, origin, title, description, visibility, version, viewerUrl, entry, header, createdAt, updatedAt, files:[{path, mime, size, sha256, contentBase64}]}` |
| DELETE | `/:id[?expectedVersion=n]` | – | 204 (tombstone) |
| GET | `?mine=1&source=unieai-code` | – | `{mine:[…], org:[…], usage, limits}`, items `{id, title, url, viewerUrl, version, updatedAt, source}` |

- The client's `mime` is ignored: the file extension decides it.
- PUT without `visibility` keeps the current one; without `header` leaves it
  unchanged; `header: null` clears it.
- `header.showAuthor` defaults to false. The viewer draws the header (title,
  description, icon, author, "Made with UnieAI", ava's controls) outside the
  sandboxed iframe; the page's HTML never draws or hides it.
- **Org visibility:** `orgId` is optional. A user in exactly one org gets that
  org; a user in several gets 403 `org_required` (the client asks which org);
  an org they are not in gives 403 `org_forbidden`.
- **Errors:** `too_large` 413 (may include `path`), `external_ref` 422 (`path`,
  `reference`, `issues`), `preflight_failed` 422, `quota_exceeded` 429,
  `version_conflict` 409, `not_found` 404, `not_uploadable` 409,
  `org_required` / `org_forbidden` 403.
- **Scope:** device grants with the client name "UnieAI Code" get `artifacts`
  by default; other existing keys don't. A key without it gets 403, and the
  user is told to run `unieai login --rabi` again.
- **Limits:** 4 MiB per file, 12 MiB and 48 files besides the entry, 16 MiB per
  share, an upload body of at most 23 MiB; per user 100 active shares (shared
  with pages published from ava chats) and 256 MiB.
- **Later (ava):** serve raw page bytes from a dedicated usercontent origin.

## What unieai-code adds

Built against the API above and an in-memory stub of it
(`agent-runtime/scripts/unieai-ava-artifacts-stub.mjs`) until it is deployed.

- **Tool:** `publish_artifact` (actions `publish | update_settings | list |
  read | delete`; delete only when the user asks) is a uac host plugin,
  `agent-runtime/src/unieai-dsh/unieai-artifacts.mjs`, with the logic in
  `unieai-artifacts-core.mjs`. It is not in uac-plugins because it reads the
  UnieAI Code login, which Studio's runtime does not have.
  `UNIEAI_DSH_PLUGINS` must name `unieai-artifacts` when it narrows the set.
- **Engines:** uac only. The tool needs the Rabi key, and a Rabi login already
  runs on uac only (Rabi's relay has no Responses API), so a codex-engine
  session never has a key to publish with. Revisit with Studio single sign-on.
- **Auth:** the Rabi device-grant key that `unieai login --rabi` stores in
  `unieai.json` (`account: "rabi"`, `gateway_api_key`); the ava base URL is its
  `studio_url`. A Studio-only user is told to link a Rabi account.
- **Local checks:** the limits above including the 23 MiB body, and external
  http(s) references in HTML, CSS and ESM other than the four accepted CDNs,
  each reported with what to inline instead. `fetch` and sockets are refused
  even to the CDNs (the viewer allows no connections).
- **Updates:** an update sends no `visibility` or `header` unless given, so it
  keeps the page's. `update_settings` is the PATCH. A 409 `version_conflict`
  returns the current version to the model; with `merge: true` the tool lays
  its files over the current version's (same path wins) and retries once.
- **Id memory:** `$UNIEAI_HOME/artifacts.json`, workspace (git root) → path →
  `{id, account, version, viewerUrl, title}`, shared by the tool and the CLI.
  Not the project's `.unieai/`: ids belong to the account and `.unieai/` is
  checked into repositories.
- **Skill:** `artifact`, bundled in `agent-runtime/src/unieai-dsh/skills/`
  (passed to `unieai-skills` as `bundledSkillDir`, so a user or project skill of
  the same name wins). It keeps v1's inline-first guidance and mentions the
  four CDNs only for a library that is genuinely needed.
- **CLI:** `unieai artifact list | open <id> | delete <id> | publish <path>
  [--title] [--description] [--id] [--visibility] [--org-id] [--force] |
  set <id> [--visibility] [--org-id] [--header-title] [--header-description]
  [--header-icon] [--show-author true|false] [--clear-header]`
  (`codex-rs/login/src/unieai_artifacts.rs`, `codex-rs/cli/src/unieai_artifact.rs`).
