// MTG Table web server.
// - Serves the web page over HTTPS (browsers need HTTPS for cameras on other devices).
// - Turns invite codes into short-lived LiveKit access tokens. The API secret never leaves this PC.
// - Proxies LiveKit's signaling (/rtc) so the page only needs this one HTTPS address.
// - Starts the LiveKit server as a child process (skip with --no-livekit).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { AccessToken } from 'livekit-server-sdk';
import {
  applyAction, joinGame, pruneDrawings, rebroadcast, roomsWithDrawings, setDeck, subscribe,
} from './game.js';
import { autocomplete, namedCard } from './scryfall.js';
import { getDeck, loadDeck, removeDeck } from './decks.js';

function loadedDeckResult(invite, summary, commanders) {
  setDeck(invite.room, invite.name, summary, commanders);
  const deck = getDeck(invite.room, invite.name);
  return { summary, commanders, notFound: deck?.notFound || [] };
}

// Drop faded drawings every few seconds so late joiners don't see stale arrows.
setInterval(() => {
  for (const room of roomsWithDrawings()) if (pruneDrawings(room)) rebroadcast(room);
}, 5000);
import {
  CERT_FILE, KEY_FILE, LIVEKIT_YAML, ROOT,
  inviteUrl, loadConfig, loadInvites,
} from '../scripts/lib.js';

