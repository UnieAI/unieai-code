# UnieAI Code — 54.6 s product film

**Logline.** A billing API is double-charging one order in two hundred. UnieAI Code
does not guess: it reads, greps, queries the ledger, sends two sub-agents out to
reproduce and to write the failing test, fixes two files, asks once for permission
to run the suite, and answers in one line.

**Product surface.** The codex-rs TUI: header `>_ UnieAI Code (v0.0.37)`, transcript,
composer, `Working (27s • esc to interrupt)` status, footer
`DeepSeek-V4-Flash-Vision-Exp default · ~/code/billing-api`. Every string in the
film is a real string from this TUI, including the sub-agent lines
(`• Spawned Hypatia [explorer] (DeepSeek-V4-Flash-Vision-Exp high)`,
`• Waiting for 2 agents`, `Completed`, `• Finished waiting`).

## Look

* Dark product → black void stage (no warm grey, unlike the Studio films).
* The window is a 118-column slab on a plane inside a CSS `perspective: 3400px`
  camera. Per shot: `translate3d` + `rotateX/rotateY/rotateZ` + `scale`.
* **No depth-of-field blur** (client request). The lens variety comes only from
  pitch, roll, yaw, focal row/column and magnification.
* Exactly one wide shot (41.40–46.20); everything else is a 2.4×–3.7× macro.
* The UI acts on its own and every cut lands on an action, never on a pause.
* Ends on one line of copy, then the official mark alone in the void —
  solid white from `UnieAILogo/logo new.png`, no dot-screen texture.

## Shots

| # | in → out | mag | pitch | roll | framing | what happens |
|---|----------|-----|-------|------|---------|--------------|
| 1 | 0.00 → 3.20 | 3.45→3.57 | 34 | −11.5→−8.6 | header, upper-left | the product alone; the header breathes |
| 2 | 3.20 → 7.00 | 3.30→3.42 | 31 | +9.0→+12.4 | composer, low-angle | `find the 1-in-200 double-charge in checkout and fix it` types out, then sends |
| 3 | 7.00 → 12.00 | 2.85→2.96 | 30 | −11.0→−8.4 | transcript mid | `• Explored`, then `• Ran rg -n "idempotency_key|charge_id" src services` and five hits |
| 4 | 12.00 → 15.60 | 3.55→3.70 | 44 | +14.4→+11.2 | table only, highest macro | `psql "$LEDGER_DB" -f q/dup_charges.sql` → three `charge_id`s at count 2, `.881` / `.884` / `.902` |
| 5 | 15.60 → 20.40 | 2.80→2.90 | 26 | −9.0→−12.4 | the two spawns | `Spawned Hypatia [explorer]`, `Spawned Kepler [worker]`, `Waiting for 2 agents` |
| 6 | 20.40 → 24.20 | 2.80→2.90 | 41 | +9.6→+6.0 | the reports | `Finished waiting`, both `Completed`, then the red run: `Tests 1 failed \| 199 passed (200)` |
| 7 | 24.20 → 28.00 | 2.95→3.08 | 33 | −13.0→−9.6 | the diff | `Edited 2 files (+18 -3)`, the retry and the ledger patch stream in |
| 8 | 28.00 → 32.60 | 2.42→2.54 | 32 | +9.6→+6.0 | the popup, three-quarters | `Would you like to run the following command?` with the second option selected |
| 9 | 32.60 → 37.00 | 2.80→2.92 | 24 | +6.8→+3.0 | settles, near square-on | `Tests 200 passed (200)` in green, then the one-line answer |
| 10 | 37.00 → 41.40 | 2.45→2.58 | 32 | −12.8→−9.2 | slash menu, steep side-on | `/model /presets /permissions /plan /review /compact`, the selection moving |
| 11 | 41.40 → 46.20 | 1.50→1.60 | 8 | 0 | **the only wide shot** | the whole window, 95 % context left; the session scrolls back up 13 rows through itself |
| — | 46.20 → 54.60 | — | — | — | copy card | `UnieAI Code`, then the mark alone |

