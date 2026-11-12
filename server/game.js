// Shared game state per room: life, poison, commander damage, counters, turn order,
// monarch/initiative and a short log. The server is the single source of truth;
// browsers send actions and receive the full state over Server-Sent Events.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../scripts/lib.js';

const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const LOG_LIMIT = 60;
const COUNTERS = ['energy', 'experience', 'rad', 'tickets'];

const games = loadGames();
const listeners = new Map(); // room -> Set<res>
let saveTimer = null;

function loadGames() {
  try {
    return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(GAMES_FILE, JSON.stringify(games, null, 2), () => {});
  }, 500);
}

// Game modes and their presets.
export const MODES = {
  standard: { label: 'Standard', life: () => 20, commander: false, cmdDmg: false },
  commander: { label: 'Commander', life: () => 40, commander: true, cmdDmg: true },
  // Brawl: 25 life head-to-head, 30 in multiplayer; commanders and commander tax, no commander damage.
  brawl: { label: 'Brawl', life: (players) => (players <= 2 ? 25 : 30), commander: true, cmdDmg: false },
};

// `keep` carries over things that survive a new game (deck, chosen commanders).
function newPlayer(game, keep = {}) {
  return {
    life: game.startingLife,
    poison: 0,
    cmdDmg: {},
    counters: {},
    commanders: keep.commanders || [], // [{ name, image, imageLarge, scryfallId }]
    casts: {}, // commander name -> times cast from the command zone (for commander tax)
    deck: keep.deck || null, // summary only: { count, updated, missing }
  };
}

function getGame(room) {
  if (!games[room]) {
    games[room] = {
      startingLife: 40,
      players: {},
      order: [],
      active: null,
      turn: 1,
      monarch: null,
      initiative: null,
      log: [],
      version: 0,
    };
  }
  const game = games[room];
  game.mode ??= 'commander';
  for (const p of Object.values(game.players)) {
    p.commanders ??= [];
    p.casts ??= {};
    p.deck ??= null;
  }
  game.stickers ??= {}; // id -> { id, tile, x, y, items: [], by }
  // Where each player's piles (and play area) are on their camera: name -> { command | library | graveyard | exile | play: [x0, y0, x1, y1] }
  // (0-1 over their picture). Kept across games: the camera hasn't moved.
  game.zones ??= {};
  // What has gone into each pile this game: name -> { zone: [{ name, image, imageLarge }] }, newest last.
  game.piles ??= {};
  for (const piles of Object.values(game.piles)) {
    for (const [zone, pile] of Object.entries(piles)) piles[zone] = pile.map((c) => (typeof c === 'string' ? { name: c, image: '', imageLarge: '' } : c));
  }
  game.drawings ??= []; // { id, tile, by, color, kind, points, keep, t }
  return game;
}

// ---------- stickers & drawings ----------
const MAX_STICKERS = 150;
const MAX_ITEMS = 12;
const MAX_DRAWINGS = 200;
const MAX_POINTS = 300;
export const DRAWING_LIFETIME_MS = 20_000;

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const unit = (n) => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 10000) / 10000;
const newId = () => Math.random().toString(36).slice(2, 10);
const PT_TEXT = /^[-+]?(\d{1,3}|\*|\d?\+\*|\*\+\d)$/;

// Validate one sticker item coming from a browser. Returns a clean item or null.
export function cleanItem(item) {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'card': {
      const image = str(item.image, 300);
      const imageLarge = str(item.imageLarge, 300);
      const okUrl = (u) => !u || u.startsWith('https://cards.scryfall.io/');
      if (!okUrl(image) || !okUrl(imageLarge)) return null;
      const pt = (v) => (PT_TEXT.test(str(v, 6)) ? str(v, 6) : '');
      return {
        type: 'card',
        name: str(item.name, 120) || 'Card',
        scryfallId: /^[0-9a-f-]{36}$/.test(item.scryfallId) ? item.scryfallId : '',
        typeLine: str(item.typeLine, 120),
        image,
        imageLarge,
        power: pt(item.power),
        toughness: pt(item.toughness),
      };
    }
    case 'pt':
      return {
        type: 'pt',
        label: str(item.label, 40),
        mode: item.mode === 'mod' ? 'mod' : 'set',
        power: clampInt(item.power, -999, 999),
        toughness: clampInt(item.toughness, -999, 999),
      };
    case 'counter':
      return { type: 'counter', label: str(item.label, 24) || 'Counter', count: clampInt(item.count, 0, 999) };
    case 'text': {
      const text = str(item.text, 80);
      return text ? { type: 'text', text } : null;
    }
    default:
      return null;
  }
}

