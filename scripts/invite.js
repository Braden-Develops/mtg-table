// Manage invite links.
//   npm run invite -- Jake            create a link for Jake
//   npm run invite -- Jake --room pod2
//   npm run invite -- --list          show all links
//   npm run invite -- --revoke Jake   revoke Jake's link(s)
import crypto from 'node:crypto';
import { inviteUrl, loadConfig, loadInvites, saveInvites } from './lib.js';

const config = loadConfig();
const invites = loadInvites();
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: npm run invite -- <name> [--room <room>] | --list | --revoke <name>');
  process.exit(1);
}

if (args[0] === '--list') {
  if (invites.length === 0) console.log('No invites yet.');
  for (const inv of invites) {
    const status = inv.revoked ? 'REVOKED' : 'active ';
    console.log(`${status}  ${inv.name.padEnd(16)} room=${inv.room.padEnd(10)} ${inviteUrl(config, inv.code)}`);
  }
  process.exit(0);
}

if (args[0] === '--revoke') {
  const name = args[1];
  const hits = invites.filter((i) => i.name.toLowerCase() === String(name).toLowerCase() && !i.revoked);
  if (hits.length === 0) {
    console.error(`No active invite named "${name}".`);
    process.exit(1);
  }
  for (const inv of hits) {
    inv.revoked = true;
    inv.revokedAt = new Date().toISOString();
  }
  saveInvites(invites);
  console.log(`Revoked ${hits.length} invite(s) for ${name}. Anyone already in a game keeps playing until they leave.`);
  process.exit(0);
}

const name = args[0].trim().slice(0, 32);
const roomIdx = args.indexOf('--room');
const room = (roomIdx >= 0 ? args[roomIdx + 1] : config.defaultRoom).replace(/[^\w-]/g, '').slice(0, 32) || config.defaultRoom;
const code = crypto.randomBytes(16).toString('base64url');
invites.push({ code, name, room, createdAt: new Date().toISOString(), revoked: false });
saveInvites(invites);
console.log(`Invite for ${name} (room "${room}"):\n  ${inviteUrl(config, code)}`);
