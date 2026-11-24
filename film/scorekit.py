"""Shared score engine for the UnieAI films: D dorian, 100 BPM, synthesised from
scratch (numpy only -- no samples, no scipy, no soundfile).

The direction the client asked for: a kick you can feel, several layers stacked so
the music changes as the picture changes, plenty of scale motion (the top line
walks the D dorian scale rather than looping three notes), and a modern electronic
timbre -- FM marimba/celesta ostinato, sidechained analog pulse bass, tight drum
machine, glass bells, and a warm maj9 pad under everything.

A film calls `arrange()` with its own cue sheet (cut times, energy per section,
per-section motif register), so the same kit scores every cut without re-tuning.

    from scorekit import Score
    s = Score(dur=48.0, cuts=[0, 4.8, 9.6, ...], energy=[1,2,2,3,3,3,2,1])
    buf = s.render()            # (N, 2) float64, already equal-loudness trimmed
    s.write("out/score.wav", buf)
"""

import wave

import numpy as np

# ------------------------------------------------------------------ timing ---
SR = 48000
BPM = 100.0
BEAT = 60.0 / BPM           # 0.600 s
BAR = 4.0 * BEAT            # 2.400 s
SIX = BEAT / 4.0            # 0.150 s

# D dorian, one octave from D3 up to D6
SCALE = ["D", "E", "F", "G", "A", "B", "C"]
PC = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
      "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def midi(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def nm(name, octv):
    """'F4' -> frequency"""
    return midi(12 * (int(octv) + 1) + PC[name])


def deg(step, base_oct=4):
    """scale step (0 = D) -> frequency, wrapping octaves"""
    o, i = divmod(step, 7)
    return nm(SCALE[i], base_oct + o)


# ------------------------------------------------------------- primitives ---
def rcos_ramp(n, rising=True):
    """raised-cosine fade, so nothing ever starts or stops on a click"""
    x = np.linspace(0.0, np.pi, n)
    y = (1.0 - np.cos(x)) * 0.5
    return y if rising else y[::-1]


def place(buf, sig, t0):
    sig = np.asarray(sig)
    if sig.ndim == 2 and buf.ndim == 1:
        sig = sig.mean(axis=1)
    elif sig.ndim == 1 and buf.ndim == 2:
        sig = np.repeat(sig[:, None], buf.shape[1], axis=1)
    i = int(round(t0 * SR))
    if i >= buf.shape[0]:
        return
    if i < 0:
        sig = sig[-i:]
        i = 0
    n = min(sig.shape[0], buf.shape[0] - i)
    if n <= 0:
        return
    if sig.ndim == 2 and buf.ndim == 2:
        buf[i:i + n, :] += sig[:n, :]
    else:
        buf[i:i + n] += sig[:n]


def place_st(buf, sig, t0, pan=0.0, gain=1.0):
    """equal-power pan, -1 left .. +1 right"""
    a = (pan + 1.0) * np.pi / 4.0
    s = np.asarray(sig) * gain
    place(buf[:, 0], s * np.cos(a) * 1.4142, t0)
    place(buf[:, 1], s * np.sin(a) * 1.4142, t0)


def envelope(n, attack, release):
    e = np.ones(n)
    a = min(n, max(1, int(attack * SR)))
    r = min(n, max(1, int(release * SR)))
    e[:a] *= rcos_ramp(a)
    e[-r:] *= rcos_ramp(r, rising=False)
    return e


def band_mask(freqs, lo, hi, soft=0.55):
    """smooth band-pass magnitude mask; `soft` in octaves of skirt"""
    lo = max(lo, 1.0)
    m = 1.0 / (1.0 + (lo / np.maximum(freqs, 1e-6)) ** (4.0 / soft))
    m *= 1.0 / (1.0 + (np.maximum(freqs, 1e-6) / hi) ** (4.0 / soft))
    return m


def nz(n, lo, hi, seed, soft=0.60, pad=None):
    """band-limited noise burst"""
    rng = np.random.default_rng(seed)
    m = pad if pad is not None else n
    x = rng.standard_normal(m)
    if m != n:
        x = np.concatenate([x[:n], np.zeros(0)])
    f = np.fft.rfftfreq(len(x), 1 / SR)
    x = np.fft.irfft(np.fft.rfft(x) * band_mask(f, lo, hi, soft), len(x))[:n]
    m2 = np.abs(x).max()
    return x / (m2 if m2 > 1e-9 else 1.0)


