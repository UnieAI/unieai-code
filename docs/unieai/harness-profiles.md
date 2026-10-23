<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->
# Harness profiles

Status: built for the uac engine (`agent-runtime/src/unieai-dsh/unieai-profiles.mjs`).
No profile has been adopted yet, so UnieAI Code ships none and every model
runs as before. The codex engine does not read profiles.

A harness profile is the set of non-weight settings the uac engine loads for
one model: persona level, extra persona lines, plugin set, tool guidance and
skills. UnieAI's harness lab (unieai-harness-lab, `hlab`) measures and
optimizes these per model. The product applies a profile with the same code
the lab measures, so what the lab adopts for a model is what users get on
that model.

## Format

YAML, one file per model, named `<model>.yaml` after the model id as the
gateway serves it (no provider prefix). The schema is
`agent-runtime/profiles/profile.schema.json`, a copy of the lab's
`src/harness_lab/schemas/profile.schema.json`; the lab owns it and its
`docs/profile.md` describes every field.

```yaml
schema_version: 1
model: Qwen3.6-35B-A3B
match: ["Qwen3.6-*"]          # optional: further model ids, as globs (* and ?)
status: adopted               # unmeasured | measured | candidate | adopted | rejected
harness: dsh
persona:
  level: rigor                # minimal | standard | rigor
  extra:
    - Verify the result against every requirement before finishing.
plugins:
  base: default               # all | none | default
  enable: [unieai-todo-guard]
  disable: [unieai-web-search]
tool_guidance:
  - tool: exec_command
    text: Read stderr before retrying a failed command.
skills:
  - name: verify-first
    description: How to check work before declaring it done
    body: |
      1. Re-read the task. ...
provenance: {...}             # written by hlab
measurements: [...]           # written by hlab
```

(The values above show the format; they are not a tuned profile.)

`match:` is a uac addition the lab's schema does not have yet. Text that ends
up in the persona (`persona.extra`, `tool_guidance`, skill names and
descriptions) may not contain `{{`, because dsh reads it as a prompt variable.

## What uac does with a profile

| field | uac |
|---|---|
| `persona.level` | `rigor` turns on the persona's rigor rules, the same switch as `UNIEAI_PERSONA_RIGOR=1`. `minimal` and `standard` add nothing. `UNIEAI_PERSONA_RIGOR=1` or `0`, when set, decides instead. |
| `persona.extra`, `tool_guidance` | Appended inside the `personaPrefix` of uac's own `system-prompt` patch row, in the exact text the lab's `render_instructions` and `append_persona` produce (including the `## Skills available` list). |
| `plugins` | The UnieAI plugin selection, as if `UNIEAI_DSH_PLUGINS` named it. `unieai-artifacts` counts as a plugin. A `UNIEAI_DSH_PLUGINS` set in the environment still wins, so A/B runs keep working. |
| `skills` | Written as `<name>/SKILL.md` under `$DSH_HOME/profile-skills/<profile_sha>/`, which `unieai-skills` reads as its bundled root: user and project skills outrank them, and they outrank (or replace, by name) the skills UnieAI Code bundles. |

A profile is part of dsh's patch, so the uac server runs one dsh process per
mode and profile. A thread keeps the profile of the model it started on; a
model switch inside the thread does not change it.

`agent-runtime/test-fixtures/harness-profiles/lab-reference.json` holds what
the lab's own Python produces for the test fixtures (profile_sha, persona
text, patch, plugin choice, SKILL.md files); `unieai-profiles.test.mjs`
compares uac's output with it byte for byte. Regenerate it with
`gen-lab-reference.py` in that directory when the lab changes how it applies
a profile.

## Which profile a model gets

1. `UNIEAI_HARNESS_PROFILE`: `off` applies none; a path applies that file to
   every model, whatever its `status`. An unusable file applies none.
2. `$UNIEAI_HOME/profiles/<model>.yaml`: the user's override.
3. A bundled profile (`agent-runtime/profiles/`) whose `model` is the id.
4. A bundled profile whose `match:` globs match the id. The pattern with the
   most literal characters wins; when two profiles tie, none is applied and
   the server log says so. The test suite fails on any tie between bundled
   profiles.

Steps 2 to 4 apply only `status: adopted` profiles. An invalid file is skipped
with a line in the uac server log; it never stops a start. A self-hosted
model (`<server>/<model>`) is looked up by its bare model id.

`UNIEAI_DSH_PATCH` (a whole patch of the user's own) replaces uac's patch, and
with it the profile.

## Seeing what applied

The uac server log (`$CODEX_HOME/uac/server.log`) has one line at startup and
one per session:

```
uac: dsh = ... (home ..., model Qwen3.6-35B-A3B, profile: Qwen3.6-35B-A3B adopted sha=3f2a9c0e1b7d (bundled))
[uac] session on Qwen3.6-35B-A3B, profile: none
```

`/status` in the TUI does not show it yet: the status card is built in Rust
from the TUI's own config (`codex-rs/tui/src/status/card.rs`,
`engine_summary`) and nothing from the uac server reaches it.

## How a profile gets adopted

1. `hlab optimize` proposes bounded edits to the model's current profile and
   probes them on a training split.
2. The best candidate is validated on a held-out split against the current
   profile (exact McNemar test, no regression).
3. If it wins, hlab writes it with `status: adopted` and a `measurements` row
   (model, harness version, benchmark, split, n, passed, p-value, tokens and
   time per task).
4. The adopted file is copied into `agent-runtime/profiles/<model>.yaml` in a
   release. Its measurements row is the citation for any claim that the model
   is tuned: model x harness version x result x cost.

A profile measured on one dsh or plugin version is not re-measured
automatically when those change; the lab's `harness_version` in the
measurements row says what it was measured on.

## Turning it off

`UNIEAI_HARNESS_PROFILE=off` in the environment the uac server starts with.
`UNIEAI_HARNESS_PROFILE=/path/to/profile.yaml` forces one file instead, which
is how a candidate is tried by hand.

## In-process use (the lab)

`renderUacConfig({ model, profile, baseUrl, modelInfo, skillsDir, env })` in
`agent-runtime/src/unieai-dsh/config.mjs` returns `{ settings, patch,
plugins, profile, skillFiles }` without touching the disk. `profile` is an
object (applied whatever its status; an invalid one throws), `null` (none) or
omitted (resolved as above). The returned `profile` is `{ model, status,
profile_sha, source, path }`, with `profile_sha` computed as the lab's
`profile_sha()`. The contract is described at the top of
`unieai-profiles.mjs`.

## Later

- Per-task variants: a profile per kind of task (a long build, a quick edit)
  for one model, chosen when the session starts.
- Profiles served from the Studio model catalog next to each model, so an
  adopted profile reaches users without a UnieAI Code release; the bundled
  ones stay the fallback.
- Sharing with Ava: agent.unieai.com also runs dsh, so the same profile and
  the same application code (persona text, plugin selection, skills) could
  serve both, measured once.
