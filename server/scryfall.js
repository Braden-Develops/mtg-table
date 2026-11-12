// Small Scryfall client: autocomplete and card lookup, with caching and polite rate limiting.
// Scryfall asks API users to send a User-Agent and Accept header and to keep to ~10 requests/second.
// https://scryfall.com/docs/api
const API = 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': 'MTGTable/0.1 (private game table)', Accept: 'application/json' };
const MIN_GAP_MS = 120;
const SEARCH_GAP_MS = 550; // searches are limited much harder than single-card lookups
const RETRIES = 2; // after "too many requests"
const CACHE_MAX = 2000;

const cache = new Map(); // url -> { at, value }
let queue = Promise.resolve();
let lastRequest = 0;
let holdUntil = 0; // Scryfall said to slow down: nothing goes out before this

// One request on the polite queue's turn. When Scryfall answers "too many requests" (429), wait as
// long as it says (or 20 s, then 40 s) and ask again: giving up at once left most of a deck's
// printings unlisted, because every request after the first refusal was refused too.
async function politeFetch(url, options) {
  const gap = url.includes('/cards/search') ? SEARCH_GAP_MS : MIN_GAP_MS;
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(lastRequest + gap, holdUntil) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= RETRIES) return res;
    const asked = Number(res.headers.get('retry-after'));
    const pause = Math.min(120, asked > 0 ? asked : 20 * (attempt + 1));
    console.warn(`Scryfall asked us to slow down; waiting ${pause} s`);
    holdUntil = Date.now() + pause * 1000;
  }
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

// Serialize requests so we never exceed Scryfall's rate limit.
function scryfallGet(path) {
  const url = API + path;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return Promise.resolve(hit.value);
  const run = queue.then(async () => {
    const res = await politeFetch(url, { headers: HEADERS });
    const body = await res.json().catch(() => ({}));
    // Only real answers are remembered: a rate limit or an outage must not stick for a day.
    return res.status === 200 || res.status === 404 ? remember(url, { status: res.status, body }) : { status: res.status, body };
  });
  queue = run.catch(() => {});
  return run;
}

