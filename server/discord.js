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
//   /hosts    owner only: let other people use these commands (add / remove / list)
//   /setup    owner only, in a server: make an MTG Table category (#tables board, #chat)
//   /tables   hosts, in a server: post the live table board in this channel
//
// The board has a card per table (who is invited, who is playing) with buttons: Play (your link,
// if a host invited you), Voice (the table's own voice channel), and for hosts Invite (pick people,
// they get DMed) and Close. Below: New table (hosts) and My links. Updated every 15 s and right
// after changes. Each table gets its own category with a chat and a voice channel, removed when the
// table is closed from the board, or 30 minutes after the table's last link ends.
//
// Set up from the host page (Discord bot section): application ID, public key, bot token, owner ID.
// With OCI Vault in use the bot token goes to the vault and is only held in memory here.
import crypto from 'node:crypto';
import path from 'node:path';
import { CONFIG_FILE, DATA_DIR, inviteUrl, loadInvites, readJson, saveInvites, writeJson } from '../scripts/lib.js';
import { closeTable, inviteActive, makeInvite, online, overLimit, revokeInvite } from './host.js';
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
// Manage Channels, View Channel, Send Messages, Embed Links, Read Message History, Pin Messages.
const P = { MANAGE_CHANNELS: 16n, VIEW: 1024n, SEND: 2048n, EMBED: 16384n, HISTORY: 65536n, PIN: 1n << 51n, REACT: 64n, THREADS: 34359738368n + 68719476736n };
const BOT_PERMISSIONS = String(P.MANAGE_CHANNELS | P.VIEW | P.SEND | P.EMBED | P.HISTORY | P.PIN);
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
  { type: 1, name: 'setup', description: 'Make the MTG Table channels in this server (owner only)', integration_types: [0], contexts: [0] },
  { type: 1, name: 'tables', description: 'Post the live table board in this channel', integration_types: [0], contexts: [0] },
  {
    type: 1, name: 'hosts', description: 'Who else can use this bot (owner only)', ...where,
    options: [
      { type: 1, name: 'add', description: 'Let someone send invites with this bot', options: [{ type: 6, name: 'user', description: 'Who', required: true }] },
      { type: 1, name: 'remove', description: 'Stop someone using this bot', options: [{ type: 6, name: 'user', description: 'Who', required: true }] },
      { type: 1, name: 'list', description: 'Everyone who can use this bot' },
    ],
  },
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
    hosts: (d.hosts || []).map((h) => ({ id: h.id, name: h.name })),
    publicKeySet: !!d.publicKey,
    tokenSet: !!d.token,
    registeredAt: d.registeredAt || null,
    endpoint: `${base}/api/discord`,
    installServer: id ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}&integration_type=0` : '',
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

export function removeHost(config, id) {
  const d = settings(config);
  const before = (d.hosts || []).length;
  d.hosts = (d.hosts || []).filter((h) => h.id !== String(id));
  if (d.hosts.length === before) return false;
  persist(config);
  console.log(`Discord: host page removed a bot user (${id})`);
  return true;
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
// "Thinking..." now, real answer later (for work that can take more than Discord's 3 seconds).
const deferred = () => ({ type: 5, data: { flags: EPHEMERAL } });
async function followUp(config, i, content, extra = {}) {
  await fetch(`${API}/webhooks/${settings(config).appId}/${i.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...extra }),
  }).catch((err) => console.warn(`Discord: follow-up failed: ${err.message}`));
}
// Private ("only you can see this") replies clean themselves up so they don't pile up in the channel:
// `ttl` is how long one stays before the bot deletes it. Interaction tokens last 15 minutes, so 14 at most.
const TTL = { quick: 15_000, read: 90_000, form: 5 * 60_000, link: 14 * 60_000 };
const reply = (content, extra = {}, ttl = TTL.read) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra }, ttl });
const update = (content, extra = {}, ttl = TTL.read) => ({ type: 7, data: { content, allowed_mentions: { parse: [] }, components: [], ...extra }, ttl });
const linkButton = (label, url) => ({ type: 2, style: 5, label: label.slice(0, 80), url });
const row = (...buttons) => ({ type: 1, components: buttons });