const config = loadConfig();
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIVEKIT_CLIENT = path.join(ROOT, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
const TOKEN_TTL = '8h';
const STATS_LOG = path.join(ROOT, 'data', 'stats.jsonl');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- LiveKit child process ----------
let livekit = null;
if (!process.argv.includes('--no-livekit')) {
  const exe = path.join(ROOT, 'bin', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  if (!fs.existsSync(exe)) {
    console.error(`LiveKit server not found at ${exe}. See README.md.`);
    process.exit(1);
  }
  livekit = spawn(exe, ['--config', LIVEKIT_YAML], { stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (stream) => stream.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) console.log('[livekit]', line);
    }
  });
  relay(livekit.stdout);
  relay(livekit.stderr);
  livekit.on('exit', (code) => {
    console.error(`[livekit] exited with code ${code}`);
    process.exit(1);
  });
  const stop = () => {
    livekit?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---------- helpers ----------
function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function findInvite(code) {
  if (typeof code !== 'string' || code.length < 10) return null;
  const invite = loadInvites().find((i) => i.code === code);
  return invite && !invite.revoked ? invite : null;
}

function isLivekitPath(url) {
  return url === '/rtc' || url.startsWith('/rtc/') || url.startsWith('/rtc?');
}

// ---------- LiveKit proxy ----------
function proxyHttp(req, res) {
  const upstream = http.request({
    host: '127.0.0.1',
    port: config.livekitPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => send(res, 502, { error: 'Video server is not reachable' }));
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  if (!isLivekitPath(req.url)) return socket.destroy();
  const upstream = net.connect(config.livekitPort, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(raw + '\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'https://local');
  const p = url.pathname;

  if (isLivekitPath(p)) return proxyHttp(req, res);

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && /^\/join\/[\w-]+$/.test(p)) {
    return sendFile(res, path.join(PUBLIC_DIR, 'join.html'));
  }
  if (req.method === 'GET' && p === '/vendor/livekit-client.js') {
    return sendFile(res, LIVEKIT_CLIENT);
  }
  if (req.method === 'GET' && p === '/vendor/livekit-client.umd.js.map') {
    return sendFile(res, LIVEKIT_CLIENT + '.map');
  }
  if (req.method === 'GET' && p.startsWith('/static/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, p.slice('/static/'.length)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    return sendFile(res, file);
  }

  // Who is this invite for? (lets the page greet the player before joining)
  const inviteMatch = p.match(/^\/api\/invite\/([\w-]+)$/);
  if (req.method === 'GET' && inviteMatch) {
    const invite = findInvite(inviteMatch[1]);
    if (!invite) return send(res, 404, { error: 'This invite link is not valid. Ask the host for a new one.' });
    return send(res, 200, { name: invite.name, room: invite.room });
  }

  // Live game state (life, counters, turns) as Server-Sent Events. Opening it seats the player.
  if (req.method === 'GET' && p === '/api/game/stream') {
    const invite = findInvite(url.searchParams.get('code'));
    if (!invite) return send(res, 403, { error: 'Invalid invite' });
    joinGame(invite.room, invite.name);
    return subscribe(invite.room, res);
  }

  if (req.method === 'POST' && p === '/api/game/action') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const invite = findInvite(body.code);
    if (!invite) return send(res, 403, { error: 'Invalid invite' });
    const error = applyAction(invite.room, invite.name, body.action || {});
    return error ? send(res, 400, { error }) : send(res, 204, '');
  }

  // Scryfall card search (proxied so we can cache and rate-limit). Invite required.
  if (req.method === 'GET' && (p === '/api/scryfall/autocomplete' || p === '/api/scryfall/card')) {
    if (!findInvite(url.searchParams.get('code'))) return send(res, 403, { error: 'Invalid invite' });
    try {
      if (p.endsWith('autocomplete')) return send(res, 200, { names: await autocomplete(url.searchParams.get('q')) });
      const card = await namedCard(url.searchParams.get('name'));
      return card ? send(res, 200, card) : send(res, 404, { error: 'Card not found on Scryfall' });
    } catch (err) {
      console.error('Scryfall error', err);
      return send(res, 502, { error: 'Could not reach Scryfall' });
    }
  }

  // Deck lists. Players can only load or remove their own deck; anyone at the table can view one.
  if (req.method === 'POST' && (p === '/api/deck' || p === '/api/deck/remove')) {
    let body;
    try {
      body = JSON.parse(await readBody(req, 60_000));
    } catch {
      return send(res, 400, { error: 'Deck list is too long or not readable.' });
    }
    const invite = findInvite(body.code);
    if (!invite) return send(res, 403, { error: 'Invalid invite' });
    if (p.endsWith('/remove')) {
      removeDeck(invite.room, invite.name);
      setDeck(invite.room, invite.name, null, null);
      return send(res, 204, '');
    }
    try {
      const { summary, commanders } = await loadDeck(invite.room, invite.name, body.text);
      const result = loadedDeckResult(invite, summary, commanders);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 400, { error: err.message || 'Could not load that deck.' });
    }
  }
  if (req.method === 'GET' && p === '/api/deck') {
    const invite = findInvite(url.searchParams.get('code'));
    if (!invite) return send(res, 403, { error: 'Invalid invite' });
    const deck = getDeck(invite.room, url.searchParams.get('player') || invite.name);
    return deck ? send(res, 200, deck) : send(res, 404, { error: 'No deck loaded' });
  }

  // Browsers report their video stats here so the host can check quality from the log.
  if (req.method === 'POST' && p === '/api/stats') {
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000));
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const invite = findInvite(body.code);
    if (!invite) return send(res, 403, { error: 'Invalid invite' });
    const line = JSON.stringify({ t: new Date().toISOString(), name: invite.name, ...body.report }) + '\n';
    fs.stat(STATS_LOG, (err, st) => {
      if (!err && st.size > 5_000_000) fs.renameSync(STATS_LOG, STATS_LOG + '.old');
      fs.appendFile(STATS_LOG, line, () => {});
    });
    return send(res, 204, '');
  }

  if (req.method === 'POST' && p === '/api/token') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const invite = findInvite(body.code);
    if (!invite) return send(res, 403, { error: 'This invite link is not valid. Ask the host for a new one.' });

    // A random suffix lets the same person join from two devices (handy for testing).
    const identity = `${invite.name}-${crypto.randomBytes(3).toString('hex')}`;
    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity,
      name: invite.name,
      ttl: TOKEN_TTL,
    });
    token.addGrant({
      room: invite.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return send(res, 200, {
      token: await token.toJwt(),
      // Same host the page was loaded from; /rtc is proxied to LiveKit.
      serverUrl: `wss://${req.headers.host}`,
      name: invite.name,
      room: invite.room,
      identity,
    });
  }

  send(res, 404, 'Not found', 'text/plain');
}

// ---------- start ----------
const server = https.createServer({
  cert: fs.readFileSync(CERT_FILE),
  key: fs.readFileSync(KEY_FILE),
}, (req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  });
});
server.on('upgrade', proxyUpgrade);
server.listen(config.httpsPort, '0.0.0.0', () => {
  const active = loadInvites().filter((i) => !i.revoked);
  console.log(`\nMTG Table running at ${config.publicUrl}`);
  if (active.length === 0) {
    console.log('No invites yet. Create one with: npm run invite -- <name>');
  } else {
    console.log('Active invites:');
    for (const inv of active) console.log(`  ${inv.name.padEnd(16)} ${inviteUrl(config, inv.code)}`);
  }
  console.log('Press Ctrl+C to stop.\n');
});
