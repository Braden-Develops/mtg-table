// Move the server's secrets into OCI Vault, or back to data/config.json.
//   sudo -u mtg node scripts/vault.js on       use the vault (run deploy/oci-vault-setup.sh in Cloud Shell first)
//   sudo -u mtg node scripts/vault.js off      copy the secrets back into data/config.json
//   sudo -u mtg node scripts/vault.js status
// Restart the server afterwards. Turning it on switches to the vault's freshly generated LiveKit secret,
// so the old one on disk becomes useless, and everyone has to log in to the host page again.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { locateVault, readSecret, SECRET_NAMES, UNSET, writeSecret } from '../server/secrets.js';
import { CONFIG_FILE, ROOT, readJson, writeJson } from './lib.js';

const cmd = process.argv[2];
const config = readJson(CONFIG_FILE, null);
if (!config) {
  console.error('No data/config.json yet. Run setup first.');
  process.exit(1);
}
const rerunSetup = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};

if (cmd === 'on') {
  const vault = config.vault || await locateVault();
  const livekit = await readSecret(vault, SECRET_NAMES.livekit);
  if (livekit.length < 32) throw new Error('The LiveKit secret in the vault looks wrong.');
  if (config.discord?.token) {
    await writeSecret(vault, SECRET_NAMES.discord, config.discord.token);
    delete config.discord.token;
    console.log('Moved the Discord bot token into the vault.');
  }
  delete config.apiSecret;
  config.vault = vault;
  writeJson(CONFIG_FILE, config);
  rerunSetup();
  console.log('Secrets now come from OCI Vault; none are left in data/. Restart the server: sudo systemctl restart mtg-table');
} else if (cmd === 'off') {
  if (!config.vault) {
    console.log('The vault is not in use.');
    process.exit(0);
  }
  config.apiSecret = await readSecret(config.vault, SECRET_NAMES.livekit);
  const token = await readSecret(config.vault, SECRET_NAMES.discord);
  if (token && token !== UNSET) config.discord = { ...(config.discord || {}), token };
  delete config.vault;
  writeJson(CONFIG_FILE, config);
  rerunSetup();
  console.log('Secrets copied back into data/config.json. Restart the server: sudo systemctl restart mtg-table');
} else if (cmd === 'status') {
  if (!config.vault) {
    console.log('Not using the vault; secrets are in data/config.json.');
  } else {
    const token = await readSecret(config.vault, SECRET_NAMES.discord);
    await readSecret(config.vault, SECRET_NAMES.livekit);
    console.log(`Using OCI Vault (${config.vault.region}). LiveKit secret: readable. Discord token: ${token && token !== UNSET ? 'set' : 'not set'}.`);
  }
} else {
  console.log('Usage: node scripts/vault.js on | off | status');
  process.exit(1);
}