// One timer per private message. Later clicks on the same message (picker -> result) replace the timer,
// keyed by the interaction that first made the message. `sameMessage`: this interaction edited the message
// its button was on (rather than replying with a new one).
// Pending cleanups are also saved to disk so a restart (every deploy) doesn't leave messages behind.
// Interaction tokens stop working 15 minutes after the click, so saved entries are short-lived.
const FADES_FILE = path.join(DATA_DIR, 'discord-fades.json');
const fades = new Map(); // key -> { timer, token, at }
const saveFades = () => {
  try {
    writeJson(FADES_FILE, [...fades].map(([key, f]) => ({ key, token: f.token, at: f.at })));
  } catch (err) {
    console.warn(`Discord: could not save pending cleanups: ${err.message}`);
  }
};
function scheduleFade(config, key, token, at) {
  clearTimeout(fades.get(key)?.timer);
  const timer = setTimeout(() => {
    fades.delete(key);
    saveFades();
    fetch(`${API}/webhooks/${settings(config).appId}/${token}/messages/@original`, {
      method: 'DELETE', headers: { 'User-Agent': UA },
    }).catch(() => {});
  }, Math.max(0, at - Date.now()));
  timer.unref?.();
  fades.set(key, { timer, token, at });
}
function fade(config, i, ms, sameMessage = true) {
  const key = (sameMessage && (i.message?.interaction_metadata?.id || i.message?.interaction?.id)) || i.id;
  if (!ms) {
    clearTimeout(fades.get(key)?.timer);
    fades.delete(key);
  } else {
    scheduleFade(config, key, i.token, Date.now() + Math.min(ms, TTL.link));
  }
  saveFades();
}
// On start: pick up cleanups from before the restart (overdue ones run right away).
function restoreFades(config) {
  const saved = readJson(FADES_FILE, []);
  if (!Array.isArray(saved) || !saved.length) return;
  for (const f of saved) {
    // Past the token's life (15 min from the click, and `at` is at most 14 min after it): give up.
    if (f?.key && f.token && Date.now() - f.at < 2 * 60_000) scheduleFade(config, f.key, f.token, f.at);
  }
  saveFades();
  if (fades.size) console.log(`Discord: picked up ${fades.size} pending message cleanup(s) from before the restart`);
}
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
  }, TTL.form);
}

// A working link at this table for `name`, made if there isn't one. Returns { inv, reused } or { error }.
function linkFor(config, name, room, days, by = 'Discord', discordId = '') {
  const invites = loadInvites();
  const inv = invites.find((x) => x.room === room && x.name.toLowerCase() === name.toLowerCase() && inviteActive(x));
  if (inv) {
    if (discordId && !inv.discordId) {
      inv.discordId = discordId; // older link: remember who it belongs to for the My link button
      saveInvites(invites);
    }
    return { inv, reused: true };
  }
  const made = makeInvite(config, { name, room, days, by, discordId });
  return made.error ? { error: made.error } : { inv: made.inv, reused: false };
}

// Makes (or reuses) the link and DMs it. Falls back to showing the link with a "Post here" button
// when Discord won't let the bot DM them (they share no server with the bot, or block DMs).
async function deliver(config, { friendId, name, room, days, host, hostId, withMine = true }) {
  const friend = linkFor(config, name, room, days, `Discord (${host})`, friendId);
  boardSoon(config);
  if (friend.error) return { content: friend.error };
  const { inv } = friend;
  const url = inviteUrl(config, inv.code);
  // The host gets a link to the same table too (reused if they already have one there), as a button.
  const buttons = [];
  let note = '';
  if (withMine && host.toLowerCase() !== name.toLowerCase()) {
    const me = linkFor(config, host, room, days, `Discord (${host})`, hostId);
    if (me.inv) buttons.push(linkButton(`Open ${room}`, inviteUrl(config, me.inv.code)));
    else note = `\n-# Couldn't make your own link: ${me.error}`;
  }
  const text = `${host} invited you to play Magic at table **${room}**.\nOpen it in Chrome, Edge or Safari; the link ${until(inv)}.`;
  try {
    const ch = await discordApi(config, 'POST', '/users/@me/channels', { recipient_id: friendId });
    await discordApi(config, 'POST', `/channels/${ch.id}/messages`, {
      content: text, allowed_mentions: { parse: [] }, components: [row(linkButton(`Join ${room}`, url))],
    });
    console.log(`Discord: ${host} sent ${name} a link to table ${room}`);
    return {
      content: `✅ Sent <@${friendId}> a link to **${room}** by DM.${note}`,
      components: buttons.length ? [row(...buttons)] : [],
      ok: true,
    };
  } catch (err) {
    console.warn(`Discord: could not DM ${name}: ${err.message}`);
    return {
      content: `Couldn't DM <@${friendId}> (${err.code === 50007 ? 'they need to share a server with the bot, or they block DMs' : err.message}). `
        + `Post their link here, or copy it from the button and send it yourself. It ${until(inv)}.${note}`,
      components: [row({ type: 2, style: 1, label: 'Post it in this chat', custom_id: `post:${inv.code}` }, linkButton(`${name}'s link`, url), ...buttons)],
      ok: false,
    };
  }
}

