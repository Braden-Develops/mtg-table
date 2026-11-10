// Host tools: password login for the /host page, invite management, who is online, and simple
// rate limits shared with the rest of the server.
import crypto from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadInvites, saveInvites } from '../scripts/lib.js';

const COOKIE = 'mtg_host';
const SESSION_DAYS = 30;
const NAME_RE = /^[\p{L}\p{N} _.'-]{1,32}$/u;
const ROOM_RE = /^[\w-]{1,32}$/;

// ---------- rate limits (fixed windows, in memory) ----------
const hits = new Map(); // key -> { n, reset }
export function overLimit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset <= now) {
    h = { n: 0, reset: now + windowMs };
    hits.set(key, h);
  }
  h.n += 1;
  return h.n > max;
}
export function clearLimit(key) {
  hits.delete(key);
}
export function peek(key) {
  const h = hits.get(key);
  return h && h.reset > Date.now() ? h.n : 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
}, 60_000).unref();

// The visitor's address. Behind Caddy (a connection from this machine) it's the last
// X-Forwarded-For entry, which Caddy sets itself.
export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (local && typeof fwd === 'string' && fwd) return fwd.split(',').pop().trim();
  return remote;
}

export function isHttps(req) {
  if (req.socket.encrypted) return true;
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return local && req.headers['x-forwarded-proto'] === 'https';
}

// ---------- invites ----------
export function inviteActive(inv, now = Date.now()) {
  return !!inv && !inv.revoked && !(inv.expiresAt && Date.parse(inv.expiresAt) <= now);
}

export function findInvite(code) {
  if (typeof code !== 'string' || code.length < 10) return null;
  const invite = loadInvites().find((i) => i.code === code);
  return inviteActive(invite) ? invite : null;
}

// ---------- password + session cookie ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 32).toString('base64url');
  return { salt, hash };
}

