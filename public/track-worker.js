/* Card corner finder for card tracking, run in a worker so the page stays smooth.
   Same model the server uses for recognition (DETRPose, 4 corners per card), via onnxruntime-web.
   Messages in:  { t: 'load', code }  then  { t: 'detect', id, pixels (RGBA 640x640) }
   Messages out: { t: 'ready', ms } | { t: 'error', message } | { t: 'result', id, cards: [{ score, quad }], ms }
   Quads are 4 [x, y] points normalized 0-1 over the image that was sent. */
import * as ort from '/vendor/ort/ort.wasm.min.mjs';

const SIZE = 640;
let session = null;

ort.env.wasm.wasmPaths = '/vendor/ort/';
// Threads need a cross-origin isolated page; one thread keeps the player's CPU free for the call anyway.
ort.env.wasm.numThreads = 1;

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
  return Math.round(performance.now() - t0);
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
      self.postMessage({ t: 'ready', ms });
    } else if (m.t === 'detect') {
      const t0 = performance.now();
      const cards = await detect(m.pixels);
      self.postMessage({ t: 'result', id: m.id, cards, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ t: m.t === 'detect' ? 'result' : 'error', id: m.id, cards: [], message: String(err?.message || err) });
  }
};
