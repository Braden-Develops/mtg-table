// Card recognition.
//  1. Corner finder (DETRPose, MIT, dhvazquez/mtg_card_pose_estimation) finds the card's 4 corners.
//     It only works on a card framed the way it was trained (see public/cardfind.js, which holds
//     the search shared with the browser's card tracking).
//  2. We straighten the card to 320x448 with a perspective warp.
//  3. Two independent comparisons against reference pictures of the cards in the decks at the table:
//     - Embedder (EfficientNet-Lite0, MIT, dhvazquez/mtg_card_identification_embeddings): a
//       256-number vector per picture. Good on sharp pictures; a webcam card 150 px wide is not
//       one (the same Scryfall image shrunk to 110 px scores 0.36 against itself).
//     - A plain low-resolution comparison (32x45, colour and local contrast). Blur doesn't hurt
//       it, but it needs the outline to fit, so for the likeliest cards the picture is also tried
//       trimmed a little on each side (the outline is often the sleeve, or loose on a dark mat).
//     Each is turned into "how far above the other reference pictures" and the two are added.
// Reference pictures come from Scryfall (every different-looking printing of each deck card) and
// their vectors are cached in data/references-v4.bin.
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import '../public/cardfind.js';
import { DATA_DIR, ROOT } from '../scripts/lib.js';
import { artworks } from './scryfall.js';

const CF = globalThis.CardFind;
const POSE_MODEL = path.join(ROOT, 'models', 'mtg_4kp_s_r4b.onnx');
const EMBED_MODEL = path.join(ROOT, 'models', 'mtg_embed_fp32.onnx');
// The whole-picture card finder (our own model, see training/): one cheap look outlines the card,
// where the corner model needs three or more looks at guessed frames.
const FINDER_MODEL = path.join(ROOT, 'cardfinder', 'card_finder.onnx');
// How the card's outline is found: 'finder' (the finder alone), 'finder+pose' (the finder, then one
// look by the corner model to sharpen it), 'pose' (the corner model's own search, as before).
const FIND_MODE = process.env.RECOG_FIND || 'finder';
const FW = 640;
const FH = 384;
const CACHE_FILE = path.join(DATA_DIR, 'references-v4.bin');
const W = 320;
const H = 448;
const DIM = 256;
const POSE_SIZE = 640;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// The server shares its two cores with the video relay: RECOG_THREADS=1 keeps one free during lookups.
const THREADS = Math.max(1, Number(process.env.RECOG_THREADS) || 2);

let sessions = null;

export function modelsAvailable() {
  return fs.existsSync(POSE_MODEL) && fs.existsSync(EMBED_MODEL);
}

function getSessions() {
  sessions ??= (async () => {
    const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: THREADS };
    return {
      pose: await ort.InferenceSession.create(POSE_MODEL, opts),
      embed: await ort.InferenceSession.create(EMBED_MODEL, opts),
      finder: fs.existsSync(FINDER_MODEL) ? await ort.InferenceSession.create(FINDER_MODEL, opts) : null,
    };
  })();
  return sessions;
}

// Load the models before the first click needs them.
export function warmUp() {
  if (modelsAvailable()) getSessions().catch((err) => console.warn('Recognition models failed to load:', err.message));
}

// One model run at a time. Running lookups side by side was tried and gains nothing: this
// library runs a model on the main thread (60% of a lookup, measured), so they still take turns.
// Real parallel lookups would need worker threads, each with its own copy of the models.
// Lookups go ahead of background indexing.
const waiting = { urgent: [], background: [] };
let running = false;
function serial(fn, urgent = true) {
  return new Promise((resolve, reject) => {
    waiting[urgent ? 'urgent' : 'background'].push({ fn, resolve, reject });
    pump();
  });
}
async function pump() {
  if (running) return;
  running = true;
  for (;;) {
    const job = waiting.urgent.shift() || waiting.background.shift();
    if (!job) break;
    try { job.resolve(await job.fn()); } catch (err) { job.reject(err); }
  }
  running = false;
}

