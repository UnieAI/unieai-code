"""Score for the UnieAI Studio overview film -- see ../scorekit.py for the engine.

D dorian, 100 BPM, every cut on a bar line (4.8 s = two bars), so the
arrangement is written to the edit: Model Zoo (light), macro (drums in),
Playground (kick + bass, typing ticks), Fine-tuning (full), the job (full),
the endpoint (pull back), API keys (build), the agents you build (mid),
one wide look back (drop to pad + bells), copy card (just the mallets),
end card (maj9).

    python3 score.py            -> out/score.wav
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scorekit import Score, BAR  # noqa: E402

DUR = 52.8
CUTS = [0.0, 4.8, 9.6, 14.4, 19.2, 24.0, 28.8, 33.6, 38.4, 43.2, 48.0]
ENERGY = [1, 2, 2, 3, 3, 2, 2, 2, 1, 1]
MOTIF = [4, 4, 5, 4, 5, 5, 4, 5, 4, 5]

# the answer typing itself in the playground shot (shot starts at 9.6)
TICKS = [9.88 + i * 0.072 for i in range(24)]


def main():
    s = Score(DUR, CUTS, energy=ENERGY, motif=MOTIF, name="overview",
              resolve=43.2)
    s.build_ticks(TICKS, vel=0.075)
    buf = s.render()
    os.makedirs("out", exist_ok=True)
    s.write("out/score.wav", buf)
    s.report(buf)


if __name__ == "__main__":
    main()