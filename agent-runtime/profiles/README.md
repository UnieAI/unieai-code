<!-- Copyright (c) 2026 UnieAI. All rights reserved. -->
# Harness profiles

One YAML file per model, `<model>.yaml`, with the model id as the gateway
serves it. The uac engine applies the profile of a thread's model: persona
level and extra lines, plugin set, tool guidance and skills. See
[docs/unieai/harness-profiles.md](../../docs/unieai/harness-profiles.md).

- `profile.schema.json` is a copy of the harness lab's schema
  (unieai-harness-lab, `src/harness_lab/schemas/profile.schema.json`), plus
  the optional top-level `match:` list of model-id globs. The lab owns it:
  change it there, then copy it here.
- Only `status: adopted` bundled profiles are applied (a user's own file in
  `$UNIEAI_HOME/profiles` applies at any status). A profile is adopted by the
  lab (`hlab optimize`, then held-out validation) and arrives here with its
  `measurements` row; nobody writes one here by hand.
- No profile has been adopted yet, so this directory ships none. Test
  fixtures live in `../test-fixtures/harness-profiles/`.
- `node --test src/unieai-dsh/unieai-profiles.test.mjs` checks every file
  here: valid, named after its model, and no model id matched equally by two
  profiles' `match:` patterns.
