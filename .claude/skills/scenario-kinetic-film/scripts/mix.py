# mix.py <film folder> [--out out/mix.wav] [--lufs -14] [--no-music]
# The film's soundtrack: the music bed from spec.music, plus a sound effect on every cue the blocks registered
# (whips, slams, typing, pops...), placed from the film's own cue list. Sounds come from <film>/audio/sfx/:
# one file per kit name (whoosh.wav, impact.mp3, key_1.wav, key_2.wav... variants rotate). The core kit is 12 sounds;
# every other cue name falls back to one of them. Custom sounds (stomp.wav, bell.wav...) play on cues of the same
# name from spec.cues, at the level set in spec.sounds. Music ducks under the big hits; two-pass loudness to the target.
import sys, os, json, glob, subprocess, argparse, wave, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filmserver import serve
here = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument('film'); ap.add_argument('--out'); ap.add_argument('--lufs', type=float, default=-14)
ap.add_argument('--no-music', action='store_true'); ap.add_argument('--kit')
a = ap.parse_args()
url, srv = serve(a.film)
info = json.loads(subprocess.run(['node', os.path.join(here, 'info.mjs')], env={**os.environ, 'FILM_URL': url}, capture_output=True, text=True, check=True).stdout)
srv.shutdown()
SR = 48000; BEAT = 60 / info['bpm']; dur = info['dur'] + .6
kit = a.kit or os.path.join(a.film, 'audio', 'sfx')
out = a.out or os.path.join(a.film, 'out', 'mix.wav'); os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
AUDIO = ('.wav', '.mp3', '.m4a', '.aif', '.aiff', '.flac')

