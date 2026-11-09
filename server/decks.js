// Deck lists: parse pasted text (Moxfield, Archidekt, Arena, MTGO-style), look the cards up on
// Scryfall, and keep each player's deck on disk. Only the owner can change their deck;
// anyone at the table can view it.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../scripts/lib.js';
import { lookupMany } from './scryfall.js';

const DECKS_FILE = path.join(DATA_DIR, 'decks.json');
const MAX_LINES = 300;
let decks = load(); // room -> name -> deck

function load() {
  try {
    return JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function save() {
  fs.writeFile(DECKS_FILE, JSON.stringify(decks), () => {});
}

const SECTION = {
  commander: 'commander', commanders: 'commander',
  deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main',
  sideboard: 'side', side: 'side',
  companion: 'companion',
  maybeboard: 'skip', maybe: 'skip', considering: 'skip', tokens: 'skip', token: 'skip',
};

// Turn pasted text into [{ qty, name, section }].
export function parseDeck(text) {
  const entries = [];
  let section = 'main';
  const lines = String(text || '').split(/\r?\n/).slice(0, MAX_LINES);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    // Section headers: "Commander", "// Sideboard", "Sideboard:", "SIDEBOARD (15)"
    const header = line.replace(/^\/\/\s*/, '').replace(/[:\s]*(\(\d+\))?$/, '').toLowerCase();
    if (SECTION[header]) {
      section = SECTION[header];
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) continue;
    let lineSection = section;
    if (/^SB:\s*/i.test(line)) {
      lineSection = 'side';
      line = line.replace(/^SB:\s*/i, '');
    }
    if (lineSection === 'skip') continue;
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    let qty = 1;
    let name = line;
    if (m) {
      qty = Math.min(99, Number(m[1]));
      name = m[2];
    }
    name = name
      .replace(/\s+\*[A-Z]+\*/g, '') // *F* foil markers
      .replace(/\s+\[[^\]]*\]/g, '') // [SET] or [Category]
      .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '') // (SET) 123
      .replace(/\s+#\S.*$/, '') // #tags
      .trim();
    if (name) entries.push({ qty, name, section: lineSection });
  }
  return entries;
}

const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
function mainType(typeLine) {
  const front = String(typeLine).split('//')[0];
  return TYPE_ORDER.find((t) => front.includes(t)) || 'Other';
}

// Parse + look up + store. Returns { summary, commanders, deck }.
export async function loadDeck(room, name, text) {
  const entries = parseDeck(text);
  if (entries.length === 0) throw new Error('No cards found. Paste one card per line, like "1 Sol Ring".');
  const { cards, notFound } = await lookupMany(entries.map((e) => e.name));
  const list = [];
  for (const e of entries) {
    const card = cards.get(e.name.toLowerCase());
    if (!card) continue;
    const existing = list.find((x) => x.name === card.name && x.section === e.section);
    if (existing) existing.qty += e.qty;
    else list.push({ ...card, qty: e.qty, section: e.section, group: e.section === 'main' ? mainType(card.typeLine) : e.section });
  }
  list.sort((a, b) => (a.cmc - b.cmc) || a.name.localeCompare(b.name));
  const count = list.filter((c) => c.section === 'main' || c.section === 'commander').reduce((s, c) => s + c.qty, 0);
  const deck = { owner: name, updated: new Date().toISOString(), cards: list, notFound };
  decks[room] ??= {};
  decks[room][name] = deck;
  save();
  const commanders = list.filter((c) => c.section === 'commander').slice(0, 2)
    .map(({ name: n, image, imageLarge, scryfallId }) => ({ name: n, image, imageLarge, scryfallId }));
  return { summary: { count, updated: deck.updated, missing: notFound.length }, commanders, deck };
}

export function getDeck(room, name) {
  return decks[room]?.[name] || null;
}

export function removeDeck(room, name) {
  if (decks[room]?.[name]) {
    delete decks[room][name];
    save();
  }
}
