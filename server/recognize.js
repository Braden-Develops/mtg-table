// Card recognition.
//  1. Corner finder (DETRPose, MIT, dhvazquez/mtg_card_pose_estimation) finds the card's 4 corners.
//  2. We straighten the card to 320x448 with a perspective warp.
//  3. Embedder (EfficientNet-Lite0, MIT, dhvazquez/mtg_card_identification_embeddings) turns it into
//     a 256-number vector. The closest vector among the decks at the table is the answer.
// Reference vectors come from Scryfall's card images (every artwork of each deck card) and are
// cached in data/embeddings-v3.bin.
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { DATA_DIR, ROOT } from '../scripts/lib.js';
import { artworks } from './scryfall.js';

const POSE_MODEL = path.join(ROOT, 'models', 'mtg_4kp_s_r4b.onnx');
const EMBED_MODEL = path.join(ROOT, 'models', 'mtg_embed_fp32.onnx');
const CACHE_FILE = path.join(DATA_DIR, 'embeddings-v3.bin');
const KEY = 48; // bytes per record key: '<scryfall id>/<face>@<size>'
const W = 320;
const H = 448;
const DIM = 256;
const POSE_SIZE = 640;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessions = null;
let queue = Promise.resolve(); // one model run at a time keeps memory and CPU predictable
const embeddings = loadCache(); // '<scryfallId>/<face>' -> Float32Array(256)
let cacheDirty = false;

export function modelsAvailable() {
  return fs.existsSync(POSE_MODEL) && fs.existsSync(EMBED_MODEL);
}

async function getSessions() {
  if (!sessions) {
    const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: 2 };
    sessions = {
      pose: await ort.InferenceSession.create(POSE_MODEL, opts),
      embed: await ort.InferenceSession.create(EMBED_MODEL, opts),
    };
  }
  return sessions;
}

function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- embedding cache (binary: [40-byte key][256 float32] repeated) ----------
function loadCache() {
  const map = new Map();
  try {
    const buf = fs.readFileSync(CACHE_FILE);
    const rec = KEY + DIM * 4;
    for (let off = 0; off + rec <= buf.length; off += rec) {
      const id = buf.toString('ascii', off, off + KEY).trimEnd();
      const vec = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) vec[i] = buf.readFloatLE(off + KEY + i * 4);
      map.set(id, vec);
    }
  } catch { /* no cache yet */ }
  return map;
}

function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const rec = KEY + DIM * 4;
  const buf = Buffer.alloc(embeddings.size * rec);
  let off = 0;
  for (const [id, vec] of embeddings) {
    buf.write(id.padEnd(KEY).slice(0, KEY), off, 'ascii');
    for (let i = 0; i < DIM; i++) buf.writeFloatLE(vec[i], off + KEY + i * 4);
    off += rec;
  }
  fs.writeFile(CACHE_FILE, buf, () => {});
}

// ---------- image helpers ----------
// RGB bytes (W x H) -> normalized NCHW float tensor for the embedder.
function toEmbedTensor(rgb) {
  const plane = W * H;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) data[c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return new ort.Tensor('float32', data, [1, 3, H, W]);
}

async function embedRgb(rgb) {
  const { embed } = await getSessions();
  const out = await embed.run({ input: toEmbedTensor(rgb) });
  const v = Float32Array.from(out.embedding.data);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
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

// Warp the quad `corners` ([TL,TR,BR,BL] in source pixels) of an RGB image to W x H.
function warp(rgb, sw, sh, corners) {
  const dst = [[0, 0], [W, 0], [W, H], [0, H]];
  const m = homography(dst, corners); // maps output pixel -> source pixel
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = m[6] * px + m[7] * py + m[8];
      const sx = (m[0] * px + m[1] * py + m[2]) / d - 0.5;
      const sy = (m[3] * px + m[4] * py + m[5]) / d - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * sw + x0) * 3 + c];
        const bq = rgb[(y0 * sw + x1) * 3 + c];
        const cq = rgb[(y1 * sw + x0) * 3 + c];
        const dq = rgb[(y1 * sw + x1) * 3 + c];
        out[o + c] = (a * (1 - fx) + bq * fx) * (1 - fy) + (cq * (1 - fx) + dq * fx) * fy;
      }
    }
  }
  return out;
}

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