def decode(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()
cache = {}
def sound(name):
    # every file for a kit name: name.ext or name_N.ext, peak-normalised to -1 dBFS so the level table means something
    if name not in cache:
        xs = []
        for f in sorted(glob.glob(os.path.join(kit, name + '*'))):
            stem, ext = os.path.splitext(os.path.basename(f))
            if ext.lower() not in AUDIO or not (stem == name or (stem.startswith(name + '_') and stem[len(name) + 1:].isdigit())): continue
            x = decode(f); pk = np.abs(x).max() or 1; xs.append(x / pk * 10 ** (-1 / 20))
        cache[name] = xs
    return cache[name]
def pick(names):
    for n in names.split('|'):
        if sound(n): return n
    return None
onset = lambda x: int(np.argmax(np.abs(x).max(1) > .2 * np.abs(x).max()))
peak = lambda x: int(np.argmax(np.abs(x).max(1)))

# cue name: list of (kit names, first that exists | align: onset, peak, end or loop | offset s | level dB)
MAP = {
    'key': [('key', 'onset', 0, -19)], 'tick': [('tick', 'onset', 0, -15)], 'pop': [('pop', 'onset', 0, -15)],
    'thock': [('thock|pop', 'onset', 0, -9)], 'whoosh': [('whoosh', 'peak', .12, -12)], 'whoosh_big': [('whoosh_big|whoosh', 'peak', .14, -5)],
    'impact': [('impact', 'onset', 0, -2)], 'impact_big': [('impact_big|impact', 'onset', 0, -3)], 'hit': [('hit|impact', 'onset', 0, -2)],
    'slash': [('slash|whoosh', 'peak', .05, -3.5)], 'sparkle': [('sparkle|tick', 'onset', 0, -19)], 'glitch': [('glitch', 'onset', 0, -13)],
    'power_down': [('power_down|glitch', 'onset', 0, -12)], 'draw': [('draw|whoosh', 'onset', 0, -14)], 'riser': [('riser', 'end', 0, -9)],
    'drop': [('drop|impact_big|impact', 'onset', 0, -4)], 'stretch': [('stretch|whoosh', 'onset', 0, -12)], 'squeeze': [('stretch|whoosh', 'onset', 0, -15)],
    'send': [('send|key', 'onset', 0, -3), ('whoosh', 'peak', .1, -14)], 'click': [('click|key', 'onset', 0, -1.5), ('impact', 'onset', 0, -10)],
    'scroll': [('scroll', 'onset', 0, -17)], 'tick_run': [('tick_run|tick', 'loop', 0, -21)], 'ding': [('ding|tick', 'onset', 0, -15)],
    'rewind': [('rewind|whoosh_big|whoosh', 'onset', 0, -11)], 'suck': [('suck|riser', 'end', 0, -9)],
    'logo_hit': [('logo_hit|impact_big|impact', 'onset', 0, -3)],
}
levels = info.get('sounds') or {}
N = int(dur * SR); sfx = np.zeros((N, 2), np.float32)
def place(x, start, g):
    s = int(round(start * SR)); lo, hi = max(0, s), min(N, s + len(x))
    if hi > lo: sfx[lo:hi] += x[lo - s:hi - s] * g
count, missing = {}, set()
for c in info['cues']:
    name, t, gain = c['name'], c['t'], c.get('gain', 1)
    i = count.get(name, 0); count[name] = i + 1
    for names, align, off, db in MAP.get(name, [(name, 'onset', 0, -8)]):
        if name in levels: db = levels[name]
        k = pick(names)
        if not k: missing.add(names.split('|')[0]); continue
        xs = sound(k); x = xs[i % len(xs)]; g = gain * 10 ** (db / 20)
        if align == 'loop':
            L = c.get('dur', 1); step = len(x) / SR if k == 'tick_run' else .075; q = 0
            while q * step < L: place(x if k == 'tick_run' else x[:int(step * SR * 1.5)], t + q * step, g); q += 1
            continue
        if align == 'end': start = c.get('end', t) - len(x) / SR
        elif align == 'peak': start = t + off - peak(x) / SR
        else: start = t + off - onset(x) / SR
        if 'dur' in c and align == 'onset':
            L = int(c['dur'] * SR); x = x[:L].copy(); fl = min(len(x), int(.25 * SR)); x[-fl:] *= np.linspace(1, 0, fl)[:, None]
        place(x, start, g)

music = np.zeros((N, 2), np.float32)
m = info.get('music') or {}
if m.get('file') and not a.no_music:
    stop = m.get('stopBeat'); st = (stop * BEAT if stop else info['dur']) + .03
    mus = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(m.get('offset', 0)), '-t', f'{st:.4f}', '-i', os.path.join(a.film, m['file']), '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    mus = np.frombuffer(mus, np.float32).reshape(-1, 2).copy()
    fi = int(.012 * SR); mus[:fi] *= np.linspace(0, 1, fi)[:, None]
    if stop:   # a hard stop on the logo downbeat
        e = int((stop * BEAT + .015) * SR); mus = mus[:e]; fo = int(.02 * SR); mus[-fo:] *= np.linspace(1, 0, fo)[:, None]
    else:
        fo = min(len(mus), int(1.2 * SR)); mus[-fo:] *= np.linspace(1, 0, fo)[:, None]
    music[:min(N, len(mus))] = mus[:N] * 10 ** ((m.get('gain', -3.5)) / 20)
duck = np.ones(N, np.float32)
for c in info['cues']:
    if c['name'] in ('impact_big', 'drop', 'hit', 'impact', 'slash', 'click', 'logo_hit') or c['name'] in levels:
        s = int(c['t'] * SR); dd = .5 if c['name'] in ('impact_big', 'drop', 'logo_hit') else .62
        env = np.concatenate([np.linspace(1, dd, int(.03 * SR)), np.linspace(dd, 1, int(.35 * SR))])
        seg = duck[s:s + len(env)]; duck[s:s + len(env)] = np.minimum(seg, env[:len(seg)])
mix = (music * duck[:, None] + sfx) * 10 ** (-6 / 20)
def db(x): return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
weak = []
for c in info['cues']:
    if c['name'] in ('impact', 'impact_big', 'hit', 'drop', 'slash', 'logo_hit', 'click') or c['name'] in levels:
        s0 = int(c['t'] * SR); s1 = s0 + int(.15 * SR); d = db(sfx[s0:s1]) - db(music[s0:s1] * duck[s0:s1, None])
        if d < 0: weak.append(f"{c['name']}@{c['t']:.2f}s {d:+.1f} dB")
tmp = out + '.raw.wav'
with wave.open(tmp, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
r = subprocess.run(['ffmpeg', '-v', 'info', '-i', tmp, '-af', f'loudnorm=I={a.lufs}:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
js = json.loads(r[r.rindex('{'):r.rindex('}') + 1])
af = f"loudnorm=I={a.lufs}:TP=-1:LRA=11:measured_I={js['input_i']}:measured_TP={js['input_tp']}:measured_LRA={js['input_lra']}:measured_thresh={js['input_thresh']}:offset={js['target_offset']}:linear=true"
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp, '-af', af, '-ar', str(SR), '-t', f"{info['dur']:.4f}", out], check=True)
os.remove(tmp)
print(f"{out}: {sum(count.values())} cues, loudness target {a.lufs} LUFS")
if missing: print('no file for these sounds (their cues are silent):', ', '.join(sorted(missing)))
if weak: print('hits quieter than the music (raise them in spec.sounds or lower music.gain):', '; '.join(weak[:12]))
