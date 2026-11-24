# UnieAI Studio — Token Factory, 48 s film

`48.0 s`, 8 shots of `4.8 s`. Light stage (warm light-grey ground `#efece7`,
soft cast shadow, visible slab edge). Every frame is a pure function of `t`
(`window.renderFrame(t)`), so the page can be reloaded at any point without
changing what is on screen.

Subject: one slab of the real UnieAI Studio, painted from `src/film.js`. Nothing
is drawn that the product does not draw. Wording, labels, table headers, model
names, chip text and colours come from the live app recon
(`/tmp/studio-ref*/`), palette `--bg:#f0f0f1 --line:#e8e8ea --ink:#16181d
--vio:#5e6ad2 --vio-t:#eceafc --grn:#00a97a`. Active violet buttons render
`#4f4bbd`.

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
shadow keeps `blur(11px)` — that is a shadow, not focus.

## Shots

| # | in | page | focal | S | pitch | what happens |
|---|----|------|-------|---|-------|--------------|
| 1 | 0.0 | UnieAI Model Zoo | fx 726 fy 430 | 1.42→1.49 | 27° | the model grid; the `Create Agent` chip in the header |
| 2 | 4.8 | UnieAI Model Zoo | fx 588 fy 372 | 2.02→2.10 | 34° | tight on the group chips and a model card (`Use base model`) |
| 3 | 9.6 | Playground | fx 900 fy 430→792 | 1.74→1.52 | 28° | a real FIX 4.4 question answered with a code block, then a second turn; the frame follows the conversation down to the composer |
| 4 | 14.4 | Fine-tuning | fx 726 fy 470 | 1.34→1.41 | 26° | `Create fine-tuning job`: datasets, `Training type`, `Training method` |
| 5 | 19.2 | Fine-tuning | fx 790 fy 452 | 1.88→1.96 | 36° | the job table; a run goes `Training → Succeeded`, loss drops |
| 6 | 24.0 | Inference endpoints | fx 800 fy 500 | 1.72→1.80 | 32° | `Create endpoint`, the OpenAI-compatible endpoint row |
| 7 | 28.8 | API keys | fx 690 fy 470 | 1.96→2.04 | 33° | `Create key`, a `sk-…` credential, `Protected`, `No limits` |
| 8 | 33.6 | UnieAI Model Zoo | fx 726 fy 470 | 1.00→1.04 | 8° | wide payoff: the whole Model Zoo on the stage |
| — | 38.4 | — | — | — | — | copy line `Train on your data. Ship one endpoint.` |
| — | 43.2 | — | — | — | — | end card: mark, `UnieAI Studio`, `Models as callable services.` |

Cuts land on `0, 4.8, 9.6, 14.4, 19.2, 24.0, 28.8, 33.6, 38.4, 43.2` — bar lines
of the score.

## Playground content (shot 3)

Typing timeline, `lt = t - 9.6`:

| lt | event |
|----|-------|
| 0.05 | `FIX parser` thread selected in the rail |
| 0.20 | user bubble: the FIX 4.4 execution report question |
| 0.28→2.00 | `ANS_A`: explains tags 31/32, then the `pairs = dict(...)` code block |
| 2.02→2.30 | code block reveals |
| 2.30→3.16 | `ANS_B`: `Ticket 8821 filled 1,200 shares at 148.62 — nothing to escalate.` |
| 3.22 / 3.30 | second bubble `and the notional?` and its avatar |
| 3.46→4.38 | `ANS_C`: `Notional is 1,200 × 148.62 = 178,344.00 USD.` |

The composer keeps the product's own placeholder, `Ask anything… (Enter to send,
Shift+Enter for newline)`. No host name is invented anywhere: the code block only
uses `raw`, and the endpoints page shows `Shared pool`.

## Score

`score.py` → `out/score.wav`, 48.000 s, `-18.0 LUFS` (verified with
`ffmpeg -af ebur128`), LRA 6.0 LU, peak -3.0 dBFS, 48 kHz stereo 16-bit.

Built on `film/scorekit.py`: D dorian, 100 BPM, so `BEAT 0.6` and `BAR 2.4`, and
every cut lands on a bar line. Layers: FM marimba/celesta ostinato on 16ths
(`pat = [0,2,4,6,5,4,2,1]`, pan ±0.22, climbing one scale step every 4 bars),
sidechained pulse bass, kick / rim / sixteenth shaker / open hat, a glass-bell
motif on every second downbeat, riser + impact on every cut, and a warm `Dmaj9`
resolution from 43.2 s.

Energy per section (`ENERGY = [1,2,2,3,3,2,2,1,2,1]`) is the picture's own arc:
bass and mallets alone under the model grid, drums in at 4.8, full at 14.4–19.2,
a pull-back under the wide payoff at 33.6, one last push under the copy line, then
the card. Density is written once; the mix is automated per section (`BUS` in
`scorekit.py`), so the arc is smooth instead of dropping a layer.

QA: onsets are positive at every cut, no adjacent-frame luminance step above 12,
mean frame luminance on the light stage ~225, slab edge visible in every shot,
audio `-18.0 LUFS` with true peak below `-1.5 dBTP`.