const PILE_LIMIT = 150;
// How the log words a card going to each pile.
const ZONES = { command: 'went back to the command zone', library: 'went to the library', graveyard: 'went to the graveyard', exile: 'was exiled' };
const itemName = (item) => (item.type === 'card' ? item.name
  : item.type === 'pt' ? (item.label || `${item.mode === 'mod' ? 'modifier' : 'P/T'} ${item.power}/${item.toughness}`)
    : item.type === 'counter' ? `${item.label} counter` : `"${item.text}"`);

export function pruneDrawings(room) {
  const game = getGame(room);
  const now = Date.now();
  const before = game.drawings.length;
  game.drawings = game.drawings.filter((d) => d.keep || now - d.t < DRAWING_LIFETIME_MS);
  return game.drawings.length !== before;
}

export function roomsWithDrawings() {
  return Object.keys(games).filter((room) => games[room].drawings?.some((d) => !d.keep));
}

// A player loaded (or removed) a deck. Only a small summary goes into the shared state;
// the full list is fetched on demand from /api/deck.
export function setDeck(room, name, summary, commanders) {
  const game = getGame(room);
  const player = game.players[name];
  if (!player) return;
  player.deck = summary;
  if (commanders?.length) {
    player.commanders = commanders.slice(0, 2);
    player.casts = Object.fromEntries(player.commanders.map((c) => [c.name, player.casts?.[c.name] || 0]));
  }
  if (summary) {
    const cmd = commanders?.length ? ` (commander: ${commanders.map((c) => c.name).join(' + ')})` : '';
    log(game, name, `${name} loaded a ${summary.count}-card deck${cmd}`);
  } else {
    log(game, name, `${name} removed their deck`);
  }
  broadcast(room);
}

export function rebroadcast(room) {
  broadcast(room);
}

function log(game, by, text) {
  game.log.push({ t: Date.now(), by, text });
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

function broadcast(room) {
  const game = getGame(room);
  game.version += 1;
  scheduleSave();
  const payload = `data: ${JSON.stringify({ ...game, serverNow: Date.now() })}\n\n`;
  for (const res of listeners.get(room) || []) res.write(payload);
}

const clampInt = (n, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(n) || 0)));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

export function joinGame(room, name) {
  const game = getGame(room);
  if (!game.players[name]) {
    game.players[name] = newPlayer(game);
    game.order.push(name);
    if (!game.active) game.active = name;
    log(game, name, `${name} sat down at the table`);
    broadcast(room);
  }
}

