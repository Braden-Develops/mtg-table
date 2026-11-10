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
        if (best.score < JUMP) {
          // Look wider still around where it was and where it was heading, and be stricter.
          const mid = { cx: (p.cx + lead.cx) / 2, cy: (p.cy + lead.cy) / 2 };
          const wide = search(t, mid.cx, mid.cy, p.th, Math.round(Math.min(L * 3, L * 1.1 + travel / 2)), 3);
          if (wide.score >= JUMP + 0.07 && wide.score > best.score) best = wide;
        }
      }
    }
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
    t.lostMs = 0;
    t.recoverTries = 0;
    t.scans = 0;
    placeFromPose(t);
  }

  // Last resort for a card that's been lost a moment (thrown across the mat faster than we could
  // follow): look for it over the whole picture. Costs a few tens of ms, so one track at a time,
  // and at most every SCAN_MS per track. Takes the best clear match, preferring the one nearest to
  // where it was heading if two are about as good (two copies of a basic land).
  function scanAll(t, now) {
    t.scanAt = now + SCAN_MS;
    const turns = [0, Math.PI / 2, -Math.PI / 2];
    const th = t.pose.th + turns[t.scans % 3];
    t.scans++;
    const { w, h } = work;
    const m = Math.ceil(t.a * 0.3);
    const peaks = []; // a few best spots, kept apart from each other
    for (let y = m; y < h - m; y += 3) {
      for (let x = m; x < w - m; x += 3) {
        const score = ncc(t, x, y, th, true);
        if (score < JUMP) continue;
        const near = peaks.findIndex((q) => Math.hypot(q.cx - x, q.cy - y) < t.a * 0.5);
        if (near >= 0) {
          if (score > peaks[near].score) peaks[near] = { score, cx: x, cy: y, th };
          continue;
        }
        peaks.push({ score, cx: x, cy: y, th });
        if (peaks.length > 6) peaks.sort((a, b) => b.score - a.score).pop();
      }
    }
    const guess = restingGuess(t);
    let best = null;
    for (const q of peaks) {
      const r = polish(t, search(t, q.cx, q.cy, th, 2, 1));
      if (r.score < JUMP + 0.07) continue;
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
        console.info(`Card tracking ready (model loaded in ${m.ms} ms)`);
      } else if (m.t === 'error') {
        detector = 'failed';
        console.warn('Card tracking unavailable:', m.message);
        worker.terminate();
      } else if (m.t === 'result') {
        if (m.message) console.warn('Card finder error:', m.message);
        const done = pending.get(m.id);
        pending.delete(m.id);
        lastDetMs = m.ms || lastDetMs;
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
  let lastJob = null;

  // Crop a square around (x, y) (working pixels) from the full-quality video and find the cards in it.
  // Resolves with poses in working pixels: all (anything card-ish) and poses (well-shaped ones).
  function detect(video, x, y, sideWork) {
    const k = work.vw / work.w;
    const short = Math.min(work.vw, work.vh);
    const side = Math.round(Math.min(short * 0.6, Math.max(short * 0.22, sideWork * k)));
    const left = Math.round(Math.max(0, Math.min(work.vw - side, x * k - side / 2)));
    const top = Math.round(Math.max(0, Math.min(work.vh - side, y * k - side / 2)));
    if (!detCanvas) {
      detCanvas = document.createElement('canvas');
      detCanvas.width = DET;
      detCanvas.height = DET;
      detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
    }
    detCtx.drawImage(video, left, top, side, side, 0, 0, DET, DET);
    const pixels = detCtx.getImageData(0, 0, DET, DET).data;
    const id = ++reqId;
    const region = { left: left / k, top: top / k, side: side / k };
    worker.postMessage({ t: 'detect', id, pixels }, [pixels.buffer]);
    return new Promise((resolve) => {
      pending.set(id, (cards) => {
        const all = cards.map((c) => {
          const quad = c.quad.map(([qx, qy]) => [region.left + qx * region.side, region.top + qy * region.side]);
          return { ...poseFromQuad(quad), quad, score: c.score };
        }).filter((p) => p.a > 6);
        resolve({ region, all, poses: all.filter((p) => p.shape > 0.5) });
      });
    });
  }

  // The model outlines a card well only near the middle of what it's shown. So: look around (x, y),
  // then look again centred on each of the nearest candidates. Returns well-outlined cards.
  async function locate(video, x, y, side, maxCards) {
    // First a wide look (cards come out smaller, which the model handles better off-centre), then a
    // close one if that found nothing near.
    let first = await detect(video, x, y, Math.max(side * 1.3, Math.min(work.w, work.h) * 0.6));
    if (!first.all.some((p) => Math.hypot(p.cx - x, p.cy - y) < p.b)) {
      const close = await detect(video, x, y, side);
      if (close.all.length) first = close;
    }
    const mid = [first.region.left + first.region.side / 2, first.region.top + first.region.side / 2];
    const near = first.all.sort((p, q) => Math.hypot(p.cx - x, p.cy - y) - Math.hypot(q.cx - x, q.cy - y)).slice(0, maxCards);
    const found = [];
    const good = (p) => p.shape > 0.75 && p.score > 0.65;
    for (const c of near) {
      let cur = c;
      let centred = Math.hypot(c.cx - mid[0], c.cy - mid[1]) < first.region.side * 0.1;
      // Re-centre on it (twice at most) until the outline is confident.
      for (let pass = 0; pass < 2 && !(centred && good(cur) && cur.score > 0.85); pass++) {
        const again = await detect(video, cur.cx, cur.cy, side);
        const best = again.poses
          .filter((p) => Math.hypot(p.cx - cur.cx, p.cy - cur.cy) < Math.max(cur.a, p.a) * 0.6)
          .sort((p, q) => q.score * q.shape - p.score * p.shape)[0];
        if (!best) break;
        centred = Math.hypot(best.cx - cur.cx, best.cy - cur.cy) < again.region.side * 0.1;
        if (best.score * best.shape >= cur.score * cur.shape || !good(cur)) cur = best;
      }
      if (good(cur)) found.push(cur);
    }
    lastJob = { at: [Math.round(x), Math.round(y)], rough: first.all.length, found: found.map((p) => `${Math.round(p.cx)},${Math.round(p.cy)} s${p.score.toFixed(2)} sh${p.shape.toFixed(2)}`) };
    return found;
  }

  const cropFor = (mult) => (cardLen ? cardLen * mult : Math.min(work.w, work.h) * 0.5);

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
    // The model can miss a card for a given framing: each retry frames it differently.
    const cards = await locate(video, pt[0], pt[1], cropFor([2.6, 2, 3.3][t.tries % 3]), 2);
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
    t.retryAt = now + 700;
    // Where it was last seen for sure (a doubtful track may have drifted onto something else).
    const at = doubt || t.weakMs > 0 ? { ...t.good } : restingGuess(t);
    const cards = await locate(video, at.cx, at.cy, cropFor(doubt ? 2.6 : 3), doubt ? 1 : 2);
    if (t.phase !== 'track' || !tracks.has(t.id) || (!doubt && t.lostMs === 0)) return; // found meanwhile
    let best = null;
    for (const p of cards) {
      // Only a card where ours was actually last seen gets the low bar (tapped in place); one near
      // where we guess it slid to may be a different card.
      const near = Math.hypot(p.cx - t.pose.cx, p.cy - t.pose.cy) < t.b * 0.75
        || (doubt && Math.hypot(p.cx - at.cx, p.cy - at.cy) < t.b * 0.75);
      if (doubt && !near) continue;
      for (const th of [p.th, p.th + Math.PI]) {
        // The template is from before: its size may differ a bit, so polish around the found pose.
        const r = polish(t, { cx: p.cx, cy: p.cy, th });
        const rank = r.score - (near ? 0 : 0.1);
        if (r.score >= (near ? RECOVER_NEAR : RECOVER_FAR) && (!best || rank > best.rank)) best = { pose: p, th, rank };
      }
    }
    const current = ncc(t, t.pose.cx, t.pose.cy, t.pose.th, false);
    // The model confirms a card about as good or better: take its outline and a fresh template.
    if (best && (!doubt || best.rank > current - 0.05)) reanchor(t, { ...best.pose, th: best.th });
    broadcastSoon();
  }

  async function straighten(video, t) {
    t.moved = false;
    const at = { ...t.pose };
    const cards = await locate(video, at.cx, at.cy, cropFor(2.6), 1);
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
      if (t.lostMs || t.weakMs || t.moved) lastActive = now;
    }
    if (tracks.size > following.length) lastActive = now; // still looking for cards
    // Everything lost at once means the camera moved or was covered, not that every card left.
    const lostCount = following.filter((t) => t.lostMs > 0).length;
    const disturbed = following.length >= 3 && lostCount / following.length >= 0.7;
    for (const t of following) {
      if (t.lostMs > REMOVE_AFTER && t.recoverTries >= 2 && t.scans >= 3 && !disturbed) removeLost(t);
    }
    // One whole-picture search per tick at most, for a card lost a little while.
    const scan = following.find((t) => t.lostMs > 250 && now >= (t.scanAt || 0));
    if (scan && !disturbed) scanAll(scan, now);
    nextDetection(video, now);
    persist(now);
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

  // ---------- removal ----------
  function removeLost(t) {
    const s = state?.stickers?.[t.id];
    tracks.delete(t.id);
    if (!s) return;
    act({ type: 'stickerRemove', id: t.id });
    showUndo(s);
  }

  let toastTimer = null;
  function showUndo(s) {
    let el = document.getElementById('track-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'track-toast';
      el.className = 'track-toast';
      document.body.appendChild(el);
    }
    const name = s.items.find((it) => it.type === 'card')?.name || 'a sticker';
    el.innerHTML = '<span></span><button type="button">Undo</button>';
    el.querySelector('span').textContent = `Card left the table: removed ${name}.`;
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
      detector, lastJob, costMs: Math.round(costMs * 10) / 10, detMs: lastDetMs, cardLen,
      tracks: [...tracks.values()].map((t) => ({ id: t.id, phase: t.phase, via: t.via, scans: t.scans, x: t.x, y: t.y, score: t.score, lostMs: t.lostMs, pose: t.pose })),
    };
  }

  // For testing from the console: what the model finds around a point (working pixels).
  async function probe(x, y, side, maxCards = 2) {
    while (jobBusy) await new Promise((r) => setTimeout(r, 50));
    jobBusy = true;
    try {
      return (await locate(localVideo(), x, y, side, maxCards)).map((p) => ({ cx: Math.round(p.cx), cy: Math.round(p.cy), a: Math.round(p.a), b: Math.round(p.b), th: p.th.toFixed(2), shape: p.shape.toFixed(2), score: p.score.toFixed(2) }));
    } finally {
      jobBusy = false;
    }
  }

  return { init, setRoom, onData, sync, setEnabled, isEnabled: () => enabled, status, debug, probe };
})();
