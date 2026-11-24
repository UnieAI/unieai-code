# UnieAI Studio — Agent Builder, 52 s film

`52.0 s`, 7 shots of `6.0 s`. Light stage (warm light-grey ground `#efece7`,
soft cast shadow, visible slab edge). Every frame is a pure function of `t`
(`window.renderFrame(t)`), so the page can be reloaded at any point without
changing what is on screen.

Subject: one slab of the real UnieAI Studio, painted from `src/film.js`. Nothing
is drawn that the product does not draw. Wording, labels, field names, helper
copy and colours come from the live app recon, palette `--bg:#f0f0f1
--line:#e8e8ea --ink:#16181d --vio:#5e6ad2 --vio-t:#eceafc --grn:#00a97a`.
Active violet buttons render `#4f4bbd`.

The film never shows an agent *running*: Agent Builder has no run/chat surface
yet (`Sessions` and `Sandboxes` are `Coming soon`), so the arc is
roster → wizard → config → roster, and the payoff is the new agent landing in
the list as `Draft · just created`.

## Camera

`#camera` carries `perspective` (2400 px) and `#camera { perspective-origin: 50% 46% }`.
One sharp `.plane` (1440 x 950) holds a `.win` crop window and the `.slab`.

    plane.transform-origin = (fx, fy)
    plane.transform = translate3d(960 - fx, 540 - fy, 0)
                      rotateX(pitch) rotateY(yaw) rotateZ(roll) scale(S)

So the focal UI point always lands near the centre of frame, and `fx`/`fy`
simply choose which part of the page is being looked at.

`camAt(t)` also adds `fx + sin(t*0.63+1.1) * 3.1` and `fy + cos(t*0.51) * 2.6`,
so the frame keeps drifting even after the move has landed.

`?flat=1` (`FLAT=1` in the env) forces the slab square-on — `S 0.86`, `p/y/r = 0`,
`fx 720`, `fy 475` — for layout checks only.

## No depth of field

The client asked for no blur. `var DOF = false`: a single sharp plane, no
`filter: blur()` on the plane, on the camera dissolve, or on the copy and logo
(they fade on opacity only), `this.camera.style.filter = 'none'`. Only the cast
shadow keeps `blur(11px)` — that is a shadow, not focus. The per-shot `nb` / `fb`
values survive in `SHOTS` as inert data.

## Shots

| # | in | page | focal | S | pitch | what happens |
|---|----|------|-------|---|-------|--------------|
| 1 | 0.0 | My Agents | fx 706 fy 470 | 1.56→1.66 | 27° | the roster: `Agents 4`, the three filter chips, four rows, `N agents · 3 run on Qwen3.6-35B-A3B` |
| 2 | 6.0 | New agent | fx 606 fy 322 | 1.62→1.72 | 31° | the wizard opens; `contracts-qa` types itself into `Name` (11 chars), the `Draft` chip |
| 3 | 12.0 | New agent | fx 662 fy 392 | 1.96→2.06 | 33° | the instructions write themselves over 10.2 s, `157 characters` counting up |
| 4 | 18.0 | New agent | fx 646 fy 552 | 2.02→2.10 | 33° | the `Model` station: `Model Zoo` selected, `Qwen3.6-35B-A3B`, the billing helper copy |
| 5 | 24.0 | New agent | fx 690 fy 700 | 1.74→1.82 | 30° | `Data sources`: the tab strip pages to `SQL`, empty state `No SQL connections in this workspace`, `0 selected` |
| 6 | 30.0 | New agent | fx 1192 fy 392→452 | 2.02→2.12 | 32° | the `Agent config` rail (`BASE MODEL`, `DISPLAY NAME`, `WORKSPACE`, `DATA SOURCES Not selected`) and `Create Agent` |
| 7 | 36.0 | My Agents | fx 720 fy 476 | 1.06→1.10 | 9° | wide payoff: `contracts-qa` appears in the roster as `Draft · just created`, violet wash, `Agents 5` |
| — | 42.0 | — | — | — | — | copy line `Describe it. Create the agent.` |
| — | 46.0 | — | — | — | — | end card: mark, `UnieAI Studio`, `The data infrastructure for enterprise AI.` |