// ---------- reference pictures ----------
// Each reference: the embedder's vector for the picture at a few sharpness levels (it is very
// sensitive to sharpness, and we don't know how sharp the camera is), and the low-res feature.
const RENDITIONS = [
  (img) => img,
  async (img, base) => sharp(await sharp(base).resize(110).toBuffer()).resize(W, H, { fit: 'fill' }),
  async (img, base) => sharp(await sharp(base).resize(160).toBuffer()).resize(W, H, { fit: 'fill' }).blur(0.8),
  async (img, base) => sharp(await sharp(base).resize(220).toBuffer()).resize(W, H, { fit: 'fill' }).blur(0.6),
];
const LW = 32; // low-res comparison size
const LH = 45;
const LM = 3; // margin left out (card border, sleeve)
const LN = (LW - 2 * LM) * (LH - 2 * LM);
const LOW = LN * 4; // 3 colour planes + 1 local-contrast plane
const KEY = 48; // bytes per record key: '<scryfall id>/<face>'
const RECORD = KEY + (RENDITIONS.length * DIM + LOW) * 4;

const refs = loadCache(); // '<scryfallId>/<face>' -> { emb: [Float32Array(256) x renditions], low: Float32Array(LOW) }
let cacheFd = null;

function loadCache() {
  const map = new Map();
  try {
    const buf = fs.readFileSync(CACHE_FILE);
    for (let off = 0; off + RECORD <= buf.length; off += RECORD) {
      const id = buf.toString('ascii', off, off + KEY).trimEnd();
      const floats = new Float32Array(buf.buffer.slice(buf.byteOffset + off + KEY, buf.byteOffset + off + RECORD));
      map.set(id, {
        emb: RENDITIONS.map((_, r) => floats.subarray(r * DIM, (r + 1) * DIM)),
        low: floats.subarray(RENDITIONS.length * DIM),
      });
    }
    // A record cut short by a crash would shift everything written after it.
    if (buf.length % RECORD) fs.truncateSync(CACHE_FILE, buf.length - (buf.length % RECORD));
  } catch { /* no cache yet */ }
  return map;
}

function appendCache(id, ref) {
  const buf = Buffer.alloc(RECORD);
  buf.write(id.padEnd(KEY).slice(0, KEY), 0, 'ascii');
  let off = KEY;
  for (const v of [...ref.emb, ref.low]) for (let i = 0; i < v.length; i++, off += 4) buf.writeFloatLE(v[i], off);
  try {
    cacheFd ??= fs.openSync(CACHE_FILE, 'a');
    fs.writeSync(cacheFd, buf);
  } catch (err) {
    console.warn('Could not save card references:', err.message);
  }
}

