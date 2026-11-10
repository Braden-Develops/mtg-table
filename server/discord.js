// Discord bot for the host: make and send invite links from Discord instead of the host page.
//
// Discord posts slash commands to POST /api/discord (the app's "Interactions Endpoint URL"), signed
// with the application's Ed25519 key; anything without a valid signature is refused. Only the owner's
// Discord user ID may use the commands. No gateway connection, no extra packages.
//
//   Right-click a user > Apps > "Invite to MTG table"  pick a table, the bot DMs them the link
//   /invite friend [table] [expires]                     same, as a slash command
//   /links    working links per table                   /revoke   revoke a link and kick the player
//   /who      who is connected right now
//
// Set up from the host page (Discord bot section): application ID, public key, bot token, owner ID.
// With OCI Vault in use the bot token goes to the vault and is only held in memory here.
import crypto from 'node:crypto';
import { CONFIG_FILE, inviteUrl, loadInvites, readJson, writeJson } from '../scripts/lib.js';
import { inviteActive, makeInvite, online, overLimit, revokeInvite } from './host.js';
import { SECRET_NAMES, UNSET, writeSecret } from './secrets.js';

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/Braden-Develops/mtg-table, 1.0)';
const EPHEMERAL = 64;
const SNOWFLAKE = /^\d{17,20}$/;
const EXPIRY_CHOICES = [
  { name: '1 day', value: 1 },
  { name: '1 week', value: 7 },
  { name: '30 days', value: 30 },
  { name: 'Until revoked', value: 0 },
];
const DEFAULT_DAYS = 1;
const NEW_TABLE = '__new__';
const NAME_CHARS = /[^\p{L}\p{N} _.'-]/gu;

// ---------- commands Discord shows ----------
// Usable in servers, in the bot's DMs and (when installed to your account) in any DM or group.
const where = { integration_types: [0, 1], contexts: [0, 1, 2] };
export const COMMANDS = [
  { type: 2, name: 'Invite to MTG table', ...where },
  {
    type: 1, name: 'invite', description: 'Send a friend a link to an MTG table', ...where,
    options: [
      { type: 6, name: 'friend', description: 'Who to invite', required: true },
      { type: 3, name: 'table', description: 'Table name (leave empty to pick from a list)', autocomplete: true, max_length: 32 },
      { type: 4, name: 'expires', description: 'How long the link works (default 1 day)', choices: EXPIRY_CHOICES },
      { type: 3, name: 'name', description: 'Name shown at the table (default: their Discord name)', max_length: 32 },
    ],
  },
  { type: 1, name: 'links', description: 'Working invite links at each table', ...where },
  {
    type: 1, name: 'revoke', description: "Revoke someone's link and remove them from the table", ...where,
    options: [{ type: 3, name: 'link', description: 'Whose link', required: true, autocomplete: true }],
  },
  { type: 1, name: 'who', description: 'Who is connected right now', ...where },
];

// ---------- settings (host page) ----------
const settings = (config) => config.discord || {};

export function discordStatus(config) {
  const d = settings(config);
  const base = String(config.publicUrl || '').replace(/\/$/, '');
  const id = d.appId || '';
  return {
    appId: id,
    ownerId: d.ownerId || '',
    publicKeySet: !!d.publicKey,
    tokenSet: !!d.token,
    registeredAt: d.registeredAt || null,
    endpoint: `${base}/api/discord`,
    installServer: id ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=0&integration_type=0` : '',
    installUser: id ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=applications.commands&integration_type=1` : '',
  };
}

function persist(config) {
  const file = readJson(CONFIG_FILE, {});
  if (config.discord) {
    file.discord = { ...config.discord };
    if (config.vault) delete file.discord.token;
  } else {
    delete file.discord;
  }
  writeJson(CONFIG_FILE, file);
}

// Saves what was given; blank fields keep their current value (the token is never sent back).
export async function saveDiscord(config, b) {
  const d = { ...settings(config) };
  const appId = String(b?.appId ?? '').trim();
  const publicKey = String(b?.publicKey ?? '').trim().toLowerCase();
  const token = String(b?.token ?? '').trim();
  const ownerId = String(b?.ownerId ?? '').trim();
  if (appId && !SNOWFLAKE.test(appId)) return { error: 'The application ID is a long number (General Information page).' };
  if (publicKey && !/^[0-9a-f]{64}$/.test(publicKey)) return { error: 'The public key is 64 letters and numbers (General Information page).' };
  if (token && !/^[\w.-]{50,100}$/.test(token)) return { error: "That doesn't look like a bot token (Bot page > Reset Token)." };
  if (ownerId && !SNOWFLAKE.test(ownerId)) return { error: 'Your user ID is a long number. Use /who in Discord once the rest is set up and the bot will tell you.' };
  if (token && config.vault) {
    try {
      await writeSecret(config.vault, SECRET_NAMES.discord, token);
    } catch (err) {
      return { error: `Couldn't save the token to the vault: ${err.message}` };
    }
  }
  if (appId) d.appId = appId;
  if (publicKey) d.publicKey = publicKey;
  if (token) d.token = token;
  if (ownerId) d.ownerId = ownerId;
  config.discord = d;
  persist(config);
  console.log('Discord bot settings changed from the host page');
  if (token || appId) {
    if (d.token && d.appId) return { registered: await registerCommands(config) };
  }
  return {};
}

export async function clearDiscord(config) {
  if (config.vault && config.discord?.token) {
    await writeSecret(config.vault, SECRET_NAMES.discord, UNSET).catch((err) => console.warn('Vault:', err.message));
  }
  delete config.discord;
  persist(config);
  console.log('Discord bot settings removed from the host page');
}

async function discordApi(config, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${settings(config).token}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Discord said ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

export async function registerCommands(config) {
  const d = settings(config);
  if (!d.appId || !d.token) return { error: 'Save the application ID and bot token first.' };
  try {
    await discordApi(config, 'PUT', `/applications/${d.appId}/commands`, COMMANDS);
  } catch (err) {
    return { error: `Discord refused the commands: ${err.message}` };
  }
  d.registeredAt = new Date().toISOString();
  persist(config);
  return { ok: true };
}

// ---------- signature ----------
const ED25519_DER = Buffer.from('302a300506032b6570032100', 'hex');
function verified(publicKey, sig, ts, raw) {
  if (!/^[0-9a-f]{128}$/i.test(sig || '') || !/^\d+$/.test(ts || '')) return false;
  // Old requests are refused so a captured one can't be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_DER, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(ts + raw), key, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

// ---------- helpers ----------
const reply = (content, extra = {}) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });
const update = (content, extra = {}) => ({ type: 7, data: { content, allowed_mentions: { parse: [] }, components: [], ...extra } });
const until = (inv) => (inv.expiresAt
  ? `works until <t:${Math.floor(Date.parse(inv.expiresAt) / 1000)}:f>`
  : 'works until you revoke it');

function displayName(i, userId) {
  const user = i.data.resolved?.users?.[userId] || {};
  const member = i.data.resolved?.members?.[userId] || {};
  for (const n of [member.nick, user.global_name, user.username]) {
    const clean = String(n || '').replace(NAME_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (clean) return clean;
  }
  return 'Player';
}

// Tables that exist right now: any with a working link.
function tablesList() {
  const rooms = new Set();
  for (const inv of loadInvites()) if (inviteActive(inv)) rooms.add(inv.room);
  return [...rooms].sort();
}

const lasts = (days) => (Number(days) > 0 ? `${days} day${Number(days) === 1 ? '' : 's'}` : 'until you revoke it');

// Popup asking for a new table's name.
function newTableForm(friendId, name, days) {
  return {
    type: 9,
    data: {
      custom_id: `newtable:${friendId}:${days}:${name}`.slice(0, 100),
      title: `New table for ${name}`.slice(0, 45),
      components: [{
        type: 1,
        components: [{
          type: 4, custom_id: 'room', style: 1, label: 'Table name', placeholder: 'e.g. friday',
          min_length: 1, max_length: 32, required: true,
        }],
      }],
    },
  };
}

// Pick an existing table or make a new one; with no tables yet it goes straight to naming one.
function tablePicker(friendId, name, days) {
  const tables = tablesList();
  if (!tables.length) return newTableForm(friendId, name, days);
  return reply(`Which table should **${name}** join? (link works ${Number(days) > 0 ? 'for ' : ''}${lasts(days)})`, {
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: `pick:${friendId}:${days}:${name}`.slice(0, 100),
        placeholder: 'Pick a table',
        options: [
          ...tables.slice(0, 24).map((r) => ({ label: r, value: r })),
          { label: 'New table...', value: NEW_TABLE, description: 'Name a new table' },
        ],
      }],
    }],
  });
}

