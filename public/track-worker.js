/* Card corner finder for card tracking, run in a worker so the page stays smooth.
   Same model the server uses for recognition (DETRPose, 4 corners per card), via onnxruntime-web.
   Messages in:  { t: 'load', code }  then  { t: 'detect', id, pixels (RGBA 640x640) }
   Messages out: { t: 'ready', ms } | { t: 'error', message } | { t: 'result', id, cards: [{ score, quad }], ms }
   Quads are 4 [x, y] points normalized 0-1 over the image that was sent. */
import * as ort from '/vendor/ort/ort.wasm.min.mjs';

const SIZE = 640;
let session = null;
let finder = null; // the whole-picture card finder (models/card_finder.onnx), if the server has it
const FW = 640; // its input: a 16:9 picture at 640x360, padded to 640x384
const FH = 384;
const FPIC = 360;

ort.env.wasm.wasmPaths = '/vendor/ort/';
// One thread. Several (which need a cross-origin isolated page) made a look three times faster in
// testing, but after a few minutes a look would never come back and card reading stopped.
const THREADS = 1;
ort.env.wasm.numThreads = THREADS;

async function fetchModel(file, code) {
  const res = await fetch(`/api/models/${file}?code=${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`model ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function load(code) {
  const t0 = performance.now();
  const [model, data] = await Promise.all([fetchModel('pose.onnx', code), fetchModel('mtg_4kp_s_r4b.onnx.data', code)]);
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: 'mtg_4kp_s_r4b.onnx.data', data }],
  });
  // The card finder is optional: without it, cards are found by pointing the corner model at guesses.
  try {
    finder = await ort.InferenceSession.create(await fetchModel('cards.onnx', code), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  } catch { finder = null; }
  return Math.round(performance.now() - t0);
}

// Every card in a 640x360 picture (RGBA). Resolves with [{ score, quad }]: corners 0-1 over the
// picture, in the card's own order (its top-left first), so the quad also says which way up it is.
async function scan(pixels) {
  const plane = FW * FH;
  const input = new Float32Array(3 * plane).fill(114 / 255);
  const top = (FH - FPIC) / 2;
  for (let y = 0; y < FPIC; y++) {
    for (let x = 0; x < FW; x++) {
      const i = (y * FW + x) * 4;
      const o = (y + top) * FW + x;
      input[o] = pixels[i] / 255;
      input[plane + o] = pixels[i + 1] / 255;
      input[2 * plane + o] = pixels[i + 2] / 255;
    }
  }
  const out = await finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, FH, FW]) });
  const t = out[finder.outputNames[0]];
  const d = t.data;
  const n = t.dims[2]; // rows: cx, cy, w, h, score, then x, y, visibility for each corner
  const found = [];
  for (let k = 0; k < n; k++) {
    const score = d[4 * n + k];
    if (score < 0.25) continue;
    const cx = d[k];
    const cy = d[n + k];
    const w = d[2 * n + k];
    const h = d[3 * n + k];
    found.push({
      score, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      quad: [0, 1, 2, 3].map((c) => [d[(5 + 3 * c) * n + k] / FW, (d[(6 + 3 * c) * n + k] - top) / FPIC]),
    });
  }
  // Keep the best of each group of overlapping boxes.
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of found) {
    const overlaps = kept.some((o) => {
      const iw = Math.min(c.box[2], o.box[2]) - Math.max(c.box[0], o.box[0]);
      const ih = Math.min(c.box[3], o.box[3]) - Math.max(c.box[1], o.box[1]);
      if (iw <= 0 || ih <= 0) return false;
      const inter = iw * ih;
      const union = (c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) + (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) - inter;
      return inter / union > 0.5;
    });
    if (!overlaps) kept.push(c);
  }
  return kept.map((c) => ({ score: c.score, quad: c.quad }));
}

async function detect(pixels) {
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = pixels[i * 4] / 255;
    input[plane + i] = pixels[i * 4 + 1] / 255;
    input[2 * plane + i] = pixels[i * 4 + 2] / 255;
  }
  const out = await session.run({ image: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const scores = out.scores.data;
  const kps = out.keypoints.data;
  const cards = [];
  for (let q = 0; q < scores.length; q++) {
    const score = 1 / (1 + Math.exp(-scores[q]));
    if (score < 0.3) continue;
    cards.push({ score, quad: [0, 1, 2, 3].map((k) => [kps[(q * 4 + k) * 2], kps[(q * 4 + k) * 2 + 1]]) });
  }
  return cards;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.t === 'load') {
      const ms = await load(m.code);
      self.postMessage({ t: 'ready', ms, threads: THREADS, finder: !!finder });
    } else if (m.t === 'scan') {
      const t0 = performance.now();
      const cards = finder ? await scan(m.pixels) : [];
      self.postMessage({ t: 'result', id: m.id, cards, ms: Math.round(performance.now() - t0), scan: true });
    } else if (m.t === 'detect') {
      const t0 = performance.now();
      const cards = await detect(m.pixels);
      self.postMessage({ t: 'result', id: m.id, cards, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ t: m.t === 'load' ? 'error' : 'result', id: m.id, cards: [], message: String(err?.message || err) });
  }
};
