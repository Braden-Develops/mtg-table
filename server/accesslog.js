// Web traffic for Grafana: tails Caddy's JSON access log (deploy/Caddyfile) and serves new lines at
// GET /logs/access?after=<seq>, behind the same bearer token and limits as /metrics. A collector on
// the monitoring box polls it and pushes the lines into Loki.
//
// Each line is trimmed to what's worth seeing: time, address, method, host, path, status, size,
// duration and user agent. Invite codes and video tokens were already hashed or removed by Caddy.
// Lines are numbered from 1 each time the app starts, with a boot id, so the collector can tell a
// restart from new lines; on start the end of the existing file is read back in (Loki drops repeats).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { overLimit, peek } from './host.js';
import { hashToken } from './metrics.js';

const FILE = process.env.ACCESS_LOG || '/var/log/caddy/access.log';
const KEEP = 20_000; // lines held in memory
const BACKFILL_BYTES = 4 * 1024 * 1024;
const POLL_MS = 3_000;
const PAGE = 5_000;

const boot = crypto.randomBytes(6).toString('hex');
const lines = []; // { seq, line }
let seq = 0;
let fd = null;
let ino = null;
let pos = 0;
let partial = '';

function slim(raw) {
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  const r = e.request || {};
  const h = r.headers || {};
  const host = String(r.host || '').replace(/:\d+$/, '');
  return JSON.stringify({
    ts: e.ts,
    ip: r.client_ip || r.remote_ip || '',
    method: r.method || '',
    host,
    site: /^[\d.]+$|^\[?[0-9a-f:]+\]?$/i.test(host) || !host ? 'ip' : host.includes('.') ? 'domain' : 'other',
    uri: String(r.uri || '').slice(0, 500),
    proto: r.proto || '',
    status: e.status ?? 0,
    size: e.size ?? 0,
    ms: Math.round((e.duration || 0) * 1000),
    ua: String(h['User-Agent']?.[0] || '').slice(0, 300),
    ref: String(h.Referer?.[0] || '').slice(0, 300),
  });
}

function add(raw) {
  const s = slim(raw);
  if (!s) return;
  lines.push({ seq: ++seq, line: s });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
}

function readNew() {
  let st;
  try { st = fs.statSync(FILE); } catch { return; } // no log yet, or no permission
  if (fd === null || st.ino !== ino || st.size < pos) { // first time, or Caddy rolled the file
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* gone */ } }
    try { fd = fs.openSync(FILE, 'r'); } catch { fd = null; return; }
    const first = ino === null;
    ino = st.ino;
    pos = first ? Math.max(0, st.size - BACKFILL_BYTES) : 0;
    partial = '';
    if (first && pos > 0) partial = null; // skip the cut-off first line
  }
  while (pos < st.size) {
    const buf = Buffer.alloc(Math.min(1024 * 1024, st.size - pos));
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (!n) break;
    pos += n;
    const text = (partial ?? '') + buf.toString('utf8', 0, n);
    const parts = text.split('\n');
    const rest = parts.pop();
    if (partial === null) parts.shift();
    for (const p of parts) if (p) add(p);
    partial = rest;
  }
}

export function startAccessLog() {
  readNew();
  setInterval(readNew, POLL_MS).unref();
}

function tokenOk(config, req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m || !config.metricsToken) return false;
  const a = Buffer.from(hashToken(m[1]), 'hex');
  const b = Buffer.from(config.metricsToken, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns true when it handled the request.
export function handleAccessLog(config, req, res, p, url, ip, send) {
  if (p !== '/logs/access') return false;
  const plain = 'text/plain';
  if (!config.metricsToken || req.method !== 'GET') {
    send(res, 404, 'Not found', plain);
    return true;
  }
  if (peek(`metricsbad:${ip}`) >= 5 || overLimit(`accesslog:${ip}`, 20, 60_000)) {
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
  readNew();
  const after = url.searchParams.get('boot') === boot ? Number(url.searchParams.get('after')) || 0 : 0;
  const out = [];
  let next = Math.min(after, seq);
  for (const l of lines) {
    if (l.seq <= after) continue;
    out.push(l.line);
    next = l.seq;
    if (out.length >= PAGE) break;
  }
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, { boot, next, more: next < seq, lines: out });
  return true;
}
