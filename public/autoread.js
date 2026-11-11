/* Read cards held up to the camera: hold a card up close and still for a moment, it's recognised,
   and when it's put down on the table a card sticker is put on it (which then follows it).
   Runs in the camera owner's browser:
   - A tiny greyscale copy of the camera (96x54, 8 times a second) is compared with how the table
     looked when nothing was moving. A big, steady change is something held up.
   - The corner model (Tracker's worker) checks it's a card, and a big one (held near the camera).
   - The server reads it (Identify), once per card held up.
   - After it's put down and everything is still, the patch of table that changed is where it went:
     a sticker goes there, and Tracker finds and follows the card under it.
   Off switch per player: menu > "Read cards I hold up" (remembered on this device). */
window.AutoRead = (() => {
  const W = 96;
  const H = 54;
  const FPS = 8;
  const DIFF = 22; // brightness change (0-255) that counts as changed
  // Frame-to-frame change (mean, 0-255) below this means nothing is moving. Cameras differ in noise,
  // so it is set from the quietest recent frames: at least CALM_MIN.
  const CALM_MIN = 2.2;
  const STEADY = 5; // a card held in a hand wobbles: this much more than calm still counts as held still
  const HELD_MIN = 0.3; // a held card's long side is at least this share of the picture's height
  const READ_GAP_MS = 2500; // between reads of different cards
  const READS_PER_MIN = 15; // the server allows 20 a minute per player
  const readTimes = [];
  const readsLastMinute = () => {
    const now = performance.now();
    while (readTimes.length && now - readTimes[0] > 60000) readTimes.shift();
    return readTimes.length;
  };
  const READS_PER_HOLD = 2;
  const LAND_WAIT_MS = 25000; // how long to wait for the card to be put down

  let code = null;
  let me = null;
  let act = null;
  let enabled = true;
  try { enabled = localStorage.getItem('readHeld') !== '0'; } catch { /* ignore */ }
  let timer = null;
  let canvas = null;
  let ctx = null;
  let prev = null; // last frame
  let bg = null; // the table when nothing was moving
  let calmSince = 0;
  const recent = []; // recent frame-to-frame changes, for the camera's noise level
  let steadyFrames = 0;
  let nextCheck = 0;
  let failedChecks = 0;
  let lastRead = -Infinity;
  let busy = false;
  // idle -> (held card seen) reading -> held -> (card gone, table still) placed / gave up -> idle
  let phase = 'idle';
  let hold = null; // { before, box, card, reads, since, gone }

  // Cards really held up score 0.8-0.99 with the model; other things that change the picture
  // (a hand, a sleeve, the camera moving) at most about 0.55.
  const isHeld = (c) => c.score > 0.65 && c.shape > 0.7 && c.b > HELD_MIN;
  // A match good enough to tag without asking (real reads of held cards score 0.65-0.75).
  const SURE = 0.5;
  const localVideo = () => document.querySelector('.tile[data-local="1"] video');

  function init(opts) {
    ({ code, me, act } = opts);
    if (enabled) start();
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem('readHeld', enabled ? '1' : '0'); } catch { /* ignore */ }
    if (enabled) start();
    else stop();
  }

  function start() {
    if (!timer) timer = setInterval(tick, 1000 / FPS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    prev = null;
    bg = null;
    phase = 'idle';
    hold = null;
  }

  // ---------- the tiny picture ----------
  function grab(video) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    let sum = 0;
    for (let i = 0; i < g.length; i++) {
      g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      sum += g[i];
    }
    g.mean = sum / g.length;
    return g;
  }

  // Changed areas between two pictures (ignoring an overall brightness change: webcams re-expose
  // when something big comes close). Returns the connected patches, biggest first:
  // [{ n (pixels), x0, y0, x1, y1, cx, cy }] in tiny-picture pixels.
  function patches(a, b) {
    const gain = b.mean > 1 ? a.mean / b.mean : 1;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.abs(a[i] - b[i] * gain) > DIFF ? 1 : 0;
    // Close single-pixel gaps so a card with a dark middle stays one patch.
    const out = [];
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue;
      const p = { n: 0, x0: W, y0: H, x1: 0, y1: 0, sx: 0, sy: 0, pix: [] };
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        const x = j % W;
        const y = (j / W) | 0;
        p.n++;
        p.pix.push(j);
        p.sx += x;
        p.sy += y;
        if (x < p.x0) p.x0 = x;
        if (x > p.x1) p.x1 = x;
        if (y < p.y0) p.y0 = y;
        if (y > p.y1) p.y1 = y;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = ny * W + nx;
            if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
          }
        }
      }
      p.cx = p.sx / p.n;
      p.cy = p.sy / p.n;
      out.push(p);
    }
    return out.sort((p, q) => q.n - p.n);
  }

  function motion(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i += 3) s += Math.abs(a[i] - b[i]);
    return s / (a.length / 3);
  }

  // ---------- main loop ----------
  function tick() {
    const video = localVideo();
    if (!enabled || !video || video.readyState < 2 || !video.videoWidth || busy) return;
    if (!window.Tracker?.findCards || !window.Identify?.read) return;
    const now = performance.now();
    const g = grab(video);
    const m = prev ? motion(g, prev) : 99;
    prev = g;
    if (m < 90) {
      recent.push(m);
      if (recent.length > 60) recent.shift();
    }
    const quiet = recent.length >= 10 ? [...recent].sort((a, b) => a - b)[Math.floor(recent.length * 0.1)] : CALM_MIN;
    const calm = Math.max(CALM_MIN, quiet * 1.4 + 0.6);
    if (m < calm) { if (!calmSince) calmSince = now; } else calmSince = 0;
    const calmFor = calmSince ? now - calmSince : 0;

    if (phase === 'idle') {
      if (!bg) { if (calmFor > 1000) bg = g; return; }
      const big = patches(g, bg)[0];
      const isBig = big && big.n > W * H * 0.05;
      // Learn the table while nothing moves (a card held still isn't the table: give it longer).
      if (calmFor > (isBig ? 4000 : 1000)) { bg = g; steadyFrames = 0; return; }
      // Something big and close in front of the table, held still for a moment.
      const tall = big && (big.y1 - big.y0 + 1) / H;
      last = { m: +m.toFixed(1), calm: +calm.toFixed(1), n: big ? +(big.n / (W * H)).toFixed(3) : 0, tall: +(tall || 0).toFixed(2), steadyFrames };
      if (isBig && tall > HELD_MIN * 0.9 && m < calm + STEADY) steadyFrames++;
      else steadyFrames = 0;
      // Whatever was in front of the camera has gone: the next thing held up is looked at straight away.
      if (!big || big.n < W * H * 0.02) { failedChecks = 0; nextCheck = 0; }
      if (steadyFrames >= 3 && now >= nextCheck && now - lastRead >= READ_GAP_MS && readsLastMinute() < READS_PER_MIN - 1) check(video, big, now);
      return;
    }
    if (phase === 'held') {
      if (now - hold.since > LAND_WAIT_MS) return giveUp();
      const vsBefore = patches(g, hold.before);
      // Put down: nothing held up any more (a hand resting elsewhere is fine), and the table has
      // been still for a second.
      // Still held: something as tall as the held card where it was held (a hand resting elsewhere,
      // say on the mouse, doesn't count).
      const hx = hold.held.cx * W;
      const hy = hold.held.cy * H;
      const tall = Math.max(HELD_MIN, hold.held.b);
      if (vsBefore.some((p) => (p.y1 - p.y0 + 1) / H > tall && hx >= p.x0 - 1 && hx <= p.x1 + 1 && hy >= p.y0 - 1 && hy <= p.y1 + 1)) return;
      if (calmFor < 700 || hold.unsure) return;
      busy = true;
      land(video, vsBefore).catch((err) => console.warn('Placing held card:', err)).finally(() => { busy = false; });
    }
  }

  // Find a card held up in the changed patch. The model is only sure of a card near the middle of
  // what it's shown, and the patch is card + hand + arm (often down to the edge of the picture), so:
  // guess where the card is from the top of the patch (cards are held from below), then look again
  // centred on the likeliest candidates. Resolves with the card, false, or null without a model.
  async function findHeld(video, p) {
    const pick = (cards) => cards.filter(isHeld).sort((a, b) => b.score * b.shape - a.score * a.shape)[0];
    // Its top edge is the top of the patch; guess a few card sizes, centred on the patch's top part.
    const seeds = [0.42, 0.32, 0.55].map((len) => {
      const rows = p.y0 + len * H;
      let sx = 0;
      let n = 0;
      for (const j of p.pix) if (j / W < rows) { sx += j % W; n++; }
      return [(n ? sx / n + 0.5 : (p.x0 + p.x1 + 1) / 2) / W, p.y0 / H + len / 2, Math.min(1, len * 2)];
    });
    const rough = [];
    for (const [x, y, side] of seeds) {
      const cards = await window.Tracker.findCards(video, x, y, side);
      if (!cards) return null;
      const hit = pick(cards);
      if (hit) return hit;
      rough.push(...cards.filter((c) => c.score > 0.2 && c.b > HELD_MIN * 0.6));
    }
    rough.sort((a, b) => b.score - a.score);
    const tried = [];
    for (const c of rough) {
      if (tried.length >= 2) break;
      if (tried.some((t) => Math.hypot(t.cx - c.cx, t.cy - c.cy) < 0.05)) continue;
      tried.push(c);
      const cards = await window.Tracker.findCards(video, c.cx, c.cy, Math.min(1, Math.max(0.5, c.b * 2)));
      const hit = cards && pick(cards);
      if (hit) return hit;
    }
    return false;
  }

  // Look again where a held card was found: is it still there, held still? (A card on its way down
  // to the table would be read cut off.) Resolves with where it is now, or null.
  async function relocate(video, held) {
    const cards = await window.Tracker.findCards(video, held.cx, held.cy, Math.min(1, held.b * 2));
    return (cards || []).filter((c) => isHeld(c) && Math.hypot(c.cx - held.cx, (c.cy - held.cy) / 1.78) < 0.03 && Math.abs(c.b / held.b - 1) < 0.15)
      .sort((a, b) => b.score * b.shape - a.score * a.shape)[0] || null;
  }

  // Ask the model whether the big steady patch is a card held up to the camera, then read it.
  async function check(video, p, now) {
    busy = true;
    try {
      const held = await findHeld(video, p);
      if (held === null) { nextCheck = now + 10000; return; } // no model on this computer
      if (!held) {
        // Probably a hand or an arm: look less often while it stays.
        failedChecks++;
        nextCheck = performance.now() + Math.min(3000, 500 * failedChecks);
        return;
      }
      failedChecks = 0;
      // Still moving (on its way up or down)? Look again next time.
      const still = await relocate(video, held);
      if (!still) {
        toast('Card seen: hold it still a moment to read it.', [], 2000);
        nextCheck = performance.now() + 300;
        return;
      }
      // The model sometimes outlines only the top of a card held very close. The patch's top edge
      // is the card's top, and its width there is the card's width: make sure the read covers that.
      const aspect = video.videoWidth / video.videoHeight;
      let x0 = W;
      let x1 = -1;
      for (const j of p.pix) {
        const y = Math.floor(j / W);
        if (y >= p.y0 + 1 && y <= p.y0 + 3) { x0 = Math.min(x0, j % W); x1 = Math.max(x1, j % W); }
      }
      const fromTop = x1 > x0 ? (((x1 - x0 + 1) / W) * aspect) / 0.716 : 0; // card length, share of height
      const crop = { cx: still.cx, cy: still.cy, b: still.b };
      if (fromTop > still.b * 1.15 && fromTop < 1.2) {
        crop.b = fromTop;
        crop.cy = Math.max(still.cy, p.y0 / H + fromTop / 2);
      }
      hold = { before: bg, card: null, reads: 0, since: performance.now(), held: still };
      phase = 'reading';
      await read(video, still, crop);
    } catch (err) {
      console.warn('Reading held card:', err);
      phase = 'idle';
      hold = null;
      nextCheck = performance.now() + 5000;
    } finally {
      busy = false;
    }
  }

  // held: where the model sees the card; crop: what to send (may be bigger, see check()).
  async function read(video, held, crop) {
    const aspect = video.videoWidth / video.videoHeight;
    const shortIsHeight = aspect >= 1;
    let result = null;
    while (hold && hold.reads < READS_PER_HOLD && (hold.reads === 0 || readsLastMinute() < READS_PER_MIN)) {
      if (hold.reads) {
        // Second try: only if it's still held up, centred on where it is now.
        const again = await relocate(video, held);
        if (!again || !hold) break;
        crop = { cx: again.cx, cy: again.cy + (crop.cy - held.cy), b: again.b * (crop.b / held.b) };
        held = again;
        hold.held = again;
      }
      // A square around the card with room around it (the server finds the card's corners itself,
      // and needs to see them), as a share of the picture's short side.
      const frac = Math.min(1, Math.max(0.5, crop.b * 1.8 * (shortIsHeight ? 1 : aspect)));
      hold.reads++;
      lastRead = performance.now();
      readTimes.push(lastRead);
      result = await window.Identify.read(video, crop.cx, crop.cy, frac);
      if (result?.found && result.confident && result.matches?.[0]?.score >= SURE) break;
      if (hold.reads < READS_PER_HOLD) await new Promise((r) => setTimeout(r, 300));
    }
    if (!hold) return;
    const best = result?.matches?.[0];
    if (!result?.found || !best) {
      toast(result?.reason === 'nodecks'
        ? 'Saw a card, but nobody has loaded a deck yet, so it can\'t be read.'
        : 'Saw a card held up but couldn\'t read it. Hold it closer and still.', []);
      hold = null;
      phase = 'idle';
      nextCheck = performance.now() + 4000;
      return;
    }
    hold.card = best.card;
    hold.since = performance.now();
    phase = 'held';
    if (result.confident && best.score >= SURE) {
      toast(`Read ${best.card.name}. Put it on the table and it gets a sticker.`, [
        ['Place it myself', () => { const c = hold?.card; done(); if (c) window.Marks.showCard(c); }],
        ['✕', () => done()],
      ], LAND_WAIT_MS);
      return;
    }
    // Not sure: only tag it if the player says it's right.
    hold.unsure = true;
    toast(`Not sure: is it ${best.card.name}?`, [
      ['Yes', () => { if (hold) { hold.unsure = false; toast(`Put ${best.card.name} on the table and it gets a sticker.`, [['✕', () => done()]], LAND_WAIT_MS); } }],
      ['Pick it myself', () => { done(); window.Marks.showCard(best.card); }],
      ['✕', () => done()],
    ], LAND_WAIT_MS);
  }

  // The card was put down: find the one card-sized patch of table that changed.
  async function land(video, vsBefore) {
    const aspect = video.videoWidth / video.videoHeight;
    const size = window.Tracker.cardSize?.(); // long side, share of picture height
    const area = (p) => p.n / (W * H); // share of the picture
    let lo = 0.002;
    let hi = 0.06;
    if (size) {
      const cardArea = (size * size * 0.716) / aspect; // share of the picture
      lo = cardArea * 0.3;
      hi = cardArea * 2.5;
    }
    const spots = window.Tracker.stickerSpots?.() || [];
    const changed = vsBefore.filter((p) => {
      const w = (p.x1 - p.x0 + 1) / W;
      const h = (p.y1 - p.y0 + 1) / H;
      if (area(p) < lo || area(p) > hi || h > 0.5) return false;
      const x = (p.cx + 0.5) / W;
      const y = (p.cy + 0.5) / H;
      // Not a card that already has a sticker (it was nudged while putting this one down).
      return !spots.some((s) => Math.abs(s.x - x) < w / 2 && Math.abs(s.y - y) < h / 2);
    }).slice(0, 4);
    // A changed spot may also be where the card was picked up from, or a hand: keep the ones where
    // the model sees a card now.
    const fits = [];
    for (const p of changed) {
      const x = (p.cx + 0.5) / W;
      const y = (p.cy + 0.5) / H;
      const h = (p.y1 - p.y0 + 1) / H;
      // The model is fussy about the crop size: try a couple.
      for (const k of [2, 3.2]) {
        const cards = await window.Tracker.findCards(video, x, y, Math.min(1, Math.max(0.3, Math.max(size || 0, h) * k)));
        if (!hold) return; // dismissed meanwhile
        // Only "is there a card here" (an emptied spot or a hand shows none), so a loose outline will do.
        const c = (cards || []).filter((q) => q.score > 0.35 && q.b > 0.08 && q.b < HELD_MIN * 1.3
          && Math.abs(q.cx - x) < 0.08 && Math.abs(q.cy - y) < 0.12)
          .sort((a, b) => b.score - a.score)[0];
        if (c) { fits.push({ x: c.cx, y: c.cy }); break; }
      }
    }
    lastLand = { changed: changed.map((p) => [+((p.cx + 0.5) / W).toFixed(2), +((p.cy + 0.5) / H).toFixed(2), +area(p).toFixed(3)]), fits, spots, lo, hi };
    const card = hold.card;
    if (fits.length !== 1) {
      // Not sure where it went (or it went back in the hand): let the player place it.
      toast(`Read ${card.name}, but didn't see it put on the table.`, [
        ['Place it myself', () => { done(); window.Marks.showCard(card); }],
        ['✕', () => done()],
      ], 15000);
      phase = 'idle';
      hold = null;
      bg = prev;
      return;
    }
    const p = fits[0];
    const id = Math.random().toString(36).slice(2, 10);
    act({ type: 'stickerAdd', id, target: me, x: p.x, y: p.y, items: [{ ...card, type: 'card' }] });
    toast(`Put ${card.name} on the table.`, [['Undo', () => { act({ type: 'stickerRemove', id }); hideToast(); }]], 8000);
    phase = 'idle';
    hold = null;
    bg = prev;
  }

  function giveUp() {
    if (hold?.unsure) return done(); // never answered
    const card = hold?.card;
    phase = 'idle';
    hold = null;
    if (card) {
      toast(`Read ${card.name}. It wasn't put on the table.`, [
        ['Place it myself', () => { done(); window.Marks.showCard(card); }],
        ['✕', () => done()],
      ], 12000);
    }
  }

  function done() {
    hideToast();
    phase = 'idle';
    hold = null;
    nextCheck = performance.now() + 2000;
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(text, buttons, ms = 6000) {
    let el = document.getElementById('read-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'read-toast';
      el.className = 'track-toast read-toast';
      document.body.appendChild(el);
    }
    el.replaceChildren();
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = fn;
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    const el = document.getElementById('read-toast');
    if (el) el.hidden = true;
  }

  let last = null;
  let lastLand = null;
  const debug = () => ({ enabled, phase, card: hold?.card?.name, failedChecks, hasBg: !!bg, last, lastLand });

  return { init, setEnabled, isEnabled: () => enabled, debug };
})();
