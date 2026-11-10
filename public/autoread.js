/* Read cards held up to the camera: hold a card up close and still for a moment, it's recognised,
   and when it's put down on the table a card sticker is put on it (which then follows it).
   Runs in the camera owner's browser:
   - A tiny greyscale copy of the camera (96x54, 5 times a second) is compared with how the table
     looked when nothing was moving. A big, steady change is something held up.
   - The corner model (Tracker's worker) checks it's a card, and a big one (held near the camera).
   - The server reads it (Identify), once per card held up.
   - After it's put down and everything is still, the patch of table that changed is where it went:
     a sticker goes there, and Tracker finds and follows the card under it.
   Off switch per player: menu > "Read cards I hold up" (remembered on this device). */
window.AutoRead = (() => {
  const W = 96;
  const H = 54;
  const FPS = 5;
  const DIFF = 22; // brightness change (0-255) that counts as changed
  const CALM = 2.2; // mean frame-to-frame change below this: nothing moving
  const HELD_MIN = 0.3; // a held card's long side is at least this share of the picture's height
  const READ_GAP_MS = 6000; // at most one read every 6 s (the server allows 20 a minute)
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
  let steadyFrames = 0;
  let nextCheck = 0;
  let failedChecks = 0;
  let lastRead = -Infinity;
  let busy = false;
  // idle -> (held card seen) reading -> held -> (card gone, table still) placed / gave up -> idle
  let phase = 'idle';
  let hold = null; // { before, box, card, reads, since, gone }

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
      const p = { n: 0, x0: W, y0: H, x1: 0, y1: 0, sx: 0, sy: 0 };
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        const x = j % W;
        const y = (j / W) | 0;
        p.n++;
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
    if (m < CALM) { if (!calmSince) calmSince = now; } else calmSince = 0;
    const calmFor = calmSince ? now - calmSince : 0;

    if (phase === 'idle') {
      if (!bg) { if (calmFor > 1000) bg = g; return; }
      const big = patches(g, bg)[0];
      const isBig = big && big.n > W * H * 0.05;
      // Learn the table while nothing moves (a card held still isn't the table: give it longer).
      if (calmFor > (isBig ? 4000 : 1000)) { bg = g; steadyFrames = 0; return; }
      // Something big and close in front of the table, held still for a moment.
      const tall = big && (big.y1 - big.y0 + 1) / H;
      if (isBig && tall > HELD_MIN * 0.9 && m < CALM * 2.5) steadyFrames++;
      else steadyFrames = 0;
      if (steadyFrames >= 3 && now >= nextCheck && now - lastRead >= READ_GAP_MS) check(video, big, now);
      return;
    }
    if (phase === 'held') {
      if (now - hold.since > LAND_WAIT_MS) return giveUp();
      const vsBefore = patches(g, hold.before);
      // Gone: no big patch left where it was held, and the table has been still for a second.
      const big = vsBefore[0];
      if (big && big.n > W * H * 0.04) return;
      if (calmFor < 1000 || hold.unsure) return;
      land(vsBefore, video.videoWidth / video.videoHeight);
    }
  }

  // Ask the model whether the big steady patch is a card held up to the camera, then read it.
  async function check(video, p, now) {
    busy = true;
    try {
      const box = { x: (p.x0 + p.x1 + 1) / 2 / W, y: (p.y0 + p.y1 + 1) / 2 / H, w: (p.x1 - p.x0 + 1) / W, h: (p.y1 - p.y0 + 1) / H };
      const aspect = video.videoWidth / video.videoHeight;
      // The model outlines a card best when it fills about half the crop.
      const side = Math.min(1, Math.max(box.h, box.w * aspect) * 1.9);
      const cards = await window.Tracker.findCards(video, box.x, box.y, side);
      if (!cards) { nextCheck = now + 10000; return; } // no model on this computer
      const held = cards.filter((c) => c.score > 0.5 && c.shape > 0.7 && c.b > HELD_MIN)
        .sort((a, b) => b.b - a.b)[0];
      if (!held) {
        // Probably a hand or an arm: look less often while it stays.
        failedChecks++;
        nextCheck = performance.now() + Math.min(5000, 1200 * failedChecks);
        return;
      }
      failedChecks = 0;
      hold = { before: bg, card: null, reads: 0, since: performance.now(), held };
      phase = 'reading';
      await read(video, held);
    } catch (err) {
      console.warn('Reading held card:', err);
      phase = 'idle';
      hold = null;
      nextCheck = performance.now() + 5000;
    } finally {
      busy = false;
    }
  }

  async function read(video, held) {
    const aspect = video.videoWidth / video.videoHeight;
    const shortIsHeight = aspect >= 1;
    // A square around the card with room around it (the server finds the card's corners itself, and
    // needs to see them), as a share of the picture's short side.
    const frac = Math.min(1, Math.max(0.5, held.b * 1.8 * (shortIsHeight ? 1 : aspect)));
    let result = null;
    while (hold && hold.reads < READS_PER_HOLD) {
      hold.reads++;
      lastRead = performance.now();
      result = await window.Identify.read(video, held.cx, held.cy, frac);
      if (result?.found && result.matches?.length && result.confident) break;
      if (hold.reads < READS_PER_HOLD) await new Promise((r) => setTimeout(r, 1500));
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
    if (result.confident) {
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
  function land(vsBefore, aspect) {
    const size = window.Tracker.cardSize?.(); // long side, share of picture height
    const area = (p) => p.n / (W * H); // share of the picture
    let lo = 0.002;
    let hi = 0.05;
    if (size) {
      const cardArea = (size * size * 0.716) / aspect; // share of the picture
      lo = cardArea * 0.3;
      hi = cardArea * 2.5;
    }
    const spots = window.Tracker.stickerSpots?.() || [];
    const fits = vsBefore.filter((p) => {
      const w = (p.x1 - p.x0 + 1) / W;
      const h = (p.y1 - p.y0 + 1) / H;
      if (area(p) < lo || area(p) > hi || h > HELD_MIN) return false;
      const x = (p.cx + 0.5) / W;
      const y = (p.cy + 0.5) / H;
      // Not a card that already has a sticker (it was nudged while putting this one down).
      return !spots.some((s) => Math.abs(s.x - x) < w / 2 && Math.abs(s.y - y) < h / 2);
    });
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
    act({ type: 'stickerAdd', id, target: me, x: (p.cx + 0.5) / W, y: (p.cy + 0.5) / H, items: [{ ...card, type: 'card' }] });
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

  const debug = () => ({ enabled, phase, card: hold?.card?.name, failedChecks, hasBg: !!bg });

  return { init, setEnabled, isEnabled: () => enabled, debug };
})();
