/* Card matching in the browser, for players whose computer does a lookup faster than the server
   (localmatch.js measures both on the join page and decides). The same steps the server takes,
   with the same code (cardmatch.js): the card finder outlines the card in the picture, the
   embedding model and a low-resolution comparison say which deck card it is.
   Messages in:  { t: 'init', code, files: [{ name, bytes, v }] }   download (or load from this
                                                                    browser's cache) and start the models
                 { t: 'bench' }                                     time a lookup's worth of model runs
                 { t: 'refs', code, hash }                          fetch the reference pack for the table's decks
                 { t: 'identify', id, pixels (RGBA), w, h, hint }   one lookup
   Messages out: { t: 'progress', done, total, cached } | { t: 'ready', ms } | { t: 'bench', ms }
                 | { t: 'refs', cards, references } | { t: 'result', id, result } | { t: 'error', what, message } */
import * as ort from '/vendor/ort/ort.webgpu.min.mjs';
import '/static/cardfind.js';
import '/static/cardmatch.js';

const CM = globalThis.CardMatch;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const CACHE = 'mtg-table-models-1';

ort.env.wasm.wasmPaths = '/vendor/ort/';
ort.env.wasm.numThreads = 1;

let finder = null;
let embedder = null;
let pack = null;

// A model file: from this browser's own cache if it has this version, else downloaded and kept.
// (The files are about 40 MB together and never change between visits.)
async function modelFile(file, code, progress) {
  const key = `/cached-model/${file.name}?v=${file.v}`;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no cache storage here: download each time */ }
  const kept = await cache?.match(key);
  if (kept) {
    const data = new Uint8Array(await kept.arrayBuffer());
    progress(data.length, true);
    return data;
  }
  const res = await fetch(`/api/models/${file.name}?code=${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`${file.name}: ${res.status}`);
  const data = new Uint8Array(file.bytes);
  const reader = res.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    data.set(value, at);
    at += value.length;
    progress(value.length, false);
  }
  if (cache) {
    // Older versions of this file are no use any more.
    for (const req of await cache.keys()) if (new URL(req.url).pathname === `/cached-model/${file.name}`) await cache.delete(req);
    await cache.put(key, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  }
  return data;
}

async function init(code, files) {
  const t0 = performance.now();
  const total = files.reduce((s, f) => s + f.bytes, 0);
  let done = 0;
  let fromCache = true;
  const progress = (n, cached) => {
    done += n;
    if (!cached) fromCache = false;
    self.postMessage({ t: 'progress', done, total, cached: fromCache });
  };
  const data = {};
  for (const f of files) data[f.name] = await modelFile(f, code, progress);
  // On the graphics card where the browser has WebGPU (many times faster than one CPU thread);
  // otherwise, or if a model won't load there, on the CPU.
  const make = async (bytes, extra = {}) => {
    if (self.navigator?.gpu) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', ...extra });
        return { session, on: 'graphics card' };
      } catch { /* fall through to the CPU */ }
    }
    return { session: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...extra }), on: 'processor' };
  };
  const f = await make(data['cards.onnx']);
  const e = await make(data['embed.onnx'], { externalData: [{ path: 'mtg_embed_fp32.onnx.data', data: data['mtg_embed_fp32.onnx.data'] }] });
  finder = f.session;
  embedder = e.session;
  return { ms: Math.round(performance.now() - t0), cached: fromCache, on: f.on === e.on ? e.on : `${e.on} (finder: ${f.on})` };
}

async function runFinder(data) {
  const out = await finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, CM.FH, CM.FW]) });
  const t = out[finder.outputNames[0]];
  return { data: await t.getData(), n: t.dims[2] };
}

// RGB pictures (320x448 each) -> unit vectors, in one run.
async function embed(pictures) {
  const plane = CM.W * CM.H;
  const data = new Float32Array(pictures.length * 3 * plane);
  pictures.forEach((rgb, n) => {
    const at = n * 3 * plane;
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) data[at + c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  });
  const out = await embedder.run({ input: new ort.Tensor('float32', data, [pictures.length, 3, CM.H, CM.W]) });
  const all = await out.embedding.getData();
  return pictures.map((_, n) => {
    const v = Float32Array.from(all.subarray(n * CM.DIM, (n + 1) * CM.DIM));
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  });
}

// A lookup's worth of model runs on blank pictures. The models are about 60% of a lookup (measured
// on the server, which reports its own time the same way), so the two figures compare like for like.
async function bench() {
  const blank = (n) => new Float32Array(n).fill(0.4);
  const go = async () => {
    await finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', blank(3 * CM.FH * CM.FW), [1, 3, CM.FH, CM.FW]) });
    await embedder.run({ input: new ort.Tensor('float32', blank(2 * 3 * CM.H * CM.W), [2, 3, CM.H, CM.W]) });
    await embedder.run({ input: new ort.Tensor('float32', blank(3 * CM.H * CM.W), [1, 3, CM.H, CM.W]) });
  };
  await go(); // the first run of a model is slower
  if (pack) {
    // With the table's references here: a whole lookup on a made-up picture (the finder's look,
    // then the comparison with every reference), which is what a real one costs.
    const side = 800;
    const rgb = new Uint8Array(side * side * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 2654435761) >>> 24;
    const quad = [[260, 200], [540, 200], [540, 592], [260, 592]];
    const t = performance.now();
    await runFinder(CM.finderInput(rgb, side, side).data);
    await CM.rank(rgb, side, side, quad, pack.pool, pack.meta.mine, embed);
    return Math.round(performance.now() - t);
  }
  const t = performance.now();
  await go();
  return Math.round((performance.now() - t) / 0.6);
}

// One thing at a time: the models aren't run side by side.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(async () => {
    try {
      if (m.t === 'init') self.postMessage({ t: 'ready', ...(await init(m.code, m.files)) });
      else if (m.t === 'bench') self.postMessage({ t: 'bench', ms: await bench() });
      else if (m.t === 'refs') {
        const res = await fetch(`/api/refs?code=${encodeURIComponent(m.code)}&h=${m.hash}`);
        if (!res.ok) throw new Error(`references: ${res.status}`);
        pack = CM.unpack(await res.arrayBuffer());
        self.postMessage({ t: 'refs', hash: m.hash, cards: pack.meta.cards.length, references: pack.meta.mine });
      } else if (m.t === 'identify') {
        if (!pack) throw new Error('no references yet');
        const rgb = new Uint8Array(m.w * m.h * 3);
        for (let i = 0, j = 0; i < m.pixels.length; i += 4, j += 3) {
          rgb[j] = m.pixels[i];
          rgb[j + 1] = m.pixels[i + 1];
          rgb[j + 2] = m.pixels[i + 2];
        }
        self.postMessage({ t: 'result', id: m.id, result: await CM.lookup(rgb, m.w, m.h, m.hint, pack, runFinder, embed) });
      }
    } catch (err) {
      self.postMessage({ t: m.t === 'identify' ? 'result' : 'error', id: m.id, what: m.t, result: null, message: String(err?.message || err) });
    }
  });
};