export function subscribe(room, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ ...getGame(room), serverNow: Date.now() })}\n\n`);
  if (!listeners.has(room)) listeners.set(room, new Set());
  listeners.get(room).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    listeners.get(room)?.delete(res);
  });
}

// Apply one action. `by` is the invite name of whoever clicked.
// Returns an error string, or null on success.
export function applyAction(room, by, action) {
  const game = getGame(room);
  const target = action.target;
  const player = target ? game.players[target] : null;
  if (target && !player) return 'Unknown player';

  switch (action.type) {
    case 'life': {
      const delta = clampInt(action.delta, -999, 999);
      if (!delta || !player) return 'Bad action';
      const before = player.life;
      player.life = clampInt(player.life + delta, -999, 9999);
      log(game, by, `${target} life ${signed(delta)} (${before} → ${player.life})`);
      break;
    }
    case 'poison': {
      const delta = clampInt(action.delta, -99, 99);
      if (!delta || !player) return 'Bad action';
      player.poison = clampInt(player.poison + delta, 0, 99);
      log(game, by, `${target} poison ${signed(delta)} (now ${player.poison})`);
      break;
    }
    case 'cmdDmg': {
      // Commander damage from `from`'s commander to `target`. Also changes life, as in the rules.
      const delta = clampInt(action.delta, -99, 99);
      const from = action.from;
      if (!delta || !player || !game.players[from]) return 'Bad action';
      const before = player.cmdDmg[from] || 0;
      const after = clampInt(before + delta, 0, 999);
      const applied = after - before;
      if (!applied) return null;
      player.cmdDmg[from] = after;
      player.life = clampInt(player.life - applied, -999, 9999);
      log(game, by, `${target} took ${signed(applied)} commander damage from ${from} (${after} total, life ${player.life})`);
      break;
    }
    case 'counter': {
      const delta = clampInt(action.delta, -99, 99);
      if (!delta || !player || !COUNTERS.includes(action.counter)) return 'Bad action';
      player.counters[action.counter] = clampInt((player.counters[action.counter] || 0) + delta, 0, 999);
      log(game, by, `${target} ${action.counter} ${signed(delta)} (now ${player.counters[action.counter]})`);
      break;
    }
    case 'passTurn': {
      if (game.order.length === 0) return 'No players';
      const i = game.order.indexOf(game.active);
      const next = game.order[(i + 1) % game.order.length];
      if (i === game.order.length - 1 || i === -1) game.turn += 1;
      game.active = next;
      log(game, by, `Turn passed to ${next}${i === game.order.length - 1 ? ` (round ${game.turn})` : ''}`);
      break;
    }
    case 'setActive': {
      if (!player) return 'Bad action';
      game.active = target;
      log(game, by, `It's now ${target}'s turn`);
      break;
    }
    case 'shuffleOrder': {
      const order = [...game.order];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      game.order = order;
      game.active = order[0] || null;
      game.turn = 1;
      log(game, by, `Random turn order: ${order.join(' → ')}. ${order[0]} goes first.`);
      break;
    }
    case 'moveSeat': {
      // Move target one seat earlier (-1) or later (+1) in turn order.
      const dir = action.delta > 0 ? 1 : -1;
      const i = game.order.indexOf(target);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= game.order.length) return null;
      [game.order[i], game.order[j]] = [game.order[j], game.order[i]];
      log(game, by, `Turn order: ${game.order.join(' → ')}`);
      break;
    }
    case 'monarch':
    case 'initiative': {
      const key = action.type;
      const value = target && game[key] !== target ? target : null;
      game[key] = value;
      log(game, by, value ? `${value} ${key === 'monarch' ? 'became the monarch' : 'took the initiative'}` : `Nobody has the ${key} now`);
      break;
    }
    // ----- stickers -----
    case 'stickerAdd': {
      if (!player) return 'Bad action';
      if (Object.keys(game.stickers).length >= MAX_STICKERS) return 'Too many stickers. Clear some first.';
      const items = (Array.isArray(action.items) ? action.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
      if (items.length === 0) return 'Bad action';
      // Browsers may pick the id so they can keep editing the sticker they just made.
      const id = /^[a-z0-9]{6,12}$/.test(action.id) && !game.stickers[action.id] ? action.id : newId();
      game.stickers[id] = { id, tile: target, x: unit(action.x), y: unit(action.y), items, by };
      // unsure: the app's guess at a card it saw on the table, shown as a question until confirmed.
      if (action.unsure) game.stickers[id].unsure = true;
      // A card put back on the table has left whichever pile it was in (the newest copy of it).
      for (const it of items) {
        if (it.type !== 'card') continue;
        for (const pile of Object.values(game.piles[target] || {})) {
          const i = pile.map((c) => c.name).lastIndexOf(it.name);
          if (i >= 0) { pile.splice(i, 1); break; }
        }
      }
      if (!action.unsure) log(game, by, `Put ${items.map(itemName).join(' + ')} on ${target}'s table`);
      break;
    }
    case 'stickerMove': {
      const s = game.stickers[action.id];
      if (!s) return 'Sticker is gone';
      s.x = unit(action.x);
      s.y = unit(action.y);
      break; // moves aren't logged
    }
    case 'stickerConfirm': {
      const s = game.stickers[action.id];
      if (!s) return 'Sticker is gone';
      delete s.unsure;
      break; // not logged
    }
    case 'stickerFixed': {
      // Fixed stickers stay where they were put; others follow the card under them.
      const s = game.stickers[action.id];
      if (!s) return 'Sticker is gone';
      if (action.fixed) s.fixed = true;
      else delete s.fixed;
      break; // not logged
    }
    case 'stickerScale': {
      // Per-sticker size, shared so it covers the same part of the card for everyone.
      const s = game.stickers[action.id];
      const scale = Number(action.scale);
      if (!s || !Number.isFinite(scale)) return 'Bad action';
      s.scale = Math.round(Math.min(3, Math.max(0.4, scale)) * 100) / 100;
      break; // not logged
    }
    case 'stickerItemAdd': {
      const s = game.stickers[action.id];
      const item = cleanItem(action.item);
      if (!s || !item) return 'Bad action';
      if (s.items.length >= MAX_ITEMS) return 'That stack is full';
      s.items.push(item);
      log(game, by, `Added ${itemName(item)} to a stack on ${s.tile}'s table`);
      break;
    }
    case 'stickerItemUpdate': {
      const s = game.stickers[action.id];
      const item = cleanItem(action.item);
      const i = clampInt(action.index, 0, MAX_ITEMS);
      if (!s || !item || !s.items[i] || s.items[i].type !== item.type) return 'Bad action';
      s.items[i] = item;
      break; // small edits aren't logged, to keep the log readable
    }
    case 'stickerItemRemove': {
      const s = game.stickers[action.id];
      const i = clampInt(action.index, 0, MAX_ITEMS);
      if (!s || !s.items[i]) return 'Bad action';
      const [removed] = s.items.splice(i, 1);
      if (s.items.length === 0) delete game.stickers[action.id];
      log(game, by, `Removed ${itemName(removed)} from ${s.tile}'s table`);
      break;
    }
    case 'stickerRemove': {
      const s = game.stickers[action.id];
      if (!s) return null;
      delete game.stickers[action.id];
      log(game, by, `Removed ${s.items.map(itemName).join(' + ')} from ${s.tile}'s table`);
      break;
    }
    // ----- zones -----
    case 'zoneSet': {
      // 'play' is the play area: not a pile, just where cards on the table are worth looking at.
      if (!player || !(ZONES[action.zone] || action.zone === 'play')) return 'Bad action';
      const box = Array.isArray(action.box) && action.box.length === 4 ? action.box.map(unit) : null;
      game.zones[target] ??= {};
      if (box && box[2] - box[0] > 0.02 && box[3] - box[1] > 0.02) game.zones[target][action.zone] = box;
      else delete game.zones[target][action.zone];
      break; // not logged
    }
    case 'stickerZone': {
      // A stickered card was moved to one of its owner's piles: the sticker goes, and the log says where.
      const s = game.stickers[action.id];
      if (!s || !ZONES[action.zone]) return null;
      delete game.stickers[action.id];
      const cards = s.items.filter((it) => it.type === 'card').map((it) => ({ name: it.name, image: it.image, imageLarge: it.imageLarge, scryfallId: it.scryfallId }));
      if (cards.length) {
        game.piles[s.tile] ??= {};
        const pile = (game.piles[s.tile][action.zone] ??= []);
        pile.push(...cards);
        if (pile.length > PILE_LIMIT) pile.splice(0, pile.length - PILE_LIMIT);
      }
      log(game, by, `${s.items.map(itemName).join(' + ')} ${ZONES[action.zone]} (${s.tile})`);
      break;
    }
    case 'pileRemove': {
      // Take one card off a pile's list by hand (it was put there by mistake, or came back).
      const pile = game.piles[target]?.[action.zone];
      const i = clampInt(action.index, 0, PILE_LIMIT);
      if (!pile || pile[i] === undefined) return null;
      pile.splice(i, 1);
      break; // not logged
    }
    case 'stickersClear': {
      for (const [id, s] of Object.entries(game.stickers)) {
        if (!target || s.tile === target) delete game.stickers[id];
      }
      log(game, by, target ? `Cleared stickers on ${target}'s table` : 'Cleared all stickers');
      break;
    }

    // ----- drawings -----
    case 'draw': {
      if (!player) return 'Bad action';
      const kind = action.kind === 'arrow' ? 'arrow' : 'pen';
      let points = (Array.isArray(action.points) ? action.points : [])
        .filter((pt) => Array.isArray(pt) && pt.length === 2)
        .map(([x, y]) => [unit(x), unit(y)]);
      if (points.length > MAX_POINTS) {
        const step = points.length / MAX_POINTS;
        points = Array.from({ length: MAX_POINTS }, (_, i) => points[Math.floor(i * step)]).concat([points[points.length - 1]]);
      }
      if (points.length < 2) return 'Bad action';
      if (kind === 'arrow') points = [points[0], points[points.length - 1]];
      const color = /^#[0-9a-f]{6}$/i.test(action.color) ? action.color : '#ffd54a';
      const size = Math.min(4, Math.max(0.5, Number(action.size) || 1));
      game.drawings.push({ id: newId(), tile: target, by, color, size, kind, points, keep: !!action.keep, t: Date.now() });
      if (game.drawings.length > MAX_DRAWINGS) game.drawings.splice(0, game.drawings.length - MAX_DRAWINGS);
      pruneDrawings(room);
      break; // drawings aren't logged
    }
    case 'drawErase': {
      // Eraser tool: remove specific drawings (anyone's) by id.
      const ids = new Set((Array.isArray(action.ids) ? action.ids : []).slice(0, 50).map(String));
      if (ids.size === 0) return 'Bad action';
      const before = game.drawings.length;
      game.drawings = game.drawings.filter((d) => !ids.has(d.id));
      if (game.drawings.length === before) return null; // already gone; nothing to broadcast
      break;
    }
    case 'drawClear': {
      // mine: only the clicker's drawings; otherwise everything (optionally on one table)
      game.drawings = game.drawings.filter((d) => {
        if (action.mine) return d.by !== by;
        return target ? d.tile !== target : false;
      });
      if (!action.mine) log(game, by, target ? `Cleared drawings on ${target}'s table` : 'Cleared all drawings');
      break;
    }

    // ----- commanders -----
    case 'setCommanders': {
      // Up to two (partners, backgrounds). Images must come from Scryfall.
      if (!player) return 'Bad action';
      const list = (Array.isArray(action.commanders) ? action.commanders : [])
        .map((c) => cleanItem({ ...c, type: 'card' }))
        .filter((c, i, all) => c && all.findIndex((x) => x?.name === c.name) === i) // no duplicates
        .slice(0, 2)
        .map(({ name, image, imageLarge, scryfallId }) => ({ name, image, imageLarge, scryfallId }));
      player.commanders = list;
      player.casts = Object.fromEntries(list.map((c) => [c.name, player.casts?.[c.name] || 0]));
      log(game, by, list.length ? `${target}'s commander: ${list.map((c) => c.name).join(' + ')}` : `${target} has no commander set`);
      break;
    }
    case 'commanderCast': {
      // Each cast from the command zone adds {2} commander tax to the next one.
      const cmdr = player?.commanders.find((c) => c.name === action.commander);
      const delta = clampInt(action.delta, -1, 1);
      if (!cmdr || !delta) return 'Bad action';
      const casts = clampInt((player.casts[cmdr.name] || 0) + delta, 0, 99);
      player.casts[cmdr.name] = casts;
      log(game, by, `${target} ${delta > 0 ? 'cast' : 'undid a cast of'} ${cmdr.name} (tax now {${casts * 2}})`);
      break;
    }

    case 'removePlayer': {
      if (!player) return 'Bad action';
      delete game.players[target];
      for (const [id, s] of Object.entries(game.stickers)) if (s.tile === target) delete game.stickers[id];
      game.drawings = game.drawings.filter((d) => d.tile !== target);
      game.order = game.order.filter((n) => n !== target);
      for (const p of Object.values(game.players)) delete p.cmdDmg[target];
      if (game.active === target) game.active = game.order[0] || null;
      if (game.monarch === target) game.monarch = null;
      if (game.initiative === target) game.initiative = null;
      log(game, by, `${target} left the game`);
      break;
    }
    case 'newGame': {
      const mode = MODES[action.mode] ? action.mode : game.mode;
      const preset = MODES[mode].life(game.order.length);
      const custom = Number(action.startingLife);
      const startingLife = Number.isInteger(custom) && custom >= 1 && custom <= 999 ? custom : preset;
      game.mode = mode;
      game.startingLife = startingLife;
      for (const [name, p] of Object.entries(game.players)) {
        game.players[name] = newPlayer(game, { commanders: p.commanders, deck: p.deck });
      }
      game.active = game.order[0] || null;
      game.turn = 1;
      game.monarch = null;
      game.initiative = null;
      game.stickers = {};
      game.piles = {}; // the boxes in game.zones stay: the cameras haven't moved
      game.drawings = [];
      game.log = [];
      log(game, by, `New ${MODES[mode].label} game started at ${startingLife} life`);
      break;
    }
    default:
      return 'Unknown action';
  }
  broadcast(room);
  return null;
}
