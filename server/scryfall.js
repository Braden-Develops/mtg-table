// Small Scryfall client: autocomplete and card lookup, with caching and polite rate limiting.
// Scryfall asks API users to send a User-Agent and Accept header and to keep to ~10 requests/second.
// https://scryfall.com/docs/api
const API = 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': 'MTGTable/0.1 (private game table)', Accept: 'application/json' };
const MIN_GAP_MS = 120;
const CACHE_MAX = 2000;

const cache = new Map(); // url -> { at, value }
let queue = Promise.resolve();
let lastRequest = 0;

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
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(url, { headers: HEADERS });
    const body = await res.json().catch(() => ({}));
    return remember(url, { status: res.status, body });
  });
  queue = run.catch(() => {});
  return run;
}

// POST helper on the same polite queue (used for batch card lookups; not cached).
function scryfallPost(path, payload) {
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  queue = run.catch(() => {});
  return run;
}

// Look up many cards at once (Scryfall allows 75 per request).
// Returns { cards: Map<lowercased name, card>, notFound: [names] }.
export async function lookupMany(names) {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const cards = new Map();
  const remember = (card) => {
    const trimmed = trimCard(card);
    cards.set(card.name.toLowerCase(), trimmed);
    // "Fire // Ice" and double-faced cards can be listed by their front-face name.
    for (const face of card.card_faces || []) if (face.name) cards.set(face.name.toLowerCase(), trimmed);
  };
  for (let i = 0; i < unique.length; i += 75) {
    const chunk = unique.slice(i, i + 75);
    const { status, body } = await scryfallPost('/cards/collection', { identifiers: chunk.map((name) => ({ name })) });
    if (status !== 200) throw new Error(body?.details || `Scryfall returned ${status}`);
    for (const card of body.data || []) remember(card);
  }
  const notFound = unique.filter((n) => !cards.has(n.toLowerCase()));
  // Second chance for typos/odd spellings: fuzzy match one by one (few cards, so this is cheap).
  for (const name of notFound.slice(0, 15)) {
    const { status, body } = await scryfallGet(`/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if (status === 200) {
      remember(body);
      cards.set(name.toLowerCase(), trimCard(body));
    }
  }
  return { cards, notFound: unique.filter((n) => !cards.has(n.toLowerCase())) };
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

// Every distinct artwork of a card (newest first), for card recognition: a player's copy may be any
// printing. Each face of a double-faced card is its own artwork. [{ key, small, normal }]
export async function artworks(name, max = 16) {
  const q = `!"${String(name).replace(/"/g, '')}" unique:art`;
  const { status, body } = await scryfallGet(`/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc&include_extras=false`);
  if (status !== 200) return [];
  const out = [];
  for (const card of body.data || []) {
    const faces = card.image_uris ? [card.image_uris] : (card.card_faces || []).map((f) => f.image_uris).filter(Boolean);
    faces.forEach((img, i) => {
      if (img.normal) out.push({ key: `${card.id}/${i}`, small: img.small || img.normal, normal: img.normal });
    });
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