// POST helper on the same polite queue (used for batch card lookups; not cached).
function scryfallPost(path, payload) {
  const run = queue.then(async () => {
    const res = await politeFetch(API + path, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  queue = run.catch(() => {});
  return run;
}

// Look up deck entries at once (Scryfall allows 75 per request). An entry is { name } or, when the
// deck list says which printing, { name, set, number }; a printing Scryfall doesn't know falls back
// to the name. Returns { cards: [card or null, one per entry], notFound: [names] }.
export async function lookupEntries(entries) {
  const cards = entries.map(() => null);
  const lower = (v) => String(v || '').toLowerCase();
  const samePrint = (a, b) => lower(a.set) === lower(b.set) && lower(a.number) === lower(b.number);
  const sameName = (a, b) => lower(a.name) === lower(b.name);
  // Ask for each distinct entry once, then hand the answer to every entry like it.
  const ask = async (indexes, same, identifier, matches) => {
    const once = indexes.filter((k, i) => indexes.findIndex((j) => same(entries[j], entries[k])) === i);
    for (let i = 0; i < once.length; i += 75) {
      const chunk = once.slice(i, i + 75);
      const { status, body } = await scryfallPost('/cards/collection', { identifiers: chunk.map((k) => identifier(entries[k])) });
      if (status !== 200) throw new Error(body?.details || `Scryfall returned ${status}`);
      for (const card of body.data || []) {
        for (const k of chunk) if (!cards[k] && matches(entries[k], card)) cards[k] = trimCard(card);
      }
    }
    for (const k of indexes) cards[k] ??= cards[once.find((j) => same(entries[j], entries[k]))] || null;
  };
  const all = entries.map((_, k) => k);
  // Exact printings first.
  await ask(all.filter((k) => entries[k].set && entries[k].number), samePrint,
    (e) => ({ set: lower(e.set), collector_number: String(e.number) }),
    (e, card) => lower(card.set) === lower(e.set) && lower(card.collector_number) === lower(e.number));
  // The rest by name. "Fire // Ice" and double-faced cards can be listed by their front-face name.
  await ask(all.filter((k) => !cards[k]), sameName, (e) => ({ name: e.name }),
    (e, card) => lower(card.name) === lower(e.name) || (card.card_faces || []).some((f) => lower(f.name) === lower(e.name)));
  // Second chance for typos/odd spellings: fuzzy match one by one (few cards, so this is cheap).
  const missing = () => [...new Set(all.filter((k) => !cards[k]).map((k) => entries[k].name))];
  for (const name of missing().slice(0, 15)) {
    const { status, body } = await scryfallGet(`/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if (status !== 200) continue;
    for (const k of all) if (!cards[k] && entries[k].name === name) cards[k] = trimCard(body);
  }
  return { cards, notFound: missing() };
}

export async function autocomplete(q) {
  const query = String(q || '').trim().slice(0, 80);
  if (query.length < 2) return [];
  const { status, body } = await scryfallGet(`/cards/autocomplete?q=${encodeURIComponent(query)}`);
  return status === 200 ? (body.data || []).slice(0, 12) : [];
}

// Look up a card by exact name (or fuzzy if exact fails). Returns a trimmed card or null.
export async function namedCard(name) {
  const query = String(name || '').trim().slice(0, 120);
  if (!query) return null;
  let { status, body } = await scryfallGet(`/cards/named?exact=${encodeURIComponent(query)}`);
  if (status !== 200) ({ status, body } = await scryfallGet(`/cards/named?fuzzy=${encodeURIComponent(query)}`));
  if (status !== 200) return null;
  return trimCard(body);
}

function trimCard(card) {
  // Double-faced cards keep images and P/T on each face; use the front face.
  const face = card.card_faces?.[0] || {};
  const images = card.image_uris || face.image_uris || {};
  const typeLine = card.type_line || face.type_line || '';
  const oracle = card.oracle_text || face.oracle_text || '';
  return {
    type: 'card',
    name: card.name,
    scryfallId: card.id,
    typeLine,
    manaCost: card.mana_cost || face.mana_cost || '',
    cmc: card.cmc ?? 0,
    // Legendary creatures, or cards that say so; Brawl also allows legendary planeswalkers.
    canCommand: /Legendary.*Creature/.test(typeLine) || /can be your commander/i.test(oracle),
    canBrawl: /Legendary.*(Creature|Planeswalker)/.test(typeLine) || /can be your commander/i.test(oracle),
    image: images.small || images.normal || '',
    imageLarge: images.normal || images.large || '',
    power: card.power ?? face.power ?? '',
    toughness: card.toughness ?? face.toughness ?? '',
    scryfallUrl: card.scryfall_uri || '',
  };
}

// Every different-looking printing of a card (newest first), for card recognition: a player's copy
// may be any of them. Printings that share the artwork but not the frame (showcase, etched, retro,
// borderless, full-art) look different on camera, so each counts; foil-only variants of the same
// look don't. Each face of a double-faced card is its own picture. [{ key, small, normal }]
// Throws when Scryfall can't be reached, so the caller knows the list isn't complete.
const MAX_LOOKS = 40;
const MAX_LOOKS_BASIC = 60; // basic lands have hundreds; the newest are the likeliest at a table
export async function artworks(name) {
  const q = `!"${String(name).replace(/"/g, '')}" game:paper`;
  let next = `/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc&include_extras=false`;
  const out = [];
  const looks = new Set();
  let max = MAX_LOOKS;
  for (let page = 0; next && page < 8 && out.length < max; page++) {
    const { status, body } = await scryfallGet(next);
    if (status === 404) break; // no such card
    if (status !== 200) throw new Error(`Scryfall returned ${status}`);
    for (const card of body.data || []) {
      if (/\bBasic\b/.test(card.type_line || '')) max = MAX_LOOKS_BASIC;
      const faces = card.image_uris ? [card] : (card.card_faces || []).filter((f) => f.image_uris);
      faces.forEach((face, i) => {
        const look = [face.illustration_id || card.illustration_id || card.id, card.frame, card.border_color,
          [...(card.frame_effects || [])].sort().join('+'), card.full_art ? 'full' : '', card.textless ? 'textless' : '', i].join('|');
        const img = face.image_uris;
        if (looks.has(look) || !img.normal || out.length >= max) return;
        looks.add(look);
        out.push({ key: `${card.id}/${i}`, small: img.small || img.normal, normal: img.normal });
      });
    }
    next = body.has_more && body.next_page ? body.next_page.replace(API, '') : null;
  }
  return out;
}
