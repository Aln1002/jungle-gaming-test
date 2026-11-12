import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';

await ConfigModule.forRoot({ envFilePath: ['config/env/keycloak.local.env'] });

const api = process.env.LOAD_API_URL ?? 'http://localhost:3000';
const identity = process.env.LOAD_IDP_URL ?? 'http://localhost:8080';
const secret = process.env.KEYCLOAK_LOCAL_CLIENT_SECRET;
const count = Number(process.env.LOAD_REQUESTS ?? '30');
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? '10');
if (!secret) throw new Error('KEYCLOAK_LOCAL_CLIENT_SECRET is required');
if (!Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error('LOAD_REQUESTS must be an integer between 1 and 1000');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100)
  throw new Error('LOAD_CONCURRENCY must be an integer between 1 and 100');

const tokenResponse = await fetch(
  `${identity}/realms/wagering/protocol/openid-connect/token`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'wagering-api',
      client_secret: secret,
    }),
  },
);
if (!tokenResponse.ok)
  throw new Error(`Token request failed: HTTP ${tokenResponse.status}`);
const tokenResult = (await tokenResponse.json()) as { access_token?: string };
if (!tokenResult.access_token)
  throw new Error('Token response has no access token');
const headers = {
  authorization: `Bearer ${tokenResult.access_token}`,
  'content-type': 'application/json',
};

async function createWallet(): Promise<{ id: string; playerId: string }> {
  const playerId = randomUUID();
  const response = await fetch(`${api}/wallets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  if (!response.ok)
    throw new Error(`Wallet creation failed: HTTP ${response.status}`);
  const wallet = (await response.json()) as { id: string; playerId: string };
  if (!wallet.id || wallet.playerId !== playerId)
    throw new Error('Invalid wallet response');
  return wallet;
}

async function runScenario(
  name: string,
  walletCount: number,
  duplicate: boolean,
) {
  const wallets = await Promise.all(
    Array.from({ length: walletCount }, () => createWallet()),
  );
  const ids = wallets.map(() => randomUUID());
  const elapsed: number[] = [];
  const statuses = new Map<number, number>();
  const transactions = new Set<string>();
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= count) return;
        const walletIndex = index % wallets.length;
        const wallet = wallets[walletIndex];
        const externalId = duplicate ? ids[walletIndex] : randomUUID();
        const requestStarted = performance.now();
        const response = await fetch(`${api}/wagering/transactions`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': `load:${externalId}` },
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId: externalId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'load-round',
            gameId: 'load-game',
            kind: 'BET',
            money: { amount: '0.01', currency: 'BRL' },
          }),
        });
        elapsed.push(performance.now() - requestStarted);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (response.ok) {
          const result = (await response.json()) as {
            transactionId?: string;
            status?: string;
          };
          if (!result.transactionId || result.status !== 'PROCESSED')
            throw new Error(`${name}: unexpected transaction result`);
          transactions.add(result.transactionId);
        } else {
          await response.arrayBuffer();
        }
      }
    }),
  );
  const durationMs = performance.now() - started;
  const sorted = elapsed.sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  const failures = count - (statuses.get(201) ?? 0);
  const expectedTransactions = duplicate ? wallets.length : count;
  let consistent = true;
  for (const [index, wallet] of wallets.entries()) {
    const response = await fetch(`${api}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers,
    });
    if (!response.ok)
      throw new Error(`${name}: reconciliation HTTP ${response.status}`);
    const result = (await response.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
    };
    const debitCount = duplicate
      ? 1
      : Math.ceil((count - index) / wallets.length);
    const remaining = 10_000n - BigInt(debitCount);
    const expected = `${remaining / 100n}.${String(remaining % 100n).padStart(2, '0')}`;
    if (!result.consistent || result.storedBalance.amount !== expected)
      consistent = false;
  }
  const report = {
    scenario: name,
    requests: count,
    concurrency,
    durationMs: Math.round(durationMs),
    throughputPerSecond: Number((count / (durationMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    },
    statusCounts: Object.fromEntries(statuses),
    errorRate: failures / count,
    uniqueTransactions: transactions.size,
    expectedTransactions,
    reconciled: consistent,
  };
  console.log(JSON.stringify(report));
  if (failures || transactions.size !== expectedTransactions || !consistent)
    throw new Error(`${name}: load scenario failed correctness checks`);
}

console.log(
  JSON.stringify({
    environment: 'local Docker Compose',
    api,
    concurrency,
    requestsPerScenario: count,
  }),
);
await runScenario('hot-wallet', 1, false);
await runScenario('separate-wallets', Math.min(5, count), false);
await runScenario('duplicate-idempotency', 1, true);
const metricsResponse = await fetch(`${api}/metrics`);
if (!metricsResponse.ok)
  throw new Error(`Metrics request failed: HTTP ${metricsResponse.status}`);
const metrics = await metricsResponse.text();
for (const name of [
  'wagering_lock_conflicts_total',
  'wagering_outbox_lag_milliseconds',
]) {
  const line = metrics.split('\n').find((item) => item.startsWith(`${name} `));
  if (!line) throw new Error(`Missing metric: ${name}`);
  console.log(line);
}
