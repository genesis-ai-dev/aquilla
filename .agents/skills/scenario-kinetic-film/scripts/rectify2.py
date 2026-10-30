# Track camera drift/zoom with SIFT on the static desk/wall (screen + caption masked),
# map the reference screen quad into every frame and warp it flat to 16:9.
import cv2, numpy as np, subprocess, sys, json
src, out, t_end = sys.argv[1], sys.argv[2], float(sys.argv[3])
REF_T_ARG, Q_ARG, CAP = float(sys.argv[4]), json.loads(sys.argv[5]), json.loads(sys.argv[6])
OW, OH = 1600, 900
REF_T = REF_T_ARG
Q = np.float32(Q_ARG)
cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
S = 0.5
def mask_for(h, w, H=None):
    m = np.full((h, w), 255, np.uint8)
    q = Q.copy() if H is None else cv2.perspectiveTransform(Q[None], H)[0]
    # grow screen quad a bit, mask it (content changes) and the burnt-in caption band
    c = q.mean(0); qg = (q - c) * 1.08 + c
    cv2.fillPoly(m, [np.int32(qg * S)], 0)
    m[int(CAP[0]*S):int(CAP[1]*S), :] = 0
    return m
sift = cv2.SIFT_create(4000)
cap.set(cv2.CAP_PROP_POS_MSEC, REF_T*1000)
ok, ref = cap.read()
rg = cv2.cvtColor(cv2.resize(ref, None, fx=S, fy=S), cv2.COLOR_BGR2GRAY)
kr, dr = sift.detectAndCompute(rg, mask_for(*rg.shape))
bf = cv2.BFMatcher()
cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
ff = subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','bgr24','-s',f'{OW}x{OH}','-r',str(fps),'-i','-',
    '-c:v','libx264','-crf','14','-preset','fast','-pix_fmt','yuv420p',out], stdin=subprocess.PIPE)
dst = np.float32([[0,0],[OW,0],[OW,OH],[0,OH]])
Hs = []; lastH = np.eye(3); n = 0
while True:
    ok, fr = cap.read()
    if not ok or n/fps > t_end: break
    g = cv2.cvtColor(cv2.resize(fr, None, fx=S, fy=S), cv2.COLOR_BGR2GRAY)
    k, d = sift.detectAndCompute(g, mask_for(*g.shape, lastH))
    H = lastH
    if d is not None and len(k) > 30:
        m = bf.knnMatch(dr, d, k=2)
        good = [a for a, b in (x for x in m if len(x) == 2) if a.distance < 0.7*b.distance]
        if len(good) > 25:
            p0 = np.float32([kr[a.queryIdx].pt for a in good]) / S
            p1 = np.float32([k[a.trainIdx].pt for a in good]) / S
            Hn, inl = cv2.findHomography(p0, p1, cv2.RANSAC, 3.0)
            if Hn is not None and inl.sum() > 20: H = Hn
    lastH = H
    q = cv2.perspectiveTransform(Q[None], H)[0]
    Hs.append(q.tolist())
    W = cv2.getPerspectiveTransform(q, dst)
    ff.stdin.write(cv2.warpPerspective(fr, W, (OW, OH), flags=cv2.INTER_CUBIC).tobytes())
    n += 1
    if n % 300 == 0: print(n, flush=True)
ff.stdin.close(); ff.wait()
with open(out + '.quads.json', 'w') as fh: json.dump(Hs, fh)
print('frames', n)
