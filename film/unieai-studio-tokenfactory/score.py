"""Score for the Token Factory film -- see ../scorekit.py for the engine.

D dorian, 100 BPM, cuts every two bars (4.8 s), so the arrangement is written to
the edit: Model Zoo (light), macro (drums in), playground (kick + bass, typing
ticks), fine-tuning (full), jobs (full), endpoint (pull back), keys (build),
wide payoff (drop to pad + bells), copy card (just the mallets), end card (maj9).

    python3 score.py            -> out/score.wav
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scorekit import Score, BAR  # noqa: E402

DUR = 48.0
CUTS = [0.0, 4.8, 9.6, 14.4, 19.2, 24.0, 28.8, 33.6, 38.4, 43.2]
ENERGY = [1, 2, 2, 3, 3, 2, 2, 1, 2, 1]
MOTIF = [4, 4, 5, 4, 5, 5, 4, 5, 5, 5]

# the answer typing itself in the playground shot (cut 9.6, typing from 9.88)
TICKS = [9.88 + i * 0.072 for i in range(24)]


def main():
    s = Score(DUR, CUTS, energy=ENERGY, motif=MOTIF, name="tokenfactory",
              resolve=43.2)
    s.build_ticks(TICKS, vel=0.075)
    buf = s.render()
    os.makedirs("out", exist_ok=True)
    s.write("out/score.wav", buf)
    s.report(buf)


if __name__ == "__main__":
    main()