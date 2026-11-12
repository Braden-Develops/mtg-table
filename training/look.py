"""Run a trained card finder on real camera pictures and draw what it finds, to look at.

  python look.py runs/cards-n/weights/best.pt real out-sheet.jpg [max pictures] [imgsz]
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

weights, folder, out = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 24
imgsz = int(sys.argv[5]) if len(sys.argv) > 5 else 640

model = YOLO(weights)
files = sorted(folder.glob('*.jpg'))
if len(files) > limit:
    step = len(files) / limit
    files = [files[int(i * step)] for i in range(limit)]
tiles = []
for f in files:
    img = cv2.imread(str(f))
    r = model.predict(img, imgsz=imgsz, conf=0.25, verbose=False, device=0)[0]
    k = max(1, img.shape[1] // 640)
    if r.keypoints is not None:
        for quad, conf in zip(r.keypoints.xy.cpu().numpy(), r.boxes.conf.cpu().numpy()):
            q = quad.astype(np.int32)
            cv2.polylines(img, [q], True, (0, 255, 0), 2 * k, cv2.LINE_AA)
            cv2.circle(img, tuple(q[0]), 5 * k, (0, 0, 255), -1)
            cv2.putText(img, f'{conf:.2f}', tuple(q[0] + (0, -6 * k)), 0, 0.6 * k, (0, 255, 255), 2 * k, cv2.LINE_AA)
    tiles.append(cv2.resize(img, (640, int(640 * img.shape[0] / img.shape[1]))))
h = max(t.shape[0] for t in tiles)
tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles]
cols = 3
while len(tiles) % cols:
    tiles.append(np.zeros_like(tiles[0]))
sheet = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
print('wrote', out, len(files), 'pictures')
