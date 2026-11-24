# UnieAI Studio — the overview film (52.8 s)

One slab, nine shots, one line of copy, one end card. Every frame is a pure
function of `t` — no animation CSS, no timeouts, no transitions. No depth of
field anywhere: the whole slab is sharp, the camera does the work.

## Shots

| # | in → out | page | what the camera is looking at | what moves |
|---|----------|------|-------------------------------|------------|
| 1 | 0.0 → 4.8 | UnieAI Model Zoo | the catalog: category chips, the Text grid, `Qwen3.6-35B-A3B`, `DeepSeek-V4-Flash-Vision-Exp`, per-1M pricing | the page drifts under a slow oblique push |
| 2 | 4.8 → 9.6 | UnieAI Model Zoo | macro: `Qwen3.6-35B-A3B` / `DeepSeek-V4-Flash-Vision-Exp` cards, capability chips, `Use base model` | `Use base model` is pressed, the row lights up |
| 3 | 9.6 → 14.4 | Playground | the conversation: prompt sent, the answer typing itself in | prompt lands at 10.00, answer types from 10.60, the frame follows the second turn down |
| 4 | 14.4 → 19.2 | Fine-tuning | the run configuration: base model, dataset, method, the `Start fine-tune` button | the start button is pressed, the config locks |
| 5 | 19.2 → 24.0 | Fine-tuning → Jobs | the job that the press created: progress, loss curve, rows | progress climbs, a row goes `Running` |
| 6 | 24.0 → 28.8 | Inference endpoints | a deployed endpoint: status, the endpoint id, the curl/browser snippet | the endpoint comes online |
| 7 | 28.8 → 33.6 | API keys | the key you hand to a customer: table, scopes, `Create API key` | a new key is revealed |
| 8 | 33.6 → 38.4 | My Agents (Agent Builder) | the roster: `budget-analyst`, `project-brief-reader`, `vendor-intake`, `audit-copilot` — base model, creator, sessions, status | the frame settles on the four agents and their statuses |
| 9 | 38.4 → 43.2 | UnieAI Model Zoo (wide) | the whole slab on the stage: full nav, both product groups, the catalog | the wide payoff — everything in one frame |
| — | 43.2 → 48.0 | copy card | `Build, deploy & scale agents.` | words rise in, one per 0.15 s |
| — | 48.0 → 52.8 | end card | mark, `UnieAI Studio`, `The infrastructure for enterprise in the Agent era.` | mark drops in, name, then the line |

Cuts land on bar lines of the 100 BPM score (2.4 s per bar, so every cut is
two bars).

## Camera

`#camera` carries `perspective: 2400px`, `perspective-origin: 50% 46%`. One
sharp `.plane` (1440 x 950) holds the `.slab`:

    plane.transform-origin = (fx, fy)
    plane.transform = translate3d(960 - fx, 540 - fy, 0)
                      rotateX(pitch) rotateY(yaw) rotateZ(roll) scale(S)

so `fx`/`fy` choose which part of the page is looked at. `camAt(t)` adds
`sin(t*0.63+1.1)*3.1` to `fx` and `cos(t*0.51)*2.6` to `fy`, so the frame
keeps drifting after the move has landed. A shot with `fy1` waits 2.05 s
before it tilts down, so the frame follows the answer instead of landing on
empty page. `?flat=1` (`FLAT=1`) forces the slab square-on for layout checks.

## Faithfulness

Every screen is the real Studio shell and the real wording: sidebar groups
`Token Factory` (`UnieAI Model Zoo`, `Playground`, `Fine-tuning`, `Inference
endpoints`, `Batch inference`, `Image Model Toolbox`, `My Models`) and
`Agent Builder` (`My Agents`, then `My assets`: `Knowledge bases`, `Skills`,
`Databases`, `API tools`, `MCP servers`, `Third-party apps`, `Asset
marketplace`), top bar `Home / GPU Fabric / Token Factory / Agent Builder`,
footer `Documentation`, `UnieAI official website`, `Discord`.

- Real model names and prices on the catalog: `Qwen3.6-35B-A3B`,
  `gemma-4-31B-it`, `DeepSeek-V4-Flash-Vision-Exp`, `FLUX.2-dev`,
  `Qwen-Image-Edit-2511`, `$0.05 / $0.10 / $0.44 / $0.30` per 1M tokens.
- Agent Builder has **no run or chat screen** (`Sandboxes`, `Sessions` are
  marked `coming soon`), so the film never shows one — it stops on the roster.
- There is no `Data map` screen in Studio. Nothing in this film invents one.
- No public base URL is shown anywhere; snippets in the other films read the
  host from the environment rather than a made-up domain.
- Copy and tagline are verbatim from unieai.com: `Build, deploy & scale agents.`
  and `The infrastructure for enterprise in the Agent era.`

## Files

| file | what |
|------|------|
| `index.html` | the slab, the stage, `#copy`, `#end` |
| `src/film.js` | the whole film: pages, sidebar, camera, `window.renderFrame(t)` |
| `render.mjs` | puppeteer driver — `stills <t,…>`, `preview [from,to]`, `master` |
| `score.py` | the score, written to the edit (`../scorekit.py` is the engine) |
| `encode.sh` | `preview` (960×540) and `master` (1920×1080), muxes the score at −18 LUFS |
| `out/preview.mp4` | silent preview |
| `out/preview_scored.mp4` | preview with the score |
| `out/score.wav` | 52.8 s, −18.0 LUFS, peak −3.2 dBFS |

## Commands

```sh
python3 score.py                  # -> out/score.wav
./encode.sh preview               # -> out/preview.mp4 + out/preview_scored.mp4
./encode.sh master                # 1920x1080, 60 fps, takes hours
node render.mjs stills 36.4,45.6  # single frames for checking
```
