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
import { allDeckCards, getDeck, loadDeck, removeDeck, roomDecks } from './decks.js';
import { identify, indexCards, modelsAvailable } from './recognize.js';
import { count, handleMetrics, noteToken, startMetrics } from './metrics.js';
import { clearDiscord, discordStatus, handleDiscord, registerCommands, saveDiscord } from './discord.js';
import { loadSecrets } from './secrets.js';
import {
  clientIp, findInvite, handleHost, isHttps, overLimit, peek,
} from './host.js';

function loadedDeckResult(invite, summary, commanders) {
  setDeck(invite.room, invite.name, summary, commanders);
  const deck = getDeck(invite.room, invite.name);
  if (deck) indexCards(deck.cards).catch((err) => console.warn('Card index failed:', err.message));
  return { summary, commanders, notFound: deck?.notFound || [] };
}

// Build card-recognition reference vectors for saved decks in the background.
setTimeout(() => indexCards(allDeckCards()).catch((err) => console.warn('Card index failed:', err.message)), 2000);

// Drop faded drawings every few seconds so late joiners don't see stale arrows.
setInterval(() => {
  for (const room of roomsWithDrawings()) if (pruneDrawings(room)) rebroadcast(room);
}, 5000);
import {
  CERT_FILE, KEY_FILE, LIVEKIT_YAML, ROOT,
  inviteUrl, loadConfig,
} from '../scripts/lib.js';

const config = loadConfig();
// On the Oracle server the secrets come from OCI Vault, not the config file (see server/secrets.js).
await loadSecrets(config);
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIVEKIT_CLIENT = path.join(ROOT, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
// Card tracking runs in each player's own browser (onnxruntime-web + the corner model), not here.
const ORT_DIR = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_FILES = /^(ort\.wasm\.min\.mjs|ort-wasm-simd-threaded\.(mjs|wasm))$/;
const POSE_FILES = { 'pose.onnx': 'mtg_4kp_s_r4b.onnx', 'mtg_4kp_s_r4b.onnx.data': 'mtg_4kp_s_r4b.onnx.data' };
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
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

// ---------- LiveKit child process ----------
let livekit = null;
if (!process.argv.includes('--no-livekit')) {
  const exe = path.join(ROOT, 'bin', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  if (!fs.existsSync(exe)) {
    console.error(`LiveKit server not found at ${exe}. See README.md.`);
    process.exit(1);
  }
  // With the vault in use, livekit.yaml has no keys; LiveKit gets them from the environment instead.
  const env = config.vault ? { ...process.env, LIVEKIT_KEYS: `${config.apiKey}: ${config.apiSecret}` } : process.env;
  livekit = spawn(exe, ['--config', LIVEKIT_YAML], { stdio: ['ignore', 'pipe', 'pipe'], env });
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
// Sent with every response. no-referrer matters: invite codes are in page URLs, and card images
// load from Scryfall.
const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function sendFile(res, file, cache = 'no-cache') {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache,
    });
    res.end(data);
  });
}

// Big files that never change (versioned by name): streamed, and cached by the browser.
function sendBig(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
    });
    fs.createReadStream(file).pipe(res);
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

