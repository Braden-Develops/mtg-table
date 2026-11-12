/* Card tracking for stickers on your own camera. Runs only in the camera owner's browser (full-quality
   local video, and no load on the server):
   - Finding the card under a sticker: the corner model (same one the server uses to recognize cards)
     in a worker, on a crop around the sticker. Used to start tracking, to find a card again after it
     was tapped or covered, and to straighten the outline once a moved card comes to rest.
   - Following it frame to frame: a small grayscale template of the card's middle, matched by normalized
     cross-correlation on a 640-px-wide copy of the picture. A card that sits still costs one match.
   - Positions go to the other players over a lossy LiveKit data channel (a few times a second); the
     sticker's position in the shared game state is updated once the card comes to rest.
   - A card that can't be found for a few seconds has left the battlefield: its sticker is removed
     (fading first, with Undo for the owner).
   If anything is missing (no model on the server, no WebAssembly, no camera) stickers just stay put. */
window.Tracker = (() => {
  const TOPIC = 'track';
  const FPS = 12;
  const WORK_W = 640; // width of the grayscale copy used for matching
  const GRID = 22; // template points along the card's long side
  const BAND = 5; // band-pass: 3x3 blur minus 11x11 blur (working pixels)
  const INNER = 0.4; // template covers the middle 80% of the card (skips sleeve edges and the table)
  const STAY = 0.8; // match where it was: the card didn't move
  const SURE = 0.85; // below this for a while (half-turned, odd light): ask the model to check
  const OK = 0.6; // match good enough to follow a small move
  const JUMP = 0.75; // match needed to follow a big move (sliding fast, tapping)
  const RECOVER_NEAR = 0.3; // a card the model finds right where ours was (tapped): low bar
  const RECOVER_FAR = 0.55;
  const RECOVER_ANYWHERE = 0.7; // a card found anywhere else in the picture (whole-picture finder)
  const FADE_AFTER = 2500; // lost this long: stickers fade for everyone
  const REMOVE_AFTER = 8000; // lost this long (and neither the model nor whole-picture scans find it): removed
  const GLIDE_MS = 400; // a card lost while sliding: assume it kept going this long
  const SCAN_MS = 700; // whole-picture search for a lost card: at most this often
  const SETTLE_MS = 700; // a moved card resting this long gets its outline straightened
  const PERSIST_MS = 1000; // ...and its sticker position saved in the game state
  const SEND_MS = 125; // live position updates to other players: at most 8 a second
  const SNAPSHOT_MS = 2000; // and everything every 2 s, for late joiners and lost packets
  const REMOTE_DELAY = 150; // their video arrives a little after our data: wait so the two line up
  const LIVE_TTL = 5000;
  const DET = 640;

  let code = null;
  let me = null;
  let act = null;
  let room = null;
  let state = null;
  let enabled = true;
  try { enabled = localStorage.getItem('trackCards') !== '0'; } catch { /* ignore */ }

  const tracks = new Map(); // sticker id -> track
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- small geometry helpers (as in server/recognize.js) ----------
  const centre = (q) => [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  function sortCorners(pts) {
    const [cx, cy] = centre(pts);
    const cw = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    const start = cw.reduce((best, p, i) => (p[0] + p[1] < cw[best][0] + cw[best][1] ? i : best), 0);
    return [0, 1, 2, 3].map((k) => cw[(start + k) % 4]);
  }
  function insideQuad([px, py], quad) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = quad[i];
      const [xj, yj] = quad[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function shapeScore(c) {
    const s = [dist(c[0], c[1]), dist(c[1], c[2]), dist(c[2], c[3]), dist(c[3], c[0])];
    const sideA = (s[0] + s[2]) / 2;
    const sideB = (s[1] + s[3]) / 2;
    if (!sideA || !sideB) return 0;
    const parallel = (Math.min(s[0], s[2]) / Math.max(s[0], s[2])) * (Math.min(s[1], s[3]) / Math.max(s[1], s[3]));
    const aspect = Math.min(sideA, sideB) / Math.max(sideA, sideB);
    return parallel * Math.max(0, 1 - Math.max(0, Math.abs(aspect - 0.75) - 0.08) * 4);
  }
  // A card's pose: centre, angle of its short side (th), short side a, long side b.
  function poseFromQuad(quad) {
    const c = sortCorners(quad);
    const [cx, cy] = centre(c);
    const top = (dist(c[0], c[1]) + dist(c[2], c[3])) / 2;
    const side = (dist(c[1], c[2]) + dist(c[3], c[0])) / 2;
    let dx;
    let dy;
    if (top <= side) {
      dx = (c[1][0] - c[0][0] + c[2][0] - c[3][0]) / 2;
      dy = (c[1][1] - c[0][1] + c[2][1] - c[3][1]) / 2;
    } else {
      dx = (c[2][0] - c[1][0] + c[3][0] - c[0][0]) / 2;
      dy = (c[2][1] - c[1][1] + c[3][1] - c[0][1]) / 2;
    }
    return { cx, cy, th: Math.atan2(dy, dx), a: Math.min(top, side), b: Math.max(top, side), shape: shapeScore(c) };
  }

  // ---------- the picture ----------
  let work = null; // { canvas, ctx, w, h, vw, vh, gray (band-passed brightness), sum (integral image) }
  let lastSum = -1;
  const localVideo = () => document.querySelector('.tile[data-local="1"] video');

  function grab(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const w = Math.min(WORK_W, vw);
    const h = Math.round((vh * w) / vw);
    if (!work || work.w !== w || work.h !== h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      work = {
        canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), w, h,
        gray: new Float32Array(w * h), sum: new Float64Array((w + 1) * (h + 1)),
      };
      for (const t of tracks.values()) restart(t, t.x, t.y); // the picture changed size: start over
    }
    work.vw = vw;
    work.vh = vh;
    work.ctx.drawImage(video, 0, 0, w, h);
    const d = work.ctx.getImageData(0, 0, w, h).data;
    work.rgb = d; // kept for colourSig()
    // Integral image of the brightness, for fast box blurs.
    const S = work.sum;
    const W1 = w + 1;
    let check = 0;
    for (let y = 0, j = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++, j += 4) {
        row += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
      }
      check += row * (y + 1); // any change anywhere in the picture changes this
    }
    // The same picture as last time: the camera is paused or off (real cameras always have noise).
    if (check === lastSum) return false;
    lastSum = check;
    // Band-pass (small blur minus big blur): card details (text, art, frame lines) without the
    // large light/dark areas, which would match any similar patch of table.
    const g = work.gray;
    const R = BAND;
    for (let y = 0, i = 0; y < h; y++) {
      // Row offsets of the two boxes (clamped at the picture's edges).
      const s0 = Math.max(0, y - 1) * W1;
      const s1 = Math.min(h, y + 2) * W1;
      const b0 = Math.max(0, y - R) * W1;
      const b1 = Math.min(h, y + R + 1) * W1;
      const sh = (s1 - s0) / W1;
      const bh = (b1 - b0) / W1;
      for (let x = 0; x < w; x++, i++) {
        const xa = x > 0 ? x - 1 : 0;
        const xb = x + 2 < w ? x + 2 : w;
        const xc = x > R ? x - R : 0;
        const xd = x + R + 1 < w ? x + R + 1 : w;
        const small = (S[s1 + xb] - S[s0 + xb] - S[s1 + xa] + S[s0 + xa]) / ((xb - xa) * sh);
        const big = (S[b1 + xd] - S[b0 + xd] - S[b1 + xc] + S[b0 + xc]) / ((xd - xc) * bh);
        g[i] = small - big;
      }
    }
    return true;
  }

  function sample(x, y) {
    const { w, h, gray } = work;
    if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
    if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
  }

  // ---------- which card is which ----------
  // A card's colours, as a small grid over its face in the card's own frame (so it turns with the
  // card): what tells two cards apart when their stickers have to be sorted out after a shuffle.
  // The grey template alone can't: under a webcam most cards are "a box of text over a picture".
  function colourSig(p, a = p.a, b = p.b) {
    const { w, h, rgb } = work;
    if (!rgb) return null;
    const out = new Float32Array(4 * 6 * 3);
    const c = Math.cos(p.th);
    const s = Math.sin(p.th);
    let k = 0;
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 4; i++) {
        const u = (-0.3 + 0.2 * i) * a;
        const v = (-0.35 + 0.14 * j) * b;
        const x = Math.min(w - 2, Math.max(1, Math.round(p.cx + u * c - v * s)));
        const y = Math.min(h - 2, Math.max(1, Math.round(p.cy + u * s + v * c)));
        let r = 0;
        let g = 0;
        let bl = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = ((y + dy) * w + x + dx) * 4;
            r += rgb[q];
            g += rgb[q + 1];
            bl += rgb[q + 2];
          }
        }
        // Colour apart from brightness (the +: very dark patches have no reliable colour).
        const sum = r + g + bl + 270;
        out[k++] = r / sum;
        out[k++] = g / sum;
        out[k++] = bl / sum;
      }
    }
    return out;
  }
  // 1 = the same colours, 0 = clearly a different card.
  function colourLike(A, B) {
    if (!A || !B) return 0.5;
    let d = 0;
    for (let i = 0; i < A.length; i++) d += Math.abs(A[i] - B[i]);
    return Math.max(0, 1 - d / A.length / 0.05);
  }
  // How well a found card fits a sticker's card: the grey template (either way up) plus colours.
  function rate(t, p) {
    let best = null;
    for (const th of [p.th, p.th + Math.PI]) {
      const r = polish(t, { cx: p.cx, cy: p.cy, th });
      const colour = colourLike(t.col, colourSig({ cx: r.cx, cy: r.cy, th: r.th }, t.a, t.b));
      const total = r.score + 0.5 * colour;
      if (!best || total > best.total) best = { th, score: r.score, colour, total };
    }
    return best;
  }

  // ---------- covered, or gone? ----------
  // A sticker whose card can't be seen is removed after a while: the card left the table. Unless
  // something is in the way (an arm reaching across, a hand hovering). The difference shows around
  // the card, not on it: when a card is picked up the table around it looks as before; under an
  // arm the surroundings have changed too. So each sticker remembers the brightness of a ring of
  // points around its card while it follows it, and while lost that ring is compared with now.
  function ringSample(pose, a, b) {
    const { w, h, rgb } = work;
    if (!rgb) return null;
    const out = [];
    const c = Math.cos(pose.th);
    const s = Math.sin(pose.th);
    for (let j = -3; j <= 3; j++) {
      for (let i = -3; i <= 3; i++) {
        const u = (i / 3) * 1.15 * a;
        const v = (j / 3) * 0.95 * b;
        if (Math.abs(u) < a * 0.6 && Math.abs(v) < b * 0.6) continue; // on the card itself
        const x = Math.round(pose.cx + u * c - v * s);
        const y = Math.round(pose.cy + u * s + v * c);
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2) { out.push(-1); continue; } // off the picture
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = ((y + dy) * w + x + dx) * 4;
            sum += rgb[q] * 0.3 + rgb[q + 1] * 0.59 + rgb[q + 2] * 0.11;
          }
        }
        out.push(sum / 9);
      }
    }
    return out;
  }
  // Has the table around this sticker's card changed since it was last followed? (0-1: the share of
  // the ring that looks different, after allowing for the camera re-exposing.)
  function ringChanged(t) {
    if (!t.ring || !work?.rgb) return 0;
    const now = ringSample(t.ringPose, t.a, t.b);
    let sa = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < now.length; i++) {
      if (now[i] < 0 || t.ring[i] < 0) continue;
      sa += t.ring[i];
      sb += now[i];
      n++;
    }
    if (n < 8) return 0;
    const gain = Math.min(1.6, Math.max(0.6, sb > 1 ? sa / sb : 1));
    let changed = 0;
    for (let i = 0; i < now.length; i++) {
      if (now[i] < 0 || t.ring[i] < 0) continue;
      if (Math.abs(t.ring[i] - now[i] * gain) > 26) changed++;
    }
    return changed / n;
  }
  const COVERED = 0.3; // this much of the ring changed: something is over the card
  const UNCOVERED_WAIT = 2500; // after it clears, the card gets this long to be found again

  // ---------- templates ----------
  // Sample points over the middle of the card, in card units scaled by its size.
  function buildTemplate(t, pose) {
    const nv = GRID;
    const nu = Math.max(8, Math.round((GRID * pose.a) / pose.b));
    const n = nu * nv;
    t.a = pose.a;
    t.b = pose.b;
    t.du = new Float32Array(n);
    t.dv = new Float32Array(n);
    const coarse = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i;
        t.du[k] = (-INNER + (2 * INNER * i) / (nu - 1)) * pose.a;
        t.dv[k] = (-INNER + (2 * INNER * j) / (nv - 1)) * pose.b;
        if (i % 2 === 0 && j % 2 === 0) coarse.push(k);
      }
    }
    t.all = Int32Array.from({ length: n }, (_, k) => k);
    t.coarse = Int32Array.from(coarse);
    t.offs = new Map();
    const off = offsets(t, pose.th);
    const values = (idx) => {
      const v = Float32Array.from(idx, (k) => sample(pose.cx + off.x[k], pose.cy + off.y[k]));
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      let norm = 0;
      for (let k = 0; k < v.length; k++) { v[k] -= mean; norm += v[k] * v[k]; }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < v.length; k++) v[k] /= norm;
      return v;
    };
    t.tAll = values(t.all);
    t.tCoarse = values(t.coarse);
    t.col = colourSig(pose);
  }

  function offsets(t, th) {
    const key = Math.round(th * 500);
    let o = t.offs.get(key);
    if (!o) {
      if (t.offs.size > 64) t.offs.clear();
      const c = Math.cos(th);
      const s = Math.sin(th);
      const n = t.du.length;
      o = { x: new Float32Array(n), y: new Float32Array(n) };
      for (let k = 0; k < n; k++) {
        o.x[k] = t.du[k] * c - t.dv[k] * s;
        o.y[k] = t.du[k] * s + t.dv[k] * c;
      }
      t.offs.set(key, o);
    }
    return o;
  }

  // Normalized cross-correlation of the template with the picture at a pose (1 = identical).
  function ncc(t, cx, cy, th, coarse) {
    const off = offsets(t, th);
    const idx = coarse ? t.coarse : t.all;
    const T = coarse ? t.tCoarse : t.tAll;
    const n = idx.length;
    let s = 0;
    let ss = 0;
    let st = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      const v = sample(cx + off.x[i], cy + off.y[i]);
      s += v;
      ss += v * v;
      st += v * T[k];
    }
    const variance = ss - (s * s) / n;
    if (variance < n * 0.5) return 0; // flat (covered by a hand, or an empty table)
    return st / Math.sqrt(variance);
  }

  // Best translation in a window (coarse template), then a full-template polish of position and angle.
  function search(t, cx, cy, th, radius, step) {
    let best = { score: -1, cx, cy, th };
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const score = ncc(t, cx + dx, cy + dy, th, true);
        if (score > best.score) best = { score, cx: cx + dx, cy: cy + dy, th };
      }
    }
    return polish(t, best, step);
  }

  function polish(t, start, step = 1) {
    let best = { ...start, score: ncc(t, start.cx, start.cy, start.th, false) };
    const r = Math.max(1, Math.ceil(step / 2));
    for (const dth of [0, 0.05, -0.05, 0.1, -0.1]) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!dth && !dx && !dy) continue;
          const p = { cx: start.cx + dx, cy: start.cy + dy, th: start.th + dth };
          const score = ncc(t, p.cx, p.cy, p.th, false);
          if (score > best.score) best = { ...p, score };
        }
      }
    }
    return best;
  }

  // ---------- tracks ----------
  // phase: acquire (waiting for the model) | track | none (no card under it)
  function restart(t, x, y) {
    Object.assign(t, { phase: 'acquire', x, y, lostMs: 0, weakMs: 0, skip: 0, tries: 0, retryAt: 0, pose: null, vx: 0, vy: 0, moved: false, recoverTries: 0, scans: 0, scanAt: 0, sentKey: '' });
  }

  function placeFromPose(t) {
    const { cx, cy, th } = t.pose;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const px = cx + t.p * t.a * c - t.q * t.b * s;
    const py = cy + t.p * t.a * s + t.q * t.b * c;
    t.x = Math.min(1, Math.max(0, px / work.w));
    t.y = Math.min(1, Math.max(0, py / work.h));
  }

  // Start following a card: remember where the sticker sits on it, in the card's own coordinates.
  function anchor(t, pose) {
    buildTemplate(t, pose);
    t.pose = { cx: pose.cx, cy: pose.cy, th: pose.th };
    const rx = t.x * work.w - pose.cx;
    const ry = t.y * work.h - pose.cy;
    const c = Math.cos(pose.th);
    const s = Math.sin(pose.th);
    t.p = (rx * c + ry * s) / pose.a;
    t.q = (-rx * s + ry * c) / pose.b;
    t.good = { ...t.pose };
    t.since = performance.now();
    t.phase = 'track';
    t.lostMs = 0;
    t.weakMs = 0;
    t.recoverTries = 0;
    cardLen = cardLen ? cardLen * 0.7 + pose.b * 0.3 : pose.b;
  }

  // Move to a new pose of the same card (after tapping, or a straightened outline): fresh template.
  function reanchor(t, pose) {
    buildTemplate(t, pose);
    t.pose = { cx: pose.cx, cy: pose.cy, th: pose.th };
    t.good = { ...t.pose };
    t.lostMs = 0;
    t.weakMs = 0;
    t.recoverTries = 0;
    t.via = 'model';
    placeFromPose(t);
  }

  let cardLen = null; // typical card length on camera, in working pixels

  // Where a card that was sliding when we lost it has probably come to rest: carry on along its last
  // velocity for a moment (cards slide for a fraction of a second, then stop).
  function restingGuess(t) {
    const glide = Math.min(t.lostMs + 60, GLIDE_MS);
    return { cx: t.pose.cx + t.vx * glide, cy: t.pose.cy + t.vy * glide };
  }

  function step(t, dt, now) {
    const p = t.pose;
    const cur = ncc(t, p.cx, p.cy, p.th, false);
    let best;
    if (cur >= STAY) {
      // Still there; follow slow slides of a pixel or two.
      best = polish(t, { ...p, score: cur });
    } else {
      best = search(t, p.cx, p.cy, p.th, 3, 1);
      // Moving, tapped, covered or gone: look further. When it's been missing a while, only every third frame.
      if (best.score < STAY && (t.lostMs + t.weakMs < 1500 || t.skip++ % 3 === 0)) {
        const L = t.b;
        // Where it should be now if it kept its speed; the faster it goes, the wider we look.
        const lead = t.lostMs ? restingGuess(t) : { cx: p.cx + t.vx * dt, cy: p.cy + t.vy * dt };
        const travel = Math.hypot(lead.cx - p.cx, lead.cy - p.cy);
        const radius = Math.round(Math.min(L * 2.5, Math.max(4, L * 0.45, travel * 0.6)));
        const tries = [
          search(t, lead.cx, lead.cy, p.th, radius, radius > L ? 3 : 2),
          search(t, p.cx, p.cy, p.th + Math.PI / 2, Math.round(L * 0.5), 2),
          search(t, p.cx, p.cy, p.th - Math.PI / 2, Math.round(L * 0.5), 2),
        ];
        // A jump must be convincing: half-matches on a half-turned card or the table drag the sticker off.
        for (const r of tries) if (r.score >= JUMP && r.score > best.score) best = r;
        // (Only without the whole-picture finder, which finds askew cards itself: these extra
        // guesses also made stickers hop onto a card held up in front of theirs.)
        if (best.score < JUMP && !hasFinder) {
          // Turned a little while it moved (a card slid by hand rarely stays square to the camera).
          const near = Math.round(Math.min(radius, L * 0.6));
          for (const dth of TILTS) {
            const r = search(t, lead.cx, lead.cy, p.th + dth, near, 2);
            if (r.score >= JUMP && r.score > best.score) best = r;
          }
        }
        if (best.score < JUMP) {
          // Look wider still around where it was and where it was heading, and be stricter.
          const mid = { cx: (p.cx + lead.cx) / 2, cy: (p.cy + lead.cy) / 2 };
          const wide = search(t, mid.cx, mid.cy, p.th, Math.round(Math.min(L * 3, L * 1.1 + travel / 2)), 3);
          if (wide.score >= JUMP + 0.07 && wide.score > best.score) best = wide;
        }
      }
    }
    // A jump onto something whose colours are clearly another card's (cards crossing, a card held
    // up in front) isn't followed.
    if (best.score >= OK && t.col && Math.hypot(best.cx - p.cx, best.cy - p.cy) > t.a * 0.5
      && colourLike(t.col, colourSig(best, t.a, t.b)) < 0.25) best = { ...p, score: 0 };
    t.score = best.score;
    t.weakMs = best.score < SURE ? t.weakMs + dt : 0;
    // Weak for long and the model couldn't fix it: treat as lost (it may have left the table).
    if (best.score >= OK && t.weakMs < 2500) found(t, best, dt, now);
    else {
      t.lostMs += dt;
      if (t.lostMs > GLIDE_MS) { t.vx *= 0.7; t.vy *= 0.7; }
    }
  }

  // Follow the card to a new pose. Velocity is in working pixels per millisecond.
  function found(t, best, dt, now) {
    const p = t.pose;
    const dx = best.cx - p.cx;
    const dy = best.cy - p.cy;
    const span = Math.max(dt, 1) + (t.lostMs || 0);
    // Found again after a gap: it has probably slowed down, so trust that speed less.
    const keep = t.lostMs ? 0.3 : 0.6;
    t.vx = keep * (dx / span) + (1 - keep) * t.vx * (t.lostMs ? 0 : 1);
    t.vy = keep * (dy / span) + (1 - keep) * t.vy * (t.lostMs ? 0 : 1);
    if (Math.hypot(dx, dy) > 0.6 || Math.abs(angDiff(best.th, p.th)) > 0.04) {
      t.moved = true;
      t.lastMove = now;
    }
    t.pose = { cx: best.cx, cy: best.cy, th: best.th };
    if (best.score >= STAY) t.good = { ...t.pose };
    // Remember the table around the card (see "covered, or gone?"), about once a second while it rests.
    if (best.score >= STAY && now - (t.lastMove || 0) > 600 && now - (t.ringAt || 0) > 1000) {
      t.ring = ringSample(t.pose, t.a, t.b);
      t.ringPose = { ...t.pose };
      t.ringAt = now;
    }
    t.lostMs = 0;
    t.recoverTries = 0;
    t.scans = 0;
    placeFromPose(t);
  }

  // How a lost card may have been turned since it was last seen: as it was, tapped or untapped, and
  // each of those left a little askew. One group per whole-picture search.
  const TILTS = [0.17, -0.17, 0.34, -0.34, 0.51, -0.51];
  const QUARTER = Math.PI / 2;
  const SCAN_TURNS = [[0], [QUARTER, -QUARTER], [0.17, -0.17], [0.34, -0.34], [QUARTER + 0.17, QUARTER - 0.17],
    [-QUARTER + 0.17, -QUARTER - 0.17], [0.51, -0.51]];

  // Last resort for a card that's been lost a moment (thrown across the mat faster than we could
  // follow, or put down askew): look for it over the whole picture. Costs a few tens of ms, so one track at a time,
  // and at most every SCAN_MS per track. Takes the best clear match, preferring the one nearest to
  // where it was heading if two are about as good (two copies of a basic land).
  function scanAll(t, now) {
    t.scanAt = now + (t.lostMs > 10000 ? 3000 : SCAN_MS);
    const groups = hasFinder ? SCAN_TURNS.slice(0, 2) : SCAN_TURNS;
    const turns = groups[t.scans % groups.length];
    t.scans++;
    const { w, h } = work;
    const m = Math.ceil(t.a * 0.3);
    const peaks = []; // a few best spots, kept apart from each other
    for (const turn of turns) {
      const th = t.pose.th + turn;
      for (let y = m; y < h - m; y += 3) {
        for (let x = m; x < w - m; x += 3) {
          const score = ncc(t, x, y, th, true);
          if (score < JUMP - 0.1) continue; // the angle may be a little off: polished below
          const near = peaks.findIndex((q) => Math.hypot(q.cx - x, q.cy - y) < t.a * 0.5);
          if (near >= 0) {
            if (score > peaks[near].score) peaks[near] = { score, cx: x, cy: y, th };
            continue;
          }
          peaks.push({ score, cx: x, cy: y, th });
          if (peaks.length > 6) peaks.sort((a, b) => b.score - a.score).pop();
        }
      }
    }
    const guess = restingGuess(t);
    let best = null;
    for (const q of peaks) {
      const r = polish(t, search(t, q.cx, q.cy, q.th, 2, 1));
      if (r.score < JUMP + 0.07 || (t.col && colourLike(t.col, colourSig(r, t.a, t.b)) < 0.25)) continue;
      r.dist = Math.hypot(r.cx - guess.cx, r.cy - guess.cy);
      if (!best || r.score > best.score + 0.03 || (Math.abs(r.score - best.score) <= 0.03 && r.dist < best.dist)) best = r;
    }
    if (best) { found(t, best, 0, now); t.via = 'scan'; }
    return !!best;
  }

  // ---------- the corner model (worker) ----------
  let worker = null;
  let detector = 'off'; // off | loading | ready | failed
  let detCanvas = null;
  let detCtx = null;
  let reqId = 0;
  const pending = new Map();

  function loadDetector() {
    if (detector !== 'off') return;
    detector = 'loading';
    try {
      worker = new Worker('/static/track-worker.js', { type: 'module' });
    } catch (err) {
      detector = 'failed';
      console.warn('Card tracking unavailable:', err.message);
      return;
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'ready') {
        detector = 'ready';
        hasFinder = !!m.finder;
        console.info(hasFinder ? 'Card finder loaded (whole-picture model)' : 'No whole-picture card finder on this server: using the corner model alone');
        console.info(`Card tracking ready (model loaded in ${m.ms} ms, ${m.threads || 1} thread${m.threads > 1 ? 's' : ''})`);
      } else if (m.t === 'error') {
        detector = 'failed';
        console.warn('Card tracking unavailable:', m.message);
        worker.terminate();
      } else if (m.t === 'result') {
        if (m.message) console.warn('Card finder error:', m.message);
        const done = pending.get(m.id);
        pending.delete(m.id);
        if (m.scan) lastScanMs = m.ms || lastScanMs;
        else lastDetMs = m.ms || lastDetMs;
        done?.(m.cards || []);
      }
    };
    worker.onerror = (err) => {
      detector = 'failed';
      console.warn('Card tracking unavailable:', err.message);
    };
    worker.postMessage({ t: 'load', code });
  }
  let lastDetMs = 0;
  let lastScanMs = 0;
  let lastJob = null;
  // The whole-picture card finder (see track-worker.js): one look outlines every card in the
  // camera's picture, wherever and however it lies. A card it scores this high is taken as found.
  let hasFinder = false;
  const FIND_SURE = 0.5;
  let scanCanvas = null;
  let scanCtx = null;
  const scanHistory = []; // [{ at, spots: [[x, y]] }] card centres in video pixels
  let lastScan = null; // { at, cards }: looks a moment apart share one run

  // Every card in the camera's picture: [{ score, quad }], corners in video pixels, the card's own
  // top-left corner first.
  async function scanCards(video) {
    const now = performance.now();
    if (lastScan && now - lastScan.at < 60) return lastScan.cards;
    if (!scanCanvas) {
      scanCanvas = document.createElement('canvas');
      scanCanvas.width = 640;
      scanCanvas.height = 360;
      scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // A camera that isn't 16:9 is fitted inside the 640x360 picture.
    const k = Math.min(640 / vw, 360 / vh);
    const ox = (640 - vw * k) / 2;
    const oy = (360 - vh * k) / 2;
    scanCtx.fillStyle = '#727272';
    scanCtx.fillRect(0, 0, 640, 360);
    scanCtx.drawImage(video, ox, oy, vw * k, vh * k);
    const pixels = scanCtx.getImageData(0, 0, 640, 360).data;
    const id = ++reqId;
    worker.postMessage({ t: 'scan', id, pixels }, [pixels.buffer]);
    const cards = (await new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) { console.warn('Card finder: a look timed out'); resolve([]); } }, 8000);
    })).map((c) => ({ score: c.score, quad: c.quad.map(([u, v]) => [(u * 640 - ox) / k, (v * 360 - oy) / k]) }));
    lastScan = { at: performance.now(), cards };
    // Where cards were lying, for a while back: a sticker that loses its card must not jump onto a
    // card that was already somewhere else at the time.
    scanHistory.push({ at: lastScan.at, spots: cards.filter((c) => c.score >= FIND_SURE).map((c) => [(c.quad[0][0] + c.quad[2][0]) / 2, (c.quad[0][1] + c.quad[2][1]) / 2]) });
    if (scanHistory.length > 40) scanHistory.shift();
    return cards;
  }

  // Run the model on a frame of the video: a rotated rectangle { cx, cy, th, w, h } in video pixels,
  // squashed to the model's square input (see cardfind.js for why the frame's shape matters).
  // Resolves with [{ score, quad }], corners in video pixels.
  function runDetector(video, f) {
    if (!detCanvas) {
      detCanvas = document.createElement('canvas');
      detCanvas.width = DET;
      detCanvas.height = DET;
      detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
    }
    detCtx.setTransform(1, 0, 0, 1, 0, 0);
    detCtx.fillStyle = '#444'; // where the frame reaches past the picture
    detCtx.fillRect(0, 0, DET, DET);
    detCtx.translate(DET / 2, DET / 2);
    detCtx.scale(DET / f.w, DET / f.h);
    detCtx.rotate(-f.th);
    detCtx.translate(-f.cx, -f.cy);
    detCtx.drawImage(video, 0, 0);
    detCtx.setTransform(1, 0, 0, 1, 0, 0);
    const pixels = detCtx.getImageData(0, 0, DET, DET).data;
    const id = ++reqId;
    worker.postMessage({ t: 'detect', id, pixels }, [pixels.buffer]);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      // A look that never comes back must not hold up every later one.
      setTimeout(() => { if (pending.delete(id)) { console.warn('Card finder: a look timed out'); resolve([]); } }, 8000);
    })
      .then((cards) => cards.map((c) => ({ score: c.score, quad: c.quad.map(([u, v]) => window.CardFind.fromFrame(f, u, v)) })));
  }

  // For other tools (reading cards held up to the camera): the card at a point of my camera's
  // picture. x, y: the point (0-1 of the picture); side: twice the card's likely length, as a share
  // of the picture's height. opts.table: it may be tapped (lying on the table), so both ways are
  // tried; otherwise only upright (held in a hand), which is one or two looks.
  // Loads the model if needed. Resolves with the outlines found, best first,
  // [{ score, shape, a, b, cx, cy, quad }] in 0-1 of the picture (a, b: of its height), or null without a model.
  async function findCards(video, x, y, side, opts = {}) {
    if (detector === 'off') loadDetector();
    for (let i = 0; detector === 'loading' && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
    if (detector !== 'ready' || !video?.videoWidth) return null;
    while (jobBusy) await new Promise((r) => setTimeout(r, 50));
    jobBusy = true;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (hasFinder) {
        // Every card in the picture; the caller picks by place and size.
        return (await scanCards(video)).map((c) => {
          const p = window.CardFind.quadPose(c.quad);
          return {
            score: c.score, sure: c.score >= FIND_SURE, shape: p.shape, a: p.a / vh, b: p.b / vh, th: p.th, cx: p.cx / vw, cy: p.cy / vh,
            quad: c.quad.map(([qx, qy]) => [qx / vw, qy / vh]),
          };
        }).sort((p, q) => q.score - p.score);
      }
      const len = (side * vh) / 2;
      const r = await window.CardFind.locate((f) => runDetector(video, f), [x * vw, y * vh], {
        size: len * 0.716, angle: opts.angle || 0, quick: true, only: !opts.table, near: len * 0.5, bounds: [vw, vh], maxRuns: opts.table ? 5 : 3,
      });
      return [r.card, ...r.others].filter(Boolean).map((p) => ({
        score: p.score, sure: !!p.sure, shape: p.shape, a: p.a / vh, b: p.b / vh, th: p.th, cx: p.cx / vw, cy: p.cy / vh, quad: p.quad.map(([qx, qy]) => [qx / vw, qy / vh]),
      }));
    } finally {
      jobBusy = false;
    }
  }

  // Where stickers sit on my camera now (0-1 over the picture), and a card's length on camera.
  function stickerSpots() {
    // (Not the tags waiting for a picked-up card: nothing is under those, and a card put down
    // there is worth a look.)
    const waiting = (id) => { const t = tracks.get(id); return !!t && t.phase === 'track' && t.lifted; };
    const out = Object.values(state?.stickers || {}).filter((s) => s.tile === me && !waiting(s.id)).map((s) => ({ x: s.x, y: s.y }));
    for (const t of tracks.values()) if (!waiting(t.id)) out.push({ x: t.x, y: t.y });
    return out;
  }
  const cardSize = () => (cardLen && work ? cardLen / work.h : null); // share of the picture's height

  // The card at (x, y) (working pixels), found by the shared search in cardfind.js: the model only
  // outlines a card well when it's shown upright, in a tall frame, filling about half its width, so
  // the search tries such frames (the size of the other cards on this camera first) and re-frames
  // on what it finds until the model is sure.
  // opts.near: also take a card whose centre is within this distance (working pixels) of the point.
  // opts.angle: how the card was turned when last seen (a pose's th).
  // opts.faint: also return an outline the model was less sure of (dark cards on dark mats).
  // Resolves with poses in working pixels, best first; only cards about the size of the others.
  async function locate(video, x, y, opts = {}) {
    const k = work.vw / work.w;
    if (hasFinder) {
      // opts.anywhere: every card in the picture (a lost card may be far from where it was).
      const found = (await scanCards(video))
        .map((c) => { const quad = c.quad.map(([qx, qy]) => [qx / k, qy / k]); return { ...poseFromQuad(quad), quad, score: c.score, sure: c.score >= FIND_SURE }; })
        .filter((p) => opts.anywhere || insideQuad([x, y], p.quad) || (opts.near && Math.hypot(p.cx - x, p.cy - y) < opts.near))
        .filter((p) => (p.sure || opts.faint) && p.shape > 0.6 && (!cardLen || (p.b > cardLen * 0.6 && p.b < cardLen * 1.6)))
        .sort((p, q) => q.score - p.score);
      lastJob = { at: [Math.round(x), Math.round(y)], looks: 1, scan: lastScanMs, sure: found.some((p) => p.sure), found: found.map((p) => `${Math.round(p.cx)},${Math.round(p.cy)} s${p.score.toFixed(2)} sh${p.shape.toFixed(2)}`) };
      return found;
    }
    const run = (f) => runDetector(video, { cx: f.cx * k, cy: f.cy * k, th: f.th, w: f.w * k, h: f.h * k })
      .then((cards) => cards.map((c) => ({ score: c.score, quad: c.quad.map(([qx, qy]) => [qx / k, qy / k]) })));
    const r = await window.CardFind.locate(run, [x, y], {
      size: cardLen ? cardLen * 0.716 : 0,
      // No card measured on this camera yet: a rough look around the point gives a first size.
      span: cardLen ? 0 : Math.min(work.w, work.h) * 0.5,
      angle: opts.angle ?? null, near: opts.near || 0, bounds: [work.w, work.h], maxRuns: opts.maxRuns || 6, skip: opts.skip || 0, quick: true,
    });
    const found = (r.sure || opts.faint ? [r.card, ...r.others] : r.others.filter((p) => p.sure)).filter(Boolean)
      .map((p) => ({ ...poseFromQuad(p.quad), quad: p.quad, score: p.score, sure: !!p.sure }))
      // An outline the model wasn't sure of is only taken when it is clean: a lopsided one is usually
      // a card seen at the wrong angle, and a sticker anchored to it is lost at the first nudge.
      .filter((p) => (p.sure ? p.shape > 0.6 : p.shape > 0.85 && p.score >= 0.7) && (!cardLen || (p.b > cardLen * 0.6 && p.b < cardLen * 1.6)));
    lastJob = { at: [Math.round(x), Math.round(y)], looks: r.runs, sure: r.sure, found: found.map((p) => `${Math.round(p.cx)},${Math.round(p.cy)} s${p.score.toFixed(2)} sh${p.shape.toFixed(2)}`) };
    return found;
  }

  // Pick the next job for the model: find lost cards first, then check doubtful ones, then new
  // stickers, then straighten cards that came to rest.
  let jobBusy = false;
  async function nextDetection(video, now) {
    if (detector !== 'ready' || jobBusy) return;
    const list = [...tracks.values()];
    const lost = list.find((t) => t.phase === 'track' && t.lostMs > 300 && now >= (t.retryAt || 0));
    const doubtful = list.find((t) => t.phase === 'track' && t.weakMs > 400 && now >= (t.retryAt || 0));
    const fresh = list.find((t) => t.phase === 'acquire' || (t.phase === 'none' && t.tries < 3 && now >= t.retryAt));
    const settled = list.find((t) => t.phase === 'track' && t.moved && t.lostMs === 0 && now - t.lastMove > SETTLE_MS);
    if (!lost && !doubtful && !fresh && !settled) return;
    jobBusy = true;
    try {
      if (lost) await recover(video, lost, now);
      else if (doubtful) await recover(video, doubtful, now, true);
      else if (fresh) await acquire(video, fresh);
      else await straighten(video, settled);
    } catch (err) {
      console.warn('Card tracking:', err);
    } finally {
      jobBusy = false;
    }
  }

  async function acquire(video, t) {
    t.phase = 'acquire';
    const pt = [t.x * work.w, t.y * work.h];
    // Each retry spends a little longer looking (more sizes and angles).
    const seeded = fromIdentify(pt);
    // Each retry carries on where the last stopped: the sticker dead centre on a card lying any
    // way round, then towards one side of it, then towards a corner (see cardfind.js). Without a card size yet,
    // each retry just looks a little longer.
    const [skip, maxRuns] = cardLen ? [[0, 10], [10, 12], [22, 8]][Math.min(t.tries, 2)] : [0, 6 + 2 * Math.min(t.tries, 2)];
    const cards = seeded ? [seeded] : await locate(video, pt[0], pt[1], { faint: true, skip, maxRuns });
    if (t.phase !== 'acquire' || !tracks.has(t.id)) return; // moved or removed meanwhile
    const under = cards.filter((p) => insideQuad([t.x * work.w, t.y * work.h], p.quad))
      .sort((a, b) => b.score * b.shape - a.score * a.shape)[0];
    if (under) anchor(t, under);
    else {
      t.phase = 'none';
      t.tries++;
      t.retryAt = performance.now() + (t.tries === 1 ? 1500 : 5000);
    }
    broadcastSoon();
  }

  // Lost (or doubtful): ask the model for the cards around the last position and take the one that
  // matches best, in either orientation. A card right where ours was is ours even if it looks
  // different (tapped under a tilted camera). Doubtful tracks only switch to a match at least as good.
  async function recover(video, t, now, doubt = false) {
    if (!doubt) t.recoverTries++;
    // (A card that has been gone a while, picked up or in a hand, is looked for less often.)
    t.retryAt = now + Math.min(3000, 700 + t.lostMs / 8);
    // Where it was last seen for sure (a doubtful track may have drifted onto something else).
    const at = doubt || t.weakMs > 0 ? { ...t.good } : restingGuess(t);
    const cards = await locate(video, at.cx, at.cy, { near: t.b * (doubt ? 0.75 : 1.3), anywhere: !doubt, angle: t.pose.th, maxRuns: doubt ? 4 : 7 });
    if (t.phase !== 'track' || !tracks.has(t.id) || (!doubt && t.lostMs === 0)) return; // found meanwhile
    let best = null;
    // Cards that were lying elsewhere while ours was still being followed, and cards other stickers
    // are on, aren't ours (a hand covering our card must not send its sticker to a neighbour).
    const k = work.vw / work.w;
    const lostAt = now - t.lostMs;
    const earlier = scanHistory.filter((s) => s.at < lostAt - 100).pop();
    const taken = (p) => [...tracks.values()].some((o) => o !== t && o.phase === 'track' && Math.hypot(o.pose.cx - p.cx, o.pose.cy - p.cy) < o.a * 0.5)
      || (earlier && earlier.spots.some(([sx, sy]) => Math.hypot(sx / k - p.cx, sy / k - p.cy) < p.a * 0.4));
    // Several stickers may have lost their cards at once (cards swapped or shuffled about): a card
    // goes to the sticker it fits best, not to whichever sticker asks first or was nearest.
    const rivals = doubt ? [] : [...tracks.values()].filter((o) => o !== t && o.phase === 'track' && o.lostMs > 0);
    const theirs = (p, mine) => rivals.some((o) => rate(o, p).total > mine + 0.03);
    for (const p of cards) {
      // Only a card where ours was actually last seen gets the low bar (tapped in place); one near
      // where we guess it slid to may be a different card.
      const dist = Math.hypot(p.cx - t.pose.cx, p.cy - t.pose.cy);
      const near = dist < t.b * 0.75
        || (doubt && Math.hypot(p.cx - at.cx, p.cy - at.cy) < t.b * 0.75);
      if (doubt && !near) continue;
      if (!near && taken(p)) continue;
      // With the whole-picture finder, a card further off than a short slide isn't claimed by how
      // it looks: on a full table that put tags on the wrong cards. A card that really was moved
      // there has no tag, so the reader looks it up and brings this one over by name (liftedNamed).
      if (hasFinder && !near && dist > t.b * 1.5) continue;
      // Further away than a short slide: it has to look a lot like ours.
      const bar = near ? RECOVER_NEAR : dist < t.b * 1.5 ? RECOVER_FAR : RECOVER_ANYWHERE;
      // The template is from before: its size may differ a bit, so rate() polishes around the found pose.
      const r = rate(t, p);
      p.fit = r;
      // Its colours must not be clearly another card's (two cards swapped in place look "near").
      if (r.score < bar || r.colour < 0.25 || theirs(p, r.total)) continue;
      const rank = r.total - (near ? 0 : 0.1);
      if (!best || rank > best.rank) best = { pose: p, th: r.th, rank };
    }
    // Nothing looks like the template (lighting changed, something covered part of it while it was
    // learned), but the model clearly sees one card the same size close to where ours was, and no
    // other sticker is following it: that's ours.
    if (!best && !doubt) {
      const mine = cards.filter((p) => p.score > 0.55 && p.shape > 0.85
        && Math.abs(p.b / t.b - 1) < 0.25
        && Math.hypot(p.cx - t.pose.cx, p.cy - t.pose.cy) < t.b * 1.3
        && (!p.fit || (p.fit.colour >= 0.25 && !theirs(p, p.fit.total)))
        && ![...tracks.values()].some((o) => o !== t && o.phase === 'track' && !o.lostMs
          && Math.hypot(o.pose.cx - p.cx, o.pose.cy - p.cy) < o.a * 0.5));
      if (mine.length === 1) {
        const p = mine[0];
        const th = Math.abs(angDiff(p.th, t.pose.th)) <= Math.PI / 2 ? p.th : p.th + Math.PI;
        best = { pose: p, th, rank: 0 };
      }
    }
    const current = ncc(t, t.pose.cx, t.pose.cy, t.pose.th, false);
    // The model confirms a card about as good or better: take its outline and a fresh template.
    if (best && (!doubt || best.rank > current - 0.05)) {
      // Moved onto a card some way off, or sorted out among several lost at once: have it checked.
      const far = Math.hypot(best.pose.cx - t.pose.cx, best.pose.cy - t.pose.cy) > t.b * 0.75;
      reanchor(t, { ...best.pose, th: best.th });
      if ((far || rivals.length) && (t.verifyTries || 0) < 3) t.verify = true;
    }
    broadcastSoon();
  }

  async function straighten(video, t) {
    t.moved = false;
    const at = { ...t.pose };
    const cards = await locate(video, at.cx, at.cy, { near: t.a * 0.35, angle: at.th, maxRuns: 4 });
    if (t.phase !== 'track' || t.moved || t.lostMs) return;
    const p = cards.find((q) => Math.hypot(q.cx - at.cx, q.cy - at.cy) < t.a * 0.35);
    if (!p) return;
    const th = Math.abs(angDiff(p.th, at.th)) <= Math.PI / 2 ? p.th : p.th + Math.PI;
    if (polish(t, { cx: p.cx, cy: p.cy, th }).score < 0.5) return;
    reanchor(t, { ...p, th });
  }

  // ---------- main loop ----------
  let ticker = null;
  let lastTick = 0;
  let lastSend = 0;
  let lastSnapshot = 0;

  function startTicker() {
    if (ticker) return;
    const src = 'let t; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data); };';
    ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    ticker.onmessage = tick;
    ticker.postMessage(Math.round(1000 / FPS));
  }
  function stopTicker() {
    ticker?.terminate();
    ticker = null;
  }

  function tick() {
    const now = performance.now();
    // Nothing has moved for a while: look 4 times a second instead of 12 (a card starting to move
    // is still caught: the wider searches find it a frame later).
    if (now - lastActive > IDLE_AFTER && now - lastTick < 1000 / IDLE_FPS - 20) return;
    const dt = Math.min(300, lastTick ? now - lastTick : 0);
    lastTick = now;
    const video = localVideo();
    if (!video || video.readyState < 2 || !video.videoWidth || video.hidden) return;
    if (detector === 'failed') return stopTicker();
    const t0 = performance.now();
    if (!grab(video)) return; // camera paused or off: nothing gets lost meanwhile
    if (detector === 'off') loadDetector();
    const following = [...tracks.values()].filter((t) => t.phase === 'track');
    for (const t of following) {
      const before = t.pose;
      step(t, dt, now);
      if (t.pose !== before && (t.pose.cx !== before.cx || t.pose.cy !== before.cy || t.pose.th !== before.th)) lastActive = now;
      // (A card gone for a while doesn't keep the fast pace going.)
      if ((t.lostMs && t.lostMs < 10000) || t.weakMs || t.moved) lastActive = now;
    }
    if (tracks.size > following.length) lastActive = now; // still looking for cards
    // Everything lost at once means the camera moved or was covered, not that every card left.
    const lostCount = following.filter((t) => t.lostMs > 0).length;
    const disturbed = following.length >= 3 && lostCount / following.length >= 0.7;
    for (const t of following) {
      if (!t.lostMs) { t.covered = 0; t.lifted = false; continue; }
      // Something is in the way (an arm across the table): the card hasn't gone anywhere we know of.
      t.covered = ringChanged(t);
      if (t.covered >= COVERED) t.coveredAt = now;
      if (now - (t.coveredAt || 0) < UNCOVERED_WAIT) continue;
      if (t.lostMs > REMOVE_AFTER && t.recoverTries >= 2 && t.scans >= (hasFinder ? 3 : SCAN_TURNS.length) && !disturbed) {
        // Not covered and nowhere to be found: it was picked up. Last seen at a pile, it went
        // there. Otherwise its tag waits where it was (faded) until the card is seen again,
        // by its picture here or by name when the reader looks it up; or, with "Tags go when
        // cards leave" switched on, the tag is removed as before.
        const last = t.good || t.pose;
        if (removesLost || (work && zoneAt(last.cx / work.w, last.cy / work.h, 0.03))) removeLost(t);
        else t.lifted = true;
      }
    }
    // One whole-picture search per tick at most, for a card lost a little while.
    const scan = following.find((t) => t.lostMs > 250 && now >= (t.scanAt || 0));
    if (scan && !disturbed) scanAll(scan, now);
    nextDetection(video, now);
    persist(now);
    checkZones(now);
    broadcast(now);
    costMs = costMs * 0.9 + (performance.now() - t0) * 0.1;
  }
  let costMs = 0;
  let lastActive = 0;
  const IDLE_AFTER = 2000;
  const IDLE_FPS = 4;

  // ---------- sharing positions ----------
  function flags(t) {
    return (t.phase === 'track' ? 1 : 0) | (t.phase === 'track' && t.lostMs > FADE_AFTER ? 2 : 0);
  }

  function showLocal(t) {
    window.Marks.setLive(t.id, t.x, t.y, flags(t), true);
  }

  let sendSoon = false;
  function broadcastSoon() { sendSoon = true; }

  function broadcast(now) {
    if (!sendSoon && now - lastSend < SEND_MS) return;
    const full = now - lastSnapshot > SNAPSHOT_MS;
    const v = [];
    for (const t of tracks.values()) {
      if (t.phase !== 'track' && !t.sentKey) continue;
      const key = `${t.x.toFixed(4)},${t.y.toFixed(4)},${flags(t)}`;
      if (key !== t.sentKey) showLocal(t);
      if (!full && key === t.sentKey) continue;
      t.sentKey = t.phase === 'track' ? key : '';
      v.push([t.id, Math.round(t.x * 10000) / 10000, Math.round(t.y * 10000) / 10000, flags(t)]);
    }
    sendSoon = false;
    lastSend = now;
    if (full) lastSnapshot = now;
    if (!v.length || !room) return;
    try {
      room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'pos', v })), { reliable: false, topic: TOPIC });
    } catch { /* not connected */ }
  }

  function onData(payload, participant, topic) {
    if (topic !== TOPIC || !participant) return;
    let msg;
    try { msg = JSON.parse(dec.decode(payload)); } catch { return; }
    if (msg.t !== 'pos' || !Array.isArray(msg.v)) return;
    setTimeout(() => {
      for (const [id, x, y, f] of msg.v.slice(0, 200)) {
        if (typeof id === 'string' && Number.isFinite(x) && Number.isFinite(y)) window.Marks.setLive(id, x, y, f | 0, false);
      }
    }, REMOTE_DELAY);
  }

  // Save resting positions in the game state, so everyone (and late joiners) agree.
  function persist(now) {
    for (const t of tracks.values()) {
      if (t.phase !== 'track' || t.lostMs > 0 || now - (t.lastMove || 0) < PERSIST_MS) continue;
      const s = state?.stickers?.[t.id];
      if (!s || (Math.abs(s.x - t.x) < 0.003 && Math.abs(s.y - t.y) < 0.003)) continue;
      if (t.persisted && Math.abs(t.persisted[0] - t.x) < 0.001 && Math.abs(t.persisted[1] - t.y) < 0.001) continue;
      t.persisted = [Math.round(t.x * 10000) / 10000, Math.round(t.y * 10000) / 10000];
      act({ type: 'stickerMove', id: t.id, x: t.persisted[0], y: t.persisted[1] });
    }
  }

  // Tags of cards that can't be seen any more: removed after a few seconds, or (the default) kept.
  let removesLost = false;
  try { removesLost = localStorage.getItem('removeLost') === '1'; } catch { /* ignore */ }
  function setRemovesLost(on) {
    removesLost = !!on;
    try { localStorage.setItem('removeLost', removesLost ? '1' : '0'); } catch { /* ignore */ }
  }
  // A tag of mine whose card was picked up, by the card's name: { id }. When the reader names a
  // card it finds on the table (or one held up and put down), the waiting tag goes to it,
  // counters and all, instead of a new one being made.
  function liftedNamed(name) {
    for (const t of tracks.values()) {
      // Its card can't be seen (and isn't just covered), or there was never a card under it.
      const waiting = t.phase === 'none' || (t.phase === 'track' && t.lostMs >= 1000 && !(t.covered >= COVERED));
      if (!waiting) continue;
      const s = state?.stickers?.[t.id];
      if (s && !s.unsure && s.items.some((it) => it.type === 'card' && it.name === name)) return { id: t.id };
    }
    return null;
  }

  // ---------- for the reader (autoread.js) ----------
  const recentlyGone = new Map(); // card name -> when its tag left my table
  const wasHere = (name, ms) => performance.now() - (recentlyGone.get(name) ?? -Infinity) < ms;
  // Stickers that were moved to a card some way from where theirs was (cards swapped or shuffled):
  // worth one lookup each to make sure the tag is on the right card. [{ id, name, x, y, a }]
  function toVerify() {
    if (!work) return [];
    const now = performance.now();
    const out = [];
    for (const t of tracks.values()) {
      if (!t.verify || t.phase !== 'track' || t.lostMs > 0 || now - (t.lastMove || 0) < 600) continue;
      const name = state?.stickers?.[t.id]?.items.find((it) => it.type === 'card')?.name;
      if (!name || state.stickers[t.id].unsure) { t.verify = false; continue; }
      out.push({ id: t.id, name, x: t.pose.cx / work.w, y: t.pose.cy / work.h, a: t.a / work.h });
    }
    return out;
  }
  function verified(id) {
    const t = tracks.get(id);
    if (t) { t.verify = false; t.verifyTries = (t.verifyTries || 0) + 1; }
  }
  function markVerify(id) {
    const t = tracks.get(id);
    if (t && (t.verifyTries || 0) < 3) t.verify = true;
  }
  // My card tags as they stand: [{ id, name, card, unsure, x, y, seen }]. x, y: where the tag is
  // (0-1 of the picture); seen: its card is in view under it right now.
  function myTags() {
    const out = [];
    for (const s of Object.values(state?.stickers || {})) {
      if (s.tile !== me || s.fixed) continue;
      const card = s.items.find((it) => it.type === 'card');
      if (!card) continue;
      const t = tracks.get(s.id);
      out.push({ id: s.id, name: card.name, card, unsure: !!s.unsure, x: t ? t.x : s.x, y: t ? t.y : s.y, seen: !!t && t.phase === 'track' && !t.lostMs });
    }
    return out;
  }
  // Another of my stickers carrying this card, if any: { id, x, y }.
  function stickerNamed(name, except) {
    const s = Object.values(state?.stickers || {}).find((x) => x.tile === me && x.id !== except && x.items.some((it) => it.type === 'card' && it.name === name));
    return s ? { id: s.id, x: s.x, y: s.y } : null;
  }

  // ---------- zones ----------
  // The player's piles (command zone, library, graveyard, exile), marked as boxes on their camera
  // with the Zones tool. A stickered card that comes to rest in one has gone there: the sticker is
  // removed and the game log says where it went.
  const ZONE_SAYS = { command: 'back to the command zone', library: 'to the library', graveyard: 'to the graveyard', exile: 'to exile' };
  function zoneAt(cx, cy, slack = 0) {
    for (const [zone, b] of Object.entries(state?.zones?.[me] || {})) {
      if (ZONE_SAYS[zone] && cx >= b[0] - slack && cx <= b[2] + slack && cy >= b[1] - slack && cy <= b[3] + slack) return zone;
    }
    return null;
  }
  function toZone(t, zone) {
    const s = state?.stickers?.[t.id];
    tracks.delete(t.id);
    window.Marks.setLive(t.id, null);
    if (!s) return;
    act({ type: 'stickerZone', id: t.id, zone });
    const name = s.items.find((it) => it.type === 'card')?.name || 'Card';
    showUndo(s, `${name} went ${ZONE_SAYS[zone]}.`);
  }
  function checkZones(now) {
    if (!work || !state?.zones?.[me]) return;
    for (const t of [...tracks.values()]) {
      // At rest, and following its card for sure.
      if (t.phase !== 'track' || t.lostMs > 0 || t.weakMs > 0 || now - Math.max(t.lastMove || 0, t.since || 0) < PERSIST_MS) continue;
      const zone = zoneAt(t.pose.cx / work.w, t.pose.cy / work.h);
      if (zone) toZone(t, zone);
    }
  }

  // ---------- removal ----------
  function removeLost(t) {
    // Last seen in (or at the edge of) a pile: it went there (turned face down on the library, slid
    // under the graveyard), not off the table.
    const last = t.good || t.pose;
    const zone = work && last ? zoneAt(last.cx / work.w, last.cy / work.h, 0.03) : null;
    if (zone) return toZone(t, zone);
    const s = state?.stickers?.[t.id];
    tracks.delete(t.id);
    if (!s) return;
    act({ type: 'stickerRemove', id: t.id });
    showUndo(s);
  }

  let toastTimer = null;
  function showUndo(s, says = null) {
    let el = document.getElementById('track-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'track-toast';
      el.className = 'track-toast';
      document.body.appendChild(el);
    }
    const name = s.items.find((it) => it.type === 'card')?.name || 'a sticker';
    el.innerHTML = '<span></span><button type="button">Undo</button>';
    el.querySelector('span').textContent = says || `Card left the table: removed ${name}.`;
    el.querySelector('button').onclick = () => {
      act({ type: 'stickerAdd', id: s.id, target: s.tile, x: s.x, y: s.y, items: s.items });
      if (s.scale && s.scale !== 1) setTimeout(() => act({ type: 'stickerScale', id: s.id, scale: s.scale }), 300);
      el.hidden = true;
    };
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 10_000);
  }

  // ---------- game state ----------
  function sync(next) {
    // Cards whose (confirmed) tag has just gone from my table: if one shows up again shortly, it is
    // the same card (knocked off while cards were being moved about), not a new question.
    if (state) {
      for (const s of Object.values(state.stickers || {})) {
        if (s.tile !== me || s.unsure || next.stickers?.[s.id]) continue;
        for (const it of s.items) if (it.type === 'card') recentlyGone.set(it.name, performance.now());
      }
    }
    state = next;
    const mine = enabled ? Object.values(next.stickers || {}).filter((s) => s.tile === me && !s.fixed) : [];
    const ids = new Set(mine.map((s) => s.id));
    for (const [id, t] of tracks) {
      if (ids.has(id)) continue;
      tracks.delete(id);
      if (t.phase === 'track') window.Marks.setLive(id, null);
    }
    for (const s of mine) {
      let t = tracks.get(s.id);
      if (!t) {
        t = { id: s.id, stateXY: [s.x, s.y] };
        restart(t, s.x, s.y);
        tracks.set(s.id, t);
        continue;
      }
      // Someone dragged it by hand: follow whatever card is at the new spot.
      const changed = Math.abs(s.x - t.stateXY[0]) > 0.0005 || Math.abs(s.y - t.stateXY[1]) > 0.0005;
      const ours = t.persisted && Math.abs(s.x - t.persisted[0]) < 0.002 && Math.abs(s.y - t.persisted[1]) < 0.002;
      t.stateXY = [s.x, s.y];
      if (changed && !ours) {
        if (t.phase === 'track') window.Marks.setLive(t.id, null);
        restart(t, s.x, s.y);
        t.persisted = null;
      }
    }
    if (tracks.size && detector !== 'failed') startTicker();
    else stopTicker();
  }

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem('trackCards', on ? '1' : '0'); } catch { /* ignore */ }
    if (!on) {
      for (const t of tracks.values()) if (t.phase === 'track') window.Marks.setLive(t.id, null);
      tracks.clear();
      stopTicker();
    }
    if (state) sync(state);
  }

  function init(opts) {
    ({ code, me, act } = opts);
  }

  function setRoom(r) {
    room = r;
  }

  // Is this sticker following a card right now? (on the owner's screen)
  function status(id) {
    const t = tracks.get(id);
    if (!t) return null;
    if (t.phase === 'track') return t.lostMs > 0 ? 'lost' : 'following';
    return t.phase === 'acquire' ? 'looking' : 'no-card';
  }

  function debug() {
    return {
      detector, hasFinder, lastJob, costMs: Math.round(costMs * 10) / 10, detMs: lastDetMs, scanMs: lastScanMs, cardLen,
      tracks: [...tracks.values()].map((t) => ({ id: t.id, phase: t.phase, via: t.via, scans: t.scans, x: t.x, y: t.y, score: t.score, lostMs: t.lostMs, pose: t.pose })),
    };
  }

  // Cards the server just recognised on my camera (click point and outline, 0-1 over the picture):
  // a sticker placed from one of those starts following that outline without searching again.
  const identified = [];
  function noteIdentified(x, y, quad) {
    identified.unshift({ x, y, quad, at: performance.now() });
    identified.length = Math.min(identified.length, 10);
  }
  function fromIdentify([px, py]) {
    if (!work) return null;
    const now = performance.now();
    for (const r of identified) {
      if (now - r.at > 60000) break;
      if (Math.hypot(r.x * work.w - px, r.y * work.h - py) > work.w * 0.03) continue;
      const quad = r.quad.map(([qx, qy]) => [qx * work.w, qy * work.h]);
      if (!insideQuad([px, py], quad)) continue;
      const pose = { ...poseFromQuad(quad), quad, score: 1 };
      if (pose.shape < 0.6 || (cardLen && (pose.b < cardLen * 0.6 || pose.b > cardLen * 1.6))) continue;
      lastJob = { at: [Math.round(px), Math.round(py)], identified: true };
      return pose;
    }
    return null;
  }

  // For testing from the console: what the model finds around a point (working pixels).
  // Debugging: how alike the cards in view look to colourLike(), two frames apart (the diagonal is
  // each card against itself a moment later).
  async function colours() {
    const video = localVideo();
    const k = work.vw / work.w;
    const poses = (await scanCards(video)).filter((c) => c.score >= FIND_SURE).map((c) => poseFromQuad(c.quad.map(([qx, qy]) => [qx / k, qy / k])));
    const first = poses.map((p) => colourSig(p));
    await new Promise((r) => setTimeout(r, 400));
    return poses.map((p, i) => poses.map((q, j) => Math.max(colourLike(first[i], colourSig(q)), colourLike(first[i], colourSig({ ...q, th: q.th + Math.PI }))).toFixed(2)).join(' ') + `  @${Math.round(p.cx)},${Math.round(p.cy)}`);
  }

  // ---------- card debug overlay ----------
  // Eye menu -> "Card debug": draws on my own camera every card the finder outlines (green = taken
  // as a card, yellow = too unsure; the dot is the card's own top-left corner), what each sticker
  // is following (cyan, red while lost), and the timings of each step.
  let debugOn = false;
  try { debugOn = localStorage.getItem('cardDebug') === '1'; } catch { /* ignore */ }
  let debugTimer = null;
  let debugBusy = false;
  let thumbCanvas = null;
  function setDebug(on) {
    debugOn = !!on;
    try { localStorage.setItem('cardDebug', debugOn ? '1' : '0'); } catch { /* ignore */ }
    clearInterval(debugTimer);
    debugTimer = null;
    document.querySelector('.card-debug')?.remove();
    document.querySelector('.card-debug-text')?.remove();
    if (debugOn) debugTimer = setInterval(drawDebug, 350);
  }
  async function drawDebug() {
    const video = localVideo();
    const layer = video?.closest('.tile')?.querySelector('.mark-layer');
    if (!layer || !video.videoWidth || debugBusy) return;
    debugBusy = true;
    try {
      if (detector === 'off') loadDetector();
      const cards = detector === 'ready' && hasFinder ? await scanCards(video) : [];
      let canvas = layer.querySelector('.card-debug');
      let text = layer.querySelector('.card-debug-text');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'card-debug';
        text = document.createElement('div');
        text.className = 'card-debug-text';
        layer.append(canvas, text);
      }
      const w = layer.clientWidth;
      const h = layer.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const s = w / video.videoWidth;
      g.lineWidth = 1.5;
      g.font = '11px ui-monospace, Consolas, monospace';
      for (const c of cards) {
        const p = poseFromQuad(c.quad);
        const ok = c.score >= FIND_SURE && p.shape > 0.6;
        g.strokeStyle = ok ? '#4f8' : '#fd4';
        g.fillStyle = g.strokeStyle;
        g.beginPath();
        c.quad.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
        g.closePath();
        g.stroke();
        g.beginPath();
        g.arc(c.quad[0][0] * s, c.quad[0][1] * s, 3, 0, 7);
        g.fill();
        g.fillText(`${c.score.toFixed(2)} sh${p.shape.toFixed(2)}`, p.cx * s - 24, Math.min(...c.quad.map((q) => q[1])) * s - 4);
      }
      // Known by sight (autoread.js): under each card on the table, the little picture its
      // fingerprint is made from and which known card that looks like (green: taken as that
      // card; grey: not sure). Down the right-hand side, every card learnt so far with its
      // fingerprints' pictures.
      const sight = window.AutoRead?.sight?.();
      if (sight) {
        const tile = (thumb, x, y, scale) => {
          if (!thumb) return;
          if (!thumbCanvas) { thumbCanvas = document.createElement('canvas'); thumbCanvas.width = 32; thumbCanvas.height = 45; }
          thumbCanvas.getContext('2d').putImageData(new ImageData(thumb, 32, 45), 0, 0);
          g.drawImage(thumbCanvas, x, y, 32 * scale, 45 * scale);
        };
        g.imageSmoothingEnabled = false;
        for (const c of sight.seen) {
          const x = c.cx * w;
          const y = (c.cy + c.b * 0.5) * h + 14;
          tile(c.thumb, x - 34, y, 0.6);
          g.fillStyle = c.as?.sure ? '#4f8' : '#bbb';
          g.fillText(c.as ? `${c.as.name.slice(0, 18)} ${c.as.score.toFixed(2)} +${c.as.lead.toFixed(2)}` : 'no cards learnt yet', x - 12, y + 12);
        }
        let gy = 30;
        g.fillStyle = '#cfe';
        g.fillText(`learnt by sight: ${sight.known.length}`, w - 190, gy - 6);
        for (const card of sight.known) {
          if (gy > h - 60) break;
          card.thumbs.forEach((thumb, i) => tile(thumb, w - 190 + i * 22, gy, 0.6));
          g.fillStyle = '#cfe';
          g.fillText(card.name.slice(0, 16), w - 190 + Math.max(1, card.thumbs.length) * 22 + 4, gy + 16);
          gy += 31;
        }
      }
      const k = work ? (work.vw / work.w) * s : 0;
      const lines = [`finder ${hasFinder ? `${lastScanMs} ms, ${cards.length} outlines` : detector === 'ready' ? 'not on this server' : detector}  corner model ${lastDetMs || '-'} ms`];
      for (const t of tracks.values()) {
        if (t.phase !== 'track' || !k) continue;
        const { cx, cy, th } = t.pose;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        const corner = (u, v) => [(cx + u * c - v * sn) * k, (cy + u * sn + v * c) * k];
        g.strokeStyle = t.lostMs > 0 ? '#f55' : '#5df';
        g.setLineDash(t.lostMs > 0 ? [4, 3] : []);
        g.beginPath();
        [[-t.a / 2, -t.b / 2], [t.a / 2, -t.b / 2], [t.a / 2, t.b / 2], [-t.a / 2, t.b / 2]].forEach(([u, v], i) => {
          const [x, y] = corner(u, v);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        });
        g.closePath();
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = g.strokeStyle;
        g.fillText(`${t.id.slice(0, 3)} ${(t.score ?? 0).toFixed(2)}${t.lostMs > 0 ? ` lost ${(t.lostMs / 1000).toFixed(1)}s${t.covered >= COVERED ? ' COVERED' : t.lifted ? ' PICKED UP' : ''} ring ${(t.covered || 0).toFixed(2)}` : ''}`, ...corner(-t.a / 2, t.b / 2 + 11 / k));
      }
      const all = [...tracks.values()];
      lines.push(`stickers ${all.filter((t) => t.phase === 'track').length} following, ${all.filter((t) => t.lostMs > 0).length} lost, ${all.filter((t) => t.phase !== 'track').length} no card  tick ${costMs.toFixed(1)} ms`);
      if (lastJob) lines.push(`last search at ${lastJob.at} -> ${lastJob.found?.join(' | ') || (lastJob.identified ? 'from Identify' : 'nothing')}`);
      const a = window.AutoRead?.debug?.();
      if (a) {
        lines.push(`held-card reader: ${a.enabled ? a.phase : 'off'}${a.card ? ` (${a.card})` : ''}  misses ${a.failedChecks}${a.timing ? `  last read: find ${a.timing.find} ms + lookup ${a.timing.read ?? '?'} ms` : ''}`);
        if (a.lastLand?.finder) lines.push(`last put-down: ${a.lastLand.ms} ms after the read`);
        if (a.lastSight) lines.push(`known by sight: ${a.lastSight.known} cards learnt; this look ${a.lastSight.labelled} of ${a.lastSight.cards} recognised, ${a.lastSight.moved} tags moved, ${a.lastSight.bySight} tagged with no lookup${a.lastSight.loose ? `, ${a.lastSight.loose} tags looking for their card` : ''}\n  ${(a.lastSight.looks || []).join(' | ')}`);
        if (a.ignored) lines.push(`left alone (✕ on a suggestion): ${a.ignored} things`);
        lines.push(`table tagging: ${a.tagging ? 'on' : 'off'}, ${a.known} spots looked up${a.lastBoard ? `  last: ${a.lastBoard.top || 'no match'} (next ${a.lastBoard.next ?? '-'}) ${a.lastBoard.tagged || 'left alone'}` : ''}`);
      }
      const l = window.Identify?.lastLookup?.();
      const lm = window.LocalMatch?.status?.();
      if (lm && lm.state !== 'off') lines.push(`lookups run on ${lm.mode === 'local' ? 'this computer' : 'the server'}: here ${lm.localMs ?? '?'} ms, server ${lm.serverMs ?? '?'} ms${lm.refs ? `, ${lm.refs.references} references of ${lm.refs.cards} cards` : ''}${lm.state === 'ready' ? '' : ` (${lm.state})`}`);
      if (l) lines.push(`last lookup: ${l.ms} ms (${l.where || `server ${l.server ?? '?'} ms`}, ${l.looks ?? '?'} looks)  ${l.found ? `${l.top} vs ${l.next ?? '-'}${l.sure ? ' SURE' : ''}` : 'no card'}`);
      text.textContent = lines.join('\n');
    } finally {
      debugBusy = false;
    }
  }
  if (debugOn) setTimeout(() => setDebug(true), 1500);

  async function probe(x, y, opts = {}) {
    while (jobBusy) await new Promise((r) => setTimeout(r, 50));
    jobBusy = true;
    try {
      return (await locate(localVideo(), x, y, { faint: true, ...opts })).map((p) => ({ cx: Math.round(p.cx), cy: Math.round(p.cy), a: Math.round(p.a), b: Math.round(p.b), th: p.th.toFixed(2), shape: p.shape.toFixed(2), score: p.score.toFixed(2) }));
    } finally {
      jobBusy = false;
    }
  }

  return { init, setRoom, onData, sync, setEnabled, isEnabled: () => enabled, status, debug, probe, noteIdentified, findCards, stickerSpots, cardSize, hasFinder: () => hasFinder, load: () => loadDetector(), setDebug, isDebug: () => debugOn, colours, hasState: () => !!state, myTags, removesLost: () => removesLost, setRemovesLost, liftedNamed, wasHere, toVerify, verified, markVerify, stickerNamed, zones: () => state?.zones?.[me] || {}, piles: () => state?.piles?.[me] || {} };
})();