def grid(t0, t1, div=1, swing=0.0):
    """event times between t0 and t1 on a `div`-per-beat grid (div 1 = beats,
    2 = eighths, 4 = sixteenths); `swing` delays the off-eighths"""
    step = BEAT / div
    out = []
    i = int(np.ceil(t0 / step - 1e-9))
    while True:
        t = i * step
        if t >= t1 - 1e-9:
            break
        if swing and (i % 2):
            t += swing * step * 0.5
        out.append((i, t))
        i += 1
    return out


# -------------------------------------------------------------- instruments ---
def kick(vel=0.62, seed=1, dur=0.42):
    """punchy drum-machine kick: a fast pitch drop plus a short beater click"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 46.0 + 96.0 * np.exp(-t / 0.031)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t / 0.145)
    click = nz(n, 1100.0, 5200.0, seed) * np.exp(-t / 0.0055) * 0.30
    sub = np.sin(2 * np.pi * f * 0.5 * t) * np.exp(-t / 0.22) * 0.42
    x = (body + click + sub) * vel
    x[:24] *= rcos_ramp(24)
    return x


def rim(vel=0.30, seed=2, dur=0.16):
    """tight rimshot/snare body -- the backbeat, dry"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 186.0 * t) * np.exp(-t / 0.032) * 0.55
    snap = nz(n, 1500.0, 7200.0, seed) * np.exp(-t / 0.021)
    x = (body + snap) * vel
    x[:16] *= rcos_ramp(16)
    return x


def shaker(vel=0.13, seed=4, dur=0.10, dec=0.030):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = nz(n, 3800.0, 13500.0, seed) * np.exp(-t / dec) * vel
    x[:12] *= rcos_ramp(12)
    return x


def hat(vel=0.16, seed=3, dur=0.22, dec=0.045):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = nz(n, 6000.0, 15500.0, seed) * np.exp(-t / dec) * vel
    x[:12] *= rcos_ramp(12)
    return x


def marimba(freq, vel=0.20, dur=1.10, seed=30, bright=1.0, dec=0.26):
    """two-operator FM mallet: wooden attack, fast index decay, clean tail --
    this is the ostinato voice the client wanted more scale motion from"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    mod = np.sin(2 * np.pi * freq * 4.0 * t) * np.exp(-t / 0.021) * 2.6 * bright
    car = np.sin(2 * np.pi * freq * t + mod)
    tail = np.sin(2 * np.pi * freq * 2.0 * t) * np.exp(-t / (dec * 0.55)) * 0.10
    x = (car * np.exp(-t / dec) + tail) * vel
    x *= envelope(n, 0.0015, 0.05)
    return x


def bell(freq, vel=0.18, dur=2.30, seed=60, dec=0.62):
    """glass bell: one clean partial pair, inharmonic, long shimmer"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) * np.exp(-t / dec)
    x += np.sin(2 * np.pi * freq * 2.756 * t) * np.exp(-t / (dec * 0.42)) * 0.34
    x += np.sin(2 * np.pi * freq * 5.404 * t) * np.exp(-t / (dec * 0.20)) * 0.13
    x *= vel * envelope(n, 0.004, 0.28)
    return x


def pulse_bass(freq, dur, vel=0.30, seed=70, cut=340.0):
    """analog pulse bass: odd/even partials, gentle one-pole low-pass by FFT,
    then the kick ducks it (the ducking is applied in the mix, not here)"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, 13):
        amp = (1.0 / k) * (0.72 if k % 2 else 1.0)
        x += amp * np.sin(2 * np.pi * freq * k * t)
    f = np.fft.rfftfreq(n, 1 / SR)
    x = np.fft.irfft(np.fft.rfft(x) * band_mask(f, 30.0, cut, soft=0.85), n)
    x *= envelope(n, 0.008, 0.055) * vel
    x /= max(np.abs(x).max(), 1e-9)
    x *= vel * 1.9
    return x


def pad_chord(freqs, dur, vel=0.13, seed=80, cut=1900.0):
    """four detuned voices per note, slow attack, soft top end"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for j, f0 in enumerate(freqs):
        for k, det in enumerate((-0.006, -0.002, 0.002, 0.006)):
            f = f0 * (1.0 + det)
            ph = (seed + j * 7 + k) * 0.37
            x += np.sin(2 * np.pi * f * t + ph)
            x += 0.30 * np.sin(2 * np.pi * 2 * f * t + ph * 1.7)
    f = np.fft.rfftfreq(n, 1 / SR)
    x = np.fft.irfft(np.fft.rfft(x) * band_mask(f, 90.0, cut, soft=0.9), n)
    x *= envelope(n, 0.75, 0.9)
    x /= max(np.abs(x).max(), 1e-9)
    return x * vel


