"""Make synthetic training pictures: Magic cards pasted onto tables, playmats and everyday photos,
as a webcam would see them (lying on the table at any angle, or one held up close in a hand).

  python gen.py train 24000
  python gen.py val 600
  python gen.py preview 12        # a few pictures with the labels drawn, to look at

Labels are in Ultralytics pose format: class cx cy w h, then the card's four corners
(top-left, top-right, bottom-right, bottom-left of the card itself, so a card upside down has its
"top-left" at the bottom right of the picture), each with a visibility flag.
"""
import math
import os
import random
import sys
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).parent
W, H = 960, 544
CARD_W, CARD_H = 488, 680

CARDS = sorted((ROOT / 'cards').glob('*.jpg'))
BG_PHOTOS = sorted((ROOT / 'bg' / 'coco').glob('*.jpg'))
BG_REAL = sorted((ROOT / 'bg' / 'real').glob('*.jpg'))  # empty tables from real cameras, if any


def rnd(a, b):
    return random.uniform(a, b)


# ---------- backgrounds ----------
def photo_bg():
    img = cv2.imread(str(random.choice(BG_PHOTOS)))
    if img is None:
        return np.full((H, W, 3), 60, np.uint8)
    h, w = img.shape[:2]
    s = max(W / w, H / h) * rnd(1.0, 1.6)
    img = cv2.resize(img, (int(w * s) + 1, int(h * s) + 1), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    y = random.randint(0, img.shape[0] - H)
    x = random.randint(0, img.shape[1] - W)
    img = img[y:y + H, x:x + W].copy()
    if random.random() < 0.5:  # out of focus, like a desk behind the cards
        k = random.choice([5, 9, 15, 25])
        img = cv2.GaussianBlur(img, (k, k), 0)
    return img


def wood(base):
    img = np.empty((H, W, 3), np.float32)
    img[:] = base
    grain = cv2.resize(np.random.randn(H // 4, 8, 1).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    if random.random() < 0.5:
        grain = cv2.resize(np.random.randn(8, W // 4, 1).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    img += grain[..., None] * rnd(4, 18)
    return np.clip(img, 0, 255).astype(np.uint8)


def mat_bg():
    """A desk with a playmat: a dark (sometimes coloured) rounded rectangle with printed lines,
    boxes and lettering, like the zones printed on real mats."""
    desk = random.choice([(rnd(90, 190), rnd(120, 200), rnd(150, 220)), (rnd(20, 90),) * 3, (rnd(150, 235),) * 3])
    img = wood(desk) if random.random() < 0.7 else photo_bg()
    if random.random() < 0.85:
        x0, y0 = int(rnd(-0.1, 0.2) * W), int(rnd(-0.1, 0.2) * H)
        x1, y1 = int(rnd(0.75, 1.1) * W), int(rnd(0.8, 1.1) * H)
        dark = random.random() < 0.75
        col = tuple(int(rnd(5, 45)) for _ in range(3)) if dark else tuple(int(rnd(30, 200)) for _ in range(3))
        mat = img.copy()
        cv2.rectangle(mat, (x0, y0), (x1, y1), col, -1, cv2.LINE_AA)
        if random.random() < 0.35 and BG_PHOTOS:  # mats with artwork
            art = cv2.resize(photo_bg(), (max(8, x1 - x0), max(8, y1 - y0)))
            ys, xs = max(0, y0), max(0, x0)
            ye, xe = min(H, y1), min(W, x1)
            if ye > ys and xe > xs:
                mat[ys:ye, xs:xe] = (art[ys - y0:ye - y0, xs - x0:xe - x0] * rnd(0.15, 0.7)).astype(np.uint8)
        ink = tuple(int(c) for c in np.clip(np.array(col) + rnd(40, 150) * np.array([rnd(0.5, 1), rnd(0.7, 1), rnd(0.5, 1)]), 0, 255))
        for _ in range(random.randint(0, 14)):
            kind = random.random()
            px, py = random.randint(x0, max(x0 + 1, x1)), random.randint(y0, max(y0 + 1, y1))
            if kind < 0.3:  # card-zone outlines: card-shaped boxes that are NOT cards
                bw = int(rnd(0.05, 0.14) * W)
                bh = int(bw * rnd(1.2, 1.5)) if random.random() < 0.7 else int(bw * rnd(0.2, 0.5))
                cv2.rectangle(mat, (px, py), (px + bw, py + bh), ink, random.choice([1, 2, 3, -1]), cv2.LINE_AA)
            elif kind < 0.6:
                pts = np.cumsum(np.random.randn(random.randint(3, 12), 2) * rnd(10, 60), axis=0) + (px, py)
                cv2.polylines(mat, [pts.astype(np.int32)], random.random() < 0.3, ink, random.choice([1, 2, 3]), cv2.LINE_AA)
            elif kind < 0.85:
                text = ''.join(random.choice('ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789 ()/') for _ in range(random.randint(2, 10)))
                cv2.putText(mat, text, (px, py), random.choice([0, 2, 3, 4, 6]), rnd(0.5, 2.2), ink, random.choice([1, 2, 3]), cv2.LINE_AA)
            else:
                cv2.ellipse(mat, (px, py), (int(rnd(10, 120)), int(rnd(10, 120))), rnd(0, 180), 0, 360, ink, random.choice([1, 2, 3]), cv2.LINE_AA)
        if random.random() < 0.5:
            mat = cv2.rotate(mat, cv2.ROTATE_180)
        img = mat
    return img


def background():
    r = random.random()
    if BG_REAL and r < 0.25:
        img = cv2.imread(str(random.choice(BG_REAL)))
        img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
        if random.random() < 0.5:
            img = cv2.rotate(img, cv2.ROTATE_180)
        return img
    if r < 0.6:
        return mat_bg()
    return photo_bg()


# ---------- cards ----------
def load_card():
    img = cv2.imread(str(random.choice(CARDS)))
    if img is None or img.shape[0] < 400:
        return load_card()
    return cv2.resize(img, (CARD_W, CARD_H))


def card_layers(card, sleeve=None):
    """The card as it would look by itself: (bgr, alpha, corners of the card in that picture).
    Half the time it is in a sleeve, a little bigger than the card, often dark and glossy."""
    alpha = np.zeros((CARD_H, CARD_W), np.uint8)
    r = int(CARD_W * 0.045)
    cv2.rectangle(alpha, (r, 0), (CARD_W - r, CARD_H), 255, -1)
    cv2.rectangle(alpha, (0, r), (CARD_W, CARD_H - r), 255, -1)
    for cx, cy in ((r, r), (CARD_W - r, r), (r, CARD_H - r), (CARD_W - r, CARD_H - r)):
        cv2.circle(alpha, (cx, cy), r, 255, -1, cv2.LINE_AA)
    corners = np.float32([[0, 0], [CARD_W, 0], [CARD_W, CARD_H], [0, CARD_H]])
    if sleeve or (sleeve is None and random.random() < 0.5):
        side = int(CARD_W * rnd(0.012, 0.05))
        top = int(CARD_H * rnd(0.012, 0.06))
        bottom = int(CARD_H * rnd(0.008, 0.03))
        col = random.choice([(rnd(5, 40),) * 3, (rnd(5, 40),) * 3, tuple(rnd(10, 230) for _ in range(3)), (rnd(200, 250),) * 3])
        sw, sh = CARD_W + 2 * side, CARD_H + top + bottom
        sleeve = np.empty((sh, sw, 3), np.uint8)
        sleeve[:] = col
        sleeve[top:top + CARD_H, side:side + CARD_W] = np.where(alpha[..., None] > 127, card, sleeve[top:top + CARD_H, side:side + CARD_W])
        if random.random() < 0.6:  # glossy plastic: washed out a little
            g = rnd(0.03, 0.18)
            sleeve = (sleeve * (1 - g) + 255 * g * rnd(0.5, 1)).astype(np.uint8)
        a2 = np.full((sh, sw), 255, np.uint8)
        return sleeve, a2, corners + (side, top)
    return card, alpha, corners


def glare(img, alpha):
    """Lamp reflections: soft white blobs and streaks."""
    h, w = img.shape[:2]
    g = np.zeros((h, w), np.float32)
    for _ in range(random.randint(1, 2)):
        c = (int(rnd(0, w)), int(rnd(0, h)))
        ax = (int(rnd(0.08, 0.5) * w), int(rnd(0.05, 0.4) * h))
        cv2.ellipse(g, c, ax, rnd(0, 180), 0, 360, rnd(0.4, 1.0), -1)
    k = int(rnd(0.1, 0.35) * w) | 1
    g = cv2.GaussianBlur(g, (k, k), 0)[..., None]
    return np.clip(img + g * 255 * (alpha[..., None] > 0), 0, 255).astype(np.uint8)


def quad_for(cx, cy, width, angle, tilt):
    """Where a card's corners land: centre, width, rotation (radians, 0 = upright) and how much
    the far end shrinks from perspective."""
    hw, hh = width / 2, width * CARD_H / CARD_W / 2
    pts = np.float32([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])
    pts += np.random.randn(4, 2).astype(np.float32) * width * tilt
    c, s = math.cos(angle), math.sin(angle)
    rot = np.float32([[c, -s], [s, c]])
    return pts @ rot.T + (cx, cy)


def paste(canvas, ids, idx, img, alpha, src, quad, shade=1.0, shadow=True):
    """Warp a card onto the canvas at quad (the card's own corners; a sleeve reaches a bit further).
    Only the part of the canvas the card touches is worked on."""
    h, w = img.shape[:2]
    size = max(np.linalg.norm(quad[1] - quad[0]), 4)
    # Shrink first (no shimmer), then warp.
    k = min(1.0, size * 1.6 / CARD_W)
    if k < 1:
        img = cv2.resize(img, (max(4, int(w * k)), max(4, int(h * k))), interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_AREA)
        src = src * k
        h, w = img.shape[:2]
    M = cv2.getPerspectiveTransform(src.astype(np.float32), quad.astype(np.float32))
    outline = cv2.perspectiveTransform(np.float32([[[0, 0], [w, 0], [w, h], [0, h]]]), M)[0]
    pad = int(size * 0.3) + 4
    x0, y0 = np.floor(outline.min(axis=0)).astype(int) - pad
    x1, y1 = np.ceil(outline.max(axis=0)).astype(int) + pad
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    shift = np.float64([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]])
    box = (x1 - x0, y1 - y0)
    warped = cv2.warpPerspective(img, shift @ M, box, flags=cv2.INTER_LINEAR)
    a = cv2.warpPerspective(alpha, shift @ M, box, flags=cv2.INTER_LINEAR).astype(np.float32) / 255
    part = canvas[y0:y1, x0:x1].astype(np.float32)
    if shadow and random.random() < 0.7:
        off = (rnd(-0.06, 0.06) * size, rnd(-0.06, 0.06) * size)
        sh = cv2.warpAffine(a, np.float32([[1, 0, off[0]], [0, 1, off[1]]]), box)
        kk = int(rnd(0.02, 0.2) * size) * 2 + 1
        sh = cv2.GaussianBlur(sh, (kk, kk), 0) * rnd(0.2, 0.7)
        part *= 1 - sh[..., None]
    part = part * (1 - a[..., None]) + warped.astype(np.float32) * shade * a[..., None]
    canvas[y0:y1, x0:x1] = part.clip(0, 255).astype(np.uint8)
    ids[y0:y1, x0:x1][a > 0.5] = idx


SKIN = [(140, 170, 225), (120, 150, 210), (90, 120, 180), (70, 95, 150), (50, 70, 115), (160, 185, 235)]


def skin():
    b, g, r = random.choice(SKIN)
    j = rnd(0.75, 1.15)
    return (int(min(255, b * j)), int(min(255, g * j)), int(min(255, r * j)))


def arm(canvas, ids, to, width):
    """A hand and forearm reaching in from an edge of the picture to a point (behind a held card)."""
    edge = random.choice(['top', 'bottom', 'left', 'right', 'top', 'bottom'])
    start = {'top': (to[0] + rnd(-0.3, 0.3) * W, -40), 'bottom': (to[0] + rnd(-0.3, 0.3) * W, H + 40),
             'left': (-40, to[1] + rnd(-0.3, 0.3) * H), 'right': (W + 40, to[1] + rnd(-0.3, 0.3) * H)}[edge]
    col = skin()
    layer = canvas.copy()
    mask = np.zeros((H, W), np.uint8)
    thick = int(width * rnd(0.45, 0.8))
    axes = (int(width * rnd(0.5, 0.8)), int(width * rnd(0.45, 0.75)))
    turn = rnd(0, 180)
    for target, c in ((layer, col), (mask, 1)):
        cv2.line(target, (int(start[0]), int(start[1])), (int(to[0]), int(to[1])), c, thick, cv2.LINE_AA)
        cv2.ellipse(target, (int(to[0]), int(to[1])), axes, turn, 0, 360, c, -1, cv2.LINE_AA)
    # Skin isn't flat: shade it along its length.
    shade = cv2.GaussianBlur(np.random.rand(H // 16, W // 16).astype(np.float32), (5, 5), 0)
    shade = cv2.resize(shade, (W, H))[..., None] * 0.5 + 0.7
    layer = np.where(mask[..., None] > 0, np.clip(layer * shade, 0, 255), layer).astype(np.uint8)
    canvas[:] = cv2.GaussianBlur(layer, (5, 5), 0)
    ids[mask > 0] = 0  # whatever it covers can't be seen any more


def fingers(canvas, ids, quad, width):
    """Fingers and a thumb over the edges of a held card."""
    col = skin()
    centre = quad.mean(axis=0)
    for _ in range(random.randint(1, 5)):
        i = random.randint(0, 3)
        p = quad[i] + (quad[(i + 1) % 4] - quad[i]) * rnd(0.05, 0.95)
        inward = centre - p
        inward /= max(np.linalg.norm(inward), 1e-3)
        q = p + inward * width * rnd(0.05, 0.3)
        p0 = p - inward * width * rnd(0.1, 0.5)
        cv2.line(canvas, (int(p0[0]), int(p0[1])), (int(q[0]), int(q[1])), col, int(width * rnd(0.1, 0.2)), cv2.LINE_AA)
        cv2.line(ids, (int(p0[0]), int(p0[1])), (int(q[0]), int(q[1])), 0, int(width * rnd(0.1, 0.2)))


# ---------- a whole picture ----------
def scene():
    canvas = background()
    ids = np.zeros((H, W), np.int32)
    placed = []  # (quad, kind)
    dim = rnd(0.45, 1.05)  # under-exposed webcams make cards darker than their scans
    base = rnd(0.045, 0.13) * W  # cards on one table are all the same size
    sleeved = random.random() < 0.5
    n_table = random.choice([0, 0, 1, 1, 2, 3, 4, 5, 6, 8, 10, 14])
    lean = rnd(0, 0.03)
    for _ in range(n_table):
        w = base * rnd(0.92, 1.08)
        r = random.random()
        ang = rnd(-0.14, 0.14) + random.choice([0, math.pi]) if r < 0.5 else rnd(-0.14, 0.14) + random.choice([-1, 1]) * math.pi / 2 if r < 0.7 else rnd(-math.pi, math.pi)
        if placed and random.random() < 0.25:  # stacked on another card, peeking out
            ref = random.choice(placed)[0].mean(axis=0)
            cx, cy = ref[0] + rnd(-0.9, 0.9) * w, ref[1] + rnd(-0.9, 0.9) * w
        else:
            cx, cy = rnd(-0.02, 1.02) * W, rnd(-0.03, 1.03) * H
        quad = quad_for(cx, cy, w, ang, lean)
        if random.random() < (0.9 if sleeved else 0.1):
            img, alpha, src = card_layers(load_card(), True)
        else:
            img, alpha, src = card_layers(load_card(), False)
        if random.random() < 0.25:
            img = glare(img, alpha)
        paste(canvas, ids, len(placed) + 1, img, alpha, src, quad, shade=dim * rnd(0.9, 1.1))
        placed.append((quad, 'table'))
    if random.random() < 0.5:  # one card held up to the camera
        w = rnd(0.13, 0.45) * W
        r = random.random()
        ang = rnd(-0.25, 0.25) + (math.pi if random.random() < 0.5 else 0) if r < 0.85 else rnd(-math.pi, math.pi)
        cx, cy = rnd(0.1, 0.9) * W, rnd(0.1, 0.9) * H
        quad = quad_for(cx, cy, w, ang, rnd(0, 0.05))
        if random.random() < 0.85:
            arm(canvas, ids, quad.mean(axis=0) + np.random.randn(2) * w * 0.3, w)
        img, alpha, src = card_layers(load_card())
        if random.random() < 0.3:
            img = glare(img, alpha)
        paste(canvas, ids, len(placed) + 1, img, alpha, src, quad, shade=min(1.15, dim * rnd(1.0, 1.4)), shadow=False)
        if random.random() < 0.8:
            fingers(canvas, ids, quad, w)
        if random.random() < 0.3:  # moving a little
            k = random.choice([3, 5, 7])
            kern = np.zeros((k, k), np.float32)
            kern[k // 2, :] = 1 / k
            kern = cv2.warpAffine(kern, cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rnd(0, 180), 1), (k, k))
            x0, y0 = np.clip(quad.min(axis=0).astype(int) - 12, 0, None)
            x1, y1 = quad.max(axis=0).astype(int) + 12
            canvas[y0:y1, x0:x1] = cv2.filter2D(canvas[y0:y1, x0:x1], -1, kern / max(kern.sum(), 1e-6))
        placed.append((quad, 'held'))
    elif random.random() < 0.3:  # a hand over the table without a card
        arm(canvas, ids, (rnd(0.1, 0.9) * W, rnd(0.1, 0.9) * H), rnd(0.08, 0.3) * W)

    labels = []
    for i, (quad, kind) in enumerate(placed, start=1):
        bx0, by0 = np.clip(np.floor(quad.min(axis=0)).astype(int), 0, [W, H])
        bx1, by1 = np.clip(np.ceil(quad.max(axis=0)).astype(int) + 1, 0, [W, H])
        if bx1 - bx0 < 2 or by1 - by0 < 2:
            continue
        mask = np.zeros((by1 - by0, bx1 - bx0), np.uint8)
        cv2.fillConvexPoly(mask, (quad - (bx0, by0)).astype(np.int32), 1)
        area_all = abs(cv2.contourArea(quad.astype(np.float32)))
        inside = mask.sum()
        seen = int(((ids[by0:by1, bx0:bx1] == i) & (mask > 0)).sum())
        if area_all < 1 or inside / area_all < 0.6 or seen / max(inside, 1) < 0.6:
            continue  # mostly out of the picture or under other cards
        x0, y0 = np.clip(quad.min(axis=0), 0, [W - 1, H - 1])
        x1, y1 = np.clip(quad.max(axis=0), 0, [W - 1, H - 1])
        row = [0, (x0 + x1) / 2 / W, (y0 + y1) / 2 / H, (x1 - x0) / W, (y1 - y0) / H]
        for x, y in quad:
            ok = 0 <= x < W and 0 <= y < H
            if ok:
                xi, yi = int(min(W - 1, max(0, x))), int(min(H - 1, max(0, y)))
                near = ids[max(0, yi - 3):yi + 4, max(0, xi - 3):xi + 4]
                vis = 2 if (near == i).any() else 1
            else:
                vis = 0
            row += [min(1, max(0, x / W)), min(1, max(0, y / H)), vis]
        labels.append(row)
    return finish(canvas), labels


def finish(img):
    """What the camera and the video call do to the picture."""
    img = img.astype(np.float32)
    img *= np.array([rnd(0.85, 1.15), rnd(0.9, 1.1), rnd(0.85, 1.15)], np.float32)  # colour cast
    img = (img - 128) * rnd(0.7, 1.25) + 128 + rnd(-30, 25)
    if random.random() < 0.4:  # light falling off across the table
        gx = np.linspace(rnd(0.6, 1.1), rnd(0.6, 1.1), W, dtype=np.float32)[None, :, None]
        gy = np.linspace(rnd(0.7, 1.1), rnd(0.7, 1.1), H, dtype=np.float32)[:, None, None]
        img *= gx * gy
    img = np.clip(img, 0, 255)
    if random.random() < 0.6:
        s = rnd(0.3, 1.6)
        img = cv2.GaussianBlur(img, (0, 0), s)
    if random.random() < 0.35:  # low-resolution video scaled back up
        k = rnd(0.4, 0.8)
        img = cv2.resize(cv2.resize(img, (int(W * k), int(H * k)), interpolation=cv2.INTER_AREA), (W, H), interpolation=cv2.INTER_LINEAR)
    img += np.random.randn(H, W, 3).astype(np.float32) * rnd(0, 7)
    img = np.clip(img, 0, 255).astype(np.uint8)
    if random.random() < 0.7:
        ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, random.randint(35, 92)])
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return img


def work(job):
    split, i, seed = job
    random.seed(seed)
    np.random.seed(seed % (2 ** 32))
    cv2.setNumThreads(1)
    img, labels = scene()
    cv2.imwrite(str(ROOT / 'data' / 'images' / split / f'{i:06d}.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    with open(ROOT / 'data' / 'labels' / split / f'{i:06d}.txt', 'w') as f:
        for row in labels:
            f.write(' '.join(f'{v:.6f}' if isinstance(v, float) else str(v) for v in row) + '\n')
    return len(labels)


def draw(img, labels):
    for row in labels:
        pts = np.array(row[5:]).reshape(4, 3)
        q = (pts[:, :2] * (W, H)).astype(np.int32)
        cv2.polylines(img, [q], True, (0, 255, 0), 2, cv2.LINE_AA)
        cv2.circle(img, tuple(q[0]), 6, (0, 0, 255), -1)  # the card's own top-left
        cv2.circle(img, tuple(q[1]), 6, (255, 0, 0), -1)
    return img


if __name__ == '__main__':
    split = sys.argv[1]
    n = int(sys.argv[2])
    if split == 'preview':
        (ROOT / 'preview').mkdir(exist_ok=True)
        random.seed(3)
        np.random.seed(3)
        for i in range(n):
            img, labels = scene()
            cv2.imwrite(str(ROOT / 'preview' / f'{i:02d}.jpg'), draw(img, labels))
        print('preview/ written')
    else:
        for d in ('images', 'labels'):
            (ROOT / 'data' / d / split).mkdir(parents=True, exist_ok=True)
        start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        jobs = [(split, i, hash((split, i)) & 0x7fffffff) for i in range(start, start + n)]
        with Pool(int(os.environ.get('GEN_PROCS', 10))) as pool:
            total = sum(pool.imap_unordered(work, jobs, chunksize=32))
        print(split, n, 'pictures,', total, 'cards')
