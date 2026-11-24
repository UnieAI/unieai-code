"""Score for the UnieAI Code film -- the same picture, a colder room.

Where the Studio cues run on dorian warmth and a marimba ostinato, this one is
built to sound like a machine thinking in the dark:

  * D minor with the third held back -- Dm11 / Bbmaj7#11 / Gm9 / A7sus4b9, so
    the harmony never quite lands until the green test result at 30.5s,
  * a sub pedal under everything and a two-chord-per-five-second harmonic
    rhythm: nothing hurries,
  * no backbeat. A heartbeat kick on 1 and the "and" of 3, rim only when the
    picture is at full tilt, shakers instead of hats,
  * sonar bells (long, reverberant, panned) as the only melodic voice, plus a
    three-note cell that returns at the reports and resolves on the result,
  * gated noise ticks for servo texture, a riser into every hard cut, and an
    80 ms hole in front of the approval prompt.

Reuses the instrument and mastering primitives from ../scorekit.py (numpy only).
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scorekit import (SR, midi, place_st, rcos_ramp,
                      kick, rim, shaker, hat, bell, pulse_bass, pad_chord,
                      sub_tone, riser, impact, tick, reverb, Score)

DUR = 54.6

# cut times straight off the shot list
CUTS = [0.0, 3.2, 7.0, 12.0, 15.6, 20.4, 24.2, 28.0, 32.6, 37.0, 41.4,
        46.2, 51.0]

# 0 = drone alone, 1 = drone + pedal, 2 = the machine idles, 3 = it works
ENERGY = [1, 2, 2, 3, 2, 3, 2, 3, 2, 3, 2, 1, 0]

# --------------------------------------------------------------- harmony ----
# Explicit midi voicings. The bass roots are D / Bb / G / A; the top voice keeps
# A or E, which is why the cue sounds suspended rather than sad.
CH = {
    "Dm11":      (26, [50, 53, 57, 60, 64, 67]),   # D  F  A  C  E  G
    "Bbmaj7#11": (34, [58, 62, 64, 65, 69]),       # Bb D  E  F  A
    "Gm9":       (31, [55, 58, 62, 65, 69]),       # G  Bb D  F  A
    "A7sus4b9":  (33, [57, 62, 64, 67, 70]),       # A  D  E  G  Bb
    "Dm11r":     (26, [50, 57, 60, 64, 69, 74]),   # the resolve, A and D on top
}
LOOP = ["Dm11", "Bbmaj7#11", "Gm9", "A7sus4b9"]

# the three-note cell: A, Bb, D -- a semitone that never resolves upward
MOTIF = [69, 70, 74]

# my own bus table (per energy level)
BUS = {
    "drone": [1.00, 0.96, 0.92, 0.90],
    "pad":   [0.88, 0.92, 1.00, 1.00],
    "sub":   [0.50, 0.78, 0.90, 1.00],
    "pulse": [0.00, 0.34, 0.78, 1.00],
    "metal": [0.72, 0.86, 1.00, 1.00],
    "drums": [0.00, 0.00, 0.62, 1.00],
    "ticks": [1.00, 1.00, 1.00, 1.00],
    "fx":    [0.50, 0.72, 0.90, 1.00],
}


class CodeScore(Score):
    BPM = 84.0
    BEAT = 60.0 / BPM
    BAR = 4.0 * BEAT

    def __init__(self, dur=DUR, cuts=CUTS, energy=ENERGY, name="code"):
        super().__init__(dur, cuts, energy, name=name)

    # -- grid --------------------------------------------------------------
    def bars(self, t0=0.0, t1=None):
        t1 = self.dur if t1 is None else t1
        b = int(np.ceil(t0 / self.BAR - 1e-9))
        while b * self.BAR < t1 - 1e-9:
            yield b, b * self.BAR
            b += 1

    def chord(self, bar, t):
        if t >= self.dur - 1.6:
            return "Dm11r"
        return LOOP[(bar // 2) % 4]

    def bus_env(self, layer):
        g = BUS.get(layer)
        if g is None:
            return None
        env = np.zeros(self.N)
        for i in range(len(self.cuts)):
            t0, t1 = self.bounds(i)
            a, b = int(t0 * SR), min(int(t1 * SR), self.N)
            if b > a:
                env[a:b] = g[min(self.energy[i], len(g) - 1)]
        n = max(8, int(0.13 * SR))
        k = rcos_ramp(n)
        for i in range(1, len(self.cuts)):
            j = int(self.cuts[i] * SR)
            if j - n // 2 < 0 or j + n // 2 > self.N:
                continue
            a = env[j - n // 2]
            b = env[j + n // 2]
            env[j - n // 2:j - n // 2 + n] = a + (b - a) * k
        return env

    # -- layers ------------------------------------------------------------
    def build_drone(self):
        """the room tone: a sub pedal that never stops, plus a low cluster that
        swells with each chord instead of pulsing"""
        buf = np.zeros((self.N, 2))
        # the pedal: D below the chord roots, held the whole cue
        place_st(buf, sub_tone(midi(26), self.dur - 0.2, 0.030), 0.0)
        place_st(buf, sub_tone(midi(38), self.dur - 0.2, 0.014), 0.0)
        prev = None
        for bar, tb in self.bars():
            ch = self.chord(bar, tb)
            if bar % 2 or ch == prev:
                continue
            prev = ch
            root, voic = CH[ch]
            d = min(self.BAR * 2.0 + 0.6, self.dur - tb)
            if d <= 0.3:
                continue
            low = [midi(root + 24), midi(root + 31), midi(root + 36)]
            place_st(buf, pad_chord(low, d, vel=0.040, seed=101 + bar), tb)
            place_st(buf, sub_tone(midi(root), d, 0.026), tb)
        self.add("drone", buf)

    def build_pad(self):
        """the suspended top: same chords, two octaves up, very slow"""
        buf = np.zeros((self.N, 2))
        prev = None
        for bar, tb in self.bars():
            ch = self.chord(bar, tb)
            if bar % 2 or ch == prev:
                continue
            prev = ch
            root, voic = CH[ch]
            d = min(self.BAR * 2.0 + 0.5, self.dur - tb)
            if d <= 0.3:
                continue
            fr = [midi(m) for m in voic]
            place_st(buf, pad_chord(fr, d, vel=0.128, seed=80 + bar), tb)
            # a quiet fifth above keeps the cluster from closing on itself
            place_st(buf, pad_chord([midi(voic[-1] + 7)], d * 0.9, vel=0.030,
                                    seed=90 + bar), tb + self.BEAT)
        self.add("pad", buf)

    def build_pulse(self):
        """the machine's heartbeat: one pitch, eighths, filtered low so it reads
        as pressure rather than as a bass line (there is no bass line here)"""
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars():
            i = self.section_at(tb)
            e = self.energy[i]
            if e < 2:
                continue
            root = CH[self.chord(bar, tb)][0]
            steps = [(0.0, 0.112), (1.0, 0.064), (2.0, 0.088), (3.0, 0.064)]
            if e >= 3:
                steps += [(0.5, 0.046), (1.5, 0.046), (2.5, 0.052), (3.5, 0.046)]
            for off, v in steps:
                t = tb + off * self.BEAT
                if t >= self.dur:
                    continue
                place_st(buf, pulse_bass(midi(root), min(0.34, self.dur - t), v,
                                         cut=250.0 + 70.0 * e), t)
            if e >= 3:
                for off in (0.0, 2.0):
                    t = tb + off * self.BEAT
                    if t >= self.dur:
                        continue
                    place_st(buf, pulse_bass(midi(root + 12),
                                             min(0.30, self.dur - t), 0.062,
                                             cut=520.0), t)
        # duck the pulse under every kick, so the two never fight
        duck = np.ones(self.N)
        for bar, tb in self.bars():
            if self.energy[self.section_at(tb)] < 2:
                continue
            for off in (0.0, 2.5):
                j = int((tb + off * self.BEAT) * SR)
                n = min(int(0.19 * SR), self.N - j)
                if n <= 0:
                    continue
                x = np.linspace(0, np.pi, n)
                duck[j:j + n] = np.minimum(duck[j:j + n],
                                           0.42 + 0.58 * (1 - np.cos(x)) * 0.5)
        self.add("pulse", buf * duck[:, None])

    def build_metal(self):
        """sonar: long bells, one per two bars, panned hard, plus the motif that
        carries the story"""
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars():
            i = self.section_at(tb)
            e = self.energy[i]
            if e < 1:
                continue
            root, voic = CH[self.chord(bar, tb)]
            if bar % 2 == 0:
                # a ping on the ninth of the chord, three octaves up
                f = midi(voic[-1] + 12)
                place_st(buf, bell(f, 0.130, dur=2.6, dec=0.62, seed=60 + bar),
                         tb + self.BEAT * 2.5, pan=0.42)
            elif bar % 4 == 1:
                f = midi(voic[-1] + 24)
                place_st(buf, bell(f, 0.072, dur=2.8, dec=0.80, seed=66 + bar),
                         tb + self.BEAT * 0.5, pan=-0.20)
            else:
                f = midi(root + 43)
                place_st(buf, bell(f, 0.082, dur=2.2, dec=0.70, seed=70 + bar),
                         tb + self.BEAT * 1.5, pan=-0.46)
        # the cell, at the four places the story turns
        for t0, vel, pan in ((12.05, 0.105, -0.30), (20.45, 0.118, 0.28),
                             (37.05, 0.096, -0.34)):
            for j, m in enumerate(MOTIF):
                t = t0 + j * self.BEAT * 0.5
                if t < self.dur:
                    place_st(buf, bell(midi(m) , vel, dur=1.6, dec=0.42,
                                       seed=31 + j), t, pan=pan)
        # the resolve: the third finally arrives over a held fifth
        for j, (m, vel) in enumerate(((62, 0.130), (69, 0.098), (74, 0.112))):
            t = 30.55 + j * 0.34
            if t < self.dur:
                place_st(buf, bell(midi(m), vel, dur=3.2, dec=0.80, seed=51 + j),
                         t, pan=0.10 * (j - 1))
        # and the last note of the film, alone
        place_st(buf, bell(midi(74), 0.090, dur=3.6, dec=0.85, seed=88), 46.30,
                 pan=0.0)
        place_st(buf, bell(midi(81), 0.062, dur=3.4, dec=0.9, seed=89), 48.90,
                 pan=0.16)
        self.add("metal", buf)

    def build_drums(self):
        """no backbeat: a heartbeat kick, a rim only at full tilt, shakers in
        place of hats"""
        k = np.zeros((self.N, 2))
        r = np.zeros((self.N, 2))
        h = np.zeros((self.N, 2))
        for bar, tb in self.bars():
            i = self.section_at(tb)
            e = self.energy[i]
            if e < 2:
                continue
            # heartbeat: 1 and the "and" of 3
            for off, v in ((0.0, 0.62), (2.5, 0.44)):
                t = tb + off * self.BEAT
                if t < self.dur:
                    place_st(k, kick(v, seed=1 + bar), t)
            if e >= 3:
                if bar % 2 == 1:
                    t = tb + 1.75 * self.BEAT
                    if t < self.dur:
                        place_st(k, kick(0.30, seed=17 + bar), t)
                for off, v in ((1.0, 0.34), (3.0, 0.30)):
                    t = tb + off * self.BEAT
                    if t < self.dur:
                        place_st(r, rim(v, seed=2 + bar), t)
            # shakers on the eighths, quiet, alternating side
            for j in range(8):
                t = tb + j * self.BEAT / 2.0
                if t >= self.dur:
                    break
                if e == 2 and j % 2 == 1:
                    continue
                v = 0.190 if j % 2 == 0 else 0.120
                if j == 7:
                    v *= 1.35
                place_st(h, shaker(v, seed=3 + bar * 8 + j,
                                   dec=0.030 if j % 2 == 0 else 0.022), t,
                         pan=0.34 if j % 2 else -0.30)
            t = tb + 3.5 * self.BEAT
            if e >= 3 and t < self.dur:
                place_st(h, hat(0.24, seed=41 + bar, dec=0.075), t, pan=0.20)
        self.add("kick", k)
        self.add("rim", r)
        self.add("hats", h)
        self.parts["drums"] = (k + r + h) * 0.52
        for key in ("kick", "rim", "hats"):
            self.parts.pop(key)

    def build_ticks(self):
        """servo texture: sixteenth noise ticks, gated in fours, low in the mix"""
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars():
            i = self.section_at(tb)
            if self.energy[i] < 1:
                continue
            pat = (1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1) \
                if self.energy[i] >= 3 else (1, 0, 0, 0, 1, 0, 0, 0,
                                             1, 0, 0, 0, 0, 0, 1, 0)
            for j, on in enumerate(pat):
                if not on:
                    continue
                t = tb + j * self.BEAT / 4.0
                if t >= self.dur:
                    break
                place_st(buf, tick(3000.0 + 420.0 * (j % 3), 0.115,
                                   seed=90 + j % 7), t,
                         pan=0.22 * ((j % 3) - 1))
        # UI events: typing, the menu, the approval
        times = []
        for j in range(24):                       # the prompt being typed
            times.append(3.25 + j * 0.153)
        times += [29.30, 29.90, 37.90, 38.40, 39.60, 40.30, 40.85, 44.60, 46.20]
        for j, t in enumerate(times):
            if t >= self.dur:
                continue
            place_st(buf, tick(2100.0 + 420.0 * (j % 3), 0.100, seed=61 + j % 5),
                     t, pan=0.16 * ((j % 3) - 1))
        self.add("ticks", buf)

    def build_cuts(self):
        """every cut is heard, and the two big ones are heard as a hole"""
        buf = np.zeros((self.N, 2))
        for c in self.cuts:
            if c <= 0.15 or c >= self.dur - 0.1:
                continue
            i = self.section_at(c)
            e = self.energy[i]
            if e >= 2:
                place_st(buf, impact(0.44 if e >= 3 else 0.32, seed=31 + int(c)), c)
            if e >= 2:
                r = min(0.58, c)
                place_st(buf, riser(r, 0.11 if e >= 3 else 0.09,
                                    seed=13 + int(c)), c - r)
        self.add("fx", buf)

    # -- mix ---------------------------------------------------------------
    def render(self):
        self.build_drone()
        self.build_pad()
        self.build_pulse()
        self.build_metal()
        self.build_drums()
        self.build_ticks()
        self.build_cuts()
        for key in list(self.parts):
            env = self.bus_env(key)
            if env is not None:
                self.parts[key] = self.parts[key] * env[:, None]
        buf = sum(self.parts.values())
        # the hole: 80 ms of nothing before the approval prompt lands
        a, b = int(27.86 * SR), int(27.94 * SR)
        x = np.linspace(0, np.pi, b - a)
        ramp = 0.5 + 0.5 * np.cos(x)
        buf[a:b] *= ramp[:, None]
        send = (self.parts.get("metal", 0) * 1.30 +
                self.parts.get("pad", 0) * 0.55 +
                self.parts.get("rim", 0) * 0.0 +
                np.zeros((self.N, 2)))
        send = send + self.parts.get("ticks", 0) * 0.40
        buf = buf + reverb(send, decay=2.10, mix=0.32, seed=77) * 0.62
        return self.master(buf)


def main():
    s = CodeScore()
    buf = s.render()
    s.write("out/score.wav", buf)
    print("%s  %.1fs  BPM %.0f  LUFS %.1f  peak %.2f dBFS" % (
        s.name, s.dur, s.BPM, s.lufs(buf), 20 * np.log10(np.abs(buf).max())))
    for k, v in sorted(s.parts.items()):
        print("  %-6s peak %.3f" % (k, float(np.abs(v).max())))
    mono = buf.mean(axis=1)
    win = int(s.BAR * SR)
    print("energy arc (per %0.2fs bar):" % s.BAR)
    rows = []
    for i in range(0, s.N - win, win):
        rms = np.sqrt(np.mean(mono[i:i + win] ** 2))
        db = 20 * np.log10(max(rms, 1e-9))
        rows.append("%5.1fs %6.1f dB %s" % (i / SR, db, "#" * int(max(0, 62 + db))))
    print("\n".join(rows))


if __name__ == "__main__":
    main()