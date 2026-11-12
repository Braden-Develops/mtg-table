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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import '../public/cardfind.js';
import '../public/cardmatch.js';
import { DATA_DIR, ROOT } from '../scripts/lib.js';
import { artworks } from './scryfall.js';

const CF = globalThis.CardFind;
const CM = globalThis.CardMatch;
const { W, H, DIM, LOW, sampleInto, integral, shrink, lowFeature } = CM;
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
    const cards = found.filter((c) => c.score >= 0.3).map((c) => ({ ...CF.quadPose(c.quad), score: c.score }))
      .filter((p) => p.shape > 0.6);
    // The card the point is on (a clean outline there counts even when the finder is lukewarm
    // about it: a card in a fan of others); failing that, a clear card whose middle is close by.
    const dist = (p) => Math.hypot(p.cx - at[0], p.cy - at[1]);
    let card = cards.filter((p) => CF.insideQuad(at, p.quad) && (p.score >= 0.5 || p.shape > 0.85)).sort((p, q) => q.score - p.score)[0]
      || cards.filter((p) => p.score >= 0.5 && dist(p) < p.b * 0.75).sort((p, q) => dist(p) - dist(q))[0];
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
const BACKGROUND = 1500; // other reference pictures used to judge what an ordinary score is
// Sure enough to say "Match": this far above the other pictures, and this far ahead of the next card.
// (On real lookups: right answers were 5.6-11.3 with the next card 2.5+ behind in all but 2 of 17;
// wrong answers, and cards that aren't in any deck, had the next card within 1.7.)
const SURE_SCORE = 5.5;
const SURE_MARGIN = 2;

// Compare the card inside `quad` with the candidates' reference pictures.
// Returns [{ card, owner, score, emb, low }] best first, one per card name; score is how far the
// card stands out from the other reference pictures (embedder + low-res, in standard deviations).
async function matchCard(rgb, sw, sh, quad, candidates) {
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

  // The comparison itself is shared with the browser (public/cardmatch.js).
  const { emb, low, embStats, lowStats } = await CM.rank(rgb, sw, sh, quad, pool, mine, (pictures) => serial(() => embedRgb(pictures)));

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
  recent = { n: recent.n + 1, ms: recent.n ? recent.ms * 0.8 + result.ms * 0.2 : result.ms };
  return log(result, {
    sureOutline: spot.sure,
    matches: matches.slice(0, 6).map((m) => ({ name: m.card.name, score: m.score, emb: m.emb, low: m.low, art: m.card.imageLarge })),
  });
}

// ---------- for browsers that do the matching themselves ----------
// A browser that is faster than this server at lookups (the join page measures both) does them
// itself with the same code (public/cardmatch.js, public/match-worker.js). For that it needs the
// reference data of the cards in the decks at its table: this pack.
//   'MTGR' | json length (u32) | json | per reference: vectors as int8, a scale (f32), low-res feature as int8
// Vectors and features are cut from 32-bit floats to 8 bits (20 KB -> 5 KB a reference; a deck's
// pack is a few MB); fewer "other" references are sent than the server uses to judge scores.
const PACK_OTHERS = 400;
const packs = new Map(); // hash -> { hash, buffer, cards }

export function refPack(candidates) {
  const cards = []; // { name, owner, card }
  const rows = []; // per candidate reference: [index into cards, small picture, normal picture]
  const pool = [];
  const keys = [];
  const seen = new Set();
  for (const { card, owner } of candidates) {
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    let at = -1;
    for (const art of arts[card.name]?.list || []) {
      const ref = refs.get(art.key);
      if (!ref) continue;
      if (at < 0) {
        at = cards.push({
          name: card.name, owner,
          card: { type: 'card', name: card.name, scryfallId: card.scryfallId, typeLine: card.typeLine, image: card.image, imageLarge: card.imageLarge, power: card.power ?? '', toughness: card.toughness ?? '' },
        }) - 1;
      }
      pool.push(ref);
      rows.push([at, art.small || '', art.normal || '']);
      keys.push(art.key);
    }
  }
  const mine = pool.length;
  if (!mine) return null;
  const hash = crypto.createHash('sha1').update(`1|${keys.join(',')}|${cards.map((c) => c.owner).join(',')}`).digest('hex').slice(0, 16);
  const had = packs.get(hash);
  if (had) return had;
  const used = new Set(pool);
  const step = Math.max(1, Math.floor(refs.size / PACK_OTHERS));
  let n = 0;
  for (const ref of refs.values()) if (n++ % step === 0 && !used.has(ref)) pool.push(ref);

  const json = Buffer.from(JSON.stringify({ v: 1, mine, total: pool.length, renditions: RENDITIONS.length, dim: DIM, low: LOW, cards, rows }));
  const head = Buffer.alloc(8);
  head.write('MTGR', 0, 'ascii');
  head.writeUInt32LE(json.length, 4);
  const per = RENDITIONS.length * DIM + 4 + LOW;
  const body = Buffer.alloc(pool.length * per);
  pool.forEach((ref, i) => {
    let off = i * per;
    for (const v of ref.emb) for (let k = 0; k < DIM; k++) body.writeInt8(Math.max(-127, Math.min(127, Math.round(v[k] * 127))), off++);
    let max = 1e-9;
    for (let k = 0; k < LOW; k++) max = Math.max(max, Math.abs(ref.low[k]));
    body.writeFloatLE(max, off);
    off += 4;
    for (let k = 0; k < LOW; k++) body.writeInt8(Math.round((ref.low[k] / max) * 127), off++);
  });
  const pack = { hash, buffer: Buffer.concat([head, json, body]), cards: cards.length };
  packs.set(hash, pack);
  if (packs.size > 6) packs.delete(packs.keys().next().value);
  return pack;
}

// About how long one lookup takes here, in ms: the average of recent real ones, or before there
// are any, the models timed on blank pictures (they are about 60% of a lookup).
let recent = { n: 0, ms: 0 };
let dryRun = null;
export async function lookupMs() {
  if (recent.n >= 3) return Math.round(recent.ms);
  dryRun ??= (async () => {
    const { finder, embed } = await getSessions();
    const blank = (n) => new Float32Array(n).fill(0.4);
    const go = async () => {
      if (finder) await finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', blank(3 * FH * FW), [1, 3, FH, FW]) });
      await embed.run({ input: new ort.Tensor('float32', blank(2 * 3 * H * W), [2, 3, H, W]) });
      await embed.run({ input: new ort.Tensor('float32', blank(3 * H * W), [1, 3, H, W]) });
    };
    await serial(go);
    const t = performance.now();
    await serial(go);
    return Math.round((performance.now() - t) / 0.6);
  })().catch(() => null);
  return dryRun;
}

export function cacheSize() {
  return refs.size;
}
