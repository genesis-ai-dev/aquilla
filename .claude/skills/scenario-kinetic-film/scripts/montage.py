# montage.py <out.jpg> <cols> <width> img...  : label each tile with its file name
import sys, cv2, numpy as np
out, cols, tw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
ims = []
for p in sys.argv[4:]:
    im = cv2.imread(p); h = int(im.shape[0] * tw / im.shape[1]); im = cv2.resize(im, (tw, h), interpolation=cv2.INTER_AREA)
    cv2.putText(im, p.split('/')[-1].replace('t_', '').replace('.png', ''), (8, 26), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 255, 0), 2)
    ims.append(im)
h = max(i.shape[0] for i in ims); rows = []
for i in range(0, len(ims), cols):
    r = ims[i:i + cols]; r += [np.zeros_like(ims[0])] * (cols - len(r))
    rows.append(cv2.copyMakeBorder(np.hstack([cv2.copyMakeBorder(x, 0, 0, 0, 4, cv2.BORDER_CONSTANT, value=(0, 0, 200)) for x in r]), 0, 4, 0, 0, cv2.BORDER_CONSTANT, value=(0, 0, 200)))
cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
