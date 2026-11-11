// Measure card recognition on real pictures: runs every logged lookup that has a known answer
// through the current code again and reports how many it gets right.
//   node scripts/recog-replay.js            all labelled lookups
//   node scripts/recog-replay.js -v         also print each lookup's top matches
// Pictures come from data/identify-log/ (every lookup; the answer is what the player picked) and
// data/identify-fixtures/ (same layout, never pruned: copy lookups worth keeping there).
// Each is a folder with crop.jpg, result.json ({ hint, size, candidates: [names] }) and
// label.json ({ name }): the card it really was, "NONE" if there was no card, or null/absent if unknown.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './lib.js';
import { identify, indexCards } from '../server/recognize.js';

const verbose = process.argv.includes('-v');
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

const cases = [];
for (const folder of ['identify-fixtures', 'identify-log']) {
  const root = path.join(DATA_DIR, folder);
  if (!fs.existsSync(root)) continue;
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    const label = read(path.join(dir, 'label.json'));
    const result = read(path.join(dir, 'result.json'));
    // Only answers the player vouched for (placed the card, or said yes), not just opened to look at.
    if (!label?.name || label.how === 'open' || !result?.candidates?.length || !fs.existsSync(path.join(dir, 'crop.jpg'))) continue;
    cases.push({ id: `${folder === 'identify-log' ? 'log' : 'fix'}/${id}`, dir, name: label.name, result });
  }
}
if (!cases.length) {
  console.log('No labelled lookups yet. They collect in data/identify-log as players use Identify and place a card.');
  process.exit(0);
}

const names = [...new Set(cases.flatMap((c) => c.result.candidates))];
console.log(`${cases.length} labelled lookups, ${names.length} cards. Fetching any missing reference pictures...`);
await indexCards(names.map((name) => ({ name })));

const tally = { right: 0, sure: 0, wrongSure: 0, noCard: 0, ms: 0, runs: 0 };
const none = { n: 0, quiet: 0 };
for (const c of cases) {
  const image = fs.readFileSync(path.join(c.dir, 'crop.jpg'));
  const hint = c.result.hint || { x: 0.5, y: 0.5 };
  const candidates = c.result.candidates.map((name) => ({ card: { name }, owner: '' }));
  const r = await identify(image, hint, candidates, { size: c.result.size || 0, log: false });
  const top = r.matches?.[0];
  let verdict;
  if (c.name === 'NONE') {
    none.n++;
    const quiet = !r.found || !r.confident;
    if (quiet) none.quiet++;
    verdict = quiet ? 'ok (no card)' : 'FALSE MATCH';
  } else {
    const right = top?.card.name === c.name;
    if (right) tally.right++;
    if (right && r.confident) tally.sure++;
    if (!right && r.confident) tally.wrongSure++;
    if (!r.found) tally.noCard++;
    verdict = !r.found ? 'NO CARD FOUND' : right ? (r.confident ? 'ok' : 'ok (unsure)') : r.confident ? 'WRONG AND SURE' : 'wrong';
  }
  tally.ms += r.ms;
  tally.runs += r.runs || 0;
  if (verbose || !verdict.startsWith('ok')) {
    const tops = (r.matches || []).slice(0, 3).map((m) => `${m.card.name} ${m.score}`).join(', ');
    console.log(`${verdict.padEnd(15)} ${c.name.padEnd(28)} ${String(r.ms).padStart(5)} ms ${String(r.runs ?? '-').padStart(2)} looks  ${tops}  [${c.id}]`);
  }
}
const cards = cases.length - none.n;
console.log(`\nRight card first: ${tally.right} of ${cards}   shown as a sure "Match": ${tally.sure}   wrong but shown as sure: ${tally.wrongSure}   no card found: ${tally.noCard}`);
if (none.n) console.log(`Pictures without a card: ${none.quiet} of ${none.n} correctly not matched`);
console.log(`Average ${Math.round(tally.ms / cases.length)} ms and ${(tally.runs / cases.length).toFixed(1)} corner-model looks per lookup on this machine.`);
process.exit(0);
