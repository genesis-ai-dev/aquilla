# render.py <film folder> [--res 4k|1080|720] [--workers N] [--out film.mp4] [--from F --to F]
# Renders the film to video (no sound): serves the folder, splits the frames across parallel workers
# (each a headless Chrome + encoder), checks every frame arrived, and joins the parts.
import sys, os, json, subprocess, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filmserver import serve
here = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument('film'); ap.add_argument('--res', default='1080', choices=['4k', '1080', '720'])
ap.add_argument('--workers', type=int); ap.add_argument('--out'); ap.add_argument('--from', dest='f0', type=int); ap.add_argument('--to', dest='f1', type=int)
a = ap.parse_args()
url, srv = serve(a.film); env = {**os.environ, 'FILM_URL': url}
info = json.loads(subprocess.run(['node', os.path.join(here, 'info.mjs')], env=env, capture_output=True, text=True, check=True).stdout)
fps = info['fps']; total = round(info['dur'] * fps)
f0, f1 = a.f0 or 0, a.f1 or total
dsf = {'4k': 2, '1080': 1, '720': 2 / 3}[a.res]
# memory: a 4K worker (Chrome at 3840x2160 + encoder) needs about 10-12 GB; more workers than RAM allows thrashes or crashes the machine
try: ram = int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout) / 2 ** 30
except Exception: ram = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 2 ** 30
per = {'4k': 11, '1080': 4, '720': 3}[a.res]
workers = a.workers or max(1, min(3 if a.res == '4k' else 6, int(ram // per), os.cpu_count() // 3))
out = a.out or os.path.join(a.film, 'out', f"video_{a.res}.mp4")
parts = os.path.join(os.path.dirname(os.path.abspath(out)), 'parts'); os.makedirs(parts, exist_ok=True)
step = -(-(f1 - f0) // workers); jobs = []
print(f"{info['title'] or 'film'}: {f1 - f0} frames at {fps} fps, {a.res}, {workers} workers ({ram:.0f} GB RAM)", flush=True)
for i in range(workers):
    s, e = f0 + i * step, min(f1, f0 + (i + 1) * step)
    if s >= e: continue
    p = os.path.join(parts, f'part{i}.mp4')
    with open(os.path.join(parts, f'part{i}.log'), 'w') as log:  # the worker keeps its own copy of the handle
        jobs.append((p, subprocess.Popen([sys.executable, '-I', os.path.join(here, 'post.py'), str(dsf), str(s), str(e), p, str(fps)], env=env, stdout=log, stderr=subprocess.STDOUT)))
try: bad = [p for p, j in jobs if j.wait() != 0]
finally: srv.shutdown()
if bad: sys.exit(f'frames missing in {bad}: see the .log beside each part')
lst = os.path.join(parts, 'list.txt')
with open(lst, 'w') as fh: fh.write(''.join(f"file '{os.path.basename(p)}'\n" for p, _ in jobs))
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', out], check=True)
n = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out], capture_output=True, text=True).stdout.strip()
print(f'{out}: {n} frames (expected {f1 - f0})')