// ---------- image helpers ----------
// RGB pictures (W x H each) -> unit vectors from the embedder, in one run.
async function embedRgb(pictures) {
  const { embed } = await getSessions();
  const plane = W * H;
  const data = new Float32Array(pictures.length * 3 * plane);
  pictures.forEach((rgb, n) => {
    const at = n * 3 * plane;
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) data[at + c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  });
  const out = await embed.run({ input: new ort.Tensor('float32', data, [pictures.length, 3, H, W]) });
  return pictures.map((_, n) => {
    const v = Float32Array.from(out.embedding.data.subarray(n * DIM, (n + 1) * DIM));
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  });
}

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
function warp(rgb, sw, sh, corners) {
  const dst = [[0, 0], [W, 0], [W, H], [0, H]];
  const m = homography(dst, corners); // maps output pixel -> source pixel
  // A card bigger than the output (held up to the camera): average a few samples per pixel.
  const big = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / W;
  const taps = big > 2.5 ? 3 : big > 1.4 ? 2 : 1;
  const out = Buffer.alloc(W * H * 3);
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

// ---------- corner finding ----------
// Squash a frame of the picture (a rotated rectangle, see cardfind.js) to the model's square input
// and run it. Returns the model's cards with corners in picture pixels.
function poseRunner(rgb, sw, sh) {
  return (f) => serial(async () => {
    const { pose } = await getSessions();
    const o = CF.fromFrame(f, 0, 0);
    const px = CF.fromFrame(f, 1, 0);
    const py = CF.fromFrame(f, 0, 1);
    const ax = (px[0] - o[0]) / POSE_SIZE;
    const ay = (px[1] - o[1]) / POSE_SIZE;
    const bx = (py[0] - o[0]) / POSE_SIZE;
    const by = (py[1] - o[1]) / POSE_SIZE;
    const plane = POSE_SIZE * POSE_SIZE;
    const data = new Float32Array(3 * plane);
    const taps = Math.max(f.w, f.h) / POSE_SIZE > 1.5 ? 2 : 1;
    const k = 255 * taps * taps;
    const acc = [0, 0, 0];
    for (let y = 0; y < POSE_SIZE; y++) {
      for (let x = 0; x < POSE_SIZE; x++) {
        acc[0] = 0; acc[1] = 0; acc[2] = 0;
        for (let ty = 0; ty < taps; ty++) {
          for (let tx = 0; tx < taps; tx++) {
            const u = x + (tx + 0.5) / taps;
            const v = y + (ty + 0.5) / taps;
            sampleInto(acc, rgb, sw, sh, o[0] + ax * u + bx * v - 0.5, o[1] + ay * u + by * v - 0.5);
          }
        }
        const i = y * POSE_SIZE + x;
        data[i] = acc[0] / k;
        data[plane + i] = acc[1] / k;
        data[2 * plane + i] = acc[2] / k;
      }
    }
    const out = await pose.run({ image: new ort.Tensor('float32', data, [1, 3, POSE_SIZE, POSE_SIZE]) });
    const found = [];
    for (let q = 0; q < out.scores.data.length; q++) {
      const score = 1 / (1 + Math.exp(-out.scores.data[q]));
      if (score < 0.2) continue;
      const quad = [0, 1, 2, 3].map((c) => CF.fromFrame(f, out.keypoints.data[(q * 4 + c) * 2], out.keypoints.data[(q * 4 + c) * 2 + 1]));
      found.push({ score, quad });
    }
    return found;
  });
}

// Every card in the picture, by the whole-picture finder: [{ score, quad }], corners in picture
// pixels, the card's own top-left first. null without the model.
async function finderCards(rgb, sw, sh) {
  const { finder } = await getSessions();
  if (!finder) return null;
  // The picture fitted inside the model's 640x384 input, grey around it.
  const k = Math.min(FW / sw, FH / sh);
  const nw = Math.max(1, Math.round(sw * k));
  const nh = Math.max(1, Math.round(sh * k));
  const ox = Math.floor((FW - nw) / 2);
  const oy = Math.floor((FH - nh) / 2);
  const small = await sharp(rgb, { raw: { width: sw, height: sh, channels: 3 } }).resize(nw, nh, { fit: 'fill' }).raw().toBuffer();
  const plane = FW * FH;
  const data = new Float32Array(3 * plane).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 3;
      const o = (y + oy) * FW + x + ox;
      data[o] = small[i] / 255;
      data[plane + o] = small[i + 1] / 255;
      data[2 * plane + o] = small[i + 2] / 255;
    }
  }
  const out = await serial(() => finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, FH, FW]) }));
  const t = out[finder.outputNames[0]];
  const d = t.data;
  const n = t.dims[2]; // rows: cx, cy, w, h, score, then x, y, visibility for each corner
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

// The card under `hint` ({x, y} in 0-1 of the picture). size: its likely short side in pixels, if known.
// Resolves with { card, sure, runs, others } (see CardFind.locate).
export async function findCard(rgb, sw, sh, hint, size = 0) {
  const at = [hint.x * sw, hint.y * sh];
  const found = FIND_MODE === 'pose' ? null : await finderCards(rgb, sw, sh);
  if (found) {
    const cards = found.filter((c) => c.score >= 0.5).map((c) => ({ ...CF.quadPose(c.quad), score: c.score }))
      .filter((p) => p.shape > 0.6);
    // The card the point is on; failing that, one whose middle is close by.
    const dist = (p) => Math.hypot(p.cx - at[0], p.cy - at[1]);
    let card = cards.filter((p) => CF.insideQuad(at, p.quad)).sort((p, q) => q.score - p.score)[0]
      || cards.filter((p) => dist(p) < p.b * 0.75).sort((p, q) => dist(p) - dist(q))[0];
    if (card) {
      let runs = 1;
      if (FIND_MODE === 'finder+pose') {
        // One look by the corner model, framed on the finder's outline, to sharpen the corners.
        runs = 2;
        const f = CF.frameFor(card);
        const sharp1 = (await poseRunner(rgb, sw, sh)(f)).map((p) => ({ ...CF.quadPose(p.quad), score: p.score }))
          .filter((p) => p.score >= 0.8 && p.shape > 0.6 && Math.hypot(p.cx - card.cx, p.cy - card.cy) < card.a * 0.15 && Math.abs(p.a / card.a - 1) < 0.15)
          .sort((p, q) => q.score - p.score)[0];
        if (sharp1) card = sharp1;
      }
      return { card, sure: true, runs, others: [], via: 'finder' };
    }
  }
  return CF.locate(poseRunner(rgb, sw, sh), at, {
    span: Math.min(sw, sh), bounds: [sw, sh], size, maxRuns: 14,
  });
}

