// Prometheus metrics at GET /metrics, for Grafana: who is connected, to which table, for how
// long, plus traffic and activity counters. Every connection and disconnection is also written
// to the log ("Player joined ..." / "Player left ... after 42m"), with address, device and user agent.
//
// Locked behind a bearer token (npm run metrics-token); without one set the endpoint doesn't
// exist (404). Rate-limited per address, and wrong tokens feed the same fail2ban jail as the
// host login.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { overLimit, peek } from './host.js';

const SAMPLE_MS = 15_000;
const startedAt = Date.now();

// ---------- counters ----------
const counters = { identify: 0, decks: 0, invitesOpened: 0 };
export function count(kind) {
  counters[kind] = (counters[kind] || 0) + 1;
}

// Address and device of each video token handed out, so the join log can say where from.
const tokens = new Map(); // identity -> { ip, ua, device }
export function noteToken(identity, ip, ua) {
  ua = String(ua || '').slice(0, 300);
  tokens.set(identity, { ip, ua, device: device(ua) });
  setTimeout(() => tokens.delete(identity), 15 * 60_000).unref();
}

// ---------- who is connected ----------
const online = new Map(); // identity -> { name, room, since, ip, ua, device }
const perPlayer = new Map(); // `${name}\0${room}` -> { name, room, seconds, sessions }
let lastSample = Date.now();
let lk = null;

const totals = (name, room) => {
  const k = `${name}\0${room}`;
  if (!perPlayer.has(k)) perPlayer.set(k, { name, room, seconds: 0, sessions: 0 });
  return perPlayer.get(k);
};
const minutes = (ms) => `${Math.round(ms / 60_000)}m`;

async function sample(config) {
  lk ??= new RoomServiceClient(`http://127.0.0.1:${config.livekitPort}`, config.apiKey, config.apiSecret);
  const now = Date.now();
  const elapsed = (now - lastSample) / 1000;
  lastSample = now;
  const seen = new Set();
  try {
    for (const r of await lk.listRooms()) {
      for (const p of await lk.listParticipants(r.name)) {
        seen.add(p.identity);
        const was = online.get(p.identity);
        if (was) {
          totals(was.name, was.room).seconds += elapsed;
          continue;
        }
        const name = p.name || p.identity;
        const since = Number(p.joinedAt) ? Number(p.joinedAt) * 1000 : now;
        const from = tokens.get(p.identity) || {};
        online.set(p.identity, { name, room: r.name, since, ip: from.ip || '', ua: from.ua || '', device: from.device || '' });
        const t = totals(name, r.name);
        t.sessions += 1;
        t.seconds += Math.max(0, (now - since) / 1000);
        console.log(`Player joined: ${name} at table ${r.name} from ${from.ip || 'unknown address'}${from.device ? ` (${from.device})` : ''}${from.ua ? ` UA: ${from.ua}` : ''}`);
      }
    }
  } catch {
    return; // video server not reachable; try again next time
  }
  for (const [id, s] of online) {
    if (seen.has(id)) continue;
    online.delete(id);
    console.log(`Player left: ${s.name} at table ${s.room} from ${s.ip || 'unknown address'} after ${minutes(now - s.since)}`);
  }
}

export function startMetrics(config) {
  setInterval(() => sample(config), SAMPLE_MS).unref();
  setTimeout(() => sample(config), 3_000).unref();
}

// ---------- traffic from the network card (Linux; what Oracle bills against 10 TB) ----------
function traffic() {
  try {
    const route = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    const iface = route.map((l) => l.split(/\s+/)).find((f) => f[1] === '00000000')?.[0];
    if (!iface) return null;
    const read = (f) => Number(fs.readFileSync(`/sys/class/net/${iface}/statistics/${f}`, 'utf8'));
    return { iface, tx: read('tx_bytes'), rx: read('rx_bytes') };
  } catch {
    return null;
  }
}

// "Chrome on Windows" from a user agent.
function device(ua = '') {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------- exposition ----------
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (o) => `{${Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;

function render() {
  const now = Date.now();
  const out = [];
  const metric = (name, type, help, rows) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [l, v] of rows) out.push(`${name}${l ? labels(l) : ''} ${v}`);
  };
  const people = [...online.values()];
  const players = [...perPlayer.values()];
  metric('mtg_player_online', 'gauge', 'Player currently connected to a table (1 per connection).',
    people.map((s) => [{ name: s.name, table: s.room, device: s.device }, 1]));
  metric('mtg_player_connection_info', 'gauge', 'Each live connection with its address and full user agent (always 1).',
    people.map((s) => [{ name: s.name, table: s.room, ip: s.ip, device: s.device, user_agent: s.ua }, 1]));
  metric('mtg_player_session_seconds', 'gauge', 'How long the current connection has lasted.',
    people.map((s) => [{ name: s.name, table: s.room }, Math.round((now - s.since) / 1000)]));
  metric('mtg_player_connected_seconds_total', 'counter', 'Time connected, per player and table, since the app started.',
    players.map((t) => [{ name: t.name, table: t.room }, Math.round(t.seconds)]));
  metric('mtg_player_sessions_total', 'counter', 'Connections started, per player and table.',
    players.map((t) => [{ name: t.name, table: t.room }, t.sessions]));
  metric('mtg_players_online', 'gauge', 'Connections right now.', [[null, people.length]]);
  metric('mtg_tables_active', 'gauge', 'Tables with someone connected.', [[null, new Set(people.map((s) => s.room)).size]]);
  metric('mtg_card_identify_total', 'counter', 'Card recognition requests.', [[null, counters.identify]]);
  metric('mtg_decks_loaded_total', 'counter', 'Deck lists loaded.', [[null, counters.decks]]);
  metric('mtg_invites_opened_total', 'counter', 'Invite pages opened.', [[null, counters.invitesOpened]]);
  const net = traffic();
  if (net) {
    metric('mtg_network_transmit_bytes_total', 'counter', 'Bytes sent by the server network card (resets on reboot).', [[{ iface: net.iface }, net.tx]]);
    metric('mtg_network_receive_bytes_total', 'counter', 'Bytes received by the server network card (resets on reboot).', [[{ iface: net.iface }, net.rx]]);
  }
  metric('mtg_uptime_seconds', 'gauge', 'Seconds since the app started.', [[null, Math.round((now - startedAt) / 1000)]]);
  return out.join('\n') + '\n';
}

// ---------- endpoint ----------
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function tokenOk(config, req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(hashToken(m[1]), 'hex');
  const b = Buffer.from(config.metricsToken, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns true when it handled the request.
export function handleMetrics(config, req, res, p, ip, send) {
  if (p !== '/metrics') return false;
  const plain = 'text/plain';
  if (!config.metricsToken || req.method !== 'GET') {
    send(res, 404, 'Not found', plain);
    return true;
  }
  // A scraper every 15 s needs 4 a minute; 20 leaves room for testing with curl.
  // Wrong tokens: 5 per hour per address, then blocked here (and fail2ban bans the address).
  if (peek(`metricsbad:${ip}`) >= 5 || overLimit(`metrics:${ip}`, 20, 60_000) || overLimit('metrics:all', 120, 60_000)) {
    send(res, 429, 'Too many requests', plain);
    return true;
  }
  if (!tokenOk(config, req)) {
    overLimit(`metricsbad:${ip}`, 5, 60 * 60_000);
    console.warn(`Metrics login failed from ${ip}`);
    res.setHeader('WWW-Authenticate', 'Bearer');
    send(res, 401, 'Unauthorized', plain);
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, render(), 'text/plain; version=0.0.4; charset=utf-8');
  return true;
}
