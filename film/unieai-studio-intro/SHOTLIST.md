# UnieAI Studio — intro film (47 s, light stage)

Rebuilt from the *real* product: the live shell at `studio.demo.unieai.com` and
the page vocabulary in `/home/ubuntu/service/UnieAI-Studio/apps/studio-web`
(screenshots in `/tmp/studio-ref` … `/tmp/studio-ref5`). The demo tenant has no
workspace data, so the screens below are re-created in HTML from the product's
own components, tokens and strings — never a mock-up of a different product.

Stage: **light** — the product is light-only. Warm light-grey ground, white slab
floating above it, one soft cast shadow, visible slab edge, high mean luminance.
No depth of field: nothing on the slab is blurred, only the cast shadow below it.

## Story

An agent is built, not described. Three real screens, in the order you meet
them:

1. **My Agents** — where agents live: `Agents 4`, `Sandboxes Coming soon`,
   `Sessions Coming soon`, rows running on `Qwen3.6-35B-A3B`, `Enabled`.
2. **My assets** — knowledge bases, skills, databases, API tools, MCP servers,
   third-party apps, asset marketplace: what an agent may read and call.
3. **New agent** — the real create-agent wizard, filled in on camera:
   `Agent definition` (`contracts-qa`, three lines of system instructions that
   type themselves to `157 characters`), `Model` (`Model Zoo`, tick landing on
   `Qwen3.6-35B-A3B`), `Data sources` (`Knowledge Base | Skills | MCP | SQL |
   API`, honest empty state `No knowledge bases in this workspace`), the
   `Agent config` rail, and `Create Agent`.

Copy: `Data that an agent can read.`
End card: UnieAI mark + `UnieAI Studio` + `The data infrastructure for enterprise AI.`

## Shots

| # | in → out | subject | camera |
|---|----------|---------|--------|
| 1 | 0.00 → 5.20 | My Agents: shell, tabs, agent table | mag 1.56→1.66, pitch 27°, roll +8.4→+11.4°, yaw −5° |
| 2 | 5.20 → 11.00 | My assets: rows lighting up | mag 1.52→1.62, pitch 30°, roll −9.6→−6.4°, yaw +6° |
| 3 | 11.00 → 18.60 | Agent definition: name, instructions typing | mag 1.62→1.72, pitch 31°, roll +9.4→+6.4°, yaw −6° |
| 4 | 18.60 → 24.20 | Model: `Model Zoo` ticked, `Qwen3.6-35B-A3B` | mag 1.90→2.00, pitch 34°, roll −10.2→−7.2°, yaw +6.4° |
| 5 | 24.20 → 29.80 | Agent config rail + `Create Agent` | mag 2.02→2.12, pitch 32°, roll +8.2→+11.4°, yaw −5.4° |
| 6 | 29.80 → 35.40 | the whole wizard, wide | mag 1.06→1.10, pitch 9°, roll +0.7→+0.2°, yaw +1.2° |
| 7 | 35.40 → 40.30 | copy over the dissolving slab | screen space, high-key wash |
| 8 | 40.30 → 47.00 | end card: mark, wordmark, tagline | screen space |

Every cut lands on an action: a row settling, the last character of the
instructions, the tick on the model, the button lighting.

## Music

`score.py` uses the shared engine in `../scorekit.py` (numpy only, no samples):
**D dorian, 100 BPM**, 2.4 s bars, one section per shot.

* layers enter on the cut — pad only over My Agents, sub + kick + bass on the
  assets page, sixteenth-note mallets under the typing, everything on the model
  and the create beat, back to pad + bells over the wide shot, mallets alone on
  the copy, `Dmaj9` on the end card;
* the wizard's typing is played: one soft tick per typed character
  (12 on the name, 114 on the instructions);
* every cut gets an impact, a riser into it and a rim on the downbeat.

Measured: 47.000 s, **−18.0 LUFS** integrated, LRA 4.5 LU, true peak −3.7 dBFS.

## Fidelity notes

* Colours are the product's own tokens: slab `#f0f0f1`, panel `#ffffff`,
  chrome `#fbfbfc`, hairlines `#e8e8ea`, ink `#16181d`, violet `#5e6ad2`
  (active buttons render `#4f4bbd`), tint `#eceafc`, status green `#00a97a`.
* Strings are copied from the product: `New agent`, `Runs on UnieAI Harness and
  returns results through an API. Define the engine, model, data sources,
  memory, guardrails and evaluation.`, `Agent definition`, `Instructions`,
  `System prompt`, `Plain text`, `Variables`, `157 characters`, `Model`,
  `Pick a built-in Model Zoo preset, or supply a base URL / API key / model name.`,
  `Model Zoo`, `Built-in, no key to manage`, `Agent`, `base URL + key + name`,
  `Model Zoo model`, `Data sources`, `0 selected`, `Knowledge Base`, `Skills`,
  `MCP`, `SQL`, `API`, `No knowledge bases in this workspace`, `Agent config`,
  `BASE MODEL`, `DISPLAY NAME`, `WORKSPACE`, `BASE MODEL ACCESS`, `DATA SOURCES`,
  `Add to My Models first`, `Not selected`, `Create Agent`, `Cancel`.
* No run or chat screen is shown: Agent Builder has no sessions yet
  (`Sandboxes Coming soon`, `Sessions Coming soon`).
* Fonts: Geist + Geist Mono (the product's own faces), self-hosted in `src/`.
  Mark: `unieai.com/logo.png` (real asset, 552×554).

## Files

```
index.html     stage, camera, app CSS, end card
src/film.js    app HTML for the three pages + deterministic renderFrame(t)
src/*.woff2    Geist / Geist Mono latin
render.mjs     puppeteer capture: stills | preview | master
encode.sh      ffmpeg encode (180° shutter via tmix) + mux with out/score.wav
score.py       sectioned score on ../scorekit.py, D dorian, 100 BPM
out/           preview.mp4, preview_scored.mp4, score.wav
```

## Commands

```bash
FLAT=1 node render.mjs stills 12.6,20.4,27.2,32.8   # square-on layout QA
node render.mjs stills 1.0,8.0,15.0,20.0,27.0,32.0  # framed QA frames
node render.mjs preview        # 960×540 / 30 fps
python3 score.py               # out/score.wav
./encode.sh preview            # encode + mux + probe
./encode.sh master             # 1920×1080 / 60 fps, ~12 000 captures
```

The film has no dependency on where it lives: copy this directory next to
`/home/ubuntu/service/UnieAI-Studio` if you want it kept with the product.