function checkPassword(config, password) {
  const hp = config.hostPassword;
  if (!hp || typeof password !== 'string' || !password) return false;
  const got = crypto.scryptSync(password, hp.salt, 32);
  const want = Buffer.from(hp.hash, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// The signing key includes the password hash, so changing the password logs everyone out.
const sign = (config, exp) => crypto.createHmac('sha256', `${config.apiSecret}:${config.hostPassword?.hash}`)
  .update(`host:${exp}`).digest('base64url');

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

export function isHost(config, req) {
  if (!config.hostPassword) return false;
  const [exp, sig] = readCookie(req).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(config, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sessionCookie(config, req) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const secure = isHttps(req) ? '; Secure' : '';
  return `${COOKIE}=${exp}.${sign(config, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// ---------- who is online (asks LiveKit) ----------
let rooms = null;
export async function online(config) {
  rooms ??= new RoomServiceClient(`http://127.0.0.1:${config.livekitPort}`, config.apiKey, config.apiSecret);
  const out = new Map(); // room -> [names]
  try {
    for (const r of await rooms.listRooms()) {
      const people = await rooms.listParticipants(r.name);
      out.set(r.name, people.map((p) => p.name || p.identity));
    }
  } catch {
    return null; // video server not running
  }
  return out;
}

// Disconnect everyone using this invite's name in its room (revoked links stop working at once).
async function kick(config, room, name) {
  try {
    rooms ??= new RoomServiceClient(`http://127.0.0.1:${config.livekitPort}`, config.apiKey, config.apiSecret);
    for (const p of await rooms.listParticipants(room)) {
      if (p.name === name) await rooms.removeParticipant(room, p.identity);
    }
  } catch { /* room not open */ }
}

// ---------- making and revoking links (host page and Discord bot) ----------
// Returns { inv } or { error, clash }.
export function makeInvite(config, { name, room, days, by = 'Host', discordId }) {
  name = String(name || '').trim();
  room = String(room || '').trim();
  days = Number(days) || 0;
  if (!NAME_RE.test(name)) return { error: 'Names can be up to 32 letters, numbers, spaces, dots, dashes or apostrophes.' };
  if (!ROOM_RE.test(room)) return { error: 'Table names can be up to 32 letters, numbers, dashes or underscores (no spaces).' };
  const invites = loadInvites();
  const clash = invites.find((i) => i.room === room && i.name.toLowerCase() === name.toLowerCase() && inviteActive(i));
  if (clash) return { clash: true, error: `${clash.name} already has a working link at this table. Revoke it first to make a new one.` };
  const inv = {
    code: crypto.randomBytes(16).toString('base64url'),
    name,
    room,
    createdAt: new Date().toISOString(),
    expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    revoked: false,
    ...(discordId ? { discordId } : {}),
  };
  invites.push(inv);
  saveInvites(invites);
  console.log(`${by} made an invite for ${name} at table ${room}`);
  return { inv };
}

// Revokes a working link and disconnects the player. Returns the invite, or null.
export async function revokeInvite(config, code, by = 'Host') {
  const invites = loadInvites();
  const inv = invites.find((i) => i.code === code);
  if (!inv) return null;
  inv.revoked = true;
  inv.revokedAt = new Date().toISOString();
  saveInvites(invites);
  await kick(config, inv.room, inv.name);
  console.log(`${by} revoked ${inv.name}'s invite at table ${inv.room}`);
  return inv;
}

// Revoke every link at a table and end its video call.
export async function closeTable(config, room, by = 'Host') {
  const invites = loadInvites();
  for (const inv of invites) {
    if (inv.room === room && !inv.revoked) {
      inv.revoked = true;
      inv.revokedAt = new Date().toISOString();
    }
  }
  saveInvites(invites);
  try {
    rooms ??= new RoomServiceClient(`http://127.0.0.1:${config.livekitPort}`, config.apiKey, config.apiSecret);
    await rooms.deleteRoom(room);
  } catch { /* not open */ }
  console.log(`${by} closed table ${room}`);
}

// ---------- routes ----------
// Returns true when it handled the request.
// `extra` handles more host-only routes (the Discord settings) after the login check.
export async function handleHost(config, req, res, p, { send, readBody, inviteUrl, extra }) {
  if (!p.startsWith('/api/host/')) return false;
  const ip = clientIp(req);

  const body = async () => {
    try {
      return JSON.parse(await readBody(req, 5_000));
    } catch {
      return null;
    }
  };

  if (req.method === 'POST' && p === '/api/host/login') {
    // Layered limits on login attempts:
    //  - each address: 5 per hour, and 10 per day
    //  - all addresses together: 30 per hour, so a spread-out attack can't keep guessing
    //    (an already logged-in browser keeps working while this is in effect)
    //  - every wrong answer waits 2 seconds
    //  - fail2ban on the server bans an address at the firewall for a day after 5 wrong
    //    passwords (deploy/fail2ban/)
    // Every attempt counts before the password is checked, so parallel requests can't slip
    // past the limit; a correct password clears the address's own counters.
    const hour = overLimit(`login:${ip}`, 5, 60 * 60_000);
    const day = overLimit(`loginday:${ip}`, 10, 24 * 60 * 60_000);
    const all = overLimit('login:all', 30, 60 * 60_000);
    if (hour || day || all) {
      console.warn(`Host login blocked for ${ip}`);
      send(res, 429, { error: 'Too many login attempts. Try again later.' });
      return true;
    }
    if (!config.hostPassword) {
      send(res, 503, { error: 'No host password is set. On the server run: npm run host-password' });
      return true;
    }
    const b = await body();
    if (!checkPassword(config, b?.password)) {
      console.warn(`Host login failed from ${ip}`);
      await new Promise((r) => setTimeout(r, 2000));
      send(res, 403, { error: 'Wrong password.' });
      return true;
    }
    clearLimit(`login:${ip}`);
    clearLimit(`loginday:${ip}`);
    console.log(`Host logged in from ${ip}`);
    res.setHeader('Set-Cookie', sessionCookie(config, req));
    send(res, 204, '');
    return true;
  }

  if (req.method === 'POST' && p === '/api/host/logout') {
    res.setHeader('Set-Cookie', clearCookie);
    send(res, 204, '');
    return true;
  }

  if (!isHost(config, req)) {
    send(res, 401, { error: 'Log in first.' });
    return true;
  }
  if (overLimit(`host:${ip}`, 300, 60_000)) {
    send(res, 429, { error: 'Slow down.' });
    return true;
  }
  if (extra && await extra(req, res, p, body)) return true;

  if (req.method === 'GET' && p === '/api/host/state') {
    const now = Date.now();
    const live = await online(config);
    const tables = new Map();
    for (const inv of loadInvites()) {
      if (!tables.has(inv.room)) tables.set(inv.room, []);
      tables.get(inv.room).push({
        name: inv.name,
        code: inv.code,
        url: inviteUrl(config, inv.code),
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt || null,
        status: inv.revoked ? 'revoked' : inviteActive(inv, now) ? 'active' : 'expired',
        online: live ? (live.get(inv.room) || []).filter((n) => n === inv.name).length : 0,
      });
    }
    for (const room of live?.keys() || []) if (!tables.has(room)) tables.set(room, []);
    send(res, 200, {
      videoServer: !!live,
      maxPlayers: config.maxPlayers || 8,
      tables: [...tables].map(([room, invites]) => ({
        room,
        invites,
        online: live ? (live.get(room) || []).length : 0,
      })).sort((a, b) => a.room.localeCompare(b.room)),
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/host/invite') {
    const b = await body();
    const made = makeInvite(config, { name: b?.name, room: b?.room, days: b?.days });
    if (made.error) {
      send(res, made.clash ? 409 : 400, { error: made.error });
      return true;
    }
    send(res, 200, { url: inviteUrl(config, made.inv.code) });
    return true;
  }

  if (req.method === 'POST' && (p === '/api/host/revoke' || p === '/api/host/remove')) {
    const b = await body();
    const invites = loadInvites();
    const inv = invites.find((i) => i.code === b?.code);
    if (!inv) {
      send(res, 404, { error: 'No such invite.' });
      return true;
    }
    if (p.endsWith('/remove')) {
      saveInvites(invites.filter((i) => i !== inv));
    } else {
      await revokeInvite(config, inv.code);
    }
    send(res, 204, '');
    return true;
  }

  // Revoke every link at a table and end its video call.
  if (req.method === 'POST' && p === '/api/host/close') {
    const b = await body();
    await closeTable(config, String(b?.room || ''));
    send(res, 204, '');
    return true;
  }

  send(res, 404, { error: 'Not found' });
  return true;
}