// deliver()'s result as message parts, and how long to keep it: a link the host still needs stays longer.
const shown = (r) => [r.content, { components: r.components || [] }, r.components?.length ? TTL.link : TTL.quick];

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

// ---------- live table board ----------
const VOICE_GRACE_MS = 30 * 60_000;
const BOARD_ROWS = 4; // tables shown as cards with buttons (Discord allows 40 parts per message)

// Every table with a working link or someone connected: room -> { invited: Map(key -> name), online: Set(key) }
async function tableState(config) {
  const live = await online(config); // Map room -> [names], or null when LiveKit is down
  const tables = new Map();
  const table = (room) => {
    if (!tables.has(room)) tables.set(room, { invited: new Map(), online: new Set() });
    return tables.get(room);
  };
  for (const inv of loadInvites()) if (inviteActive(inv)) table(inv.room).invited.set(inv.name.toLowerCase(), inv.name);
  for (const [room, names] of live || []) {
    for (const n of names) {
      const t = table(room);
      t.online.add(n.toLowerCase());
      if (!t.invited.has(n.toLowerCase())) t.invited.set(n.toLowerCase(), n);
    }
  }
  return { live, tables };
}

// Discord's newer message layout: cards (containers) that hold text and buttons together.
const COMPONENTS_V2 = 1 << 15;
const BOARD_VERSION = 2;

export async function boardMessage(config) {
  const d = settings(config);
  const b = d.board || {};
  const voice = d.voice || {};
  const { live, tables } = await tableState(config);
  const rooms = [...tables.keys()].sort((a, c) => a.localeCompare(c));
  // 4 cards fit Discord's 40-part limit; any more tables are listed under them.
  const shown = BOARD_ROWS;
  const components = [{
    type: 10,
    content: `## Tables${live ? '' : '\n\u26A0\uFE0F The video server is down right now.'}`,
  }];
  for (const room of rooms.slice(0, shown)) {
    const t = tables.get(room);
    const people = [...t.invited].sort(([a], [c]) => (t.online.has(c) - t.online.has(a)) || a.localeCompare(c))
      .map(([key, n]) => `${t.online.has(key) ? '\u{1F7E2}' : '\u26AA'} ${n}`);
    const vc = voice[room];
    const status = [t.online.size ? `\u{1F7E2} ${t.online.size} playing` : 'Nobody playing yet'];
    if (vc?.textId && !vc.goneSince) status.push(`\u{1F4AC} <#${vc.textId}>`);
    const buttons = [{ type: 2, style: 1, label: 'Play', custom_id: `play:${room}` }];
    if (vc?.id && !vc.goneSince && b.guildId) buttons.push({ type: 2, style: 5, label: 'Voice', url: `https://discord.com/channels/${b.guildId}/${vc.id}` });
    buttons.push({ type: 2, style: 2, label: 'Invite', custom_id: `invite:${room}` });
    buttons.push({ type: 2, style: 4, label: 'Close', custom_id: `close:${room}` });
    components.push({
      type: 17,
      accent_color: t.online.size ? 0x3ba55d : 0x4f545c,
      components: [
        {
          type: 10,
          content: `### ${room}\n-# ${status.join('  \u00B7  ')}\n${people.join('\u2003') || '-# No one invited yet'}`.slice(0, 1500),
        },
        { type: 14, divider: true, spacing: 1 },
        { type: 1, components: buttons },
      ],
    });
  }
  if (!rooms.length) {
    components.push({ type: 17, accent_color: 0x4f545c, components: [{ type: 10, content: 'No tables right now. Hosts can start one with **New table**.' }] });
  }
  if (rooms.length > shown) {
    const more = rooms.slice(shown).map((room) => `**${room}**: ${tables.get(room).online.size} playing`).join('\n');
    components.push({ type: 17, accent_color: 0x4f545c, components: [{ type: 10, content: `More tables (invite with /invite):\n${more}`.slice(0, 1500) }] });
  }
  components.push({
    type: 1,
    components: [
      { type: 2, style: 3, label: 'New table', custom_id: 'mktable' },
      { type: 2, style: 2, label: 'My links', custom_id: 'mylink' },
    ],
  });
  return { flags: COMPONENTS_V2, components, allowed_mentions: { parse: [] } };
}