// ---------- corner finding ----------
// Run the corner model on a region of the image; returns cards with corners in full-image pixels.
async function runPose(rgb, sw, sh, region = { left: 0, top: 0, width: sw, height: sh }) {
  const { pose } = await getSessions();
  const resized = await sharp(rgb, { raw: { width: sw, height: sh, channels: 3 } })
    .extract(region)
    .resize(POSE_SIZE, POSE_SIZE, { fit: 'fill', kernel: 'linear' })
    .raw()
    .toBuffer();
  const plane = POSE_SIZE * POSE_SIZE;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) data[c * plane + i] = resized[i * 3 + c] / 255;
  const out = await pose.run({ image: new ort.Tensor('float32', data, [1, 3, POSE_SIZE, POSE_SIZE]) });
  const scores = out.scores.data;
  const kps = out.keypoints.data;
  const found = [];
  for (let q = 0; q < scores.length; q++) {
    const score = 1 / (1 + Math.exp(-scores[q]));
    if (score < 0.3) continue;
    const quad = [0, 1, 2, 3].map((k) => [
      region.left + kps[(q * 4 + k) * 2] * region.width,
      region.top + kps[(q * 4 + k) * 2 + 1] * region.height,
    ]);
    found.push({ score, quad });
  }
  return found;
}

const centre = (quad) => [quad.reduce((s, p) => s + p[0], 0) / 4, quad.reduce((s, p) => s + p[1], 0) / 4];

// The outline found is often the sleeve, with a dark border around the card. Also try the outline
// pulled in a little on every side, and keep whichever matches better.
const INSETS = (process.env.RECOG_INSETS || '0').split(',').map(Number);
function inset(quad, f) {
  if (!f) return quad;
  const [cx, cy] = centre(quad);
  // Pull each corner towards the centre; for a rectangle this trims the same share off each side.
  return quad.map(([x, y]) => [x + (cx - x) * f * 2, y + (cy - y) * f * 2]);
}

// How card-like a quad is: 1 for a perfect 63x88 rectangle, lower for odd shapes.
function shapeScore(quad) {
  const c = sortCorners(quad);
  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const s = [len(c[0], c[1]), len(c[1], c[2]), len(c[2], c[3]), len(c[3], c[0])];
  const sideA = (s[0] + s[2]) / 2;
  const sideB = (s[1] + s[3]) / 2;
  if (!sideA || !sideB) return 0;
  const parallel = Math.min(s[0], s[2]) / Math.max(s[0], s[2]) * (Math.min(s[1], s[3]) / Math.max(s[1], s[3]));
  const aspect = Math.min(sideA, sideB) / Math.max(sideA, sideB);
  // Bare cards are 0.72 wide-to-tall; sleeved ones a bit squarer (the outline is often the sleeve).
  return parallel * Math.max(0, 1 - Math.max(0, Math.abs(aspect - 0.75) - 0.08) * 4);
}

export async function findCard(rgb, sw, sh, hint) {
  const hintPx = [hint.x * sw, hint.y * sh];
  // Prefer the card under the click, then the best-shaped, then the most confident.
  const rank = (list) => list
    .map((f) => ({ ...f, under: insideQuad(hintPx, f.quad), shape: shapeScore(f.quad) }))
    .sort((a, b) => (b.under - a.under) || (b.shape * b.score - a.shape * a.score));
  let found = rank(await runPose(rgb, sw, sh));

  // No card, or a lopsided one: look again with the picture turned around, and zoomed in on the click.
  if (!found[0] || !found[0].under || found[0].shape < 0.75) {
    const flipped = await sharp(rgb, { raw: { width: sw, height: sh, channels: 3 } }).rotate(180).raw().toBuffer();
    const more = (await runPose(flipped, sw, sh)).map((f) => ({ ...f, quad: f.quad.map(([x, y]) => [sw - x, sh - y]) }));
    const zoom = async ([cx, cy], frac) => {
      const side = Math.round(Math.min(sw, sh) * frac);
      const left = Math.round(Math.max(0, Math.min(sw - side, cx - side / 2)));
      const top = Math.round(Math.max(0, Math.min(sh - side, cy - side / 2)));
      more.push(...await runPose(rgb, sw, sh, { left, top, width: side, height: side }));
    };
    await zoom(hintPx, 0.7);
    found = rank([...found, ...more]);
  }
  if (found.length === 0) return null;
  return { score: found[0].score, quad: found[0].quad, underClick: found[0].under, shape: found[0].shape };
}

