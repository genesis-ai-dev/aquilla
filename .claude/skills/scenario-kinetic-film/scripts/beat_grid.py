# beat_grid.py <music file> [--bpm 174] : measure a track's tempo, its downbeats and where it drops,
# so the film's beat grid (spec.bpm, spec.music.offset) lands every cut on the music.
# Prints JSON: bpm, offset (seconds of the first strong downbeat to start the film on), drop candidates
# (in film beats from that offset), and how clearly the track keeps time (grid strength 0 to 1).
import json, subprocess, argparse, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('music'); ap.add_argument('--bpm', type=float, help='expected tempo (from the music prompt)')
ap.add_argument('--start', type=float, default=0, help='fit from this second (skip silence or an intro you will not use)')
ap.add_argument('--window', type=float, default=0, help='fit only this many seconds from --start: the stretch the film plays over (generated music can drift)')
a = ap.parse_args()
SR, HOP, NF = 22050, 128, 2048
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', a.music, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.float32)
fr = SR / HOP
win = np.hanning(NF).astype(np.float32)
nfr = 1 + (len(x) - NF) // HOP
S = np.abs(np.fft.rfft(np.stack([x[i * HOP:i * HOP + NF] * win for i in range(nfr)]), axis=1))
L = np.log1p(10 * S)
flux = np.maximum(0, np.diff(L, axis=0)).sum(1); flux = np.concatenate([[0], flux])
low = np.maximum(0, np.diff(L[:, :int(150 / (SR / NF))], axis=0)).sum(1); low = np.concatenate([[0], low])   # kick drum band
rms = np.sqrt((S ** 2).mean(1))
def norm(v): v = v - np.convolve(v, np.ones(int(fr)) / int(fr), 'same'); return np.maximum(v, 0)
k0 = int(a.start * fr); k1 = int((a.start + a.window) * fr) if a.window else len(flux)
e = norm(flux)[:k1]; low = low[:k1]
# tempo: autocorrelation of the onset envelope, 60-200 BPM, with a soft preference for the hinted tempo
ac = np.correlate(e[k0:], e[k0:], 'full')[len(e) - k0 - 1:]
lags = np.arange(len(ac)); bpms = 60 * fr / np.maximum(lags, 1)
ok = (bpms >= 60) & (bpms <= 200)
prior = np.exp(-.5 * (np.log2(bpms / (a.bpm or 120)) / (.25 if a.bpm else .9)) ** 2)
score = np.where(ok, ac * prior, 0)
lag = int(np.argmax(score))
if 1 <= lag < len(ac) - 1:   # parabolic refinement
    y0, y1, y2 = score[lag - 1], score[lag], score[lag + 1]; lagf = lag + .5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-9)
else: lagf = lag
bpm = 60 * fr / lagf
# fine fit: tempo within 1.5% of the estimate and phase together, scoring the onset energy at every beat of the track
def comb(P, phases):
    n = int((len(e) - k0) / P) - 1
    pos = k0 + phases[:, None] + P * np.arange(n)[None, :]
    i = np.clip(pos.astype(int), 0, len(e) - 2); fpart = pos - i
    v = e[i] * (1 - fpart) + e[i + 1] * fpart
    return v.mean(1)
# score on a smoothed mix of all onsets and the kick band, so off-beat accents do not pull the grid
g = np.exp(-.5 * (np.arange(-12, 13) / (.015 * fr)) ** 2); g /= g.sum()
kk = norm(low)
e = np.convolve(e / (e.max() + 1e-9) + 1.5 * kk / (kk.max() + 1e-9), g, 'same')
best, P, ph = -1, lagf, 0
lo, hi = (a.bpm * .92, a.bpm * 1.08) if a.bpm else (bpm * .985, bpm * 1.015)
for b in np.arange(lo, hi, .01):
    Pb = 60 * fr / b; phs = np.linspace(0, Pb, 96, endpoint=False); sc = comb(Pb, phs); j = int(np.argmax(sc))
    if sc[j] > best: best, P, ph = sc[j], Pb, phs[j]
bpm = 60 * fr / P
n = int((len(e) - k0) / P) - 1
beats = k0 + ph + P * np.arange(n)
kick = norm(low)
bar = [kick[(beats[i::4]).astype(int)].sum() for i in range(4)]
d0 = int(np.argmax(bar))
down = beats[d0::4] / fr
strength = float(e[beats.astype(int)].mean() / (e.mean() + 1e-9) / 4); strength = min(1, strength)
# drops: the biggest rises in loudness at a downbeat, measured over two bars
ev = np.convolve(rms, np.ones(int(fr)) / int(fr), 'same')
def at_(t): return ev[min(len(ev) - 1, int(t * fr))]
bars = [(t, at_(t + 2 * 4 * 60 / bpm) / (at_(t - 4 * 60 / bpm) + 1e-9)) for t in down if t > 4 * 60 / bpm]
drops = sorted(bars, key=lambda q: -q[1])[:3]
off = float(down[0])
print(json.dumps({'bpm': round(bpm, 2), 'offset': round(off, 3), 'downbeats': [round(float(t), 3) for t in down[:16]],
                  'drops': [{'music_s': round(float(t), 2), 'film_beat': round((t - off) * bpm / 60, 1), 'rise': round(float(r), 2)} for t, r in sorted(drops)],
                  'grid_strength': round(strength, 2), 'duration': round(len(x) / SR, 2),
                  'film_beats_available': int((len(x) / SR - off) * bpm / 60)}, indent=1))
