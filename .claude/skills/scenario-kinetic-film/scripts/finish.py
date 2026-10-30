# finish.py <film folder> --video out/video_4k.mp4 [--audio out/mix.wav] [--name my-film] [--dest out/final]
# Makes the deliverables and checks them: the master (4K or 1080p, video stream copied, never re-encoded),
# a 1080p version, and a 9:16 version (the 16:9 film centred on black). Every file is checked for frame count,
# size (under 1 GB), H.264 level (5.2 or lower, or Macs and phones refuse it), a hardware decode on macOS
# (what QuickTime uses), loudness, and the film's dynamism (still frames and holds).
import sys, os, re, json, subprocess, argparse, platform
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filmserver import serve
here = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument('film'); ap.add_argument('--video', required=True); ap.add_argument('--audio')
ap.add_argument('--name'); ap.add_argument('--dest'); ap.add_argument('--no-vertical', action='store_true')
a = ap.parse_args()
url, srv = serve(a.film)
info = json.loads(subprocess.run(['node', os.path.join(here, 'info.mjs')], env={**os.environ, 'FILM_URL': url}, capture_output=True, text=True, check=True).stdout)
srv.shutdown()
name = a.name or re.sub(r'[^a-z0-9]+', '-', (info.get('title') or 'film').lower()).strip('-')
dest = a.dest or os.path.join(a.film, 'out', 'final'); os.makedirs(dest, exist_ok=True)
expected = round(info['dur'] * info['fps']); fps = info['fps']
probe = lambda f, e: subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', e, '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip()
h = int(probe(a.video, 'stream=height'))
audio = ['-i', a.audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '320k'] if a.audio else []
x264 = lambda lvl: ['-c:v', 'libx264', '-crf', '15', '-preset', 'slow', '-level', lvl, '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
outs = []
master = os.path.join(dest, f'{name}_{"4k" if h > 1440 else str(h) + "p"}{fps}.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.video, *audio, '-c:v', 'copy', '-movflags', '+faststart', '-metadata', f"title={info.get('title', '')}", master], check=True)
outs.append(master)
if h > 1080:
    p = os.path.join(dest, f'{name}_1080p{fps}.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.video, *audio, '-vf', 'scale=1920:1080:flags=lanczos', *x264('4.2'), '-movflags', '+faststart', p], check=True)
    outs.append(p)
if not a.no_vertical:
    p = os.path.join(dest, f'{name}_9x16.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.video, *audio, '-vf', 'scale=1080:-2:flags=lanczos,pad=1080:1920:0:(1920-ih)/2:black', *x264('4.2'), '-movflags', '+faststart', p], check=True)
    outs.append(p)

ok = True
def check(label, cond, detail):
    global ok
    ok &= bool(cond); print(f"  {'PASS' if cond else 'FAIL'}  {label}: {detail}")
for f in outs:
    print(os.path.basename(f))
    n = int(subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout.strip() or 0)
    check('frames', n == expected, f'{n} of {expected}')
    sz = os.path.getsize(f); check('size', sz < 1e9, f'{sz / 1e9:.2f} GB')
    lvl = int(probe(f, 'stream=level') or 0); check('H.264 level', 0 < lvl <= 52, f'{lvl / 10:.1f}')
    if platform.system() == 'Darwin':
        r = subprocess.run(['ffmpeg', '-v', 'error', '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-i', f, '-f', 'null', '-'], capture_output=True, text=True)
        errs = [l for l in r.stderr.splitlines() if l.strip()]
        check('plays on the Mac hardware decoder', not errs, 'clean' if not errs else errs[0][:90])
    if a.audio:
        r = subprocess.run(['ffmpeg', '-i', f, '-vn', '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
        m = re.findall(r'I:\s+(-?[\d.]+) LUFS', r); check('loudness', m and -16 <= float(m[-1]) <= -12, f'{m[-1] if m else "?"} LUFS')
# dynamism of the film itself: the numbers the reference reels were measured with
src = outs[1] if len(outs) > 1 and '1080p' in outs[1] else outs[0]
# measured up to the end card (the last 4.5 s may hold on the logo by design)
d = json.loads(subprocess.run([sys.executable, os.path.join(here, 'dyn.py'), src, '0', str(max(1, info['dur'] - 4.5)), os.path.join(dest, 'dynamism.json')], capture_output=True, text=True).stdout)
print('dynamism')
check('still frames before the end card (under 1.5% of the frame changing)', d['still_share'] <= .4, f"{d['still_share'] * 100:.0f}% (target 40% or less)")
hl = subprocess.run([sys.executable, os.path.join(here, 'holds.py'), src, '.5', str(info['bpm'])], capture_output=True, text=True).stdout.splitlines()
long = [l for l in hl if 's (beat' in l and float(l.split(')')[1].split('s')[0]) > .6 and float(l.split('s')[0]) < info['dur'] - 4.5]
check('holds longer than 0.6 s (end card excluded)', not long, 'none' if not long else '; '.join(x.strip() for x in long[:4]))
check('median motion', d['median_flow'] >= 2.5, f"{d['median_flow']} px/frame (target 2.5 or more)")
print(f"cuts per 10 s: {d['cuts_per_10s']}, full-frame colour flips: {d['flips']}")
print('ALL CHECKS PASS' if ok else 'SOME CHECKS FAILED: fix before handing the film over')
sys.exit(0 if ok else 1)
