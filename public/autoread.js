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
  const STEADY = 8; // a card held in a hand wobbles: this much more than calm still counts as held still
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
  let lastCards = null; // every card the last whole-picture look found
  let seen = null; // { held, at }: the held card as the last look saw it (whole-picture finder)
  let timing = null; // the last read: ms spent finding the card and asking the server

  // Cards really held up score 0.8-0.99 with the model; other things that change the picture
  // (a hand, a sleeve, the camera moving) at most about 0.55.
  const isHeld = (c) => c.score > 0.65 && c.shape > 0.7 && c.b > HELD_MIN;
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
    // Have the card models ready: tagging table cards waits for the finder, and until now nothing
    // loaded it before the first sticker or held card.
    window.Tracker?.load?.();
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
      // Nothing moving: a good moment to look over the table for cards that have no tag yet.
      // (Not before the table's state has arrived: the zone boxes say which cards to skip.)
      if (tagging && calmFor > 500 && now >= nextBoard && window.Tracker.hasFinder?.() && window.Tracker.hasState?.()) {
        busy = true;
        boardLook(video).catch((err) => console.warn('Tagging table cards:', err)).finally(() => { busy = false; });
        return;
      }
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
      if (!big || big.n < W * H * 0.02) { failedChecks = 0; nextCheck = 0; seen = null; }
      // With the whole-picture card finder there's no waiting for the picture to settle: it looks
      // as soon as something big shows up, and reads once it has seen the card in the same place twice.
      const ready = window.Tracker.hasFinder?.() ? isBig && tall > HELD_MIN * 0.9 : steadyFrames >= 2;
      if (ready && now >= nextCheck && now - lastRead >= READ_GAP_MS && readsLastMinute() < READS_PER_MIN - 1) check(video, big, now);
      return;
    }
    if (phase === 'held' && window.Tracker.hasFinder?.()) {
      // With the whole-picture finder: keep looking for a card on the table that wasn't there.
      if (now - hold.since > LAND_WAIT_MS) return giveUp();
      if (hold.unsure || now < (hold.nextLook || 0)) return;
      busy = true;
      watchLanding(video).catch((err) => console.warn('Placing held card:', err)).finally(() => { busy = false; });
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

  // Where in the changed patch a card could be. The patch is card + hand + arm (and anything else
  // that changed and touches them), and which way the arm comes in depends on where the camera is.
  // What sets the card apart is that it is the widest solid part: an arm is half as wide. So: slide
  // card-shaped boxes of every likely size over the patch and keep, per size, the place where the
  // most of the box is filled. Resolves with [{ x, y, len, angle, cover }] (0-1 of the picture; len
  // of its height), the biggest well-filled boxes first.
  const LENS = [0.95, 0.8, 0.67, 0.56, 0.47, 0.39, 0.33, 0.28];
  function cardSpots(p) {
    const W1 = W + 1;
    const S = new Int32Array(W1 * (H + 1));
    const mask = new Uint8Array(W * H);
    for (const j of p.pix) mask[j] = 1;
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += mask[y * W + x];
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
      }
    }
    const out = [];
    for (const len of LENS) {
      for (const upright of [true, false]) {
        const h = Math.round((upright ? len : len * 0.716) * H);
        const w = Math.round((upright ? len * 0.716 : len) * H);
        if (w > W || h > H) continue;
        const filled = (x, y) => S[(y + h) * W1 + x + w] - S[y * W1 + x + w] - S[(y + h) * W1 + x] + S[y * W1 + x];
        let best = 0;
        for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) best = Math.max(best, filled(x, y));
        // Several places about as full (the box fits inside the card with room to spare): their middle.
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let y = 0; y + h <= H; y++) {
          for (let x = 0; x + w <= W; x++) if (filled(x, y) >= best * 0.97) { sx += x; sy += y; n++; }
        }
        out.push({ x: (sx / n + w / 2) / W, y: (sy / n + h / 2) / H, len, angle: upright ? 0 : Math.PI / 2, cover: best / (w * h) });
      }
    }
    // The biggest box that is mostly filled is the card (bigger ones take in table, smaller ones fit
    // anywhere on it); then the next sizes down, in case the hand filled part of that one.
    const good = out.filter((c) => c.cover >= 0.72).sort((c, d) => d.len - c.len || d.cover - c.cover);
    const spots = [];
    for (const c of good) if (!spots.some((d) => d.len === c.len)) spots.push(c);
    return spots.slice(0, 3);
  }

  // Find a card held up in the changed patch: the model only sees a card it is pointed at (within a
  // quarter of the card's width, at about the right size), so it is shown the likely spots in turn.
  // Resolves with the card, false, or null without a model.
  async function findHeld(video, p) {
    if (window.Tracker.hasFinder?.()) {
      // One look outlines every card in the picture: the held one is big, and in what changed.
      const cards = await window.Tracker.findCards(video, 0.5, 0.5, 1);
      if (!cards) return null;
      lastCards = cards;
      const inside = (c) => c.cx * W >= p.x0 - 1 && c.cx * W <= p.x1 + 2 && c.cy * H >= p.y0 - 1 && c.cy * H <= p.y1 + 2;
      return cards.filter((c) => c.sure && c.shape > 0.7 && c.b > HELD_MIN && inside(c)).sort((a, b) => b.b - a.b)[0] || false;
    }
    // On a printed playmat the model can imagine a card (scoring up to 0.85): only one it is sure
    // of counts, and only inside what changed.
    const inPatch = (c) => c.cx * W >= p.x0 - 1 && c.cx * W <= p.x1 + 2 && c.cy * H >= p.y0 - 1 && c.cy * H <= p.y1 + 2;
    const pick = (cards) => cards.filter((c) => c.sure && isHeld(c) && inPatch(c)).sort((a, b) => b.score * b.shape - a.score * a.shape)[0];
    const spots = cardSpots(p);
    if (!spots.length) return false; // nothing card-shaped in it (an arm, a hand): no need to ask the model
    lastSpots = spots.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)} len${c.len} ${c.angle ? 'side' : 'up'} cover${c.cover.toFixed(2)}`);
    for (const c of spots) {
      const cards = await window.Tracker.findCards(video, c.x, c.y, Math.min(1, c.len * 2), { angle: c.angle });
      if (!cards) return null;
      const hit = pick(cards);
      if (hit) return hit;
    }
    return false;
  }
  let lastSpots = null;

  // Look again where a held card was found: is it still there, held still? (A card on its way down
  // to the table would be read cut off.) Resolves with where it is now, or null.
  async function relocate(video, held) {
    const cards = await window.Tracker.findCards(video, held.cx, held.cy, Math.min(1, held.b * 2), { angle: held.th || 0 });
    return (cards || []).filter((c) => isHeld(c) && Math.hypot(c.cx - held.cx, (c.cy - held.cy) / 1.78) < 0.03 && Math.abs(c.b / held.b - 1) < 0.15)
      .sort((a, b) => b.score * b.shape - a.score * a.shape)[0] || null;
  }

  // Ask the model whether the big steady patch is a card held up to the camera, then read it.
  async function check(video, p, now) {
    busy = true;
    try {
      const t0 = performance.now();
      let held = await findHeld(video, p);
      if (held === null) { nextCheck = now + 10000; return; } // no model on this computer
      if (!held) {
        seen = null;
        // Probably a hand or an arm: look less often while it stays.
        // The first couple of looks are usually the hand still on its way up: look again at once.
        failedChecks++;
        nextCheck = performance.now() + (window.Tracker.hasFinder?.()
          ? (failedChecks <= 8 ? 0 : Math.min(600, 100 * (failedChecks - 8))) // a look is cheap: keep watching for a card
          : (failedChecks <= 2 ? 0 : Math.min(3000, 500 * (failedChecks - 2))));
        return;
      }
      failedChecks = 0;
      if (window.Tracker.hasFinder?.()) {
        // Held still? Seen in the same place and at the same size as a moment ago.
        const aspect = video.videoWidth / video.videoHeight;
        const still = () => {
          const before = seen;
          seen = { held, at: performance.now() };
          return before && seen.at - before.at < 900
            && Math.hypot((held.cx - before.held.cx) * aspect, held.cy - before.held.cy) <= held.b * 0.06
            && Math.abs(held.b / before.held.b - 1) <= 0.08;
        };
        // Not seen in this place before: look again straight away (twice at most, then next tick).
        for (let again = 0; !still(); again++) {
          if (again >= 2) { nextCheck = 0; return; }
          held = await findHeld(video, p);
          if (!held) { seen = null; nextCheck = 0; return; }
        }
      }
      // Otherwise: the picture was steady when we looked (see tick), and the model saw the card clearly.
      const still = held;
      timing = { find: Math.round(performance.now() - t0) };
      toast('Reading the card…', [], 4000);
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
      if (false && fromTop > still.b * 1.15 && fromTop < 1.2) {
        crop.b = fromTop;
        crop.cy = Math.max(still.cy, p.y0 / H + fromTop / 2);
      }
      // table: the cards lying on the table now, so the one put down next can be told from them.
      hold = { before: bg, card: null, reads: 0, since: performance.now(), held: still, table: (lastCards || []).filter((c) => c !== held && c.b < HELD_MIN * 0.9) };
      phase = 'reading';
      const t1 = performance.now();
      await read(video, still, crop);
      timing.read = Math.round(performance.now() - t1);
      timing.reads = hold?.reads;
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
      // The card's width as a share of the crop's, so the server knows what size to look for.
      const share = (held.a * video.videoHeight) / (frac * Math.min(video.videoWidth, video.videoHeight));
      result = await window.Identify.read(video, crop.cx, crop.cy, frac, share);
      // A second read helps when a card was found but the picture was poor. When nothing among the
      // decks stands out at all, the card most likely isn't in one: say so now, don't make them wait.
      if (result?.found && (result.confident || result.weak)) break;
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
    hold.lookup = result.id;
    hold.since = performance.now();
    phase = 'held';
    const lookup = result.id;
    if (result.confident) {
      toast(`Read ${best.card.name}. Put it on the table and it gets a sticker.`, [
        ['Place it myself', () => { const c = hold?.card; done(); if (c) window.Marks.showCard(c); }],
        ['✕', () => done()],
      ], LAND_WAIT_MS, best.card);
      return;
    }
    // Not sure: only tag it if the player says it's right.
    hold.unsure = true;
    toast(result.weak ? `Can't tell what this is. It may not be in a loaded deck. Is it ${best.card.name}?` : `Not sure: is it ${best.card.name}?`, [
      ['Yes', () => {
        window.Identify.feedback(lookup, best.card.name, 'confirm');
        if (hold) { hold.unsure = false; toast(`Put ${best.card.name} on the table and it gets a sticker.`, [['✕', () => done()]], LAND_WAIT_MS, best.card); }
      }],
      ['Pick it myself', () => { window.Identify.feedback(lookup, null, 'reject'); done(); window.Marks.showCard(best.card); }],
      ['✕', () => done()],
    ], LAND_WAIT_MS, best.card);
  }

  // ---------- tagging cards on the table ----------
  // Finding the cards is cheap (one look in this browser); naming one is a lookup on the server.
  // So each card is looked up once: when it has lain in the same spot for two looks and has no
  // sticker. A match far ahead of every other card gets its tag; a likely one gets a tag marked as
  // a question ("Is it this?"); anything else is left alone. Either way the spot is remembered, so
  // the same card isn't asked about again (or re-tagged after its tag is removed) until it moves.
  const BOARD_PER_MIN = 8; // lookups a minute, leaving room for held-up cards and Identify clicks
  const AUTO_SCORE = 7.5;
  const AUTO_LEAD = 2.5;
  const ASK_SCORE = 5; // a guess at least this strong and this far ahead is shown as a question
  const ASK_LEAD = 0.5;
  let tagging = true;
  try { tagging = localStorage.getItem('autoTag') !== '0'; } catch { /* ignore */ }
  let nextBoard = 0;
  let boardSeen = []; // untagged cards the last look saw
  let known = []; // spots already looked up: { cx, cy }
  let lastBoard = null;

  async function boardLook(video) {
    const cards = await window.Tracker.findCards(video, 0.5, 0.5, 1);
    const now = performance.now();
    if (!cards) { nextBoard = now + 10000; return; }
    const aspect = video.videoWidth / video.videoHeight;
    const far = (p, q) => Math.hypot((p.cx - q.cx) * aspect, p.cy - q.cy);
    const size = window.Tracker.cardSize?.();
    const onTable = (c) => c.sure && c.shape > 0.75 && (size ? c.b > size * 0.6 && c.b < size * 1.6 : c.b < HELD_MIN * 0.9);
    const spots = window.Tracker.stickerSpots?.() || [];
    // The library is face down and the command zone's card is known: not worth a lookup.
    const zones = window.Tracker.zones?.() || {};
    const inZone = (c, zone) => { const b = zones[zone]; return b && c.cx >= b[0] && c.cx <= b[2] && c.cy >= b[1] && c.cy <= b[3]; };
    const table = cards.filter(onTable);
    // Forget spots whose card has gone, so a card put there later is looked at.
    known = known.filter((k) => table.some((c) => far(k, c) < c.a * 0.3));
    const untagged = table.filter((c) => !spots.some((s) => far({ cx: s.x, cy: s.y }, c) < c.b * 0.6)
      && !known.some((k) => far(k, c) < c.a * 0.3) && !inZone(c, 'library') && !inZone(c, 'command'));
    const settled = untagged.filter((c) => boardSeen.some((o) => far(o, c) < c.a * 0.08));
    boardSeen = untagged;
    if (!settled.length) { nextBoard = now + (untagged.length ? 250 : 1500); return; }
    if (readsLastMinute() >= BOARD_PER_MIN) { nextBoard = now + 4000; return; }
    const c = settled[0];
    readTimes.push(now);
    const frac = 0.55;
    const r = await window.Identify.read(video, c.cx, c.cy, frac, c.a / frac).catch(() => null);
    known.push({ cx: c.cx, cy: c.cy });
    nextBoard = performance.now() + 300;
    const [top, next] = r?.matches || [];
    lastBoard = { at: [+c.cx.toFixed(2), +c.cy.toFixed(2)], top: top && `${top.card.name} ${top.score.toFixed(1)}`, next: next && +next.score.toFixed(1), found: !!r?.found, weak: !!r?.weak };
    // Nothing in the decks stands out: leave it. (On the server's first night every "best guess"
    // from 5.3 up was right, some only 0.9 ahead of the next card; a card that isn't in any deck
    // tops out around 4.5.)
    const lead = top ? top.score - (next?.score ?? 0) : 0;
    if (!tagging || !r?.found || !top || top.score < ASK_SCORE || lead < ASK_LEAD) return;
    // The card on top of the graveyard or exile pile is already on that pile's list (the page
    // forgets which spots it has looked at when it reloads): don't log it going there again.
    const pile = ['graveyard', 'exile'].find((zone) => inZone(c, zone));
    if (pile && (window.Tracker.piles?.()[pile] || []).at(-1)?.name === top.card.name) return;
    const sure = r.confident && top.score >= AUTO_SCORE && lead >= AUTO_LEAD;
    const id = Math.random().toString(36).slice(2, 10);
    act({ type: 'stickerAdd', id, target: me, x: c.cx, y: c.cy, items: [{ ...top.card, type: 'card' }], unsure: !sure });
    if (sure) window.Identify.feedback(r.id, top.card.name, 'auto');
    lastBoard.tagged = sure ? 'sure' : 'asked';
  }

  function setTagging(on) {
    tagging = !!on;
    try { localStorage.setItem('autoTag', tagging ? '1' : '0'); } catch { /* ignore */ }
    known = [];
  }

  // Put down yet? (Whole-picture finder.) One look lists every card; the one put down is a card of
  // table size that wasn't on the table when the held card was read and has no sticker. It is
  // placed as soon as two looks in a row see it in the same spot, hand still nearby or not.
  async function watchLanding(video, round = 0) {
    const cards = await window.Tracker.findCards(video, 0.5, 0.5, 1);
    if (!hold || phase !== 'held' || !cards) return;
    const now = performance.now();
    const aspect = video.videoWidth / video.videoHeight;
    const far = (p, q) => Math.hypot((p.cx - q.cx) * aspect, p.cy - q.cy);
    const size = window.Tracker.cardSize?.();
    const onTable = (c) => c.sure && c.shape > 0.7 && (size ? c.b > size * 0.6 && c.b < size * 1.6 : c.b < HELD_MIN * 0.9);
    const spots = window.Tracker.stickerSpots?.() || [];
    const fresh = cards.filter((c) => onTable(c)
      && !hold.table.some((o) => far(o, c) < c.a * 0.6)
      && !spots.some((s) => far({ cx: s.x, cy: s.y }, c) < c.b * 0.6));
    const before = hold.landing || [];
    hold.landing = fresh;
    const settled = fresh.filter((c) => before.some((o) => far(o, c) < c.a * 0.08));
    if (!settled.length) {
      // A new card, not yet seen twice in one spot: look again straight away. Nothing new: next tick.
      if (fresh.length && round < 3) return watchLanding(video, round + 1);
      hold.nextLook = now;
      return;
    }
    const card = hold.card;
    let spot = settled.length === 1 ? settled[0] : null;
    if (!spot) {
      // Several new cards (others were uncovered or moved meanwhile): the one that is the card read.
      const frac = 0.55;
      const same = [];
      for (const c of settled.slice(0, 3)) {
        const r = await window.Identify.read(video, c.cx, c.cy, frac, c.a / frac).catch(() => null);
        if (!hold) return;
        if (r?.found && r.matches?.[0]?.card.name === card.name) same.push(c);
      }
      if (same.length === 1) [spot] = same;
      else {
        // Can't tell them apart: they are part of the table now; keep waiting for the real one.
        hold.table.push(...settled);
        hold.nextLook = performance.now() + 300;
        return;
      }
    }
    window.Identify.feedback(hold.lookup, card.name, 'place');
    const id = Math.random().toString(36).slice(2, 10);
    act({ type: 'stickerAdd', id, target: me, x: spot.cx, y: spot.cy, items: [{ ...card, type: 'card' }] });
    toast(`Put ${card.name} on the table.`, [['Undo', () => { act({ type: 'stickerRemove', id }); hideToast(); }]], 8000);
    lastLand = { finder: true, ms: Math.round(performance.now() - hold.since), fresh: fresh.length, settled: settled.length };
    phase = 'idle';
    hold = null;
    seen = null;
    bg = prev;
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
      // A card lying on the table, upright or tapped, about the size of the others (or of the patch).
      const cards = await window.Tracker.findCards(video, x, y, Math.min(1, Math.max(0.16, (size || h) * 2)), { table: true });
      if (!hold) return; // dismissed meanwhile
      // Only "is there a card here" (an emptied spot or a hand shows none).
      const c = (cards || []).filter((q) => q.score > 0.6 && q.b > 0.08 && q.b < HELD_MIN * 1.3
        && Math.abs(q.cx - x) < 0.08 && Math.abs(q.cy - y) < 0.12)
        .sort((a, b) => b.score - a.score)[0];
      if (c) fits.push({ x: c.cx, y: c.cy });
    }
    lastLand = { changed: changed.map((p) => [+((p.cx + 0.5) / W).toFixed(2), +((p.cy + 0.5) / H).toFixed(2), +area(p).toFixed(3)]), fits, spots, lo, hi };
    const card = hold.card;
    // Several spots have a card that wasn't there before (others were moved while this one was held
    // up): look at each, and take the one that is the card that was read.
    if (fits.length > 1) {
      const frac = 0.55;
      const share = size ? (size * 0.716) / frac : 0;
      const same = [];
      for (const f of fits.slice(0, 3)) {
        const r = await window.Identify.read(video, f.x, f.y, frac, share).catch(() => null);
        if (!hold) return;
        if (r?.found && r.matches?.[0]?.card.name === card.name) same.push(f);
      }
      if (same.length === 1) fits.splice(0, fits.length, same[0]);
    }
    if (fits.length !== 1) {
      // Not sure where it went (or it went back in the hand): let the player place it.
      toast(`Read ${card.name}, but didn't see it put on the table.`, [
        ['Place it myself', () => { done(); window.Marks.showCard(card); }],
        ['✕', () => done()],
      ], 15000, card);
      phase = 'idle';
      hold = null;
      bg = prev;
      return;
    }
    const p = fits[0];
    // Put down and not undone: counts as the player agreeing with the read (for the capture log).
    window.Identify.feedback(hold.lookup, card.name, 'place');
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
  function toast(text, buttons, ms = 6000, card = null) {
    let el = document.getElementById('read-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'read-toast';
      el.className = 'track-toast read-toast';
      document.body.appendChild(el);
    }
    el.replaceChildren();
    const picture = card?.imageLarge || card?.image;
    el.classList.toggle('with-card', !!picture);
    let side = el;
    let row = el;
    if (picture) {
      // The card it thinks this is, shown beside the question.
      const img = document.createElement('img');
      img.src = picture;
      img.alt = card.name;
      img.referrerPolicy = 'no-referrer';
      el.appendChild(img);
      side = document.createElement('div');
      side.className = 'read-side';
      row = document.createElement('div');
      row.className = 'read-buttons';
      el.appendChild(side);
    }
    const span = document.createElement('span');
    span.textContent = text;
    side.appendChild(span);
    if (row !== el) side.appendChild(row);
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = fn;
      row.appendChild(b);
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
  const debug = () => ({ enabled, phase, card: hold?.card?.name, failedChecks, hasBg: !!bg, last, lastLand, lastSpots, timing, tagging, lastBoard, known: known.length });

  return { init, setEnabled, isEnabled: () => enabled, setTagging, isTagging: () => tagging, debug, patches, cardSpots };
})();