// The card may be upright, tapped either way or upside down: try all four turns.
// (A wrong turn squashes the card, so it never wins against the right one.)
function orientations(quad) {
  const c = sortCorners(quad);
  return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((k) => c[(k + r) % 4]));
}

// ---------- reference cards ----------
// A player's copy can be any printing, so every artwork of each deck card gets a reference vector
// (the deck's own printing first). Artwork lists are cached in data/arts.json.
const ARTS_FILE = path.join(DATA_DIR, 'arts.json');
const MAX_ARTS = 16;
let arts = {};
try { arts = JSON.parse(fs.readFileSync(ARTS_FILE, 'utf8')); } catch { /* none yet */ }
const toIndex = new Map(); // card name -> card, waiting for the background indexer
let indexing = null;

// The embedder is very sensitive to sharpness: a card 160 px wide on camera scores poorly against
// a crisp Scryfall scan. So each artwork is also stored as it would look at a few camera sizes,
// and a lookup compares against the size closest to how big the card appears.
const SIZES = [
  { id: 's110', width: 110, blur: 0 },
  { id: 's160', width: 160, blur: 0.8 },
  { id: 's220', width: 220, blur: 0.6 },
  { id: 'full', width: 0, blur: 0 },
];
const sizeFor = (cardWidth) => (cardWidth < 135 ? 's110' : cardWidth < 190 ? 's160' : cardWidth < 270 ? 's220' : 'full');
const refKey = (art, size) => `${art.key}@${size}`;

const okImage = (u) => typeof u === 'string' && u.startsWith('https://cards.scryfall.io/');
const indexed = (card) => arts[card.name]?.every((a) => SIZES.every((s) => embeddings.has(refKey(a, s.id))));

