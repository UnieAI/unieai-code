"""Score for the UnieAI Studio film -- see ../scorekit.py for the engine.

D dorian, 100 BPM, cut on the action: My Agents (light), one data source
(drums), the agent typed into the wizard (ostinato + key ticks), the Model Zoo
preset (full), Create Agent (full), the wide payoff (drop to pad and bells),
the copy card (mallets), the end card (maj9).

    python3 score.py            -> out/score.wav
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scorekit import Score  # noqa: E402

DUR = 47.0
CUTS = [0.0, 5.2, 11.0, 18.6, 24.2, 29.8, 35.3, 40.3]
ENERGY = [1, 2, 2, 3, 3, 2, 2, 1]
MOTIF = [4, 4, 5, 4, 5, 5, 4, 5]

# the wizard typing itself: the name (11.25 / 1.15 s), then the instructions
# (12.55 / 6.4 s) -- one tick per character, soft enough to sit under the mix
TICKS = ([11.30 + i * 0.093 for i in range(12)] +
         [12.62 + i * 0.054 for i in range(114)])


def main():
    s = Score(DUR, CUTS, energy=ENERGY, motif=MOTIF, name="studio",
              resolve=40.3)
    s.build_ticks(TICKS, vel=0.058)
    buf = s.render()
    os.makedirs("out", exist_ok=True)
    s.write("out/score.wav", buf)
    s.report(buf)


if __name__ == "__main__":
    main()