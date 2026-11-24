"""Score for the UnieAI Studio Agent Builder film -- see ../scorekit.py.

D dorian, 100 BPM, cut on the action: the roster (light), the wizard opening,
the name typed (ticks), the instructions typed (ostinato + ticks), the Model Zoo
preset snapping in (full), the data-source tabs paging (full), Create Agent
(full), the wide payoff where the new agent lands in the roster (drop to pad and
bells), the copy card (mallets), the end card (maj9).

    python3 score.py            -> out/score.wav
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scorekit import Score  # noqa: E402

DUR = 52.0
CUTS = [0.0, 6.0, 12.0, 18.0, 24.0, 30.0, 36.0, 42.0, 46.0]
ENERGY = [1, 2, 2, 3, 3, 2, 3, 1]
MOTIF = [4, 4, 5, 4, 5, 5, 4, 5]

# the wizard typing itself: the name (6.40 / 1.15 s), then the instructions
# (7.75 / 10.2 s) -- one tick per character, soft enough to sit under the mix
TICKS = ([6.45 + i * 0.093 for i in range(12)] +
         [7.82 + i * 0.063 for i in range(157)])


def main():
    s = Score(DUR, CUTS, energy=ENERGY, motif=MOTIF, name="agentbuilder",
              resolve=42.0)
    s.build_ticks(TICKS, vel=0.058)
    buf = s.render()
    os.makedirs("out", exist_ok=True)
    s.write("out/score.wav", buf)
    s.report(buf)


if __name__ == "__main__":
    main()