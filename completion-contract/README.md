# @unieai/completion-contract

Refuse to let a coding-agent turn end while the work is visibly unfinished.

A weak model's most common failure is not a wrong patch — it is no patch. On
SWE-bench Verified, Qwen3.6-35B-A3B ended **71 of 100** turns having changed
nothing at all. It analysed the problem, described the fix, and stopped.

This package is three gates that run when the model declares a turn finished. It
does not make a model more accurate; it makes it finish.

| Model | codex alone | + this |
|---|---|---|
| Qwen3.6-35B-A3B | 16 / 100 | **45 / 100** |
| DeepSeek-V4-Flash-0731 | 83 / 100 | **84 / 100** |

Full numbers, cost and method: [`benchmarks/RESULTS-completion-contract.md`](https://github.com/UnieAI/unieai-code/blob/main/benchmarks/RESULTS-completion-contract.md).

## Install

```bash
npm i -g @unieai/completion-contract
```

Zero runtime dependencies. Needs Node ≥ 20, `git`, and — for the Python gate —
`python3` on PATH.

## Use as a codex Stop hook

In `$CODEX_HOME/config.toml`:

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "unieai-stop-hook"
```

The hook reads codex's `StopCommandInput` from stdin and answers
`{"decision":"block","reason":"…"}` to send the turn back, or `{}` to let it end.

> A hook declared in a user config is **Untrusted** until its hash is recorded, and
> an untrusted hook is skipped silently. Either record the trust hash, ship it in a
> managed config layer, or pass `--dangerously-bypass-hook-trust` for a test run.

Environment:

| Variable | Purpose | Default |
|---|---|---|
| `UNIEAI_API_KEY` | the skeptic's model call | — (skeptic skipped without it) |
| `UNIEAI_BASE_URL` | gateway | `https://api.unieai.com/v1` |
| `UNIEAI_SKEPTIC_MODE` | `nudged` \| `always` \| `never` | `nudged` |
| `UNIEAI_MAX_NUDGES` | nudges per turn | `5` |

## Use from your own loop

```js
import { createCompletionContract } from "@unieai/completion-contract";

const check = createCompletionContract({
  workspace: "/path/to/repo",
  callModel: async ({ system, user }) => yourModel(system, user), // returns a string
  state,          // an object you persist across turns
});

const nudge = await check({
  task: "the user's request",
  answerText: "what the model says it did",
  wasNudged: false,   // did this turn already have to be pushed?
});

if (nudge) {
  // send `nudge` back into the turn and let the model continue
}
```

`callModel` is the only thing a host must supply. Everything else the contract
learns from `git` and the filesystem, so it does not know or care which loop is
driving it.

## The three gates

| Gate | Fires when | Model call |
|---|---|---|
| **mutation** | nothing in the workspace changed | no |
| **deterministic** | changed Python fails to compile or import; test files edited | no |
| **skeptic** | a diff exists *and* the turn needed pushing | yes |

The first two are self-limiting — they speak only when something is actually
wrong, so a model that behaves well never hears from them.

The skeptic is the one with a cost, so it is rationed. By default it reviews only
a turn that had to be nudged to get here, or one the deterministic gates flagged.
That default is measured, not chosen: reviewing every turn cost DeepSeek 3 points
and dropped its per-patch accuracy from 84% to 80%; rationing it restored both.
Set `UNIEAI_SKEPTIC_MODE=always` to review unconditionally, `never` to disable.

## Everything fails open

A hook that errors, times out, cannot reach a model, or is pointed at a directory
that is not a git repository lets the turn end. Refusing to finish because the
verifier is broken is strictly worse than finishing unverified.

## Which models this helps

The predictor is not model size or benchmark rank — it is the **empty-handed
rate**: how often the model ends a turn having changed nothing. Measure it over
ten instances with no harness at all.

| Empty-handed rate | Configuration |
|---|---|
| > 40% | all gates on |
| 10–40% | gates on, skeptic adaptive (the default) |
| < 10% | the skeptic will almost never fire; the cheap gates cost nothing |

Observed: Qwen3.6-35B-A3B 71%, GLM-5.2 4%, DeepSeek-V4-Flash-0731 1%.

## License

Apache-2.0