// Each table gets its own category with a chat and a voice channel; removed when the table ends.
async function deleteVoice(config, room) {
  const d = settings(config);
  const v = d.voice?.[room];
  if (!v) return;
  for (const id of [v.textId, v.id, v.categoryId]) { // children before their category
    if (!id) continue;
    await discordApi(config, 'DELETE', `/channels/${id}`).catch((err) => {
      if (err.code !== 10003) console.warn(`Discord: could not remove a channel for ${room}: ${err.message}`);
    });
  }
  delete d.voice[room];
  persist(config);
}

async function makeTableChannels(config, room) {
  const g = settings(config).board.guildId;
  const make = (body) => discordApi(config, 'POST', `/guilds/${g}/channels`, body);
  const cat = await make({ name: `\u{1F3B2} ${room}`.slice(0, 100), type: 4 });
  const text = await make({ name: `${room}-chat`.slice(0, 100), type: 0, parent_id: cat.id, topic: `Chat for table ${room}` });
  const voice = await make({ name: `${room} voice`.slice(0, 100), type: 2, parent_id: cat.id });
  const v = { id: voice.id, textId: text.id, categoryId: cat.id };
  await postLinkCard(config, room, v);
  return v;
}

// The card at the top of each table chat: Play shows each person their own link (only they see it).
// Discord can't show different text to different people in one message, so the link itself comes
// from the button. The card is the chat's first message and the channel topic links to it. (Not pinned:
// pinning adds a "pinned a message" notice the bot isn't allowed to remove.)
const CARD_VERSION = 2;
async function postLinkCard(config, room, v) {
  const g = settings(config).board?.guildId;
  // Cards from older versions are edited in place; new tables get a new one.
  const old = v.pinId && v.pinId !== 'failed' && v.cardVersion !== CARD_VERSION;
  v.cardVersion = CARD_VERSION;
  try {
    const msg = await discordApi(config, old ? 'PATCH' : 'POST', `/channels/${v.textId}/messages${old ? `/${v.pinId}` : ''}`, {
      flags: COMPONENTS_V2,
      allowed_mentions: { parse: [] },
      components: [{
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 10, content: `### \u{1F3B2} ${room}\nTap **Play** for your seat at this table.` },
          { type: 1, components: [
            { type: 2, style: 1, label: 'Play', custom_id: `play:${room}`.slice(0, 100) },
            ...(g ? [{ type: 2, style: 5, label: 'Voice', url: `https://discord.com/channels/${g}/${v.id}` }] : []),
            { type: 2, style: 2, label: 'My links', custom_id: 'mylink' },
          ] },
        ],
      }],
    });
    v.pinId = msg.id;
    if (g) {
      await discordApi(config, 'PATCH', `/channels/${v.textId}`, {
        topic: `Your seat at ${room}: tap Play here → https://discord.com/channels/${g}/${v.textId}/${msg.id}`.slice(0, 1024),
      }).catch(() => {});
    }
  } catch (err) {
    v.pinId = 'failed'; // don't retry every refresh
    console.warn(`Discord: could not post the link card for ${room}: ${err.message}`);
  }
}

async function syncVoice(config) {
  const d = settings(config);
  const b = d.board;
  if (!b?.guildId) return;
  const rooms = tablesList();
  d.voice ??= {};
  let changed = false;
  for (const room of rooms) {
    const v = d.voice[room];
    if (v) {
      if (v.goneSince) { delete v.goneSince; changed = true; }
      // Tables made before link cards, or with an older card.
      if (v.textId && (!v.pinId || (v.pinId !== 'failed' && v.cardVersion !== CARD_VERSION))) { await postLinkCard(config, room, v); changed = true; }
      continue;
    }
    try {
      d.voice[room] = await makeTableChannels(config, room);
      changed = true;
      console.log(`Discord: made the channels for table ${room}`);
    } catch (err) {
      console.warn(`Discord: could not make the channels for ${room}: ${err.message}`);
      return; // probably missing permission; try again next time
    }
  }
  for (const [room, v] of Object.entries(d.voice)) {
    if (rooms.includes(room)) continue;
    if (!v.goneSince) { v.goneSince = Date.now(); changed = true; continue; }
    if (Date.now() - v.goneSince > VOICE_GRACE_MS) {
      await deleteVoice(config, room);
      console.log(`Discord: removed the channels for ended table ${room}`);
    }
  }
  if (changed) persist(config);
}

