// Oracle Cloud spend for Grafana (Oracle Cloud server only): month-to-date cost per service from
// the Usage API, and each budget's limit, actual and forecast spend from the Budgets API. Fetched
// once an hour, served on /metrics by server/metrics.js.
//
// Oracle's own numbers run several hours behind (up to about a day), so this is "spend as of
// Oracle's last update", not a live meter. The real alarm is the budget's email alert, which Oracle
// sends even when this VM is down.
//
// The VM signs in as itself (instance principal, like server/secrets.js) and needs two read-only
// policy lines, added by deploy/oci-vault-setup.sh: read usage-report and read usage-budgets.
// Until they exist the fetch fails quietly and the metrics just aren't there.
import { whereAmI } from './secrets.js';

const REFRESH_MS = 60 * 60_000;

// Last good result of each fetch, or null.
export const cost = { usage: null, budgets: null };

let clients = null;
async function connect() {
  if (clients) return clients;
  const [common, usageapi, budget] = await Promise.all([import('oci-common'), import('oci-usageapi'), import('oci-budget')]);
  const { region } = await whereAmI();
  const builder = new common.InstancePrincipalsAuthenticationDetailsProviderBuilder();
  const provider = await builder.build();
  const u = new usageapi.UsageapiClient({ authenticationDetailsProvider: provider });
  const b = new budget.BudgetClient({ authenticationDetailsProvider: provider });
  u.region = common.Region.fromRegionId(region);
  b.region = common.Region.fromRegionId(region);
  clients = { u, b, tenancy: builder.tenancyId };
  return clients;
}

// Month-to-date cost per service, in the tenancy's billing currency.
async function fetchUsage() {
  const { u, tenancy } = await connect();
  const now = new Date();
  const details = {
    tenantId: tenancy,
    timeUsageStarted: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    timeUsageEnded: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    granularity: 'MONTHLY',
    queryType: 'COST',
    groupBy: ['service'],
  };
  const services = new Map();
  let currency = '';
  let page;
  do {
    const r = await u.requestSummarizedUsages({ requestSummarizedUsagesDetails: details, page });
    for (const item of r.usageAggregation?.items || []) {
      const name = item.service || 'Other';
      services.set(name, (services.get(name) || 0) + (item.computedAmount || 0));
      currency ||= item.currency || '';
    }
    page = r.opcNextPage;
  } while (page);
  return { currency, services, fetchedAt: Date.now() };
}

// Every budget in the tenancy: limit, spend so far and Oracle's forecast for the period.
async function fetchBudgets() {
  const { b, tenancy } = await connect();
  const out = [];
  let page;
  do {
    const r = await b.listBudgets({ compartmentId: tenancy, targetType: 'ALL', page });
    for (const x of r.items || []) {
      if (x.lifecycleState !== 'ACTIVE') continue;
      out.push({ name: x.displayName, amount: x.amount, actual: x.actualSpend || 0, forecast: x.forecastedSpend || 0 });
    }
    page = r.opcNextPage;
  } while (page);
  return { items: out, fetchedAt: Date.now() };
}

const warned = new Set();
async function refresh() {
  const run = async (key, fn, label) => {
    try {
      cost[key] = await fn();
      if (warned.delete(key)) console.log(`OCI ${label}: working again`);
    } catch (err) {
      // Log once, not every hour: usually the policy isn't there yet.
      if (!warned.has(key)) console.warn(`OCI ${label} unavailable: ${err.message}`);
      warned.add(key);
    }
  };
  await run('usage', fetchUsage, 'cost (Usage API)');
  await run('budgets', fetchBudgets, 'budgets');
}

// Only on the Oracle server (where the vault is) and only when metrics are switched on.
export function startCost(config) {
  if (!config.vault || !config.metricsToken) return;
  setTimeout(refresh, 10_000).unref();
  setInterval(refresh, REFRESH_MS).unref();
}
