// Make a new token for the /metrics endpoint (Prometheus / Grafana Alloy scraping).
//   npm run metrics-token          print a new token; the old one stops working
//   npm run metrics-token -- off   turn the endpoint off
// Only a hash is stored. Restart the server afterwards.
import crypto from 'node:crypto';
import { hashToken } from '../server/metrics.js';
import { CONFIG_FILE, loadConfig, writeJson } from './lib.js';

const config = loadConfig();
if (process.argv[2] === 'off') {
  delete config.metricsToken;
  writeJson(CONFIG_FILE, config);
  console.log('Metrics endpoint turned off. Restart the server.');
} else {
  const token = crypto.randomBytes(32).toString('base64url');
  config.metricsToken = hashToken(token);
  writeJson(CONFIG_FILE, config);
  console.log(`Metrics token: ${token}\n(Put it in your scraper config. It is not stored anywhere in readable form.)`);
  console.log('Restart the server for the change to take effect.');
}
