/* Telling which card a picture shows: the comparison shared by the server (server/recognize.js
   imports this file) and the browser (public/match-worker.js). Like cardfind.js it has no imports
   and puts everything on globalThis.CardMatch. It needs cardfind.js loaded first.

   The card is straightened to ${W}x${H} and compared with reference pictures two ways: the
   embedding model's vector (given as a function, since the server and the browser run the model
   differently), and a plain low-resolution comparison of colour and local contrast that also
   tries the outline trimmed a little on each side. */
(() => {
  const W = 320; // the straightened card
  const H = 448;
  const DIM = 256; // the embedder's vector
  const LW = 32; // low-res comparison size
  const LH = 45;
  const LM = 3; // margin left out (card border, sleeve)
  const LN = (LW - 2 * LM) * (LH - 2 * LM);
  const LOW = LN * 4; // 3 colour planes + 1 local-contrast plane
  const TRIMS = [0, 0.08, 0.16]; // shares trimmed off a side, coarse pass
  const FINE = [-0.04, 0, 0.04]; // then around the best
  const LIKELY = 24; // reference pictures that get the trimming search

  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };
  
  // Solve the 3x3 homography that maps 4 src points onto 4 dst points.
  function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    // Gaussian elimination with partial pivoting.
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c || !A[c][c]) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [...h, 1];
  }
  
  // Brightness-weighted sample of an RGB picture at (sx, sy), added into acc. Outside: nearest edge pixel.
  function sampleInto(acc, rgb, sw, sh, sx, sy) {
    if (sx < 0) sx = 0; else if (sx > sw - 1.001) sx = sw - 1.001;
    if (sy < 0) sy = 0; else if (sy > sh - 1.001) sy = sh - 1.001;
    const x0 = sx | 0;
    const y0 = sy | 0;
    const fx = sx - x0;
    const fy = sy - y0;
    const i = (y0 * sw + x0) * 3;
    const j = i + sw * 3;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    acc[0] += rgb[i] * w00 + rgb[i + 3] * w10 + rgb[j] * w01 + rgb[j + 3] * w11;
    acc[1] += rgb[i + 1] * w00 + rgb[i + 4] * w10 + rgb[j + 1] * w01 + rgb[j + 4] * w11;
    acc[2] += rgb[i + 2] * w00 + rgb[i + 5] * w10 + rgb[j + 2] * w01 + rgb[j + 5] * w11;
  }
  
  // Warp the quad `corners` ([TL,TR,BR,BL] in source pixels) of an RGB image to W x H.
  function warp(rgb, sw, sh, corners, W = 320, H = 448) {
    const dst = [[0, 0], [W, 0], [W, H], [0, H]];
    const m = homography(dst, corners); // maps output pixel -> source pixel
    // A card bigger than the output (held up to the camera): average a few samples per pixel.
    const big = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / W;
    const taps = big > 2.5 ? 3 : big > 1.4 ? 2 : 1;
    const out = new Uint8Array(W * H * 3);
    const acc = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        acc[0] = 0; acc[1] = 0; acc[2] = 0;
        for (let ty = 0; ty < taps; ty++) {
          for (let tx = 0; tx < taps; tx++) {
            const px = x + (tx + 0.5) / taps;
            const py = y + (ty + 0.5) / taps;
            const d = m[6] * px + m[7] * py + m[8];
            sampleInto(acc, rgb, sw, sh, (m[0] * px + m[1] * py + m[2]) / d - 0.5, (m[3] * px + m[4] * py + m[5]) / d - 0.5);
          }
        }
        const o = (y * W + x) * 3;
        const n = taps * taps;
        out[o] = acc[0] / n;
        out[o + 1] = acc[1] / n;
        out[o + 2] = acc[2] / n;
      }
    }
    return out;
  }

  // ---------- low-resolution comparison ----------
  // Integral images of an RGB picture, for fast box averages.
  function integral(rgb, w, h) {
    const S = [0, 1, 2].map(() => new Float64Array((w + 1) * (h + 1)));
    const W1 = w + 1;
    for (let y = 0; y < h; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        r += rgb[i];
        g += rgb[i + 1];
        b += rgb[i + 2];
        const o = (y + 1) * W1 + x + 1;
        S[0][o] = S[0][o - W1] + r;
        S[1][o] = S[1][o - W1] + g;
        S[2][o] = S[2][o - W1] + b;
      }
    }
    return { S, w, h };
  }
  
  // The picture with a share trimmed off each side, shrunk to LW x LH; optionally turned upside down.
  function shrink(I, l = 0, t = 0, r = 0, b = 0, flip = false) {
    const out = new Float32Array(LW * LH * 3);
    const x0 = l * I.w;
    const y0 = t * I.h;
    const sx = (I.w * (1 - l - r)) / LW;
    const sy = (I.h * (1 - t - b)) / LH;
    const W1 = I.w + 1;
    for (let y = 0; y < LH; y++) {
      const ya = Math.round(y0 + y * sy);
      const yb = Math.max(ya + 1, Math.round(y0 + (y + 1) * sy));
      for (let x = 0; x < LW; x++) {
        const xa = Math.round(x0 + x * sx);
        const xb = Math.max(xa + 1, Math.round(x0 + (x + 1) * sx));
        const area = (xb - xa) * (yb - ya);
        const o = (flip ? (LH - 1 - y) * LW + (LW - 1 - x) : y * LW + x) * 3;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (I.S[c][yb * W1 + xb] - I.S[c][ya * W1 + xb] - I.S[c][yb * W1 + xa] + I.S[c][ya * W1 + xa]) / area;
        }
      }
    }
    return out;
  }
  
  // What gets compared: each colour with its average removed (so overall brightness and tint don't
  // matter), plus the brightness of each pixel against its neighbourhood (which survives glare and
  // washed-out exposure). The two halves weigh the same; the whole is a unit vector.
  const GRAY = new Float64Array(LW * LH); // scratch space for lowFeature (it never runs twice at once)
  const SUM = new Float64Array((LW + 1) * (LH + 1));
  const SUMSQ = new Float64Array((LW + 1) * (LH + 1));
  function lowFeature(small) {
    const out = new Float32Array(LOW);
    let k = 0;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      const start = k;
      for (let y = LM; y < LH - LM; y++) {
        for (let x = LM; x < LW - LM; x++) {
          const v = small[(y * LW + x) * 3 + c];
          out[k++] = v;
          sum += v;
        }
      }
      const mean = sum / LN;
      for (let i = start; i < k; i++) out[i] -= mean;
    }
    let norm = 0;
    for (let i = 0; i < k; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm * 2) || 1;
    for (let i = 0; i < k; i++) out[i] /= norm;
  
    // Neighbourhood mean and spread from running sums (this runs hundreds of times per lookup, for
    // the trimming search; adding up each 7x7 neighbourhood by hand was most of a lookup's time).
    const gray = GRAY;
    const S = SUM;
    const SS = SUMSQ;
    const W1 = LW + 1;
    for (let y = 0; y < LH; y++) {
      let row = 0;
      let rowSq = 0;
      for (let x = 0; x < LW; x++) {
        const i = y * LW + x;
        const g = small[i * 3] * 0.3 + small[i * 3 + 1] * 0.59 + small[i * 3 + 2] * 0.11;
        gray[i] = g;
        row += g;
        rowSq += g * g;
        const o = (y + 1) * W1 + x + 1;
        S[o] = S[o - W1] + row;
        SS[o] = SS[o - W1] + rowSq;
      }
    }
    const R = 3;
    norm = 0;
    for (let y = LM; y < LH - LM; y++) {
      const ya = Math.max(0, y - R);
      const yb = Math.min(LH - 1, y + R) + 1;
      for (let x = LM; x < LW - LM; x++) {
        const xa = Math.max(0, x - R);
        const xb = Math.min(LW - 1, x + R) + 1;
        const n = (xb - xa) * (yb - ya);
        const s = S[yb * W1 + xb] - S[ya * W1 + xb] - S[yb * W1 + xa] + S[ya * W1 + xa];
        const ss = SS[yb * W1 + xb] - SS[ya * W1 + xb] - SS[yb * W1 + xa] + SS[ya * W1 + xa];
        const mean = s / n;
        const v = (gray[y * LW + x] - mean) / (Math.sqrt(Math.max(0, ss / n - mean * mean)) + 8);
        out[k++] = v;
        norm += v * v;
      }
    }
    norm = Math.sqrt(norm * 2) || 1;
    for (let i = 3 * LN; i < k; i++) out[i] /= norm;
    return out;
  }

  const stats = (v) => {
    let sum = 0;
    for (const x of v) sum += x;
    const mean = sum / v.length;
    let sq = 0;
    for (const x of v) sq += (x - mean) ** 2;
    return { mean, sd: Math.sqrt(sq / v.length) || 1 };
  };
  
  // The corners of the card after trimming shares off the sides of the outline u ([TL,TR,BR,BL]).
  function trimQuad(u, l, t, r, b) {
    const pt = (x, y) => {
      const top = [u[0][0] + (u[1][0] - u[0][0]) * x, u[0][1] + (u[1][1] - u[0][1]) * x];
      const bot = [u[3][0] + (u[2][0] - u[3][0]) * x, u[3][1] + (u[2][1] - u[3][1]) * x];
      return [top[0] + (bot[0] - top[0]) * y, top[1] + (bot[1] - top[1]) * y];
    };
    return [pt(l, t), pt(1 - r, t), pt(1 - r, 1 - b), pt(l, 1 - b)];
  }

  /* Compare the card inside `quad` (corners in the picture's pixels) with reference pictures.
     pool: [{ ref: { emb: [vectors], low } }], the first `mine` of them the candidates and the rest
     others to judge the scores against. embed(pictures) -> Promise<unit vectors>.
     Resolves with { emb, low } (how alike each pool entry is, by each comparison) and their
     { mean, sd } over the pool; a candidate's score is the two, each as "standard deviations above
     the pool", added. */
  async function rank(rgb, sw, sh, quad, pool, mine, embed) {
    // The outline's long sides are the card's; it may still be upside down, so both ways are compared.
    const u = globalThis.CardFind.uprightCorners(quad);
    const upright = warp(rgb, sw, sh, u);
    const turned = new Uint8Array(upright.length);
    for (let i = 0, j = W * H - 1; i < W * H; i++, j--) {
      turned[j * 3] = upright[i * 3];
      turned[j * 3 + 1] = upright[i * 3 + 1];
      turned[j * 3 + 2] = upright[i * 3 + 2];
    }
    const vectors = await embed([upright, turned]);
    const I = integral(upright, W, H);
    const plain = [lowFeature(shrink(I)), lowFeature(shrink(I, 0, 0, 0, 0, true))];
  
  
    const emb = new Float32Array(pool.length);
    const low = new Float32Array(pool.length);
    pool.forEach((p, i) => {
      let e = -1;
      for (const v of vectors) for (const r of p.ref.emb) e = Math.max(e, dot(v, r));
      emb[i] = e;
      low[i] = Math.max(dot(plain[0], p.ref.low), dot(plain[1], p.ref.low));
    });
    const lowStats = stats(low); // before trimming: trimming only lifts the likely ones
    let embStats = stats(emb);
  
    // Trimming search for the likeliest candidates: coarse over all four sides, then fine around the best.
    const likely = [...Array(mine).keys()]
      .sort((a, b) => ((emb[b] - embStats.mean) / embStats.sd + (low[b] - lowStats.mean) / lowStats.sd) - ((emb[a] - embStats.mean) / embStats.sd + (low[a] - lowStats.mean) / lowStats.sd))
      .slice(0, LIKELY);
    const features = new Map();
    const featureAt = (flip, l, t, r, b) => {
      const key = `${flip}|${l.toFixed(2)}|${t.toFixed(2)}|${r.toFixed(2)}|${b.toFixed(2)}`;
      let f = features.get(key);
      if (!f) features.set(key, f = lowFeature(shrink(I, l, t, r, b, !!flip)));
      return f;
    };
    let fit = null; // the best trim over all likely candidates
    const fitOf = new Map(); // pool index -> its best { s, flip, l, t, r, b }
    for (const flip of [0, 1]) {
      for (const l of TRIMS) for (const t of TRIMS) for (const r of TRIMS) for (const b of TRIMS) {
        const f = featureAt(flip, l, t, r, b);
        for (const i of likely) {
          const s = dot(f, pool[i].ref.low);
          if (!(fitOf.get(i)?.s >= s)) fitOf.set(i, { s, flip, l, t, r, b });
        }
      }
    }
    for (const i of [...fitOf.keys()].sort((a, b) => fitOf.get(b).s - fitOf.get(a).s).slice(0, 6)) {
      const c = fitOf.get(i);
      let best = c;
      for (const dl of FINE) for (const dt of FINE) for (const dr of FINE) for (const db of FINE) {
        const [l, t, r, b] = [c.l + dl, c.t + dt, c.r + dr, c.b + db];
        if (l < 0 || t < 0 || r < 0 || b < 0 || (!dl && !dt && !dr && !db)) continue;
        const s = dot(featureAt(c.flip, l, t, r, b), pool[i].ref.low);
        if (s > best.s) best = { s, flip: c.flip, l, t, r, b };
      }
      fitOf.set(i, best);
    }
    for (const [i, c] of fitOf) {
      if (c.s > low[i]) low[i] = c.s;
      if (!fit || c.s > fit.s) fit = c;
    }
    // The embedder gets a second go at the best-fitting trim.
    if (fit && (fit.l || fit.t || fit.r || fit.b)) {
      const again = warp(rgb, sw, sh, trimQuad(fit.flip ? [u[2], u[3], u[0], u[1]] : u, fit.l, fit.t, fit.r, fit.b));
      const [v] = await embed([again]);
      pool.forEach((p, i) => { for (const r of p.ref.emb) emb[i] = Math.max(emb[i], dot(v, r)); });
      embStats = stats(emb);
    }
  
  
    // (boxes: the text box either way up, for basicLand below.)
    return { emb, low, embStats, lowStats, boxes: [boxFeature(shrink(I)), boxFeature(shrink(I, 0, 0, 0, 0, true))] };
  }


  // ---------- basic lands, by their symbol ----------
  // A basic land has hundreds of printings with different art, far more than there are reference
  // pictures for, so the art is the wrong thing to match: a player's Island was suggested as
  // "Temple of Abandon". But the text box of almost every one is the same: one big mana symbol.
  // So basics are told by that. The feature is the text box alone (rows 28-40 of the 45, the
  // middle 24 of 32 columns) as colour with its average removed; its average colour is kept apart,
  // to tell a Forest's symbol from a Swamp's, which are alike in shape.
  // Measured on webcam captures against symbols from scans: Forests 0.64-0.91, Islands 0.43-0.79,
  // every non-land at most 0.38.
  const BASIC_AT = 0.5; // the text box is this alike to a basic's symbol: it is that basic
  function boxFeature(small, flip = false) {
    const f = new Float32Array(13 * 24 * 3);
    const mean = [0, 0, 0];
    let k = 0;
    for (let y = 28; y <= 40; y++) {
      for (let x = 4; x <= 27; x++) {
        const i = ((flip ? LH - 1 - y : y) * LW + (flip ? LW - 1 - x : x)) * 3;
        for (let c = 0; c < 3; c++) { f[k] = small[i + c]; mean[c] += small[i + c]; k++; }
      }
    }
    const n = f.length / 3;
    let ss = 0;
    for (let i = 0; i < f.length; i++) { f[i] -= mean[i % 3] / n; ss += f[i] * f[i]; }
    const norm = Math.sqrt(ss) || 1;
    for (let i = 0; i < f.length; i++) f[i] /= norm;
    const sum = mean[0] + mean[1] + mean[2] || 1;
    return { f, c: mean.map((m) => m / sum) };
  }
  // Which basic land the text boxes (from rank) show, if any: { name, score, lead }.
  // refs: [{ name, f, c }], symbols taken from scans (server/recognize.js builds them).
  function basicLand(boxes, refs) {
    if (!boxes || !refs?.length) return null;
    const best = new Map(); // name -> { score, hue }
    for (const ref of refs) {
      for (const box of boxes) {
        const score = dot(box.f, ref.f);
        const hue = Math.abs(box.c[0] - ref.c[0]) + Math.abs(box.c[1] - ref.c[1]) + Math.abs(box.c[2] - ref.c[2]);
        if (!(best.get(ref.name)?.score >= score)) best.set(ref.name, { name: ref.name, score, hue });
      }
    }
    const order = [...best.values()].sort((a, b) => b.score - a.score);
    let [top, next] = order;
    // Two symbols about as alike in shape: the one whose colour is closer.
    if (next && top.score - next.score < 0.12 && next.hue < top.hue) [top, next] = [next, top];
    if (top.score < BASIC_AT) return null;
    return { name: top.name, score: top.score, lead: top.score - (next?.score ?? 0) };
  }
  // Put a detected basic land at the head of a lookup's matches. matches: [{ card, owner, score }]
  // best first; own(name) -> { card, owner } from the decks, or null. Returns the new list.
  function withBasic(matches, basic, own, fallback) {
    if (!basic || matches[0]?.score >= 9) return matches; // (a match that strong isn't overruled)
    const mine = own(basic.name) || (fallback ? { card: fallback, owner: '' } : null);
    if (!mine) return matches;
    const rest = matches.filter((m) => m.card.name !== basic.name);
    // Clear of the rest, so it is taken as sure: the symbol, not the art score, is the evidence.
    const score = Math.round(Math.max(7.5 + basic.score * 3, (rest[0]?.score ?? 0) + 3) * 10) / 10;
    return [{ ...mine, score, basic: true }, ...rest];
  }

  // ---------- a whole lookup, for the browser ----------
  // The server does these steps with its own image library and model runtime (server/recognize.js);
  // a browser that is faster than the server does them here, in public/match-worker.js.
  const FW = 640; // the card finder's input
  const FH = 384;
  const SURE_SCORE = 5.5; // as on the server: this far above the other pictures...
  const SURE_MARGIN = 2; // ...and this far ahead of the next card is a sure match

  // The reference pack the server sends (see refPack in server/recognize.js) -> { meta, pool }.
  function unpack(buffer) {
    const view = new DataView(buffer);
    if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'MTGR') throw new Error('not a reference pack');
    const jsonLength = view.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength)));
    const bytes = new Int8Array(buffer, 8 + jsonLength);
    const pool = [];
    let off = 0;
    for (let i = 0; i < meta.total; i++) {
      const emb = [];
      for (let r = 0; r < meta.renditions; r++) {
        const v = new Float32Array(meta.dim);
        let norm = 0;
        for (let k = 0; k < meta.dim; k++) { v[k] = bytes[off++]; norm += v[k] * v[k]; }
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < meta.dim; k++) v[k] /= norm; // unit length again after rounding
        emb.push(v);
      }
      const scale = view.getFloat32(8 + jsonLength + off, true) / 127;
      off += 4;
      const low = new Float32Array(meta.low);
      for (let k = 0; k < meta.low; k++) low[k] = bytes[off++] * scale;
      pool.push({ ref: { emb, low } });
    }
    return { meta, pool };
  }

  // The picture fitted inside the finder's input, grey around it: { data, k, ox, oy }.
  function finderInput(rgb, sw, sh) {
    const k = Math.min(FW / sw, FH / sh);
    const nw = Math.max(1, Math.round(sw * k));
    const nh = Math.max(1, Math.round(sh * k));
    const ox = Math.floor((FW - nw) / 2);
    const oy = Math.floor((FH - nh) / 2);
    const plane = FW * FH;
    const data = new Float32Array(3 * plane).fill(114 / 255);
    const taps = 1 / k > 1.5 ? 2 : 1;
    const acc = [0, 0, 0];
    const div = 255 * taps * taps;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        acc[0] = 0; acc[1] = 0; acc[2] = 0;
        for (let ty = 0; ty < taps; ty++) {
          for (let tx = 0; tx < taps; tx++) sampleInto(acc, rgb, sw, sh, (x + (tx + 0.5) / taps) / k - 0.5, (y + (ty + 0.5) / taps) / k - 0.5);
        }
        const o = (y + oy) * FW + x + ox;
        data[o] = acc[0] / div;
        data[plane + o] = acc[1] / div;
        data[2 * plane + o] = acc[2] / div;
      }
    }
    return { data, k, ox, oy };
  }

  // The finder's raw answer (rows of n values: cx, cy, w, h, score, then x, y, visibility per
  // corner) -> [{ score, quad }] in the picture's pixels, overlapping boxes merged.
  function finderCards(d, n, { k, ox, oy }) {
    const found = [];
    for (let i = 0; i < n; i++) {
      const score = d[4 * n + i];
      if (score < 0.25) continue;
      found.push({
        score, box: [d[i] - d[2 * n + i] / 2, d[n + i] - d[3 * n + i] / 2, d[i] + d[2 * n + i] / 2, d[n + i] + d[3 * n + i] / 2],
        quad: [0, 1, 2, 3].map((c) => [(d[(5 + 3 * c) * n + i] - ox) / k, (d[(6 + 3 * c) * n + i] - oy) / k]),
      });
    }
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of found) {
      const overlaps = kept.some((o) => {
        const iw = Math.min(c.box[2], o.box[2]) - Math.max(c.box[0], o.box[0]);
        const ih = Math.min(c.box[3], o.box[3]) - Math.max(c.box[1], o.box[1]);
        if (iw <= 0 || ih <= 0) return false;
        const inter = iw * ih;
        return inter / ((c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) + (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) - inter) > 0.5;
      });
      if (!overlaps) kept.push(c);
    }
    return kept;
  }

  /* One lookup: which card is at `hint` ({x, y} in 0-1) of an RGB picture?
     pack: from unpack(). runFinder(data) -> Promise<{ data, n }> runs the card finder on a
     640x384 input; embed(pictures) -> Promise<unit vectors> runs the embedding model.
     Resolves with what the server's /api/identify answers. */
  async function lookup(rgb, sw, sh, hint, pack, runFinder, embed) {
    const t0 = Date.now();
    const CF = globalThis.CardFind;
    const at = [hint.x * sw, hint.y * sh];
    const input = finderInput(rgb, sw, sh);
    const out = await runFinder(input.data);
    // A clean outline right under the point counts even when the finder is lukewarm about it (a
    // card in a fan of others); one that is only nearby has to be a clear card.
    const cards = finderCards(out.data, out.n, input).filter((c) => c.score >= 0.3)
      .map((c) => ({ ...CF.quadPose(c.quad), score: c.score })).filter((p) => p.shape > 0.6);
    const dist = (p) => Math.hypot(p.cx - at[0], p.cy - at[1]);
    const card = cards.filter((p) => CF.insideQuad(at, p.quad) && (p.score >= 0.5 || p.shape > 0.85)).sort((p, q) => q.score - p.score)[0]
      || cards.filter((p) => p.score >= 0.5 && dist(p) < p.b * 0.75).sort((p, q) => dist(p) - dist(q))[0];
    if (!card) return { found: false, runs: 1, ms: Date.now() - t0, local: true };
    const { meta, pool } = pack;
    const { emb, low, embStats, lowStats, boxes } = await rank(rgb, sw, sh, card.quad, pool, meta.mine, embed);
    const best = new Map(); // card index -> its best reference
    for (let i = 0; i < meta.mine; i++) {
      const score = (emb[i] - embStats.mean) / embStats.sd + (low[i] - lowStats.mean) / lowStats.sd;
      const [ci, small, normal] = meta.rows[i];
      if (!(best.get(ci)?.score >= score)) best.set(ci, { ci, small, normal, score });
    }
    let matches = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 6).map((m) => {
      const c = meta.cards[m.ci];
      // Show the printing that matched, so a sticker looks like the card on the table.
      return { owner: c.owner, score: Math.round(m.score * 10) / 10, card: { ...c.card, image: m.small || c.card.image, imageLarge: m.normal || c.card.imageLarge } };
    });
    // A basic land is told by its symbol, whatever its art.
    const basic = basicLand(boxes, meta.symbols?.refs);
    matches = withBasic(matches, basic, (name) => meta.cards.find((c) => c.name === name) || null, meta.symbols?.cards?.[basic?.name]).slice(0, 6);
    const top = matches[0];
    const lead = top ? top.score - (matches[1]?.score ?? -Infinity) : 0;
    return {
      found: true,
      cardScore: card.score,
      underClick: CF.insideQuad(at, card.quad),
      quad: card.quad.map(([x, y]) => [x / sw, y / sh]),
      matches,
      confident: !!top && top.score >= SURE_SCORE && lead >= SURE_MARGIN,
      weak: !!top && lead < 1,
      cardWidth: Math.round(card.a),
      waiting: 0,
      runs: 1,
      ms: Date.now() - t0,
      local: true,
    };
  }

  globalThis.CardMatch = { W, H, DIM, LW, LH, LM, LN, LOW, dot, homography, sampleInto, warp, integral, shrink, lowFeature, stats, trimQuad, rank, boxFeature, basicLand, withBasic, FW, FH, unpack, finderInput, finderCards, lookup };
})();
