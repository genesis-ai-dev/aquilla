# holds.py <video> [min_s] [bpm]: list still stretches (under 1.5% of the frame changing), with the beat they start on
import sys, subprocess, numpy as np, cv2
src = sys.argv[1]; mn = float(sys.argv[2]) if len(sys.argv) > 2 else .3; bpm = float(sys.argv[3]) if len(sys.argv) > 3 else 120
w, h = 320, 180
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', src, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], stdout=subprocess.PIPE)
prev = None; A = []
while True:
    b = p.stdout.read(w * h)
    if len(b) < w * h: break
    g = np.frombuffer(b, np.uint8).reshape(h, w)
    if prev is not None: A.append(float((cv2.absdiff(g, prev) > 24).mean()))
    prev = g
A = np.array(A); still = A < .015; B = 60 / bpm
runs = []; s0 = None
for i, v in enumerate(list(still) + [False]):
    if v and s0 is None: s0 = i
    if not v and s0 is not None:
        if (i - s0) / 60 >= mn: runs.append((s0 / 60, (i - s0) / 60, float(A[s0:i].mean())))
        s0 = None
for a, d, m in runs: print(f'{a:6.2f}s (beat {a / B:6.1f})  {d:.2f}s  mean change {m*100:.2f}%')
print('still share', round(float(still.mean()), 3))
