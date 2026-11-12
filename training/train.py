"""Train the card finder: a small pose model that outlines every card in a camera frame.

  python train.py [name] [epochs] [model]
"""
import sys
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).parent
name = sys.argv[1] if len(sys.argv) > 1 else 'cards-n'
epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 40
base = sys.argv[3] if len(sys.argv) > 3 else 'yolo11n-pose.pt'

(ROOT / 'cards.yaml').write_text(f"""path: {(ROOT / 'data').as_posix()}
train: images/train
val: images/val
kpt_shape: [4, 3]
flip_idx: [1, 0, 3, 2]
names:
  0: card
""")

if __name__ == '__main__':
    model = YOLO(base)
    model.train(
        data=str(ROOT / 'cards.yaml'), epochs=epochs, imgsz=640, rect=False, batch=64, workers=12, device=0,
        project=str(ROOT / 'runs'), name=name, exist_ok=True, amp=True, cache=False, patience=0,
        # The pictures are already varied; keep the geometry honest (no mirroring: a mirrored card
        # isn't a card, and corner order means which way up it is).
        fliplr=0.0, flipud=0.0, mosaic=0.5, close_mosaic=8, degrees=0.0, translate=0.08, scale=0.35, shear=0.0,
        perspective=0.0, hsv_h=0.01, hsv_s=0.4, hsv_v=0.35, erasing=0.0, mixup=0.0,
        pose=16.0, kobj=1.0, box=7.5,
    )
