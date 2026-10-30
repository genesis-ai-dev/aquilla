# dyn.py <video> <t0> <t1> <out.json>
# How dynamic is a piece of motion design? Measured at 320x180 on every frame:
#   flow   mean optical-flow speed (px/frame at 1920 width): how fast things move
#   area   share of the frame that changes (luma diff > 24): how much of the screen is in motion
#   still  frames where under 1.5% of the frame changes: holds
#   cuts   frames where most of the frame changes at once (hard cuts, flashes, colour swaps)
#   flips  big changes in mean frame brightness (full-bleed background swaps)
import sys, json, subprocess, numpy as np, cv2
src, t0, t1, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
w, h = 320, 180
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(t0), '-t', str(t1 - t0), '-i', src, '-vf', f'fps=60,scale={w}:{h}',
                      '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
prev = None; rows = []
while True:
    b = p.stdout.read(w * h * 3)
    if len(b) < w * h * 3: break
    f = np.frombuffer(b, np.uint8).reshape(h, w, 3)
    g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    if prev is not None:
        d = cv2.absdiff(g, prev)
        area = float((d > 24).mean())
        fl = cv2.calcOpticalFlowFarneback(prev, g, None, .5, 3, 15, 3, 5, 1.2, 0)
        mag = np.hypot(fl[..., 0], fl[..., 1])
        # only count flow where something is actually there (textured or changing), scaled to 1920 px
        m = (d > 10) | (cv2.Laplacian(g, cv2.CV_16S) != 0)
        flow = float(mag[m].mean() * 1920 / w) if m.any() else 0.0
        rows.append(dict(area=area, flow=flow, luma=float(g.mean()), dl=float(abs(g.mean() - prev.mean()))))
    prev = g
p.wait()
if not rows: sys.exit(f'no frames decoded from {src} between {t0} and {t1} s')
n = len(rows); fps = 60
A = np.array([r['area'] for r in rows]); F = np.array([r['flow'] for r in rows]); DL = np.array([r['dl'] for r in rows])
still = A < .015
runs = []; c = 0
for s in still.tolist():
    if s: c += 1
    else:
        if c: runs.append(c)
        c = 0
if c: runs.append(c)
cuts = int(((A > .45) & ((DL > 18) | (A > .6))).sum())
flips = int((DL > 40).sum())
sec = [dict(s=i, area=round(float(A[i*fps:(i+1)*fps].mean()), 3), flow=round(float(F[i*fps:(i+1)*fps].mean()), 1),
            still=round(float(still[i*fps:(i+1)*fps].mean()), 2)) for i in range(n // fps)]
summ = dict(src=src, seconds=round(n / fps, 2), mean_area=round(float(A.mean()), 4), mean_flow=round(float(F.mean()), 2),
            median_flow=round(float(np.median(F)), 2), p90_flow=round(float(np.percentile(F, 90)), 1),
            still_share=round(float(still.mean()), 3), holds_over_0_5s=int(sum(1 for r in runs if r >= 30)),
            longest_hold_s=round(max(runs) / fps if runs else 0, 2), cuts=cuts, cuts_per_10s=round(cuts / (n / fps) * 10, 2),
            flips=flips, high_motion_share=round(float((A > .12).mean()), 3))
with open(out, 'w') as fh: json.dump(dict(summary=summ, per_second=sec), fh, indent=1)
print(json.dumps(summ))