let lastBoard = '';
let boardTimer = null;
export async function refreshBoard(config, force = false) {
  const b = settings(config).board;
  if (!b || !settings(config).token) return;
  if (b.version !== BOARD_VERSION || !b.guildId) {
    try {
      const ch = await discordApi(config, 'GET', `/channels/${b.channelId}`);
      await postBoard(config, b.channelId, ch.guild_id, ch.parent_id || null);
      console.log('Discord: reposted the table board in the new layout');
    } catch (err) {
      console.warn(`Discord: could not repost the table board: ${err.message}`);
    }
    return;
  }
  await syncVoice(config);
  const msg = await boardMessage(config);
  const key = JSON.stringify(msg);
  if (key === lastBoard && !force) return;
  try {
    await discordApi(config, 'PATCH', `/channels/${b.channelId}/messages/${b.messageId}`, msg);
    lastBoard = key;
  } catch (err) {
    if (err.code === 10008 || err.code === 10003) { // the message or channel was deleted
      delete settings(config).board;
      persist(config);
      console.warn('Discord: the table board was deleted; post a new one with /tables');
    } else {
      console.warn(`Discord: could not update the table board: ${err.message}`);
    }
  }
}
// After an invite, revoke or close, update soon instead of waiting for the next 15 s tick.
function boardSoon(config) {
  clearTimeout(boardTimer);
  boardTimer = setTimeout(() => refreshBoard(config).catch(() => {}), 1500);
}
const BOARD_TOPIC = 'Live tables and who is playing. Tap Play for your seat; hosts start tables and invite.';
// Keeps the #tables topic (made by /setup) in step with the wording above.
async function syncBoardTopic(config) {
  const b = settings(config).board;
  if (!b?.channelId || !settings(config).token) return;
  const ch = await discordApi(config, 'GET', `/channels/${b.channelId}`);
  if (ch.name === 'tables' && ch.topic !== BOARD_TOPIC) await discordApi(config, 'PATCH', `/channels/${b.channelId}`, { topic: BOARD_TOPIC });
}
export function startBoard(config) {
  restoreFades(config);
  setInterval(() => refreshBoard(config).catch(() => {}), 15_000).unref();
  setTimeout(() => {
    refreshBoard(config, true).catch(() => {});
    syncBoardTopic(config).catch(() => {});
  }, 5_000).unref();
}

async function postBoard(config, channelId, guildId, categoryId) {
  const d = settings(config);
  const old = d.board;
  if (categoryId === undefined) {
    const ch = await discordApi(config, 'GET', `/channels/${channelId}`);
    categoryId = ch.parent_id || null;
  }
  // Moving the board to another server: forget voice channels that belonged to the old one.
  if (old?.guildId && old.guildId !== guildId) d.voice = {};
  d.board = { channelId, guildId, categoryId, version: BOARD_VERSION };
  const msg = await discordApi(config, 'POST', `/channels/${channelId}/messages`, await boardMessage(config));
  d.board.messageId = msg.id;
  config.discord = d;
  persist(config);
  lastBoard = '';
  if (old?.messageId && old.messageId !== msg.id) {
    await discordApi(config, 'DELETE', `/channels/${old.channelId}/messages/${old.messageId}`).catch(() => {});
  }
  boardSoon(config);
}

// /setup: an "MTG Table" category with #tables (only the bot posts) and #chat. Each table gets its
// own voice channel there. Reuses channels with those names if they're already there.
async function setupServer(config, guildId) {
  const appId = settings(config).appId;
  const existing = await discordApi(config, 'GET', `/guilds/${guildId}/channels`);
  const find = (name, type, parent) => existing.find((c) => c.name === name && c.type === type && (parent === undefined || c.parent_id === parent));
  const make = async (body) => discordApi(config, 'POST', `/guilds/${guildId}/channels`, body);
  const cat = find('MTG Table', 4) || await make({ name: 'MTG Table', type: 4 });
  const readOnly = [
    { id: guildId, type: 0, deny: String(P.SEND | P.REACT | P.THREADS) },
    { id: appId, type: 1, allow: String(P.VIEW | P.SEND | P.EMBED | P.HISTORY) },
  ];
  const topic = BOARD_TOPIC;
  let tables = find('tables', 0, cat.id);
  if (tables && tables.topic !== topic) await discordApi(config, 'PATCH', `/channels/${tables.id}`, { topic }).catch(() => {});
  tables ||= await make({ name: 'tables', type: 0, parent_id: cat.id, topic, permission_overwrites: readOnly });
  const made = [cat.name, `#${tables.name}`];
  if (!find('chat', 0, cat.id)) made.push(`#${(await make({ name: 'chat', type: 0, parent_id: cat.id })).name}`);
  await postBoard(config, tables.id, guildId, cat.id);
  console.log(`Discord: set up the MTG Table channels in server ${guildId}`);
  return `Done: ${made.join(', ')}. The board in <#${tables.id}> updates by itself, and each table gets its own chat and voice channels.`;
}

