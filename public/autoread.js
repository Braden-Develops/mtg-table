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
  const READS_PER_MIN = 34; // the server allows 40 a minute per player
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
    loadIgnored();
    loadGallery();
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
      ['Another card…', () => {
        // The other cards it considered, to pick from (or search by name).
        window.Identify.feedback(lookup, null, 'reject');
        const at = hold?.held;
        done();
        window.Identify.choose(me, at?.cx ?? 0.5, at?.cy ?? 0.5, result);
      }],
      ['✕', () => done()],
    ], LAND_WAIT_MS, best.card);
  }

  // ---------- tagging cards on the table ----------
  // Finding the cards is cheap (one look in this browser); naming one is a lookup on the server.
  // So each card is looked up once: when it has lain in the same spot for two looks and has no
  // sticker. A match far ahead of every other card gets its tag; a likely one gets a tag marked as
  // a question ("Is it this?"); anything else is left alone. Either way the spot is remembered, so
  // the same card isn't asked about again (or re-tagged after its tag is removed) until it moves.
  const BOARD_PER_MIN = 24; // lookups a minute (the server allows 40), leaving room for held-up cards and Identify clicks
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
    boardCards = table;
    // Forget spots whose card has gone, so a card put there later is looked at.
    known = known.filter((k) => table.some((c) => far(k, c) < c.a * 0.3));
    // With a play area marked, only cards in it (or in the graveyard or exile) are looked at: not
    // the deck box, a pile of spare cards, or whatever the finder makes of the picture's edge.
    const inPlay = (c) => !zones.play || inZone(c, 'play') || inZone(c, 'graveyard') || inZone(c, 'exile');
    // Things the player said not to tag (✕ on a suggestion) are known by their colours, so they
    // stay left alone after being moved.
    const looks = ignored.length ? signatures(video, table) : null;
    const leftAlone = (c) => !!looks && ignored.some((sig) => alike(sig, looks.get(c)) >= SAME_LOOK);
    // What each card on the table looks like, and which known card (if any) that is. See "what
    // each card looks like here" below: this, not a lookup, decides everything once a card has
    // been named.
    const prints = fingerprints(video, table);
    const label = new Map(table.map((c) => [c, recall(prints.get(c))]));
    const tags = window.Tracker.myTags?.() || [];
    const reach = (t, c) => far({ cx: t.x, cy: t.y }, c);
    for (const t of tags) t.on = table.filter((c) => reach(t, c) < c.b * 0.6).sort((p, q) => reach(t, p) - reach(t, q))[0] || null;
    // One card, one card tag. Two on the same card means something went wrong: the one that
    // belongs stays (by sight if the card is known, else the one that was confirmed first), a
    // suggestion among the rest is dropped, and a confirmed tag is set loose to find its own card,
    // by sight below or by name when the untagged cards are looked up again.
    let conflicts = 0;
    for (const c of table) {
      const here = tags.filter((t) => t.on === c);
      if (here.length < 2) continue;
      conflicts++;
      const k = label.get(c);
      const keep = (k?.sure && here.find((t) => !t.unsure && t.name === k.name)) || here.find((t) => !t.unsure) || here[0];
      for (const t of here) {
        if (t === keep) continue;
        t.on = null;
        if (t.unsure || t.name === keep.name) { act({ type: 'stickerRemove', id: t.id }); t.gone = true; } else loose.add(t.id);
      }
    }
    for (const id of [...loose]) {
      const t = tags.find((o) => o.id === id);
      if (!t || t.gone) loose.delete(id); // removed since
      else if (t.on && !tags.some((o) => o !== t && !o.gone && o.on === t.on)) loose.delete(id); // alone on a card again
      else t.on = null;
    }
    // Something was wrong: cards looked at before may be the ones missing their tags.
    if (conflicts) known = known.filter((spot) => tags.some((t) => !t.gone && t.on && far(spot, t.on) < t.on.a * 0.3));
    let moved = 0;
    for (const t of tags) {
      if (t.unsure || t.gone) continue;
      const under = t.on && label.get(t.on);
      // On its own card: nothing to do but note how the card looks now (new spot, new light).
      if (under?.sure && under.name === t.name) { learn(t.card, prints.get(t.on)); continue; }
      // Its card by a nose: the tag is being followed on this card (t.seen) and nothing else it
      // knows looks more like it, but the fingerprint on file is a poor one (taken with a hand in
      // the way, say). A better one is taken now.
      if (under && under.name === t.name && t.seen && under.score >= 0.5) { learn(t.card, prints.get(t.on)); continue; }
      if (!gallery.has(t.name)) continue; // never learnt what this one looks like: can't say
      if (t.on && !under?.sure) continue; // can't tell what is under it: leave it be
      // A different card is under it, or none: its own card, if in view without its tag, gets it.
      const home = table.filter((c) => {
        const k = label.get(c);
        return k?.sure && k.name === t.name && !tags.some((o) => o !== t && !o.unsure && o.name === t.name && o.on === c);
      }).sort((p, q) => reach(t, p) - reach(t, q))[0];
      // Set loose from another card's tag, and every card that looks like its own already has its
      // tag: it is a leftover second tag for a card that has one. It goes.
      if (!home && loose.has(t.id) && table.some((c) => label.get(c)?.sure && label.get(c).name === t.name)) {
        act({ type: 'stickerRemove', id: t.id });
        loose.delete(t.id);
        t.gone = true;
        continue;
      }
      if (!home) continue;
      act({ type: 'stickerMove', id: t.id, x: home.cx, y: home.cy });
      t.on = home;
      t.x = home.cx;
      t.y = home.cy;
      moved++;
    }
    const untagged = table.filter((c) => inPlay(c) && !leftAlone(c) && !tags.some((t) => !t.gone && t.on === c)
      && !known.some((k) => far(k, c) < c.a * 0.3) && !inZone(c, 'library') && !inZone(c, 'command'));
    const settled = untagged.filter((c) => boardSeen.some((o) => far(o, c) < c.a * 0.08));
    boardSeen = untagged;
    // (Lookups done on this computer cost the server nothing: no limit per minute then.)
    const room = () => inFlight < MAX_FLIGHT && (window.LocalMatch?.ready() || readsLastMinute() < BOARD_PER_MIN);
    // Tags that were moved to another card after a swap or shuffle and whose card was never
    // learnt by sight: check each with a lookup.
    for (const v of window.Tracker.toVerify?.() || []) {
      if (gallery.has(v.name)) { window.Tracker.verified(v.id); continue; } // settled by sight above
      if (!room()) break;
      window.Tracker.verified(v.id);
      lookUp(video, { cx: v.x, cy: v.y, a: v.a }, (r) => checkTag(v, r));
    }
    // A tag that was already here (from before the page loaded, or put on by hand) whose card has
    // no fingerprint yet: one lookup of the card under it. If that agrees, the card is learnt.
    for (const t of tags) {
      if (t.unsure || !t.on || !t.seen || gallery.has(t.name) || vetted.has(t.id)) continue;
      if (!room()) break;
      vetted.add(t.id);
      const print = prints.get(t.on);
      lookUp(video, t.on, (r) => {
        const [top, next] = r?.matches || [];
        if (!r?.found || !top || !r.confident || top.score < AUTO_SCORE || top.score - (next?.score ?? 0) < AUTO_LEAD) return;
        if (top.card.name === t.name) learn(t.card, print);
        else { remember(t.id, r); act({ type: 'stickerDoubt', id: t.id }); } // a clearly different card is under it
      });
    }
    let bySight = 0;
    for (const c of settled) {
      const k = label.get(c);
      if (k?.sure) {
        // Seen and named before: it is that card. No lookup, no question.
        known.push({ cx: c.cx, cy: c.cy });
        if (tagging) {
          // A tag of this card that has no card in view under it comes here; else a new one.
          const idle = tags.find((t) => !t.gone && !t.unsure && t.name === k.name && !t.on && !t.claimed);
          if (idle) {
            idle.claimed = true;
            act({ type: 'stickerMove', id: idle.id, x: c.cx, y: c.cy });
            moved++;
          } else {
            act({ type: 'stickerAdd', id: Math.random().toString(36).slice(2, 10), target: me, x: c.cx, y: c.cy, items: [{ ...k.card, type: 'card' }] });
            bySight++;
          }
        }
        continue;
      }
      // Never seen before: every such card that is lying still is looked up now, side by side.
      if (!room()) break;
      known.push({ cx: c.cx, cy: c.cy });
      const print = prints.get(c);
      lookUp(video, c, (r) => tagFrom(c, r, inZone, print));
    }
    lastSight = {
      known: gallery.size, moved, bySight, conflicts, loose: loose.size, labelled: [...label.values()].filter((k) => k?.sure).length, cards: table.length,
      // (for the debug overlay: each card's little picture, what it looks most like, and by how much)
      seen: table.map((c) => ({ cx: c.cx, cy: c.cy, b: c.b, thumb: prints.get(c)?.[2] || null, as: label.get(c) })),
      looks: table.map((c) => { const k = label.get(c); return k ? `${k.name} ${k.score.toFixed(2)}+${k.lead.toFixed(2)}${k.sure ? '' : '?'}` : '-'; }),
    };
    nextBoard = now + (untagged.length > settled.length || inFlight || moved ? 250 : 700);
  }

  const MAX_FLIGHT = 6; // lookups under way at once
  let inFlight = 0;
  function lookUp(video, c, then) {
    inFlight++;
    readTimes.push(performance.now());
    const frac = 0.55;
    window.Identify.read(video, c.cx, c.cy, frac, c.a / frac).catch(() => null)
      .then(then).catch((err) => console.warn('Tagging table cards:', err)).finally(() => { inFlight--; });
  }

  // A lookup's answer for an untagged card at c.
  function tagFrom(c, r, inZone, print = null) {
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
    // Sure by score; or its tag was on this table a moment ago (knocked off while cards were
    // moved about), so there is nothing to ask.
    // Sure by score only. (A guess used to count as sure when a tag of that name had just left the
    // table, and a waiting tag of that name was moved onto any guess: between them they put a
    // confirmed Termagant Swarm tag on a card that was only a 5.7 guess. Cards that come back are
    // now known by sight; a guess stays a question.)
    const sure = r.confident && top.score >= AUTO_SCORE && lead >= AUTO_LEAD;
    // Named for sure: from now on this card is known by how it looks through this camera.
    if (sure) learn(top.card, print);
    // The card may have got a tag while this lookup was under way: one card, one card tag.
    const video = localVideo();
    const aspect = video?.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    const mine = window.Tracker.myTags?.() || [];
    if (mine.some((t) => !loose.has(t.id) && Math.hypot((t.x - c.cx) * aspect, t.y - c.cy) < c.b * 0.6)) { lastBoard.tagged = 'already has a tag'; return; }
    // A tag of this card is waiting for it (the card was picked up and has been put down here, or
    // its tag was found sharing another card): that tag, with whatever counters it carries, moves
    // to the card.
    // (Any confirmed tag of this name whose card isn't in view under it will do, even one that is
    // only covered by an arm: a second tag for the same card was the result of leaving those out.
    // With two copies of a card, the covered copy gets a tag again by sight once it shows.)
    const set = mine.find((t) => !t.unsure && t.name === top.card.name && (loose.has(t.id) || !t.seen));
    if (set) loose.delete(set.id);
    const waiting = sure ? set || window.Tracker.liftedNamed?.(top.card.name) : null;
    if (waiting) {
      act({ type: 'stickerMove', id: waiting.id, x: c.cx, y: c.cy });
      lastBoard.tagged = 'its waiting tag moved here';
      return;
    }
    const id = Math.random().toString(36).slice(2, 10);
    remember(id, r);
    act({ type: 'stickerAdd', id, target: me, x: c.cx, y: c.cy, items: [{ ...top.card, type: 'card' }], unsure: !sure });
    if (sure) window.Identify.feedback(r.id, top.card.name, 'auto');
    lastBoard.tagged = sure ? 'sure' : 'asked';
  }

  // A lookup's answer for a tag that was moved to another card (v: { id, name, x, y }). If the
  // card under it is clearly a different one that has a tag of its own elsewhere, the two tags
  // are on each other's cards: they change places.
  function checkTag(v, r) {
    const [top, next] = r?.matches || [];
    lastCheck = { tag: v.name, saw: top && `${top.card.name} ${top.score.toFixed(1)}`, next: next && +next.score.toFixed(1) };
    if (!r?.found || !top || !r.confident || top.score < AUTO_SCORE || top.score - (next?.score ?? 0) < AUTO_LEAD) return;
    if (top.card.name === v.name) { lastCheck.result = 'right card'; return; }
    // Clearly a different card. Two tags have only changed places if the other card's tag is in
    // turn sitting on this tag's card: look there before moving anything. (Swapping on the first
    // look alone sent tags chasing each other round a full table.)
    const other = window.Tracker.stickerNamed?.(top.card.name, v.id);
    const video = localVideo();
    const doubt = () => {
      // Not a simple swap: the tag becomes a question, with what was seen under it as the choices.
      remember(v.id, r);
      act({ type: 'stickerDoubt', id: v.id });
      lastCheck.result = 'wrong card: asking';
    };
    if (!other || !video) return doubt();
    lookUp(video, { cx: other.x, cy: other.y, a: v.a }, (r2) => {
      const [top2, next2] = r2?.matches || [];
      const sure2 = r2?.found && top2 && r2.confident && top2.score >= AUTO_SCORE && top2.score - (next2?.score ?? 0) >= AUTO_LEAD;
      if (!sure2 || top2.card.name !== v.name) return doubt();
      act({ type: 'stickerMove', id: v.id, x: other.x, y: other.y });
      act({ type: 'stickerMove', id: other.id, x: v.x, y: v.y });
      lastCheck.result = `swapped with ${top.card.name}`;
    });
  }
  let lastCheck = null;

  // ---------- what each card looks like here ----------
  // Naming a card from reference pictures is the hard, uncertain step: a webcam picture of a
  // sleeved card under a lamp against a clean scan. But once a card HAS been named, how it looks
  // through this camera, in this light, is known exactly, and telling it from the other cards on
  // the table by that is easy and repeatable. Measured on a table of nine cards: a card against
  // itself a moment later scores 0.91-1.00; against any different card 0.39-0.60 (two copies of
  // one basic land: 0.69).
  // So each named card gets fingerprints taken from the camera (the same low-resolution colour and
  // contrast feature the matcher uses, of the card straightened by the finder's outline), and from
  // then on the table look goes by those: a tag belongs on the card with its fingerprint, a
  // known card without a tag gets its tag back with no lookup and no question. Lookups are only
  // for cards never seen before. Kept for the browser session (two fingerprints a card, so a
  // reload doesn't forget the table).
  const FP_W = 96; // the straightened card the fingerprint is taken from
  const FP_H = 134;
  const KNOWN_AS = 0.78; // this alike to a known card's fingerprint...
  const KNOWN_LEAD = 0.12; // ...and this far ahead of every other card's: it is that card
  const SAMPLES = 5; // fingerprints kept per card (different spots and light)
  const gallery = new Map(); // card name -> { card, samples: [[upright, turned]] }
  let fpCanvas = null;
  let lastSight = null;
  const vetted = new Set(); // tags whose card has been looked up once to learn it
  const loose = new Set(); // confirmed tags found sharing a card with another: looking for their own

  // Fingerprints of cards the finder outlined: Map(card -> [feature, feature turned upside down]).
  function fingerprints(video, cards) {
    const CM = window.CardMatch;
    const out = new Map();
    if (!CM || !cards.length || !video.videoWidth) return out;
    const fw = Math.min(960, video.videoWidth);
    const fh = Math.round((fw * video.videoHeight) / video.videoWidth);
    if (!fpCanvas) fpCanvas = document.createElement('canvas');
    if (fpCanvas.width !== fw || fpCanvas.height !== fh) { fpCanvas.width = fw; fpCanvas.height = fh; }
    const ctx = fpCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, fw, fh);
    const rgba = ctx.getImageData(0, 0, fw, fh).data;
    const rgb = new Uint8Array(fw * fh * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    for (const c of cards) {
      const corners = window.CardFind.uprightCorners(c.quad.map(([x, y]) => [x * fw, y * fh]));
      const I = CM.integral(CM.warp(rgb, fw, fh, corners, FP_W, FP_H), FP_W, FP_H);
      const small = CM.shrink(I); // the 32x45 picture the fingerprint is made from
      // (third: that little picture, kept only to show in the card debug overlay)
      const thumb = new Uint8ClampedArray(CM.LW * CM.LH * 4);
      for (let i = 0; i < CM.LW * CM.LH; i++) {
        thumb[i * 4] = small[i * 3];
        thumb[i * 4 + 1] = small[i * 3 + 1];
        thumb[i * 4 + 2] = small[i * 3 + 2];
        thumb[i * 4 + 3] = 255;
      }
      out.set(c, [CM.lowFeature(small), CM.lowFeature(CM.shrink(I, 0, 0, 0, 0, true)), thumb]);
    }
    return out;
  }
  // How alike two fingerprints are (1 = the same card seen the same way), either way up.
  const likeness = (p, q) => Math.max(window.CardMatch.dot(p[0], q[0]), window.CardMatch.dot(p[0], q[1]));
  // Which known card a fingerprint is: { name, card, score, lead, sure }, or null if none are known.
  function recall(print) {
    if (!print || !gallery.size) return null;
    let best = null;
    let next = 0;
    for (const [name, g] of gallery) {
      let score = 0;
      for (const sample of g.samples) score = Math.max(score, likeness(print, sample));
      if (!best || score > best.score) {
        if (best) next = Math.max(next, best.score);
        best = { name, card: g.card, score };
      } else next = Math.max(next, score);
    }
    best.lead = best.score - next;
    best.sure = best.score >= KNOWN_AS && best.lead >= KNOWN_LEAD;
    return best;
  }
  // This fingerprint is that card (named for sure, or vouched for by the player).
  function learn(card, print) {
    if (!print || !card?.name) return;
    let g = gallery.get(card.name);
    if (!g) gallery.set(card.name, g = { card: { ...card, type: 'card' }, samples: [] });
    const twin = g.samples.find((sample) => likeness(print, sample) > 0.95);
    if (twin) {
      if (!twin[2]) twin[2] = print[2]; // (one kept over a reload has no picture to show: lend it this one)
      return; // nothing new in it
    }
    g.samples.push(print);
    if (g.samples.length > SAMPLES) g.samples.splice(1, 1); // the first stays; the oldest of the rest goes
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGallery, 1500);
  }
  // Keeping it over a reload: the upright feature of the first and the newest fingerprint of each
  // card, as bytes. (The upside-down feature is the same numbers in reverse order within each of
  // its four planes, so it isn't stored.)
  let saveTimer = null;
  const galleryKey = () => `sight:${code}`;
  function turned(f) {
    const n = f.length / 4;
    const out = new Float32Array(f.length);
    for (let p = 0; p < 4; p++) for (let i = 0; i < n; i++) out[p * n + i] = f[p * n + n - 1 - i];
    return out;
  }
  function saveGallery() {
    try {
      const packed = [...gallery].map(([name, g]) => {
        const keep = g.samples.length > 1 ? [g.samples[0], g.samples[g.samples.length - 1]] : g.samples;
        return [name, g.card, keep.map(([f]) => {
          let max = 1e-9;
          for (const v of f) max = Math.max(max, Math.abs(v));
          let bytes = '';
          for (const v of f) bytes += String.fromCharCode(Math.round((v / max) * 127) + 128);
          return [max, btoa(bytes)];
        })];
      });
      sessionStorage.setItem(galleryKey(), JSON.stringify(packed));
    } catch { /* storage full or unavailable: the gallery just isn't kept */ }
  }
  function loadGallery() {
    try {
      for (const [name, card, samples] of JSON.parse(sessionStorage.getItem(galleryKey())) || []) {
        gallery.set(name, {
          card,
          samples: samples.map(([max, text]) => {
            const bytes = atob(text);
            const f = new Float32Array(bytes.length);
            for (let i = 0; i < f.length; i++) f[i] = ((bytes.charCodeAt(i) - 128) / 127) * max;
            return [f, turned(f)];
          }),
        });
      }
    } catch { /* nothing kept */ }
  }
  // The player says the tag on the card at (x, y) is wrong: forget any fingerprint that says that
  // card is `name` (or, with no name, that it is anything).
  async function unlearnAt(x, y, name = null) {
    const video = localVideo();
    if (!video?.videoWidth || !gallery.size || !window.Tracker.hasFinder?.()) return;
    const cards = await window.Tracker.findCards(video, 0.5, 0.5, 1);
    const aspect = video.videoWidth / video.videoHeight;
    const at = (cards || []).filter((c) => c.sure && c.shape > 0.75)
      .map((c) => ({ c, d: Math.hypot((c.cx - x) * aspect, c.cy - y) })).filter((o) => o.d < o.c.b * 0.6).sort((p, q) => p.d - q.d)[0];
    if (!at) return;
    const print = fingerprints(video, [at.c]).get(at.c);
    let changed = false;
    for (const [known, g] of [...gallery]) {
      if (name && known !== name) continue;
      const keep = g.samples.filter((sample) => likeness(print, sample) < 0.85);
      if (keep.length === g.samples.length) continue;
      changed = true;
      if (keep.length) g.samples = keep;
      else gallery.delete(known);
    }
    if (changed) saveGallery();
  }
  // The player says the card at (x, y) of my camera is this one (✓ on a suggestion, or a pick).
  async function learnAt(x, y, card) {
    const video = localVideo();
    if (!video?.videoWidth || !window.Tracker.hasFinder?.()) return;
    for (let i = 0; i < 40 && !(calmSince && performance.now() - calmSince > 400); i++) await new Promise((r) => setTimeout(r, 100));
    const cards = await window.Tracker.findCards(video, 0.5, 0.5, 1);
    const aspect = video.videoWidth / video.videoHeight;
    const at = (cards || []).filter((c) => c.sure && c.shape > 0.75)
      .map((c) => ({ c, d: Math.hypot((c.cx - x) * aspect, c.cy - y) })).filter((o) => o.d < o.c.b * 0.6).sort((p, q) => p.d - q.d)[0];
    if (at) learn(card, fingerprints(video, [at.c]).get(at.c));
  }

  // ---------- what the reader remembers about its suggestions ----------
  // The answer behind each tag it made, so "Other…" on a suggestion can show the other cards it
  // considered: sticker id -> the lookup's result.
  const answers = new Map();
  function remember(id, result) {
    answers.set(id, result);
    if (answers.size > 60) answers.delete(answers.keys().next().value);
  }
  const alternatives = (id) => answers.get(id) || null;

  // "Don't suggest anything for this again" (✕ on a suggestion): the thing is remembered by its
  // colours, a small grid over its face, so it is still recognised after it has been moved. Kept
  // for this browser session (the colours depend on tonight's light and camera settings).
  const SAME_LOOK = 0.6; // how alike two colour grids must be to be the same thing
  const IGNORED_MAX = 40;
  let ignored = [];
  let boardCards = []; // the table cards the last look saw
  let sigCanvas = null;
  const ignoredKey = () => `noScan:${code}`;
  function loadIgnored() {
    try { ignored = (JSON.parse(sessionStorage.getItem(ignoredKey())) || []).map((a) => Float32Array.from(a)); } catch { ignored = []; }
  }
  function saveIgnored() {
    try { sessionStorage.setItem(ignoredKey(), JSON.stringify(ignored.map((sig) => Array.from(sig, (v) => Math.round(v * 1000) / 1000)))); } catch { /* ignore */ }
  }
  // Colour grids of cards the finder outlined: Map(card -> Float32Array). Each grid is 4x6 points
  // over the card's face in the card's own frame, as colour without brightness.
  function signatures(video, cards) {
    const SW = 640;
    const SH = Math.round((SW * video.videoHeight) / video.videoWidth);
    if (!sigCanvas) sigCanvas = document.createElement('canvas');
    if (sigCanvas.width !== SW || sigCanvas.height !== SH) { sigCanvas.width = SW; sigCanvas.height = SH; }
    const ctx = sigCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, SW, SH);
    const rgb = ctx.getImageData(0, 0, SW, SH).data;
    const out = new Map();
    for (const c of cards) {
      const sig = new Float32Array(4 * 6 * 3);
      const cos = Math.cos(c.th);
      const sin = Math.sin(c.th);
      const a = c.a * SH;
      const b = c.b * SH;
      let k = 0;
      for (let j = 0; j < 6; j++) {
        for (let i = 0; i < 4; i++) {
          const u = (-0.3 + 0.2 * i) * a;
          const v = (-0.35 + 0.14 * j) * b;
          const x = Math.min(SW - 2, Math.max(1, Math.round(c.cx * SW + u * cos - v * sin)));
          const y = Math.min(SH - 2, Math.max(1, Math.round(c.cy * SH + u * sin + v * cos)));
          let r = 0;
          let g = 0;
          let bl = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const q = ((y + dy) * SW + x + dx) * 4;
              r += rgb[q];
              g += rgb[q + 1];
              bl += rgb[q + 2];
            }
          }
          const sum = r + g + bl + 270; // (very dark patches have no reliable colour)
          sig[k++] = r / sum;
          sig[k++] = g / sum;
          sig[k++] = bl / sum;
        }
      }
      out.set(c, sig);
    }
    return out;
  }
  // 1 = the same colours, 0 = clearly different; either way up (an outline doesn't say which end is the top).
  function alike(A, B) {
    if (!A || !B) return 0;
    let straight = 0;
    let turned = 0;
    const n = A.length / 3;
    for (let p = 0; p < n; p++) {
      const q = n - 1 - p;
      for (let ch = 0; ch < 3; ch++) {
        straight += Math.abs(A[p * 3 + ch] - B[p * 3 + ch]);
        turned += Math.abs(A[p * 3 + ch] - B[q * 3 + ch]);
      }
    }
    return Math.max(0, 1 - Math.min(straight, turned) / A.length / 0.05);
  }
  // ✕ on a suggestion of mine at (x, y): never suggest anything for that thing again.
  function rejected(id, x, y) {
    answers.delete(id);
    known.push({ cx: x, cy: y });
    const video = localVideo();
    if (!video?.videoWidth) return;
    const aspect = video.videoWidth / video.videoHeight;
    const near = boardCards.map((c) => ({ c, d: Math.hypot((c.cx - x) * aspect, c.cy - y) }))
      .filter((o) => o.d < o.c.b * 0.6).sort((p, q) => p.d - q.d)[0];
    if (!near) return;
    const sig = signatures(video, [near.c]).get(near.c);
    ignored = ignored.filter((old) => alike(old, sig) < SAME_LOOK);
    ignored.push(sig);
    if (ignored.length > IGNORED_MAX) ignored.shift();
    saveIgnored();
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
    // A held card is put down in the play area or on a pile, if those are marked.
    const zones = window.Tracker.zones?.() || {};
    const within = (c, zone) => { const b = zones[zone]; return b && c.cx >= b[0] && c.cx <= b[2] && c.cy >= b[1] && c.cy <= b[3]; };
    const fresh = cards.filter((c) => onTable(c)
      && (!zones.play || ['play', 'graveyard', 'exile', 'command', 'library'].some((zone) => within(c, zone)))
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
    // Picked up from the table, shown to the camera and put down again: its own tag goes with it.
    const waiting = window.Tracker.liftedNamed?.(card.name);
    if (waiting) {
      act({ type: 'stickerMove', id: waiting.id, x: spot.cx, y: spot.cy });
      toast(`${card.name} is back on the table.`, [], 4000);
    } else {
      const id = Math.random().toString(36).slice(2, 10);
      act({ type: 'stickerAdd', id, target: me, x: spot.cx, y: spot.cy, items: [{ ...card, type: 'card' }] });
      toast(`Put ${card.name} on the table.`, [['Undo', () => { act({ type: 'stickerRemove', id }); hideToast(); }]], 8000);
    }
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
  const debug = () => ({ enabled, phase, card: hold?.card?.name, failedChecks, hasBg: !!bg, last, lastLand, lastSpots, timing, tagging, lastBoard, lastCheck, lastSight, inFlight, known: known.length, ignored: ignored.length });

  return { init, setEnabled, isEnabled: () => enabled, setTagging, isTagging: () => tagging, alternatives, rejected, learnAt, unlearnAt, debug,
    // A tag of mine at (x, y) was deleted by hand: don't put one straight back, and forget that the card there looks like `name`.
    removedAt: (x, y, name) => { known.push({ cx: x, cy: y }); return unlearnAt(x, y, name); },
    // For the card debug overlay: every known card's fingerprints as little pictures, and the last look's cards.
    sight: () => ({ known: [...gallery].map(([name, g]) => ({ name, thumbs: g.samples.map((sample) => sample[2] || null) })), seen: lastSight?.seen || [] }), patches, cardSpots };
})();