// ---------- reference cards ----------
// A player's copy can be any printing, so every different-looking printing of each deck card gets
// a reference (the deck's own printings first). Printing lists are cached in data/arts.json:
// name -> { at, complete, list: [{ key, small, normal }] }.
const ARTS_FILE = path.join(DATA_DIR, 'arts.json');
const ARTS_MAX_AGE = 30 * 24 * 3600_000; // look for new printings once a month
const ARTS_RETRY = 600_000; // after Scryfall couldn't be reached
let arts = {};
try {
  const saved = JSON.parse(fs.readFileSync(ARTS_FILE, 'utf8'));
  // Lists saved by earlier versions (plain arrays) missed alternate frames: fetch those again.
  for (const [name, v] of Object.entries(saved)) arts[name] = Array.isArray(v) ? { at: 0, complete: false, list: v } : v;
} catch { /* none yet */ }
let artsTimer = null;
function saveArts() {
  artsTimer ??= setTimeout(() => {
    artsTimer = null;
    const tmp = `${ARTS_FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(arts), (err) => { if (!err) fs.rename(tmp, ARTS_FILE, () => {}); });
  }, 2000);
}

const toIndex = new Map(); // card name -> card, waiting for the background indexer
let indexing = null;

const okImage = (u) => typeof u === 'string' && u.startsWith('https://cards.scryfall.io/');
const listFresh = (entry) => entry && Date.now() - entry.at < (entry.complete ? ARTS_MAX_AGE : ARTS_RETRY);
// The printings a deck card was loaded as (the deck list may name several).
const ownPrints = (card) => [card, ...(card.prints || [])]
  .filter((p) => p.scryfallId && okImage(p.imageLarge))
  .map((p) => ({ key: `${p.scryfallId}/0`, small: p.image, normal: p.imageLarge }));
const indexed = (card) => {
  const entry = arts[card.name];
  return listFresh(entry) && entry.list.every((a) => refs.has(a.key)) && ownPrints(card).every((a) => refs.has(a.key));
};

async function indexArt(art) {
  const res = await fetch(art.normal, { headers: { 'User-Agent': 'MTGTable/0.1 (private game table)' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const base = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().resize(W, H, { fit: 'fill' }).png().toBuffer();
  const pictures = [];
  for (const make of RENDITIONS) pictures.push(await (await make(sharp(base), base)).removeAlpha().raw().toBuffer());
  const emb = await serial(() => embedRgb(pictures), false);
  const ref = { emb, low: lowFeature(shrink(integral(pictures[0], W, H))) };
  refs.set(art.key, ref);
  appendCache(art.key, ref);
}

// Make sure the card's list of printings is there and current. The deck's own printings go first.
async function listArts(card) {
  let entry = arts[card.name];
  if (!listFresh(entry)) {
    let more = null;
    try { more = await artworks(card.name); } catch (err) { console.warn('Could not list printings of', card.name, '-', err.message, '(trying again later)'); }
    const list = [...(entry?.list || []), ...(more || [])].filter((x, i, all) => okImage(x.normal) && all.findIndex((y) => y.key === x.key) === i);
    entry = { at: Date.now(), complete: !!more, list };
    arts[card.name] = entry;
    saveArts();
  }
  const own = ownPrints(card).filter((a) => !entry.list.some((b) => b.key === a.key));
  if (own.length) {
    entry.list.unshift(...own);
    saveArts();
  }
  return entry.list;
}

async function indexSome(card, list) {
  for (const art of list) {
    if (refs.has(art.key)) continue;
    try {
      await indexArt(art);
    } catch (err) {
      console.warn('Could not index', card.name, err.message);
    }
    await new Promise((r) => setTimeout(r, 60)); // be gentle with Scryfall's image servers
  }
}

// First the deck's own printing of every card (so a new deck is usable within a minute), then the rest.
async function runIndexer() {
  const later = [];
  while (toIndex.size) {
    const [name, card] = toIndex.entries().next().value;
    const list = await listArts(card);
    const own = ownPrints(card).map((a) => a.key);
    const first = list.filter((a) => own.includes(a.key));
    await indexSome(card, first.length ? first : list.slice(0, 1));
    later.push(card);
    toIndex.delete(name);
  }
  for (const card of later) await indexSome(card, arts[card.name]?.list || []);
}

// Queue cards for indexing in the background (after a deck loads, and at startup). Resolves when done.
export function indexCards(cards) {
  if (!modelsAvailable()) return Promise.resolve();
  for (const card of cards) if (card?.name && !indexed(card)) toIndex.set(card.name, card);
  if (!indexing) {
    indexing = runIndexer().finally(() => {
      indexing = null;
      if (toIndex.size) indexCards([]); // queued while the second pass was running
    });
  }
  return indexing;
}

export function indexStatus() {
  return { waiting: toIndex.size };
}

// ---------- capture log ----------
// Every lookup is kept (the crop, what was found, and afterwards what the player picked) so
// recognition can be measured on real pictures: `node scripts/recog-replay.js`. The newest
// RECOG_LOG_MAX are kept (default 400, about 60 MB; 0 turns the log off).
const LOG_DIR = path.join(DATA_DIR, 'identify-log');
const LOG_MAX = process.env.RECOG_LOG_MAX === undefined ? 400 : Math.max(0, Number(process.env.RECOG_LOG_MAX) || 0);

function saveCapture(image, record) {
  if (!LOG_MAX) return null;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    const dir = path.join(LOG_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFile(path.join(dir, 'crop.jpg'), image, () => {});
    fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(record), () => {});
    const old = fs.readdirSync(LOG_DIR).sort().slice(0, -LOG_MAX);
    for (const d of old) fs.rm(path.join(LOG_DIR, d), { recursive: true, force: true }, () => {});
  } catch (err) {
    console.warn('Could not log the lookup:', err.message);
    return null;
  }
  return id;
}

// What the player did with a lookup: label = { name (the card it really was, or null), how, by }.
export function labelCapture(id, label) {
  if (!/^[\w-]{10,60}$/.test(String(id))) return false;
  const dir = path.join(LOG_DIR, id);
  if (!fs.existsSync(path.join(dir, 'result.json'))) return false;
  fs.writeFile(path.join(dir, 'label.json'), JSON.stringify(label), () => {});
  return true;
}

// ---------- matching ----------
const TRIMS = [0, 0.08, 0.16]; // shares trimmed off a side, coarse pass
const FINE = [-0.04, 0, 0.04]; // then around the best
const LIKELY = 24; // reference pictures that get the trimming search
const BACKGROUND = 1500; // other reference pictures used to judge what an ordinary score is
// Sure enough to say "Match": this far above the other pictures, and this far ahead of the next card.
// (On real lookups: right answers were 5.6-11.3 with the next card 2.5+ behind in all but 2 of 17;
// wrong answers, and cards that aren't in any deck, had the next card within 1.7.)
const SURE_SCORE = 5.5;
const SURE_MARGIN = 2;

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

// Compare the card inside `quad` with the candidates' reference pictures.
// Returns [{ card, owner, score, emb, low }] best first, one per card name; score is how far the
// card stands out from the other reference pictures (embedder + low-res, in standard deviations).
async function matchCard(rgb, sw, sh, quad, candidates) {
  // The outline's long sides are the card's; it may still be upside down, so both ways are compared.
  const u = CF.uprightCorners(quad);
  const upright = warp(rgb, sw, sh, u);
  const turned = Buffer.alloc(upright.length);
  for (let i = 0, j = W * H - 1; i < W * H; i++, j--) {
    turned[j * 3] = upright[i * 3];
    turned[j * 3 + 1] = upright[i * 3 + 1];
    turned[j * 3 + 2] = upright[i * 3 + 2];
  }
  const vectors = await serial(() => embedRgb([upright, turned]));
  const I = integral(upright, W, H);
  const plain = [lowFeature(shrink(I)), lowFeature(shrink(I, 0, 0, 0, 0, true))];

  // Reference pictures to compare with: the candidates', plus others to judge the scores against.
  const pool = []; // { ref, name?, card?, owner?, art? }
  const seen = new Set();
  for (const { card, owner } of candidates) {
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    for (const art of arts[card.name]?.list || []) {
      const ref = refs.get(art.key);
      if (ref) pool.push({ ref, name: card.name, card, owner, art });
    }
  }
  const mine = pool.length;
  if (!mine) return [];
  const used = new Set(pool.map((p) => p.ref));
  const step = Math.max(1, Math.floor(refs.size / BACKGROUND));
  let n = 0;
  for (const ref of refs.values()) if (n++ % step === 0 && !used.has(ref)) pool.push({ ref });

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
    const [v] = await serial(() => embedRgb([again]));
    pool.forEach((p, i) => { for (const r of p.ref.emb) emb[i] = Math.max(emb[i], dot(v, r)); });
    embStats = stats(emb);
  }

  const best = new Map(); // name -> its best reference
  for (let i = 0; i < mine; i++) {
    const p = pool[i];
    const score = (emb[i] - embStats.mean) / embStats.sd + (low[i] - lowStats.mean) / lowStats.sd;
    if (!(best.get(p.name)?.score >= score)) best.set(p.name, { ...p, score, emb: emb[i], low: low[i] });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).map(({ card, owner, art, score, emb: e, low: l }) => ({
    // Show the printing that matched, so a sticker looks like the card on the table.
    card: { ...card, image: art.small || card.image, imageLarge: art.normal }, owner, score, emb: e, low: l,
  }));
}

const margin = (m) => (m[0] ? m[0].score - (m[1]?.score ?? -Infinity) : 0);

// ---------- identify ----------
// image: JPEG/PNG buffer of the area around the click. hint: click position inside it (0-1).
// candidates: [{ card, owner }] to match against (cards from the decks at the table).
// opts.size: the card's likely short side as a share of the picture's width (from the browser's
// card tracking), opts.log: false to keep this lookup out of the capture log, opts.note: extra
// fields for the log (who asked, at which table).
export async function identify(image, hint, candidates, opts = {}) {
  if (!modelsAvailable()) throw new Error('Recognition models are not installed on the server.');
  indexCards(candidates.map((c) => c.card)); // anything new gets learned in the background
  const { data: rgb, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const t0 = Date.now();
  const size = opts.size > 0.02 && opts.size < 0.9 ? opts.size * info.width : 0;
  const spot = await findCard(rgb, info.width, info.height, hint, size);
  const record = {
    ...opts.note, hint, size: opts.size || 0, width: info.width, height: info.height,
    candidates: [...new Set(candidates.map((c) => c.card.name))],
  };
  const log = (result, extra) => {
    const id = opts.log === false ? null : saveCapture(image, { ...record, ...result, ...extra });
    return id ? { ...result, id } : result;
  };
  if (!spot.card) return log({ found: false, runs: spot.runs, ms: Date.now() - t0, waiting: toIndex.size });

  let card = spot.card;
  let matches = await matchCard(rgb, info.width, info.height, card.quad, candidates);
  // Not a clear answer and the model had another outline in mind: see if that one reads better.
  const other = spot.others[0];
  if (other && (margin(matches) < SURE_MARGIN || !spot.sure)) {
    const second = await matchCard(rgb, info.width, info.height, other.quad, candidates);
    if (second[0] && second[0].score > (matches[0]?.score ?? -Infinity)) {
      matches = second;
      card = other;
    }
  }
  const top = matches[0];
  const result = {
    found: true,
    cardScore: card.score,
    underClick: CF.insideQuad([hint.x * info.width, hint.y * info.height], card.quad),
    quad: card.quad.map(([x, y]) => [x / info.width, y / info.height]),
    matches: matches.slice(0, 6).map((m) => ({ ...m, score: Math.round(m.score * 10) / 10 })),
    confident: !!top && top.score >= SURE_SCORE && margin(matches) >= SURE_MARGIN,
    // Nothing stands out: it may well not be in any loaded deck.
    weak: !!top && margin(matches) < 1,
    cardWidth: Math.round(card.a),
    waiting: toIndex.size,
    runs: spot.runs,
    ms: Date.now() - t0,
  };
  return log(result, {
    sureOutline: spot.sure,
    matches: matches.slice(0, 6).map((m) => ({ name: m.card.name, score: m.score, emb: m.emb, low: m.low, art: m.card.imageLarge })),
  });
}

export function cacheSize() {
  return refs.size;
}
