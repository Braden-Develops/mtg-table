/* Finding a card's four corners with the corner model (DETRPose, dhvazquez/mtg_card_pose_estimation).
   Shared by the server (server/recognize.js imports this file) and the browser (tracker.js), so it
   has no imports and puts everything on globalThis.CardFind.

   The model was trained on tall phone photos (9:16) squashed to a square, each with one roughly
   upright card filling about half the picture's width. Shown anything else it still answers, but
   the corners are off by 10-30% of the card. Measured on pictures with known corners:
     card upright in a 9:16 frame, 30-70% of its width, within about 20 degrees: ~1 px, score ~1.0
     the same card in a square frame, or turned 45 degrees: 10-100 px, score anywhere
   So we never trust a look at an arbitrary crop. A "frame" is a rotated rectangle of the picture,
   { cx, cy, th, w, h }, th in radians (0 = upright), which the caller's `run(frame)` squashes to the
   model's square input. locate() tries frames until the model sees a card the way it was trained to:
   upright, the right size, centred, and with a high score. */
(() => {
  const ASPECT = 16 / 9; // frame height / width the model was trained on
  const FILL = 0.5; // card width as a share of the frame's width
  const ACCEPT = 0.8; // score of a card seen in the trained framing (real ones: 0.85-1.0; hands, keyboards: under 0.6)
  const FLOOR = 0.6; // below this, even the best outline found isn't a card

  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const centre = (q) => [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];

  // Order 4 points clockwise (on screen), starting nearest the top-left.
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

  // A card's pose from its corners: centre, short side a, long side b, th = how far the long side is
  // turned from vertical (radians, only meaningful modulo 180 degrees), and shape: 1 for a clean
  // 63x88 rectangle (sleeved cards are a little squarer), lower for lopsided outlines.
  function quadPose(quad) {
    const c = sortCorners(quad);
    const [cx, cy] = centre(c);
    const s = [len(c[0], c[1]), len(c[1], c[2]), len(c[2], c[3]), len(c[3], c[0])];
    const e0 = (s[0] + s[2]) / 2;
    const e1 = (s[1] + s[3]) / 2;
    const [dx, dy] = e0 >= e1
      ? [(c[1][0] - c[0][0] + c[2][0] - c[3][0]) / 2, (c[1][1] - c[0][1] + c[2][1] - c[3][1]) / 2]
      : [(c[2][0] - c[1][0] + c[3][0] - c[0][0]) / 2, (c[2][1] - c[1][1] + c[3][1] - c[0][1]) / 2];
    const a = Math.min(e0, e1);
    const b = Math.max(e0, e1);
    let shape = 0;
    if (a && b) {
      const parallel = (Math.min(s[0], s[2]) / Math.max(s[0], s[2])) * (Math.min(s[1], s[3]) / Math.max(s[1], s[3]));
      shape = parallel * Math.max(0, 1 - Math.max(0, Math.abs(a / b - 0.75) - 0.08) * 4);
    }
    return { cx, cy, th: Math.atan2(-dx, dy), a, b, shape, quad: c };
  }

  // The four corners with the card's long sides vertical: [TL, TR, BR, BL] of the card as it lies,
  // which may still be upside down.
  function uprightCorners(quad) {
    const c = sortCorners(quad);
    return len(c[0], c[1]) + len(c[2], c[3]) <= len(c[1], c[2]) + len(c[3], c[0]) ? c : [c[1], c[2], c[3], c[0]];
  }

  // The frame that shows a card of this pose the way the model was trained.
  const frameFor = (p, fill = FILL) => ({ cx: p.cx, cy: p.cy, th: p.th, w: p.a / fill, h: (p.a / fill) * ASPECT });

  // A point of the frame (u, v in 0-1 across and down it) in picture coordinates.
  function fromFrame(f, u, v) {
    const c = Math.cos(f.th);
    const s = Math.sin(f.th);
    const x = (u - 0.5) * f.w;
    const y = (v - 0.5) * f.h;
    return [f.cx + x * c - y * s, f.cy + x * s + y * c];
  }

  // Angle between two long-side directions, 0 to 90 degrees (a card upside down is the same outline).
  const turn = (a, b) => Math.abs(Math.asin(Math.sin(a - b)));

  // Was this card seen the way the model was trained: upright in the frame, a sensible size, near the middle?
  function trained(p, f) {
    const fill = p.a / f.w;
    return turn(p.th, f.th) < 0.3 && fill > 0.3 && fill < 0.68
      && Math.hypot(p.cx - f.cx, p.cy - f.cy) < f.w * 0.22;
  }

  /* Find the card at `at` ([x, y] in picture pixels).
     run(frame) -> Promise<[{ score, quad }]>: the model's cards in that frame, corners in picture pixels.
     opts.size: the card's likely short side in pixels, if known (other cards on this camera).
     opts.span: size of the area worth a first rough look (the crop around a click); 0 to skip it.
     opts.angle: how the card is likely turned (radians, as in a pose's th), if known.
     opts.only: look at that size and angle only (no other sizes, no diagonals): a quick check.
     opts.bounds: [width, height] of the picture; outlines sticking out of it are ignored.
     opts.near: also accept a card whose outline doesn't contain `at` but whose centre is this close.
     opts.maxRuns: model runs to spend.
     Resolves with { card, sure, runs, others }: card is the best outline (pose + score) or null;
     sure says the model saw it in the trained framing with a high score (twice, if not very high);
     others are different outlines at the point that also looked good, best first. */
  async function locate(run, at, opts = {}) {
    const { size = 0, span = 0, near = 0, bounds = null, angle = null, only = false, maxRuns = 10, accept = ACCEPT, floor = FLOOR } = opts;
    let runs = 0;
    const kept = []; // outlines seen in the trained framing: { ...pose, score, sure }
    const inPicture = (p) => !bounds || p.quad.every(([x, y]) => x > -p.a * 0.1 && y > -p.a * 0.1 && x < bounds[0] + p.a * 0.1 && y < bounds[1] + p.a * 0.1);
    const ours = (p) => inPicture(p) && (insideQuad(at, p.quad) || (near && Math.hypot(p.cx - at[0], p.cy - at[1]) < near));
    const same = (p, q) => Math.hypot(p.cx - q.cx, p.cy - q.cy) < q.a * 0.06 && Math.abs(p.a / q.a - 1) < 0.06 && Math.abs(p.b / q.b - 1) < 0.06 && turn(p.th, q.th) < 0.07;

    const look = async (frame) => {
      runs++;
      return (await run(frame)).map((d) => ({ ...quadPose(d.quad), score: d.score })).filter(ours)
        .sort((p, q) => q.score * q.shape - p.score * p.shape);
    };
    const keep = (p, sure) => {
      const i = kept.findIndex((q) => same(p, q));
      if (i < 0) kept.push({ ...p, sure });
      else if (p.score > kept[i].score || sure > kept[i].sure) kept[i] = { ...p, sure: sure || kept[i].sure };
    };

    // From a guess at the pose, re-frame on what the model finds until it sees a card as trained.
    // A very high score is believed at once; a fairly high one when a second look agrees.
    const settle = async (guess) => {
      let cur = guess;
      let last = null; // the previous look's card, if it was seen as trained
      for (let pass = 0; pass < 3 && runs < maxRuns; pass++) {
        const f = frameFor(cur);
        const p = (await look(f))[0];
        if (!p || p.score < 0.3) return null;
        // Loose outlines grow when re-framed (in the end the whole picture looks like one card).
        if (p.a > guess.a * 1.3) return null;
        if (trained(p, f) && p.shape > 0.6) {
          if (p.score >= 0.9 || (p.score >= accept && last && same(p, last))) { keep(p, true); return p; }
          if (p.score >= floor) keep(p, false);
          last = p.score >= accept ? p : null;
        } else last = null;
        if (same(p, cur) && !last) return null; // going nowhere
        cur = p;
      }
      return null;
    };
    const result = () => {
      kept.sort((p, q) => (q.sure - p.sure) || (q.score * q.shape - p.score * p.shape));
      const [card = null, ...others] = kept;
      return { card, sure: !!card?.sure, runs, others };
    };

    // 1. A rough look at the whole area. Its corners are loose (the outline usually encloses the
    //    card), but it gives the card's angle, and a size the card is no bigger than.
    let centreAt = at;
    let sizes = size ? (only ? [size] : [size, size * 1.5, size / 1.5]) : [];
    // Untapped and tapped; or as it was, and turned a quarter (tapped or untapped since).
    let first = angle === null ? [0, Math.PI / 2] : only ? [angle] : [angle, angle + Math.PI / 2];
    if (span) {
      const r = (await look({ cx: at[0], cy: at[1], th: 0, w: span, h: span }))[0];
      if (r && r.score >= 0.3) {
        if (insideQuad(at, r.quad)) centreAt = [r.cx, r.cy];
        if (angle === null) first = [r.th, r.th + Math.PI / 2];
        if (!size) sizes = [r.a / 1.35, r.a / 1.9, r.a];
      }
    }
    // 2. Frames at the point: every likely size at the likely angles, then the diagonals. Whatever
    //    card shows, however faintly, is followed up by re-framing on it.
    if (!sizes.length) sizes = [span * 0.27 || 150, span * 0.46 || 255, span * 0.16 || 90];
    const tries = [];
    for (const turns of only ? [first] : [first, [first[0] + Math.PI / 4, first[0] - Math.PI / 4]]) {
      for (const a of sizes) for (const th of turns) tries.push({ cx: centreAt[0], cy: centreAt[1], th, w: a / FILL, h: (a / FILL) * ASPECT });
    }
    for (const f of tries) {
      if (runs >= maxRuns) break;
      const p = (await look(f))[0];
      if (p && p.score >= 0.35 && await settle(p)) break;
    }
    return result();
  }

  globalThis.CardFind = { ASPECT, FILL, ACCEPT, sortCorners, insideQuad, quadPose, uprightCorners, frameFor, fromFrame, locate };
})();
