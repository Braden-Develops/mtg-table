// Secrets kept in OCI Vault instead of on disk (Oracle Cloud server only).
//
// When data/config.json has a "vault" section, the LiveKit API secret (which also signs host logins)
// and the Discord bot token are fetched from the vault at startup and live only in memory. The VM
// proves who it is with an instance principal (OCI's built-in machine identity), so no credential
// for the vault is stored anywhere either. Set up with deploy/oci-vault-setup.sh in Cloud Shell, then
// `sudo -u mtg node scripts/vault.js on` on the server.
//
// Without a "vault" section everything stays in data/config.json as before (home and LAN use).

export const SECRET_NAMES = { livekit: 'mtg-livekit-secret', discord: 'mtg-discord-token' };
export const UNSET = 'unset';

let clients = null;
async function connect(region) {
  if (clients) return clients;
  const [common, secrets, vault] = await Promise.all([import('oci-common'), import('oci-secrets'), import('oci-vault')]);
  const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  const s = new secrets.SecretsClient({ authenticationDetailsProvider: provider });
  const v = new vault.VaultsClient({ authenticationDetailsProvider: provider });
  s.region = common.Region.fromRegionId(region);
  v.region = common.Region.fromRegionId(region);
  clients = { s, v };
  return clients;
}

// This VM's compartment and region, from the instance metadata service.
export async function whereAmI() {
  const res = await fetch('http://169.254.169.254/opc/v2/instance/', {
    headers: { Authorization: 'Bearer Oracle' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error('Not running on Oracle Cloud (no instance metadata).');
  const m = await res.json();
  return { compartmentId: m.compartmentId, region: m.canonicalRegionName };
}

// Finds the vault holding the MTG secrets. Returns { vaultId, compartmentId, region }.
export async function locateVault() {
  const { compartmentId, region } = await whereAmI();
  const { v } = await connect(region);
  const r = await v.listSecrets({ compartmentId, name: SECRET_NAMES.livekit, lifecycleState: 'ACTIVE' });
  const found = r.items?.[0];
  if (!found) throw new Error(`No secret named ${SECRET_NAMES.livekit}. Run deploy/oci-vault-setup.sh in Cloud Shell first.`);
  return { vaultId: found.vaultId, compartmentId, region };
}

export async function readSecret(vault, name) {
  const { s } = await connect(vault.region);
  const r = await s.getSecretBundleByName({ secretName: name, vaultId: vault.vaultId });
  return Buffer.from(r.secretBundle.secretBundleContent.content, 'base64').toString('utf8');
}

export async function writeSecret(vault, name, value) {
  const { v } = await connect(vault.region);
  const r = await v.listSecrets({ compartmentId: vault.compartmentId, vaultId: vault.vaultId, name, lifecycleState: 'ACTIVE' });
  const id = r.items?.[0]?.id;
  if (!id) throw new Error(`No secret named ${name} in the vault.`);
  await v.updateSecret({
    secretId: id,
    updateSecretDetails: { secretContent: { contentType: 'BASE64', content: Buffer.from(String(value)).toString('base64') } },
  });
}

// Fills config.apiSecret and config.discord.token from the vault (in memory only). Retries for a
// while, since right after a reboot the network or OCI may not answer yet.
export async function loadSecrets(config) {
  if (!config.vault) return;
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const [livekit, discord] = await Promise.all([
        readSecret(config.vault, SECRET_NAMES.livekit),
        readSecret(config.vault, SECRET_NAMES.discord),
      ]);
      config.apiSecret = livekit;
      if (discord && discord !== UNSET) config.discord = { ...(config.discord || {}), token: discord };
      console.log('Secrets loaded from OCI Vault');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`Could not read secrets from OCI Vault (try ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`Secrets unavailable: ${lastErr?.message}`);
}
