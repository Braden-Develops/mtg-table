// Check the browser's way of matching cards against the server's, on the saved lookups.
// A browser that is faster than the server matches cards itself (public/match-worker.js) with
// public/cardmatch.js, a reference pack cut down to 8 bits, and fewer "other" references. This
// runs that same code here (with this machine's model runtime) and compares the answers.
//   node scripts/recog-local-check.js
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { DATA_DIR, ROOT } from './lib.js';
import { identify, indexCards, refPack } from '../server/recognize.js';

const CM = globalThis.CardMatch;
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const cases = [];
for (const folder of ['identify-fixtures', 'identify-log']) {
  const root = path.join(DATA_DIR, folder);
  if (!fs.existsSync(root)) continue;
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    const label = read(path.join(dir, 'label.json'));
    const result = read(path.join(dir, 'result.json'));
    if (!label?.name || label.how === 'open' || label.how === 'auto' || !result?.candidates?.length) continue;
    cases.push({ id, dir, name: label.name, result });
  }
}
const names = [...new Set(cases.flatMap((c) => c.result.candidates))];
await indexCards(names.map((name) => ({ name })));
const candidates = names.map((name) => ({ card: { name }, owner: '' }));
const packed = refPack(candidates);
const pack = CM.unpack(packed.buffer.buffer.slice(packed.buffer.byteOffset, packed.buffer.byteOffset + packed.buffer.length));
console.log(`${cases.length} lookups; pack: ${pack.meta.mine} references of ${pack.meta.cards.length} cards + ${pack.meta.total - pack.meta.mine} others, ${(packed.buffer.length / 1e6).toFixed(1)} MB`);

const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: 1 };
const finder = await ort.InferenceSession.create(path.join(ROOT, 'cardfinder', 'card_finder.onnx'), opts);
const embedder = await ort.InferenceSession.create(path.join(ROOT, 'models', 'mtg_embed_fp32.onnx'), opts);
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const runFinder = async (data) => {
  const out = await finder.run({ [finder.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, CM.FH, CM.FW]) });
  const t = out[finder.outputNames[0]];
  return { data: t.data, n: t.dims[2] };
};
const embed = async (pictures) => {
  const plane = CM.W * CM.H;
  const data = new Float32Array(pictures.length * 3 * plane);
  pictures.forEach((rgb, n) => {
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) data[n * 3 * plane + c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  });
  const out = await embedder.run({ input: new ort.Tensor('float32', data, [pictures.length, 3, CM.H, CM.W]) });
  return pictures.map((_, n) => {
    const v = Float32Array.from(out.embedding.data.subarray(n * CM.DIM, (n + 1) * CM.DIM));
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
  });
};

const tally = { server: 0, local: 0, same: 0, localSure: 0, serverSure: 0, wrongSure: 0, ms: 0 };
for (const c of cases) {
  const image = fs.readFileSync(path.join(c.dir, 'crop.jpg'));
  const hint = c.result.hint || { x: 0.5, y: 0.5 };
  const s = await identify(image, hint, candidates, { size: c.result.size || 0, log: false });
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const l = await CM.lookup(data, info.width, info.height, hint, pack, runFinder, embed);
  const want = c.name === 'NONE' ? null : c.name;
  const st = s.matches?.[0];
  const lt = l.matches?.[0];
  if (want) {
    if (st?.card.name === want) tally.server++;
    if (lt?.card.name === want) tally.local++;
    if (st?.card.name === lt?.card.name) tally.same++;
    if (s.confident && st?.card.name === want) tally.serverSure++;
    if (l.confident && lt?.card.name === want) tally.localSure++;
    if (l.confident && lt?.card.name !== want) tally.wrongSure++;
  } else if (l.found && l.confident) tally.wrongSure++;
  tally.ms += l.ms;
  if (want && (lt?.card.name !== want || Math.abs((lt?.score ?? 0) - (st?.score ?? 0)) > 1.5)) {
    console.log(`  ${want.padEnd(26)} server ${st ? `${st.card.name} ${st.score}` : '-'}  |  browser way ${lt ? `${lt.card.name} ${lt.score}` : l.found ? 'no match' : 'no card'}`);
  }
}
const n = cases.filter((c) => c.name !== 'NONE').length;
console.log(`Right card first: server ${tally.server} of ${n}, browser way ${tally.local} of ${n} (same top card ${tally.same})`);
console.log(`Sure and right: server ${tally.serverSure}, browser way ${tally.localSure}; browser way wrong but sure: ${tally.wrongSure}`);
console.log(`Browser way: ${Math.round(tally.ms / cases.length)} ms a lookup on one thread of this machine (a browser is about twice as slow).`);
process.exit(0);
