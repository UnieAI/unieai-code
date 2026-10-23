# Copyright (c) 2026 UnieAI. All rights reserved.
"""Regenerate lab-reference.json with the harness lab's own code.

unieai-profiles.test.mjs checks that uac applies a profile byte for byte as
the lab does: profile_sha, the persona text (render_instructions), where it
lands in the patch (append_persona), the plugin choice (the dsh adapter's
UNIEAI_DSH_PLUGINS) and the SKILL.md files. This writes what the lab
produces for each fixture here. Run it with the lab's interpreter (read-only
use of the lab):

    <unieai-harness-lab>/.venv/bin/python gen-lab-reference.py

The lab's schema has no `match:` yet, so it is dropped before the lab loads a
fixture (it is not part of profile_sha either way).
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from harness_lab import profile as profmod
from harness_lab.adapters.dsh import DshHarness
from harness_lab.adapters.dsh_patch import append_persona

HERE = Path(__file__).resolve().parent

# The uac pack as the lab's examples/unieai.yaml configures it.
CATALOG = [
    "unieai-exec", "unieai-exec-notify", "unieai-edit-observe", "unieai-skills",
    "unieai-edit-rescue", "unieai-edit-feedback", "unieai-apply-patch",
    "unieai-web-search", "unieai-vision-fallback", "unieai-secret-redact",
    "unieai-auto-approval", "unieai-rewind", "unieai-wait-agents", "unieai-agents",
    "unieai-schedule", "unieai-loop-truncation", "unieai-loop-completion",
    "unieai-todo-guard", "unieai-loop-toolerrors", "unieai-toolcall-repair",
    "unieai-context-overflow", "unieai-context-usage", "unieai-loop-guard",
]
HARNESS = DshHarness("uac", {
    "plugin_dir": "/nonexistent/unieai-dsh",
    "plugins_env": "UNIEAI_DSH_PLUGINS",
    "persona_env": {"rigor": {"UNIEAI_PERSONA_RIGOR": "1"}},
    "home_env": "UNIEAI_HOME",
    "plugin_catalog": CATALOG,
})

# A patch shaped like uac's: a persona block with a blank line inside, rows after it.
BASE_PATCH = "\n".join([
    "- id: acp",
    "  config:",
    "    provider: unieai",
    '    model: "Example-Model-7B"',
    "- id: system-prompt",
    "  config:",
    "    includeHarnessIdentity: false",
    "    includeRuntimeContext: true",
    "    personaPrefix: |",
    "      You are {{model}}, a coding agent.",
    "",
    "      # Rules",
    "      - Keep going until the task is solved.",
    "",
    "- id: compaction-basic",
    "  config:",
    "    thresholdRatio: 0.75",
    "",
])


def main() -> None:
    cases = []
    for path in sorted(HERE.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        raw.pop("match", None)
        errors = profmod.validate(raw)
        if errors:
            raise SystemExit(f"{path.name}: {errors}")
        p = profmod.normalize(raw)
        applied = HARNESS.apply_profile(p)
        cases.append({
            "file": path.name,
            "profile_sha": applied.profile_sha,
            "instructions": applied.instructions,
            "pack_env": applied.settings.get("pack_env") or {},
            "skill_files": {
                f"{s['name']}/SKILL.md": profmod.skill_markdown(s) for s in p["skills"]
            },
            "patched": append_persona(BASE_PATCH, applied.instructions),
            "patched_empty": append_persona("", applied.instructions),
        })
    out = {"base_patch": BASE_PATCH, "catalog": CATALOG, "cases": cases}
    (HERE / "lab-reference.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