def sub_tone(freq, dur, vel=0.16):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) * envelope(n, 0.02, 0.10)
    return x * vel


def riser(dur, vel=0.16, seed=11):
    """noise sweep + rising tone, for the two and a half beats before a cut"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    f = np.fft.rfftfreq(n, 1 / SR)
    out = np.zeros(n)
    seg = max(1, n // 12)
    for i in range(0, n, seg):
        hi = 900.0 + 9000.0 * (i / n)
        m = band_mask(f, hi * 0.45, hi, 0.7)
        block = np.fft.irfft(np.fft.rfft(x) * m, n)
        out[i:i + seg] += block[i:i + seg]
    out /= max(np.abs(out).max(), 1e-9)
    out *= np.linspace(0.15, 1.0, n) ** 1.6 * vel
    tone_f = np.geomspace(320.0, 1250.0, n)
    tone = np.sin(2 * np.pi * np.cumsum(tone_f) / SR) * np.linspace(0, 1, n) ** 2
    return (out + tone * vel * 0.5) * envelope(n, 0.02, 0.02)


def impact(vel=0.55, seed=21):
    """the downbeat thump that lands on a cut"""
    n = int(1.5 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * (58.0 - 22.0 * t) * t) * np.exp(-t / 0.28)
    air = nz(n, 250.0, 6000.0, seed) * np.exp(-t / 0.10) * 0.55
    x = (body + air) * vel
    x[:32] *= rcos_ramp(32)
    return x


def tick(freq=1900.0, vel=0.11, dec=0.014, seed=9):
    n = int(0.10 * SR)
    t = np.arange(n) / SR
    x = (np.sin(2 * np.pi * freq * t) * 0.6 + nz(n, freq * 0.6, 9000.0, seed) * 0.5)
    x *= np.exp(-t / dec) * vel
    x[:10] *= rcos_ramp(10)
    return x


def reverb(x, decay=1.6, mix=0.24, seed=99, lo=200.0, hi=9000.0):
    """cheap convolver: a decaying noise tail shaped to the band"""
    n = x.shape[0]
    m = int(decay * SR)
    t = np.arange(m) / SR
    ir = np.random.default_rng(seed).standard_normal(m) * np.exp(-t / (decay / 3.4))
    f = np.fft.rfftfreq(m, 1 / SR)
    ir = np.fft.irfft(np.fft.rfft(ir) * band_mask(f, lo, hi, 0.8), m)
    ir /= max(np.abs(ir).max(), 1e-9)
    ir[:int(0.012 * SR)] *= rcos_ramp(int(0.012 * SR))
    L = 1 << int(np.ceil(np.log2(n + m)))
    wet = np.zeros_like(x)
    for ch in range(x.shape[1]):
        y = np.fft.irfft(np.fft.rfft(x[:, ch], L) * np.fft.rfft(ir, L), L)[:n]
        wet[:, ch] = y
    wet /= max(np.abs(wet).max(), 1e-9)
    wet *= np.abs(x).max()
    return x * (1.0 - mix) + wet * mix


# ------------------------------------------------------------------ chords ---
# each entry: name, bass root (midi), pad voicing (scale steps, octave base)
CHORDS = {
    "Dm9":    (38, [0, 2, 4, 7, 9]),      # D  F  A  C  E
    "Gm9":    (43, [3, 5, 7, 10, 12]),    # G  Bb D  F  A
    "Bbmaj7": (46, [5, 7, 9, 12, 14]),    # Bb D  F  A  C
    "C69":    (48, [7, 9, 11, 14, 16]),   # C  E  G  A  D
    "Am7":    (45, [4, 7, 9, 12]),        # A  C  E  G
    "Dmaj9":  (38, [0, 2, 4, 7, 11]),     # D  F# A  C# E  (the warm resolution)
}

# four-bar loop, with a variant every eighth bar so the loop never feels closed
LOOP_A = ["Dm9", "Bbmaj7", "Gm9", "C69"]
LOOP_B = ["Dm9", "Gm9", "Bbmaj7", "Am7"]


def harmony(bar_index, loops=None):
    loop = LOOP_A if (bar_index // 4) % 2 == 0 else LOOP_B
    return loop[bar_index % 4]


def voicing(name, octv=4):
    root, steps = CHORDS[name]
    return [deg(s, octv) for s in steps]


# per-energy bus level: the arrangement keeps its density, the mix opens and
# closes with the picture, so the arc is smooth instead of dropping a layer
BUS = {
    "pad":   [1.15, 1.00, 1.00, 1.00],
    "sub":   [0.00, 0.85, 1.00, 1.00],
    "kick":  [0.00, 0.74, 1.00, 1.00],
    "rim":   [0.00, 0.00, 0.88, 1.00],
    "hats":  [0.00, 0.45, 0.90, 1.00],
    "bass":  [0.00, 0.60, 1.00, 1.00],
    "ost":   [0.52, 0.84, 1.00, 1.00],
    "bell":  [0.55, 0.80, 1.00, 1.00],
    "fx":    [0.00, 0.85, 1.00, 1.00],
    "ticks": [1.00, 1.00, 1.00, 1.00],
}


# ------------------------------------------------------------------- score ---
class Score:
    def __init__(self, dur, cuts, energy=None, motif=None, name="film", resolve=None):
        self.dur = float(dur)
        self.N = int(round(self.dur * SR))
        self.cuts = [float(c) for c in cuts]
        self.name = name
        n = len(self.cuts)
        # energy 0..3 per section: 0 = pad only, 3 = everything, moving
        self.energy = list(energy) if energy else [2] * n
        while len(self.energy) < n:
            self.energy.append(self.energy[-1])
        # motif register per section (scale octave for the top line)
        self.motif = list(motif) if motif else [4] * n
        while len(self.motif) < n:
            self.motif.append(self.motif[-1])
        # from `resolve` on, every bar sits on a warm maj9 instead of the loop,
        # so the card lands on a consonant resolution rather than a cut chord
        self.resolve = resolve
        self.parts = {}

    # -- helpers -----------------------------------------------------------
    def section_at(self, t):
        i = 0
        for k, c in enumerate(self.cuts):
            if t >= c - 1e-9:
                i = k
        return i

    def bounds(self, i):
        t0 = self.cuts[i]
        t1 = self.cuts[i + 1] if i + 1 < len(self.cuts) else self.dur
        return t0, min(t1, self.dur)

    def chord(self, bar, t):
        if self.resolve is not None and t >= self.resolve - 1e-9:
            return "Dmaj9"
        return harmony(bar)

    def bars(self, t0, t1):
        b0 = int(np.ceil(t0 / BAR - 1e-9))
        while b0 * BAR < t1 - 1e-9:
            yield b0, b0 * BAR
            b0 += 1

    def add(self, key, buf):
        self.parts[key] = self.parts.get(key, np.zeros((self.N, 2))) + buf

    # -- layers ------------------------------------------------------------
    def build_pad(self):
        buf = np.zeros((self.N, 2))
        for bar, t in self.bars(0.0, self.dur):
            ch = self.chord(bar, t)
            d = min(BAR * 2.0, self.dur - t)
            v = voicing(ch, 4)
            sig = pad_chord(v, d + 0.35, vel=0.115)
            place_st(buf, sig, t, pan=0.0)
            if bar % 2 == 0:
                place_st(buf, pad_chord([f / 2 for f in voicing(ch, 3)], d + 0.4, vel=0.062),
                         t, pan=0.0)
        self.add("pad", buf)

    def build_sub(self):
        buf = np.zeros((self.N, 2))
        for bar, t in self.bars(0.0, self.dur):
            root = CHORDS[self.chord(bar, t)][0]
            i = self.section_at(t)
            if self.energy[i] < 1:
                continue
            place_st(buf, sub_tone(midi(root), min(BAR, self.dur - t) + 0.2, 0.105), t)
        self.add("sub", buf)

    def build_drums(self):
        k = np.zeros((self.N, 2))
        r = np.zeros((self.N, 2))
        h = np.zeros((self.N, 2))
        for bar, tb in self.bars(0.0, self.dur):
            i = self.section_at(tb)
            e = self.energy[i]
            if e < 1:
                continue
            # kick on 1 and 3
            for beat in (0, 2):
                place(k, kick(0.62 if beat == 0 else 0.52, seed=1 + bar),
                      tb + beat * BEAT)
            if e >= 2:                            # pickup before the next bar
                place(k, kick(0.36, seed=3 + bar), tb + 2.5 * BEAT)
            if e >= 3:
                place(k, kick(0.30, seed=5 + bar), tb + 3.75 * BEAT)
            # rim on the backbeat
            if e >= 2:
                place(r, rim(0.52, seed=7 + bar), tb + 1.0 * BEAT)
                place(r, rim(0.58, seed=9 + bar), tb + 3.0 * BEAT)
            # sixteenth shaker, accented on the eighths
            for j, t in grid(tb, tb + BAR, 4):
                if t >= self.dur:
                    break
                v = 0.30 if j % 4 == 0 else (0.19 if j % 2 == 0 else 0.13)
                place_st(h, shaker(v, seed=20 + j + bar), t,
                         pan=0.35 if j % 2 else -0.30)
            if e >= 2:
                place_st(h, hat(0.36, seed=41 + bar), tb + 3.5 * BEAT, pan=0.28)
                place_st(h, hat(0.24, seed=43 + bar), tb + 1.5 * BEAT, pan=-0.24)
        self.add("kick", k)
        self.add("rim", r)
        self.add("hats", h)

    def build_bass(self):
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars(0.0, self.dur):
            i = self.section_at(tb)
            e = self.energy[i]
            root, steps = CHORDS[self.chord(bar, tb)]
            fifth = midi(root + 7)
            octv = midi(root + 12)
            pat = [(0.0, 0.42, midi(root)), (1.5, 0.24, midi(root)),
                   (2.0, 0.24, fifth), (2.75, 0.30, octv), (3.5, 0.40, midi(root))]
            if e < 3:
                pat = pat[:4]
            for beat, dur, f in pat:
                t = tb + beat * BEAT
                if t >= self.dur:
                    break
                place_st(buf, pulse_bass(f, min(dur + 0.06, self.dur - t), 0.235,
                                         cut=300.0 + 90.0 * e), t)
        # duck the bass under every kick -- the pump is what makes it feel electronic
        duck = np.ones(self.N)
        for bar, tb in self.bars(0.0, self.dur):
            i = self.section_at(tb)
            if self.energy[i] < 2:
                continue
            for off in (0.0, 2.0 * BEAT, 2.5 * BEAT, 3.75 * BEAT):
                t = tb + off
                j = int(t * SR)
                n = min(int(0.20 * SR), self.N - j)
                if n <= 0:
                    continue
                x = np.linspace(0, np.pi, n)
                duck[j:j + n] = np.minimum(duck[j:j + n], 0.42 + 0.58 * (1 - np.cos(x)) * 0.5)
        self.add("bass", buf * duck[:, None])

    def build_ostinato(self):
        """the sixteenth marimba figure -- scale motion, not a fixed loop: each bar
        walks up the dorian scale from the chord's root and the top note climbs a
        step every four bars"""
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars(0.0, self.dur):
            i = self.section_at(tb)
            e = self.energy[i]
            root, steps = CHORDS[self.chord(bar, tb)]
            base = self.motif[i]
            climb = (bar // 4) % 3
            pat = [0, 2, 4, 6, 5, 4, 2, 1]          # scale steps, up then back
            for j in range(8):
                t = tb + j * (BEAT / 2.0)
                if t >= self.dur:
                    break
                s = pat[j] + climb + (0 if j % 2 == 0 else 1)
                f = deg(s, base)
                v = (0.26 if e >= 2 else 0.17) * (1.0 if j % 2 == 0 else 0.74)
                if e >= 3 and j in (3, 7):
                    v *= 0.85
                place_st(buf, marimba(f, v, dur=1.05, seed=50 + j + bar, bright=1.5,
                                      dec=0.26 if e >= 2 else 0.34),
                         t, pan=(-0.22 if j % 2 == 0 else 0.22))
        self.add("ost", buf)

    def build_melody(self):
        """glass-bell motif on the downbeat of every second bar: a rising scale
        figure that answers the ostinato an octave up"""
        buf = np.zeros((self.N, 2))
        for bar, tb in self.bars(0.0, self.dur):
            i = self.section_at(tb)
            if self.energy[i] < 1 or bar % 2:
                continue
            base = self.motif[i] + 1
            phrase = [(0, 5), (0.75, 6), (1.5, 7), (2.25, 9)]
            for beat, s in phrase:
                t = tb + beat * BEAT
                if t >= self.dur:
                    break
                place_st(buf, bell(deg(s, base), 0.135, dur=1.9, seed=60 + int(s)),
                         t, pan=0.10 if beat else -0.10)
        self.add("bell", buf)

    def build_cuts(self):
        """every cut is heard: a riser into it, an impact on it"""
        buf = np.zeros((self.N, 2))
        for c in self.cuts:
            if c <= 0.15 or c >= self.dur - 0.05:
                continue
            i = self.section_at(c)
            if self.energy[i] >= 1:
                place(buf, impact(0.34 if self.energy[i] < 3 else 0.44, seed=31 + int(c)),
                      c)
            r = min(0.62, c)                     # two and a half beats of riser
            place(buf, riser(r, 0.115 if self.energy[i] < 3 else 0.145,
                             seed=13 + int(c)), c - r)
        self.add("fx", buf)

    def build_ticks(self, times, vel=0.10):
        """UI sounds: keystrokes, submits, checkmarks"""
        buf = np.zeros((self.N, 2))
        for j, t in enumerate(times):
            place_st(buf, tick(1700.0 + 400.0 * (j % 3), vel, seed=90 + j % 7), t,
                     pan=0.12 * ((j % 3) - 1))
        self.add("ticks", buf)

    # -- mix ---------------------------------------------------------------
    def bus_env(self, layer):
        """section-wise gain for one bus, smoothed over 90 ms at each cut"""
        g = BUS.get(layer)
        if g is None:
            return None
        env = np.zeros(self.N)
        for i in range(len(self.cuts)):
            t0, t1 = self.bounds(i)
            a, b = int(t0 * SR), min(int(t1 * SR), self.N)
            if b > a:
                env[a:b] = g[min(self.energy[i], len(g) - 1)]
        n = max(8, int(0.09 * SR))
        k = rcos_ramp(n)
        for i in range(1, len(self.cuts)):
            j = int(self.cuts[i] * SR)
            if j + n >= self.N:
                continue
            a = env[j - n // 2]
            b = env[j + n // 2]
            env[j - n // 2:j - n // 2 + n] = a + (b - a) * k
        return env

    def render(self, reverb_mix=0.22):
        self.build_pad()
        self.build_sub()
        self.build_drums()
        self.build_bass()
        self.build_ostinato()
        self.build_melody()
        self.build_cuts()
        for key in list(self.parts):
            env = self.bus_env(key)
            if env is not None:
                self.parts[key] = self.parts[key] * env[:, None]
        buf = sum(self.parts.values())
        # one shared plate for the percussion and the mallets
        send = (self.parts.get("ost", 0) + self.parts.get("bell", 0) +
                self.parts.get("rim", 0) * 0.5 + self.parts.get("hats", 0) * 0.35)
        buf = buf + reverb(send, decay=1.5, mix=reverb_mix) * 0.55
        buf = self.master(buf)
        return buf

    @staticmethod
    def _limit(buf, th=0.97, knee=0.72):
        """linear below `knee`, bends towards `th` above it, so only the kick and
        impact transients are touched and the body of the mix stays untouched"""
        a = np.abs(buf)
        out = buf.copy()
        m = a > knee
        if m.any():
            span = th - knee
            out[m] = np.sign(buf[m]) * (knee + span * np.tanh((a[m] - knee) / span))
        return out

    def master(self, buf):
        f = np.fft.rfftfreq(self.N, 1 / SR)
        hp = band_mask(f, 26.0, 20000.0, soft=0.9)
        with np.errstate(divide="ignore"):
            fq = np.maximum(f, 1.0)
            # presence for the mallets and hats, and a small low cut so the
            # bass does not fill the whole low mids
            shelf = 10 ** ((4.2 / 20.0) / (1.0 + (3300.0 / fq) ** 2))
            lowcut = 10 ** ((-1.6 / 20.0) / (1.0 + (fq / 230.0) ** 2))
        eq = hp * shelf * lowcut
        for ch in range(2):
            buf[:, ch] = np.fft.irfft(np.fft.rfft(buf[:, ch]) * eq, self.N)
        fi = int(0.5 * SR)
        buf[:fi] *= rcos_ramp(fi)[:, None]
        fo = int(1.5 * SR)
        buf[-fo:] *= rcos_ramp(fo, rising=False)[:, None]
        buf *= 0.70 / (np.abs(buf).max() or 1.0)
        # one measured linear gain to the delivery loudness, limited once so the
        # kick transients cannot clip
        for _ in range(2):
            buf *= self.gain_for_target(buf, -18.0)
            buf = self._limit(buf)
        self.loudness = self.lufs(buf)
        return buf

    # BS.1770 K-weighting, 48 kHz: high shelf then high pass. Applied in the
    # frequency domain (magnitude only), which is exact for these biquads and
    # avoids needing a sample-by-sample IIR.
    K_SHELF_B = (1.53512485958697, -2.69169618940638, 1.19839281085285)
    K_SHELF_A = (1.0, -1.69065929318241, 0.73248077421585)
    K_HP_B = (1.0, -2.0, 1.0)
    K_HP_A = (1.0, -1.99004745483398, 0.99007225036621)

    @classmethod
    def _k_weight(cls, n):
        f = np.fft.rfftfreq(n, 1 / SR)
        w = 2 * np.pi * f / SR

        def h(b, a):
            num = sum(bk * np.exp(-1j * w * k) for k, bk in enumerate(b))
            den = sum(ak * np.exp(-1j * w * k) for k, ak in enumerate(a))
            return num / den

        return np.abs(h(cls.K_SHELF_B, cls.K_SHELF_A) * h(cls.K_HP_B, cls.K_HP_A))

    @classmethod
    def lufs(cls, buf):
        """ITU-R BS.1770-4 integrated loudness (gate at -70 LUFS, then -10 LU)"""
        n = buf.shape[0]
        k = cls._k_weight(n)
        ms = np.zeros(n)
        for ch in range(buf.shape[1]):
            y = np.fft.irfft(np.fft.rfft(buf[:, ch]) * k, n)
            ms += y ** 2        # BS.1770 sums the channels, no division
        win, hop = int(0.4 * SR), int(0.1 * SR)
        blocks = np.array([ms[i:i + win].mean() for i in range(0, n - win, hop)])
        if not blocks.size:
            return -70.0
        lk = -0.691 + 10 * np.log10(np.maximum(blocks, 1e-14))
        gated = blocks[lk > -70.0]
        if not gated.size:
            return -70.0
        thr = -0.691 + 10 * np.log10(gated.mean()) - 10.0
        gated = gated[-0.691 + 10 * np.log10(np.maximum(gated, 1e-14)) > thr]
        if not gated.size:
            return -70.0
        return -0.691 + 10 * np.log10(gated.mean())

    def gain_for_target(self, buf, target):
        cur = self.lufs(buf)
        return 10 ** ((target - cur) / 20.0)

    def write(self, path, buf):
        pcm = np.clip(buf * 32767.0, -32768, 32767).astype("<i2")
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())

    def report(self, buf):
        mono = buf.mean(axis=1)
        pk = np.abs(buf).max()
        lufs = self.lufs(buf)
        print("%s  %.2f s  peak %.2f dBFS  %.2f LUFS" %
              (self.name, self.dur, 20 * np.log10(max(pk, 1e-9)), lufs))
        print("layer balance:")
        tot = sum(float((p ** 2).sum()) for p in self.parts.values()) or 1.0
        for k, p in self.parts.items():
            print("  %-6s %5.1f %%" % (k, 100 * float((p ** 2).sum()) / tot))
        sp = np.abs(np.fft.rfft(mono))
        fr = np.fft.rfftfreq(self.N, 1 / SR)
        tot_e = (sp ** 2).sum() or 1.0
        print("spectral balance:")
        for a, b in ((20, 60), (60, 110), (110, 300), (300, 1000), (1000, 3000),
                     (3000, 8000), (8000, 16000)):
            sel = (fr >= a) & (fr < b)
            print("  %5d-%-5d Hz %5.1f %%" % (a, b, 100 * (sp[sel] ** 2).sum() / tot_e))
        print("  centroid %.0f Hz" % ((fr * sp ** 2).sum() / tot_e))
        # energy arc in 2.4 s blocks, so the arrangement is verifiable by reading
        win = int(BAR * SR)
        print("energy arc:")
        for i in range(0, self.N - win, win):
            r = np.sqrt(np.mean(mono[i:i + win] ** 2))
            print("  %5.1fs %6.1f dB %s" % (i / SR, 20 * np.log10(max(r, 1e-9)),
                                            "#" * int(max(0, 60 + 20 * np.log10(max(r, 1e-9))))))