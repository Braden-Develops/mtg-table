// Shared paths and helpers for the setup, invite and server scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
export const LIVEKIT_YAML = path.join(DATA_DIR, 'livekit.yaml');
export const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
export const KEY_FILE = path.join(DATA_DIR, 'key.pem');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadConfig() {
  const config = readJson(CONFIG_FILE, null);
  if (!config) {
    console.error('No config found. Run "npm run setup" first.');
    process.exit(1);
  }
  return config;
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export function loadInvites() {
  return readJson(INVITES_FILE, []);
}

export function saveInvites(invites) {
  writeJson(INVITES_FILE, invites);
}

export function inviteUrl(config, code) {
  return `${config.publicUrl.replace(/\/$/, '')}/join/${code}`;
}