// Re-shows the links hosts already sent this person (never makes new ones).
function myLinks(config, userId) {
  const mine = loadInvites().filter((inv) => inviteActive(inv) && inv.discordId === userId);
  if (!mine.length) return reply("You don't have a link yet. A host will invite you.", {}, TTL.quick);
  const list = mine.slice(0, 25);
  return reply(`${list.map((inv) => `**${inv.room}** ${until(inv)}`).join('\n')}\n-# Opens in Chrome, Edge or Safari.`, {
    components: Array.from({ length: Math.ceil(list.length / 5) }, (_, r) => row(...list.slice(r * 5, r * 5 + 5).map((inv) => linkButton(`Open ${inv.room}`, inviteUrl(config, inv.code))))),
  }, TTL.link);
}

// People picker for inviting to a table (up to 10 at once).
// Lists the server's members (not bots, not you, not people already at this table) when the bot may
// read the member list ("Server Members Intent" in the Developer Portal) and there are 25 or fewer;
// otherwise Discord's own people picker (bots picked there are skipped).
const memberNames = new Map(); // id -> display name, from the last member list
const cleanName = (...names) => {
  for (const n of names) {
    const c = String(n || '').replace(NAME_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (c) return c;
  }
  return 'Player';
};
let warnedIntent = false;
async function invitePicker(config, i, room, text, extraButton) {
  const extra = extraButton ? [row(extraButton)] : [];
  const guildId = i.guild_id || settings(config).board?.guildId;
  const me = (i.member?.user || i.user || {}).id;
  if (guildId) {
    try {
      const invited = new Set(loadInvites().filter((x) => x.room === room && inviteActive(x) && x.discordId).map((x) => x.discordId));
      const members = await discordApi(config, 'GET', `/guilds/${guildId}/members?limit=1000`);
      const people = members.filter((m) => m.user && !m.user.bot && m.user.id !== me && !invited.has(m.user.id))
        .map((m) => ({ id: m.user.id, name: cleanName(m.nick, m.user.global_name, m.user.username) }))
        .sort((a, c) => a.name.localeCompare(c.name));
      for (const m of people) memberNames.set(m.id, m.name);
      if (!people.length) return reply(`Everyone in this server is already invited to **${room}**.`, { components: extra }, extra.length ? TTL.link : TTL.quick);
      if (people.length <= 25) {
        return reply(text, {
          components: [{
            type: 1,
            components: [{
              type: 3, custom_id: `invpick:${room}`.slice(0, 100), placeholder: `Who should join ${room}?`.slice(0, 150),
              min_values: 1, max_values: Math.min(10, people.length),
              options: people.map((m) => ({ label: m.name, value: m.id })),
            }],
          }, ...extra],
        }, TTL.form);
      }
    } catch (err) {
      if (!warnedIntent) console.warn(`Discord: can't list server members (${err.message}); turn on Server Members Intent to hide bots from the invite list`);
      warnedIntent = true;
    }
  }
  return reply(text, {
    components: [{ type: 1, components: [{ type: 5, custom_id: `invpick:${room}`.slice(0, 100), placeholder: `Who should join ${room}?`.slice(0, 150), min_values: 1, max_values: 10 }] }, ...extra],
  }, TTL.form);
}

// ---------- interactions ----------
async function interact(config, i) {
  const d = settings(config);
  const me = i.member?.user || i.user || {};
  const host = String(me.global_name || me.username || 'The host').replace(NAME_CHARS, '').trim() || 'The host';

  if (i.type === 3 && i.data?.custom_id === 'mylink') return myLinks(config, me.id);
  const isHost = !!d.ownerId && (me.id === d.ownerId || (d.hosts || []).some((h) => h.id === me.id));
  if (i.type === 3 && String(i.data?.custom_id).startsWith('play:')) {
    const room = String(i.data.custom_id).slice(5);
    let inv = loadInvites().find((x) => x.room === room && x.discordId === me.id && inviteActive(x));
    if (!inv && isHost) {
      const mine = linkFor(config, host, room, DEFAULT_DAYS, `Discord (${host})`, me.id);
      if (mine.error) return reply(mine.error);
      inv = mine.inv;
      boardSoon(config);
    }
    if (!inv) return reply(`You're not invited to **${room}** yet. Ask a host.`, {}, TTL.quick);
    return reply(`Your seat at **${room}** is ready. The link ${until(inv)}.\n-# Opens in Chrome, Edge or Safari.`, {
      components: [row(linkButton(`Open ${room}`, inviteUrl(config, inv.code)))],
    }, TTL.link);
  }

  if (!d.ownerId) {
    return reply(`Almost set up. Your Discord user ID is \`${me.id}\`: paste it into the Discord section on the host page, then try again.`);
  }
  const isOwner = me.id === d.ownerId;
  if (!isOwner && !(d.hosts || []).some((h) => h.id === me.id)) return reply('Only hosts can do that. Invited? Tap Play or My links on the table board.', {}, TTL.quick);

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
        if (i.data.resolved?.users?.[friendId]?.bot) return reply("Bots can't play.");
        const name = displayName(i, friendId);
        return tablePicker(friendId, name, DEFAULT_DAYS);
      }
      case 'invite': {
        const friendId = opt('friend');
        if (i.data.resolved?.users?.[friendId]?.bot) return reply("Bots can't play.");
        const custom = String(opt('name') || '').replace(NAME_CHARS, '').trim().slice(0, 32);
        const name = custom || displayName(i, friendId);
        const days = opt('expires') ?? DEFAULT_DAYS;
        const room = String(opt('table') || '').trim();
        if (!room) return tablePicker(friendId, name, days);
        return reply(...shown(await deliver(config, { friendId, name, room, days, host, hostId: me.id })));
      }
      case 'links':
        return reply(linksText(config));
      case 'setup': {
        if (!isOwner) return reply('Only the owner can set up channels.');
        if (!i.guild_id) return reply('Run this in your server.');
        return { ...deferred(), ttl: TTL.read, after: async () => followUp(config, i, await setupServer(config, i.guild_id).catch((err) => `Couldn't set up: ${err.message}. Add the bot to this server again with the "to a server" link on the host page (it asks for Manage Channels).`)) };
      }
      case 'tables': {
        if (!i.guild_id) return reply('Run this in a server channel.');
        const channelId = i.channel_id || i.channel?.id;
        return { ...deferred(), ttl: TTL.quick, after: async () => followUp(config, i, await postBoard(config, channelId).then(() => 'Posted the table board here; it updates by itself.', (err) => `Couldn't post here: ${err.message}. The bot needs to be able to send messages in this channel.`)) };
      }
      case 'hosts': {
        if (!isOwner) return reply('Only the owner can change who can use this bot.');
        const sub = i.data.options?.[0];
        const list = d.hosts || [];
        if (sub?.name === 'list') {
          return reply(list.length ? `Besides you, these people can use the bot:\n${list.map((h) => `- <@${h.id}> (${h.name})`).join('\n')}` : 'Only you can use the bot. Add someone with /hosts add.');
        }
        const id = sub?.options?.find((o) => o.name === 'user')?.value;
        if (!SNOWFLAKE.test(String(id || ''))) return reply('Pick a user.');
        if (sub.name === 'add') {
          if (id === d.ownerId) return reply("That's you; you can always use it.");
          if (i.data.resolved?.users?.[id]?.bot) return reply("Bots can't be hosts.");
          const name = displayName(i, id);
          d.hosts = [...list.filter((h) => h.id !== id), { id, name, addedAt: new Date().toISOString() }];
          config.discord = d;
          persist(config);
          console.log(`Discord: ${host} let ${name} (${id}) use the bot`);
          return reply(`<@${id}> can now send invites with this bot (right-click a friend > Apps > Invite to MTG table, /invite, /links, /revoke, /who). They need the bot added to their account or to a server they're in.`);
        }
        if (sub.name === 'remove') {
          if (!list.some((h) => h.id === id)) return reply(`<@${id}> wasn't a host.`);
          d.hosts = list.filter((h) => h.id !== id);
          config.discord = d;
          persist(config);
          console.log(`Discord: ${host} stopped ${id} using the bot`);
          return reply(`<@${id}> can no longer use this bot. Links they already sent keep working; revoke them with /revoke if needed.`);
        }
        return reply('Use /hosts add, /hosts remove or /hosts list.');
      }
      case 'who':
        return reply(await whoText(config));
      case 'revoke': {
        const inv = await revokeInvite(config, opt('link'), `Discord (${host})`);
        boardSoon(config);
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
      return update(...shown(await deliver(config, { friendId, name: nameParts.join(':'), room, days: Number(days), host, hostId: me.id })));
    }
    if (kind === 'invite') return invitePicker(config, i, rest.join(':'), `Who should join **${rest.join(':')}**? They'll get the link by DM.`);
    if (kind === 'invpick') {
      const room = rest.join(':');
      const ids = (i.data.values || []).filter((id) => !i.data.resolved?.users?.[id]?.bot);
      // DMs can take a moment each, so answer "working" first and fill in the result.
      return {
        type: 6,
        ttl: TTL.link,
        after: async () => {
          const lines = [];
          const buttons = [];
          for (const friendId of ids) {
            let name = i.data.resolved?.users?.[friendId] ? displayName(i, friendId) : memberNames.get(friendId);
            if (!name) {
              const m = await discordApi(config, 'GET', `/guilds/${i.guild_id}/members/${friendId}`).catch(() => null);
              name = cleanName(m?.nick, m?.user?.global_name, m?.user?.username);
            }
            const r = await deliver(config, { friendId, name, room, days: DEFAULT_DAYS, host, hostId: me.id, withMine: false });
            lines.push(r.content);
            if (!r.ok) for (const b of r.components?.[0]?.components || []) buttons.push(b);
          }
          const mine = linkFor(config, host, room, DEFAULT_DAYS, `Discord (${host})`, me.id);
          if (mine.inv) buttons.push(linkButton(`Open ${room}`, inviteUrl(config, mine.inv.code)));
          boardSoon(config);
          const rows = [];
          for (let n = 0; n < buttons.length && rows.length < 5; n += 5) rows.push(row(...buttons.slice(n, n + 5)));
          await followUp(config, i, lines.join('\n').slice(0, 1990) || 'Nobody picked.', { components: rows });
          // Everyone got their DM: the summary only needs a short look. Otherwise keep the links around.
          fade(config, i, buttons.length <= 1 ? TTL.read : TTL.link);
        },
      };
    }
    if (kind === 'close') {
      const room = rest.join(':');
      return reply(`Close **${room}**? Everyone's link stops working, the video call ends and its chat and voice channels are removed.`, {
        components: [row(
          { type: 2, style: 4, label: `Close ${room}`.slice(0, 80), custom_id: `closeyes:${room}`.slice(0, 100) },
          { type: 2, style: 2, label: 'Keep it', custom_id: 'dismiss' },
        )],
      }, TTL.form);
    }
    if (kind === 'dismiss') return { type: 6, ttl: 1 }; // just remove this message
    if (kind === 'closeyes') {
      const room = rest.join(':');
      await closeTable(config, room, `Discord (${host})`);
      await deleteVoice(config, room);
      boardSoon(config);
      return update(`Closed **${room}**.`, {}, TTL.quick);
    }
    if (kind === 'mktable') {
      return {
        type: 9,
        data: {
          custom_id: 'mktable',
          title: 'New table',
          components: [{ type: 1, components: [{ type: 4, custom_id: 'room', style: 1, label: 'Table name', placeholder: 'e.g. friday', min_length: 1, max_length: 32, required: true }] }],
        },
      };
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
    if (kind === 'mktable') {
      const room = String(i.data.components?.[0]?.components?.[0]?.value || '').trim();
      if (tablesList().includes(room)) return invitePicker(config, i, room, `**${room}** already exists. Who should join?`);
      const mine = linkFor(config, host, room, DEFAULT_DAYS, `Discord (${host})`, me.id);
      if (mine.error) return reply(mine.error);
      boardSoon(config);
      return invitePicker(config, i, room, `Made **${room}**; its chat and voice channels appear in a moment. Who should join?`, linkButton(`Open ${room}`, inviteUrl(config, mine.inv.code)));
    }
    if (kind === 'newtable') {
      const room = String(i.data.components?.[0]?.components?.[0]?.value || '').trim();
      const result = shown(await deliver(config, { friendId, name: nameParts.join(':'), room, days: Number(days), host, hostId: me.id }));
      // Opened from the picker: replace the picker message. Opened from a command: a new reply.
      return i.message ? update(...result) : reply(...result);
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
    const { after, ttl, ...response } = await interact(config, i);
    send(res, 200, response);
    // Only private messages fade; public ones (the "Post it in this chat" link) and popups stay.
    const priv = response.type === 5 || ((response.type === 6 || response.type === 7) && i.message?.flags & EPHEMERAL)
      || (response.type === 4 && response.data?.flags & EPHEMERAL);
    if (priv && ttl) fade(config, i, ttl, response.type === 6 || response.type === 7);
    if (after) after().catch((err) => console.error('Discord command failed', err));
  } catch (err) {
    console.error('Discord command failed', err);
    send(res, 200, reply('Something went wrong on the server.'));
  }
  return true;
}