function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  const ip = clientIp(req);

  // Every player request carries an invite code. Unknown codes count against the visitor's
  // address, and each invite gets a per-minute budget for each kind of request.
  const guest = (code, bucket, perMinute, status = 403, error = 'Invalid invite') => {
    if (peek(`bad:${ip}`) >= 30) {
      send(res, 429, { error: 'Too many invalid invite links from your address. Try again later.' });
      return null;
    }
    const invite = findInvite(code);
    if (!invite) {
      overLimit(`bad:${ip}`, 30, 10 * 60_000);
      send(res, status, { error });
      return null;
    }
    if (overLimit(`${bucket}:${invite.code}`, perMinute, 60_000)) {
      send(res, 429, { error: 'Too many requests. Wait a moment and try again.' });
      return null;
    }
    return invite;
  };
  const BAD_LINK = 'This invite link is not valid. Ask the host for a new one.';

  if (handleMetrics(config, req, res, p, ip, send)) return;
  if (await handleDiscord(config, req, res, p, { send, readBody })) return;
  if (await handleHost(config, req, res, p, { send, readBody, inviteUrl, extra: hostDiscord })) return;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && p === '/host') {
    return sendFile(res, path.join(PUBLIC_DIR, 'host.html'));
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
  const ortMatch = p.match(/^\/vendor\/ort\/([\w.-]+)$/);
  if (req.method === 'GET' && ortMatch && ORT_FILES.test(ortMatch[1])) {
    return sendBig(res, path.join(ORT_DIR, ortMatch[1]), 'public, max-age=86400');
  }
  // The card corner model, for tracking cards under stickers in the camera owner's browser.
  const modelMatch = p.match(/^\/api\/models\/([\w.-]+)$/);
  if (req.method === 'GET' && modelMatch && POSE_FILES[modelMatch[1]]) {
    if (!guest(url.searchParams.get('code'), 'model', 20)) return;
    return sendBig(res, path.join(ROOT, 'models', POSE_FILES[modelMatch[1]]), 'private, max-age=604800, immutable');
  }
  if (req.method === 'GET' && p.startsWith('/static/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, p.slice('/static/'.length)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    return sendFile(res, file);
  }

  // Who is this invite for? (lets the page greet the player before joining)
  const inviteMatch = p.match(/^\/api\/invite\/([\w-]+)$/);
  if (req.method === 'GET' && inviteMatch) {
    const invite = guest(inviteMatch[1], 'invite', 60, 404, BAD_LINK);
    if (!invite) return;
    count('invitesOpened');
    return send(res, 200, { name: invite.name, room: invite.room });
  }

  // Live game state (life, counters, turns) as Server-Sent Events. Opening it seats the player.
  if (req.method === 'GET' && p === '/api/game/stream') {
    const invite = guest(url.searchParams.get('code'), 'stream', 30);
    if (!invite) return;
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
    const invite = guest(body.code, 'action', 600);
    if (!invite) return;
    const error = applyAction(invite.room, invite.name, body.action || {});
    return error ? send(res, 400, { error }) : send(res, 204, '');
  }

  // Scryfall card search (proxied so we can cache and rate-limit). Invite required.
  if (req.method === 'GET' && (p === '/api/scryfall/autocomplete' || p === '/api/scryfall/card')) {
    if (!guest(url.searchParams.get('code'), 'scryfall', 120)) return;
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
    const invite = guest(body.code, 'deck', 10);
    if (!invite) return;
    if (p.endsWith('/remove')) {
      removeDeck(invite.room, invite.name);
      setDeck(invite.room, invite.name, null, null);
      return send(res, 204, '');
    }
    try {
      const { summary, commanders } = await loadDeck(invite.room, invite.name, body.text);
      const result = loadedDeckResult(invite, summary, commanders);
      count('decks');
      return send(res, 200, result);
    } catch (err) {
      return send(res, 400, { error: err.message || 'Could not load that deck.' });
    }
  }
  if (req.method === 'GET' && p === '/api/deck') {
    const invite = guest(url.searchParams.get('code'), 'deckview', 120);
    if (!invite) return;
    const deck = getDeck(invite.room, url.searchParams.get('player') || invite.name);
    return deck ? send(res, 200, deck) : send(res, 404, { error: 'No deck loaded' });
  }

  // Card recognition. Body: JPEG of the area around the click. Query: code, player (whose video),
  // x/y (click position inside the image, 0-1). Matches that player's deck first, then everyone's.
  if (req.method === 'POST' && p === '/api/identify') {
    const invite = guest(url.searchParams.get('code'), 'identify', 20);
    if (!invite) return;
    if (!modelsAvailable()) return send(res, 503, { error: 'Card recognition is not installed on this server.' });
    let image;
    try {
      image = await readBinary(req, 3_000_000);
    } catch {
      return send(res, 413, { error: 'Image too large' });
    }
    const player = url.searchParams.get('player') || '';
    const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0.5));
    const decks = roomDecks(invite.room);
    count('identify');
    if (decks.length === 0) return send(res, 200, { found: false, reason: 'nodecks' });
    // The player's own deck goes first so their cards win ties.
    decks.sort((a, b) => (b.owner === player) - (a.owner === player));
    const candidates = decks.flatMap((d) => d.cards.map((card) => ({ card, owner: d.owner })));
    try {
      const result = await identify(image, { x: clamp(url.searchParams.get('x')), y: clamp(url.searchParams.get('y')) }, candidates);
      if (result.found) {
        result.matches = result.matches.map(({ card, owner, score }) => ({
          owner,
          score: Math.round(score * 1000) / 1000,
          card: {
            type: 'card', name: card.name, scryfallId: card.scryfallId, typeLine: card.typeLine,
            image: card.image, imageLarge: card.imageLarge, power: card.power ?? '', toughness: card.toughness ?? '',
          },
        }));
        const [first, second] = result.matches;
        result.confident = !!first && first.score >= 0.3 && first.score - (second?.score || 0) >= 0.07;
      }
      const top = result.matches?.[0];
      const said = !result.found ? 'no card found' : !top ? 'no deck match' : `${top.card.name} ${top.score}${result.confident ? '' : ' (unsure)'}`;
      console.log(`Identify by ${invite.name} on ${player || '?'}: ${said} in ${result.ms} ms`);
      return send(res, 200, result);
    } catch (err) {
      console.error('Recognition error', err);
      return send(res, 400, { error: 'Could not read that image.' });
    }
  }

  // Browsers report their video stats here so the host can check quality from the log.
  if (req.method === 'POST' && p === '/api/stats') {
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000));
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    const invite = guest(body.code, 'stats', 30);
    if (!invite) return;
    const line =JSON.stringify({ t: new Date().toISOString(), name: invite.name, ...body.report }) + '\n';
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
    const invite = guest(body.code, 'token', 20, 403, BAD_LINK);
    if (!invite) return;

    // A random suffix lets the same person join from two devices (handy for testing).
    const identity = `${invite.name}-${crypto.randomBytes(3).toString('hex')}`;
    noteToken(identity, ip, req.headers['user-agent']);
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
      serverUrl: `${isHttps(req) ? 'wss' : 'ws'}://${req.headers.host}`,
      name: invite.name,
      room: invite.room,
      identity,
    });
  }

  send(res, 404, 'Not found', 'text/plain');
}

