// Set the password for the /host page.
//   npm run host-password                 make up a strong random password and print it
//   npm run host-password -- "my words"    use your own (at least 10 characters)
// Changing the password logs out every browser that was logged in. Restart the server afterwards.
import crypto from 'node:crypto';
import { hashPassword } from '../server/host.js';
import { CONFIG_FILE, loadConfig, writeJson } from './lib.js';

const config = loadConfig();
const given = process.argv[2];
if (given && given.length < 10) {
  console.error('Use at least 10 characters.');
  process.exit(1);
}
const password = given || crypto.randomBytes(12).toString('base64url');
config.hostPassword = hashPassword(password);
writeJson(CONFIG_FILE, config);
console.log(given ? 'Host password set.' : `Host password: ${password}\n(Save it in your password manager. It is not stored anywhere in readable form.)`);
console.log('Restart the server for the change to take effect.');