async function indexArt(art) {
  const res = await fetch(art.normal, { headers: { 'User-Agent': 'MTGTable/0.1 (private game table)' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const base = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().resize(W, H, { fit: 'fill' }).toBuffer();
  for (const size of SIZES) {
    if (embeddings.has(refKey(art, size.id))) continue;
    let img = sharp(base);
    if (size.width) img = sharp(await sharp(base).resize(size.width).toBuffer()).resize(W, H, { fit: 'fill' });
    if (size.blur) img = img.blur(size.blur);
    const rgb = await img.removeAlpha().raw().toBuffer();
    embeddings.set(refKey(art, size.id), await serial(() => embedRgb(rgb)));
  }
}

async function indexOne(card) {
  if (!arts[card.name]) {
    const own = okImage(card.imageLarge) ? [{ key: `${card.scryfallId}/0`, small: card.image, normal: card.imageLarge }] : [];
    let more = [];
    try { more = await artworks(card.name, MAX_ARTS); } catch { /* offline: own printing only */ }
    const list = [...own, ...more].filter((x, i, all) => okImage(x.normal) && all.findIndex((y) => y.key === x.key) === i);
    arts[card.name] = list.slice(0, MAX_ARTS + 1);
    fs.writeFile(ARTS_FILE, JSON.stringify(arts), () => {});
  }
  for (const art of arts[card.name]) {
    if (SIZES.every((s) => embeddings.has(refKey(art, s.id)))) continue;
    try {
      await indexArt(art);
      cacheDirty = true;
    } catch (err) {
      console.warn('Could not index', card.name, err.message);
    }
    await new Promise((r) => setTimeout(r, 60)); // be gentle with Scryfall's image servers
  }
}

async function runIndexer() {
  let n = 0;
  while (toIndex.size) {
    const [name, card] = toIndex.entries().next().value;
    await indexOne(card);
    toIndex.delete(name);
    if (++n % 10 === 0) saveCache();
  }
  saveCache();
}

// Queue cards for indexing in the background (after a deck loads, and at startup). Resolves when done.
export function indexCards(cards) {
  if (!modelsAvailable()) return Promise.resolve();
  for (const card of cards) if (card?.name && !indexed(card)) toIndex.set(card.name, card);
  if (!indexing) indexing = runIndexer().finally(() => { indexing = null; });
  return indexing;
}

export function indexStatus() {
  return { waiting: toIndex.size };
}

// While tuning: keep the last few lookups (crop, straightened card, top matches) in data/identify-debug.
const DEBUG_DIR = process.env.RECOG_DEBUG === '0' ? null : path.join(DATA_DIR, 'identify-debug');
async function saveDebug(image, warps, card, top) {
  const dir = path.join(DEBUG_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crop.jpg'), image);
  for (let i = 0; i < warps.length; i++) {
    await sharp(warps[i], { raw: { width: W, height: H, channels: 3 } }).jpeg().toFile(path.join(dir, `turn${i}.jpg`));
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    cardScore: card.score, underClick: card.underClick, quad: card.quad, size: card.size, cardWidth: card.cardWidth,
    top: top.map((m) => ({ name: m.card.name, score: m.score, art: m.card.imageLarge })),
  }, null, 1));
  const old = fs.readdirSync(DEBUG_DIR).sort().slice(0, -20);
  for (const d of old) fs.rmSync(path.join(DEBUG_DIR, d), { recursive: true, force: true });
}

// ---------- identify ----------
// image: JPEG/PNG buffer of the area around the click. hint: click position inside it (0-1).
// candidates: [{ card, owner }] to match against (cards from the decks at the table).
export async function identify(image, hint, candidates) {
  if (!modelsAvailable()) throw new Error('Recognition models are not installed on the server.');
  indexCards(candidates.map((c) => c.card)); // anything new gets learned in the background
  const { data: rgb, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const t0 = Date.now();
  const card = await serial(() => findCard(rgb, info.width, info.height, hint));
  if (!card) {
    if (DEBUG_DIR) saveDebug(image, [], { score: 0, underClick: false, quad: [] }, []).catch(() => {});
    return { found: false, ms: Date.now() - t0, waiting: toIndex.size };
  }

  const vectors = [];
  const warps = [];
  for (const q of orientations(card.quad).flatMap((o) => INSETS.map((f) => inset(o, f)))) {
    const warped = warp(rgb, info.width, info.height, q);
    warps.push(warped);
    vectors.push(await serial(() => embedRgb(warped)));
  }

  // How wide the card is on camera (its short side, in pixels) picks the reference size.
  const [a, b, c2, d] = card.quad;
  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const cardWidth = Math.min(len(a, b) + len(c2, d), len(b, c2) + len(d, a)) / 2;
  const size = sizeFor(cardWidth);

  const seen = new Set();
  const scored = [];
  for (const { card: c, owner } of candidates) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    let best = null;
    for (const art of arts[c.name] || []) {
      const ref = embeddings.get(refKey(art, size));
      if (!ref) continue;
      const score = Math.max(...vectors.map((v) => dot(v, ref)));
      if (!best || score > best.score) best = { score, art };
    }
    // Show the printing that matched, so a sticker looks like the card on the table.
    if (best) scored.push({ card: { ...c, image: best.art.small, imageLarge: best.art.normal }, owner, score: best.score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (DEBUG_DIR) saveDebug(image, warps, { ...card, size, cardWidth }, scored.slice(0, 6)).catch(() => {});
  return {
    found: true,
    cardScore: card.score,
    underClick: card.underClick,
    quad: card.quad.map(([x, y]) => [x / info.width, y / info.height]),
    matches: scored.slice(0, 6),
    cardWidth: Math.round(cardWidth),
    size,
    waiting: toIndex.size,
    ms: Date.now() - t0,
  };
}

// For tests: embed a straightened card image directly.
export async function embedImage(image) {
  const rgb = await sharp(image).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
  return serial(() => embedRgb(rgb));
}

export function cacheSize() {
  return embeddings.size;
}