// Discord bot settings on the host page (only reached after the host login check).
async function hostDiscord(req, res, p, body) {
  if (!p.startsWith('/api/host/discord')) return false;
  if (req.method === 'GET' && p === '/api/host/discord') {
    send(res, 200, discordStatus(config));
  } else if (req.method === 'POST' && p === '/api/host/discord') {
    const result = await saveDiscord(config, await body());
    send(res, result.error ? 400 : 200, { ...result, status: discordStatus(config) });
  } else if (req.method === 'POST' && p === '/api/host/discord/register') {
    const result = await registerCommands(config);
    send(res, result.error ? 400 : 200, { ...result, status: discordStatus(config) });
  } else if (req.method === 'POST' && p === '/api/host/discord/clear') {
    await clearDiscord(config);
    send(res, 200, { status: discordStatus(config) });
  } else {
    send(res, 404, { error: 'Not found' });
  }
  return true;
}

// ---------- start ----------
// Keep Discord's copy of the bot's commands current (they change with deploys).
if (config.discord?.appId && config.discord?.token) {
  registerCommands(config).then((r) => console.log(r.error ? `Discord: ${r.error}` : 'Discord commands registered'));
}
startMetrics(config);
const onRequest = (req, res) => handle(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) send(res, 500, { error: 'Server error' });
});
const announce = () => {
  console.log(`\nMTG Table running at ${config.publicUrl}`);
  console.log(config.hostPassword
    ? `Host page: ${config.publicUrl.replace(/\/$/, '')}/host`
    : 'Host page is locked until you set a password: npm run host-password');
  console.log('Press Ctrl+C to stop.\n');
};

if (config.behindProxy) {
  // On a public server: Caddy (or another proxy) handles HTTPS and forwards to this port on localhost.
  const server = http.createServer(onRequest);
  server.on('upgrade', proxyUpgrade);
  server.listen(config.httpPort, '127.0.0.1', announce);
} else {
  const server = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, onRequest);
  server.on('upgrade', proxyUpgrade);
  server.listen(config.httpsPort, '0.0.0.0', announce);
}

// Optional plain-HTTP listener on this machine only (MTG_DEV_HTTP=<port>), for previewing the UI in
// browsers that refuse the self-signed certificate. Never reachable from other machines.
if (process.env.MTG_DEV_HTTP) {
  const dev = http.createServer(onRequest);
  dev.on('upgrade', proxyUpgrade);
  dev.listen(Number(process.env.MTG_DEV_HTTP), '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${process.env.MTG_DEV_HTTP}`));
}
