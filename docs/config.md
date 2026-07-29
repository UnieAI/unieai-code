# Configuration

For basic configuration instructions, see [this documentation](https://developers.openai.com/codex/config-basic).

For advanced configuration instructions, see [this documentation](https://developers.openai.com/codex/config-advanced).

For a full configuration reference, see [this documentation](https://developers.openai.com/codex/config-reference).

## Granular approvals

`approval_policy = "granular"` takes a table of per-category switches. Each one
chooses between two outcomes, and neither of them is "approve automatically":

| Value | What happens |
| --- | --- |
| `true` | The request is shown to you as an approval prompt. |
| `false` | The request is rejected automatically, without being shown. |

So setting a field to `true` does not permit the action — it means you will be
asked about it. Setting it to `false` does not silence the prompt in order to
let the action through; it refuses the action outright.

```toml
[approval_policy.granular]
sandbox_approval  = true   # ask before escalating out of the sandbox
rules             = true   # ask when an execpolicy `prompt` rule matches
skill_approval    = true   # ask before running a skill script
request_permissions = true # ask when the agent requests wider access
mcp_elicitations  = true   # ask on MCP elicitations
```

Each key also accepts a `prompt_on_*` alias that reads the way the flag
behaves — `prompt_on_sandbox_escalation`, `prompt_on_execpolicy_rules`,
`prompt_on_skill_execution`, `prompt_on_request_permissions`, and
`prompt_on_mcp_elicitations`. The original names stay valid.

To run without being prompted, use `approval_policy = "never"` instead. That
policy declines to ask and returns the failure to the model, so pair it with a
sandbox mode that already grants what the work needs — commonly
`sandbox_mode = "workspace-write"`. There is no per-category equivalent.

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in
`requirements.toml` to ignore user, project, and session hook configs while
still allowing managed hooks from requirements and managed config layers. This
setting is only supported in `requirements.toml`; putting it in `config.toml`
does not enable managed-hooks-only mode.
