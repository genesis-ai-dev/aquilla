# audit.py <video> [frame_offset]: flags stale frames, blank bottom bands and luminance spikes at 1/4 scale
import sys, cv2, numpy as np
cap = cv2.VideoCapture(sys.argv[1]); off = int(sys.argv[2]) if len(sys.argv) > 2 else 0
prev = None; k = 0; diffs = []; lum = []; band = []
while True:
    ok, f = cap.read()
    if not ok: break
    g = cv2.cvtColor(cv2.resize(f, (960, 540), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    diffs.append(0 if prev is None else float(np.abs(g - prev).mean()))
    lum.append(float(g.mean())); band.append(float(g[-30:].mean()))
    prev = g; k += 1
d = np.array(diffs); L = np.array(lum); Bd = np.array(band)
print(f'{k} frames; median diff {np.median(d):.2f}; mean luma {L.mean():.1f}')
stale = [i + off for i in range(2, k - 1) if d[i] < .02 and d[i - 1] > .6 and d[i + 1] > .6]
print('stale (frozen between moving frames):', stale[:30])
print('blank bottom band (<3.0):', [i + off for i in range(k) if Bd[i] < 3.0][:30])
spk = [i + off for i in range(1, k - 1) if L[i] - max(L[i - 1], L[i + 1]) > 25]
print('single-frame luma spikes:', spk[:30])