Three shots roll left, three roll right, one is a high macro (44°), one looks up
from below, one turns square-on for the answer, one is steep and side-on for the
menu, and the wide shot is height-limited so the whole window clears the frame.

## Transcript timeline (as typed and revealed)

```
 3.25  › find the 1-in-200 double-charge in checkout and fix it   14.6 cps
 6.98  send
 7.30  • Explored        3 × Read, 1 × Search
10.10  • Ran rg -n "idempotency_key|charge_id" src services
11.85  • Ran psql "$LEDGER_DB" -f q/dup_charges.sql
12.15  └ charge_id | count | first_seen    3 rows, .881 / .884 / .902
15.90  • Spawned Hypatia [explorer] (DeepSeek-V4-Flash-Vision-Exp high)
16.55  • Spawned Kepler  [worker]   (DeepSeek-V4-Flash-Vision-Exp medium)
17.30  • Waiting for 2 agents
20.80  • Finished waiting      both Completed, mechanism named
22.55  • Ran pnpm vitest run checkout/race --repeat 200
24.02  Tests  1 failed | 199 passed (200)
24.65  • Edited 2 files (+18 -3)   src/checkout/retry.ts, services/ledger/src/write.ts
28.15  approval popup → 29.90 confirm → 30.35 dismissed
30.45  • Ran pnpm test -- checkout --repeat 200
31.85  Tests  200 passed (200)
33.00  answer, line 1
34.70  answer, line 2 — one idempotency key, 200 of 200 replays charge once
37.25  /model typed, menu opens, selection moves, closes
41.70  13-row back-scroll begins under the wide shot
46.20  cut to the copy card
```

## Music — `out/score.wav`

A cue of its own, not the Studio cue and not the earlier UnieAI Code cue.
D minor with the third held back (`Dm11 / Bbmaj7#11 / Gm9 / A7sus4b9`), 84 BPM,
one chord per two bars, so nothing hurries:

* **drone** — a D pedal two octaves down, held for the whole film, plus a low
  cluster that swells per chord;
* **pulse** — one pitch, eighths, low-passed to 250–320 Hz: pressure, not a bass line;
* **metal** — sonar bells, hard-panned, long decay; a three-note cell (A, Bb, D)
  at the evidence, the reports and the menu; the resolve at 30.55 s, where the
  third finally arrives over a held fifth, and one last note at 46.3 s;
* **drums** — no backbeat: a heartbeat kick on 1 and the "and" of 3, rim only at
  full tilt, shakers instead of hats;
* **ticks** — gated servo noise, plus a click on every keystroke and menu move;
* **fx** — a riser into every hard cut, an impact on it, and an 80 ms hole in front
  of the approval prompt.

Mastered to −18.0 LUFS, peak −1.5 dBFS; band balance
30 / 11 / 20 / 32 / 4.6 / 1.8 / 0.3 %.

## Files

```
index.html        stage, slab, palette, copy card, logo            (150 lines)
src/film.js       shot list, camera, transcript, overlays           (613 lines)
src/logo-mark.png official UnieAI mark, recoloured pure white  (1566×808)
score.py          the cue; imports ../scorekit.py                  (360 lines)
render.mjs        puppeteer stills / rows / preview / master
encode.sh         x264 1920×1080 preview and master, muxes score.wav
out/              preview.mp4, score.wav, preview_scored.mp4
```

## Render

```sh
cd film/unieai-code-intro
PUPPETEER_CACHE_DIR=$PWD/.pptr node render.mjs stills 12.90 29.60   # spot checks
PUPPETEER_CACHE_DIR=$PWD/.pptr node render.mjs preview              # ~10 min
python3 score.py                                                    # out/score.wav
./encode.sh preview                                                 # → out/preview_scored.mp4
```