// A working link at this table for `name`, made if there isn't one. Returns { inv, reused } or { error }.
function linkFor(config, name, room, days) {
  const inv = loadInvites().find((x) => x.room === room && x.name.toLowerCase() === name.toLowerCase() && inviteActive(x));
  if (inv) return { inv, reused: true };
  const made = makeInvite(config, { name, room, days, by: 'Discord' });
  return made.error ? { error: made.error } : { inv: made.inv, reused: false };
}

// Makes (or reuses) the link and DMs it. Falls back to showing the link with a "Post here" button
// when Discord won't let the bot DM them (they share no server with the bot, or block DMs).
async function deliver(config, { friendId, name, room, days, host }) {
  const friend = linkFor(config, name, room, days);
  if (friend.error) return { content: friend.error };
  const { inv, reused } = friend;
  const url = inviteUrl(config, inv.code);
  // The host gets a link to the same table too (reused if they already have one there).
  let mine = '';
  if (host.toLowerCase() !== name.toLowerCase()) {
    const me = linkFor(config, host, room, days);
    mine = me.inv ? `\nYour link: ${inviteUrl(config, me.inv.code)}` : `\n(Couldn't make your own link: ${me.error})`;
  }
  const text = `${host} invited you to play Magic at table **${room}**: ${url}\nOpen it in Chrome, Edge or Safari; the link ${until(inv)}.`;
  try {
    const ch = await discordApi(config, 'POST', '/users/@me/channels', { recipient_id: friendId });
    await discordApi(config, 'POST', `/channels/${ch.id}/messages`, { content: text, allowed_mentions: { parse: [] } });
    console.log(`Discord: sent ${name} a link to table ${room}`);
    return { content: `Sent <@${friendId}> ${reused ? 'their existing' : 'a new'} link to table **${room}** (${until(inv)}).${mine}` };
  } catch (err) {
    console.warn(`Discord: could not DM ${name}: ${err.message}`);
    return {
      content: `Couldn't DM <@${friendId}> (${err.code === 50007 ? 'they need to share a server with the bot, or they block DMs' : err.message}). `
        + `Here is ${reused ? 'their existing' : 'a new'} link for table **${room}** (${until(inv)}):\n${url}${mine}`,
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Post it in this chat', custom_id: `post:${inv.code}` }] }],
    };
  }
}