Cuts land on `0, 6.0, 12.0, 18.0, 24.0, 30.0, 36.0, 42.0, 46.0` — bar lines of
the score (`BAR 2.4`), so every cut is on a downbeat.

## The wizard content

`WZ_NAME = 'contracts-qa'`, `WZ_INSTR` is 3 lines / 157 characters:

    You answer contract questions for the legal team.
    Cite the clause and the document you used.
    If a clause is not in the workspace, say so instead of guessing.

| t | event |
|----|-------|
| 6.40→7.55 | `Name` types, caret blinking at 2.6 Hz |
| 7.75→17.95 | `Instructions` types; `157 characters` counts up |
| 20.35→20.75 | the Model Zoo preset ticks on (`cz-tick`) |
| 26.50 | the `Data sources` strip pages `Knowledge Base → SQL` |
| 33.10→33.60 | `Create Agent` presses |
| 36.45→37.35 | the new row fades in and lifts 12 px into place |

Page switching is a hard function of `t`: `agents` before 6.0, `create` until
36.0, `agents5` after — the switch itself is hidden inside a cut.

Everything visible is the product's own: `Model Zoo` / `Agent` radio cards,
`Model Zoo model`, `Plain text` `Variables`, `0 selected`, `BASE MODEL ACCESS
Add to My Models first`. No API host is invented anywhere.

## Score

`score.py` → `out/score.wav`, 52.000 s, `-18.0 LUFS` (verified with
`ffmpeg -af ebur128`), LRA 4.5 LU, peak -3.7 dBFS, 48 kHz stereo 16-bit.

Built on `film/scorekit.py`: D dorian, 100 BPM, so `BEAT 0.6` and `BAR 2.4`, and
every cut lands on a bar line. Layers: FM marimba/celesta ostinato on 16ths
(`pat = [0,2,4,6,5,4,2,1]`, pan ±0.22, climbing one scale step every 4 bars),
sidechained pulse bass, kick / rim / sixteenth shaker / open hat, a glass-bell
motif on every second downbeat, riser + impact on every cut, and a warm `Dmaj9`
resolution from 42.0 s.

`TICKS` puts one soft tick on every character the wizard types — 12 on the name
(`6.45 + 0.093 i`), 157 on the instructions (`7.82 + 0.063 i`, vel 0.058) — so the
sound follows the typing exactly, outside the 100 BPM grid.

Energy per section (`ENERGY = [1,2,2,3,3,2,3,1]`) is the picture's own arc: bass
and mallets under the roster, drums in at 6.0, full through the typing and the
model station, a pull-back at the data sources, one last push under the button
and the reveal, then the copy line and the card.

## QA

- capture count `3120 / 3120` (1560 frames x 2 sub-frames), preview 960x540/30 fps
- mean frame luminance `225.3` (min 220.6 / max 231.0), max adjacent step `4.3`
  (gate: 12) — the light stage never dips
- every shot's crop verified as a still before the render: no sliced headline,
  no half-cut text baseline, `0 selected` chip and the `Data sources` title stay
  on one line
- score: `-18.0 LUFS` integrated, true peak `-3.7 dBFS`

## Files

    index.html      the slab, the stage, all CSS
    src/film.js     SHOTS, camAt(t), renderFrame(t) — every pixel a function of t
    render.mjs      puppeteer driver (stills / preview / master, range re-shoots)
    encode.sh       sub-frame shutter + grain + AAC mux (-18 LUFS)
    score.py        the 52 s score
    out/preview.mp4         960x540, 52.0 s, silent
    out/score.wav           48 kHz stereo
    out/preview_scored.mp4  960x540, 52.0 s, with the score