function linksText(config) {
  const by = new Map();
  for (const inv of loadInvites()) {
    if (!inviteActive(inv)) continue;
    if (!by.has(inv.room)) by.set(inv.room, []);
    by.get(inv.room).push(inv);
  }
  if (!by.size) return 'No working links. Right-click a friend > Apps > Invite to MTG table, or use /invite.';
  let out = '';
  for (const [room, list] of [...by].sort()) {
    out += `**${room}**\n${list.map((inv) => `- ${inv.name}: ${until(inv)}`).join('\n')}\n`;
  }
  return out.length > 1900 ? `${out.slice(0, 1900)}\n...` : out;
}

async function whoText(config) {
  const live = await online(config);
  if (!live) return 'The video server is not running.';
  const rows = [...live].filter(([, names]) => names.length);
  if (!rows.length) return 'Nobody is connected.';
  return rows.map(([room, names]) => `**${room}**: ${names.join(', ')}`).join('\n');
}

// ---------- interactions ----------
async function interact(config, i) {
  const d = settings(config);
  const me = i.member?.user || i.user || {};
  const host = String(me.global_name || me.username || 'The host').replace(NAME_CHARS, '').trim() || 'The host';

  if (!d.ownerId) {
    return reply(`Almost set up. Your Discord user ID is \`${me.id}\`: paste it into the Discord section on the host page, then try again.`);
  }
  if (me.id !== d.ownerId) return reply('This bot only takes commands from its owner.');

  // Typing in the table / link boxes.
  if (i.type === 4) {
    const focused = (i.data.options || []).find((o) => o.focused);
    const q = String(focused?.value || '').toLowerCase();
    let choices = [];
    if (focused?.name === 'table') {
      choices = tablesList().filter((r) => r.toLowerCase().includes(q)).map((r) => ({ name: r, value: r }));
      if (q && /^[\w-]{1,32}$/.test(q) && !choices.some((c) => c.value.toLowerCase() === q)) choices.unshift({ name: `${focused.value} (new table)`, value: focused.value });
    } else if (focused?.name === 'link') {
      choices = loadInvites().filter((inv) => inviteActive(inv) && `${inv.name} ${inv.room}`.toLowerCase().includes(q))
        .map((inv) => ({ name: `${inv.name} at ${inv.room}`.slice(0, 100), value: inv.code }));
    }
    return { type: 8, data: { choices: choices.slice(0, 25) } };
  }

  if (i.type === 2) {
    const opt = (n) => (i.data.options || []).find((o) => o.name === n)?.value;
    switch (i.data.name) {
      case 'Invite to MTG table': {
        const friendId = i.data.target_id;
        const name = displayName(i, friendId);
        return tablePicker(friendId, name, DEFAULT_DAYS);
      }
      case 'invite': {
        const friendId = opt('friend');
        const custom = String(opt('name') || '').replace(NAME_CHARS, '').trim().slice(0, 32);
        const name = custom || displayName(i, friendId);
        const days = opt('expires') ?? DEFAULT_DAYS;
        const room = String(opt('table') || '').trim();
        if (!room) return tablePicker(friendId, name, days);
        return reply('', await deliver(config, { friendId, name, room, days, host }));
      }
      case 'links':
        return reply(linksText(config));
      case 'who':
        return reply(await whoText(config));
      case 'revoke': {
        const inv = await revokeInvite(config, opt('link'), 'Discord');
        return reply(inv ? `Revoked ${inv.name}'s link at **${inv.room}**; they've been removed from the call.` : 'No working link like that.');
      }
      default:
        return reply('Unknown command. Re-register the commands from the host page.');
    }
  }

  if (i.type === 3) {
    const [kind, ...rest] = String(i.data.custom_id).split(':');
    if (kind === 'pick') {
      const [friendId, days, ...nameParts] = rest;
      const room = i.data.values?.[0];
      if (room === NEW_TABLE) return newTableForm(friendId, nameParts.join(':'), days);
      return update('', await deliver(config, { friendId, name: nameParts.join(':'), room, days: Number(days), host }));
    }
    if (kind === 'post') {
      const inv = loadInvites().find((x) => x.code === rest[0] && inviteActive(x));
      if (!inv) return reply('That link no longer works.');
      return { type: 4, data: { content: `${inv.name}, here's your link to table **${inv.room}**: ${inviteUrl(config, inv.code)} (${until(inv)})`, allowed_mentions: { parse: [] } } };
    }
  }
  // The new-table popup was filled in.
  if (i.type === 5) {
    const [kind, friendId, days, ...nameParts] = String(i.data.custom_id).split(':');
    if (kind === 'newtable') {
      const room = String(i.data.components?.[0]?.components?.[0]?.value || '').trim();
      const result = await deliver(config, { friendId, name: nameParts.join(':'), room, days: Number(days), host });
      // Opened from the picker: replace the picker message. Opened from a command: a new reply.
      return i.message ? update('', result) : reply('', result);
    }
  }
  return reply("Sorry, I didn't understand that.");
}

// Returns true when it handled the request.
export async function handleDiscord(config, req, res, p, { send, readBody }) {
  if (p !== '/api/discord') return false;
  const d = settings(config);
  if (req.method !== 'POST' || !d.publicKey) {
    send(res, 404, { error: 'Not found' });
    return true;
  }
  if (overLimit('discord:all', 300, 60_000)) {
    send(res, 429, { error: 'Too many requests' });
    return true;
  }
  let raw;
  try {
    raw = await readBody(req, 100_000);
  } catch {
    send(res, 413, { error: 'Too large' });
    return true;
  }
  if (!verified(d.publicKey, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], raw)) {
    send(res, 401, { error: 'invalid request signature' });
    return true;
  }
  let i;
  try {
    i = JSON.parse(raw);
  } catch {
    send(res, 400, { error: 'Bad request' });
    return true;
  }
  if (i.type === 1) {
    send(res, 200, { type: 1 }); // Discord checking the endpoint
    return true;
  }
  try {
    send(res, 200, await interact(config, i));
  } catch (err) {
    console.error('Discord command failed', err);
    send(res, 200, reply('Something went wrong on the server.'));
  }
  return true;
}
