import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataSource } from 'typeorm';

const api = process.env.E2E_API_URL;
const identity = process.env.E2E_IDP_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT;
const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = process.env.KEYCLOAK_LOCAL_CLIENT_SECRET;
if (
  (api || identity) &&
  (!api || !identity || !endpoint || !secret || !databaseUrl)
) {
  throw new Error(
    'Isolated E2E API, identity, SQS, database and client secret are required',
  );
}
const queueUrl = `${endpoint}/000000000000/wager-transactions.fifo`;
const eventsUrl = `${endpoint}/000000000000/wager-events.fifo`;
const sqs = new SQSClient({
  endpoint,
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});
let token = '';

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

const e2eSuite =
  api && identity && endpoint && secret && databaseUrl
    ? describe
    : describe.skip;

e2eSuite('Isolated full-stack HTTP and SQS', () => {
  const source = new DataSource({ type: 'postgres', url: databaseUrl });
  beforeAll(async () => {
    await source.initialize();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(
          `${identity}/realms/wagering/protocol/openid-connect/token`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: 'wagering-api',
              client_secret: secret ?? '',
            }),
          },
        );
      } catch (error) {
        if (attempt === 59) throw error;
        await Bun.sleep(1_000);
        continue;
      }
      if (response.ok) {
        const body = (await response.json()) as { access_token?: string };
        if (!body.access_token)
          throw new Error('Identity response has no token');
        token = body.access_token;
        return;
      }
      if (response.status < 500 && response.status !== 404) {
        throw new Error(
          `Identity token request failed: HTTP ${response.status}`,
        );
      }
      await Bun.sleep(1_000);
    }
    throw new Error('Identity provider did not become ready');
  }, 70_000);

  afterAll(async () => {
    sqs.destroy();
    if (source.isInitialized) await source.destroy();
  });

  it('returns an auditable terminal FAILED response after a real database permission failure', async () => {
    const playerId = randomUUID();
    const created = await request('/wallets', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `e2e_permission_${suffix}`;
    const triggerName = `e2e_permission_trigger_${suffix}`;
    const key = randomUUID();
    const body = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'e2e-failure',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const submit = () =>
      request('/wagering/transactions', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    await source.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'injected permission failure' USING ERRCODE = '42501'; END; $$`,
    );
    try {
      await source.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON wallet_ledger_entries
         FOR EACH ROW WHEN (NEW.wallet_id = '${wallet.id}'::uuid)
         EXECUTE FUNCTION ${functionName}()`,
      );
      const first = await submit();
      expect(first.status).toBe(503);
      const result = (await first.json()) as {
        transactionId: string;
        status: string;
        failureCode: string;
        idempotentReplay: boolean;
      };
      expect(result).toMatchObject({
        status: 'FAILED',
        failureCode: 'INFRASTRUCTURE_PERMISSION_DENIED',
        idempotentReplay: false,
      });
      const replay = await submit();
      expect(replay.status).toBe(503);
      expect(await replay.json()).toMatchObject({
        transactionId: result.transactionId,
        status: 'FAILED',
        idempotentReplay: true,
      });
      let failedEventFound = false;
      for (let attempt = 0; attempt < 25 && !failedEventFound; attempt += 1) {
        const batch = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          }),
        );
        for (const message of batch.Messages ?? []) {
          if (!message.Body || !message.ReceiptHandle) {
            throw new Error('Published message is missing body or receipt');
          }
          const event = JSON.parse(message.Body) as {
            eventType: string;
            data: { transactionId?: string; failureCode?: string };
          };
          if (
            event.eventType === 'WagerTransactionFailed' &&
            event.data.transactionId === result.transactionId
          ) {
            expect(event.data.failureCode).toBe(
              'INFRASTRUCTURE_PERMISSION_DENIED',
            );
            failedEventFound = true;
          }
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: eventsUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      expect(failedEventFound).toBe(true);
      const ledger = await request(`/wallets/${wallet.id}/ledger`);
      expect(ledger.status).toBe(200);
      expect(
        ((await ledger.json()) as { items: unknown[] }).items,
      ).toHaveLength(1);
      const reconciliation = await request(
        `/wallets/${wallet.id}/reconciliation`,
        { method: 'POST' },
      );
      expect(reconciliation.status).toBe(200);
      expect(await reconciliation.json()).toMatchObject({
        storedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
      });
    } finally {
      await source.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON wallet_ledger_entries`,
      );
      await source.query(`DROP FUNCTION ${functionName}()`);
    }
  }, 70_000);

  it('rejects malformed money, extreme values and invalid ownership without changing funds', async () => {
    const playerId = randomUUID();
    const validMoney = { amount: '1.00', currency: 'BRL' };
    for (const initialBalance of [
      [],
      [validMoney],
      null,
      '1.00',
      { amount: 'NaN', currency: 'BRL' },
      { amount: 'Infinity', currency: 'BRL' },
      { amount: '1e2', currency: 'BRL' },
      { amount: '-1.00', currency: 'BRL' },
      { amount: '1.001', currency: 'BRL' },
      { amount: 1, currency: 'BRL' },
      { amount: '1000000000000000000.00', currency: 'BRL' },
      { amount: '1.00', currency: 'ZZZ' },
    ]) {
      const response = await request('/wallets', {
        method: 'POST',
        body: JSON.stringify({ playerId, initialBalance }),
      });
      expect(response.status).toBe(400);
    }

    const created = await request('/wallets', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '999999999999999999.99', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    const base = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'adversarial-test',
      kind: 'WIN',
      money: validMoney,
    };
    const submit = (body: object) =>
      request('/wagering/transactions', {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify(body),
      });

    for (const money of [[], [validMoney], null, '1.00']) {
      expect((await submit({ ...base, money })).status).toBe(400);
    }
    for (const [changes, failureCode] of [
      [
        { money: { amount: '0.01', currency: 'BRL' } },
        'BALANCE_LIMIT_EXCEEDED',
      ],
      [{ money: { amount: '0.01', currency: 'USD' } }, 'CURRENCY_MISMATCH'],
      [{ playerId: randomUUID() }, 'PLAYER_MISMATCH'],
      [{ walletId: randomUUID() }, 'WALLET_NOT_FOUND'],
    ] as const) {
      const response = await submit({
        ...base,
        ...changes,
        externalTransactionId: randomUUID(),
      });
      expect(response.status).toBe(422);
      expect(
        ((await response.json()) as { failureCode: string }).failureCode,
      ).toBe(failureCode);
    }
    expect((await request(`/wallets/${randomUUID()}`)).status).toBe(404);
    const reconciliation = await request(
      `/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    );
    expect(reconciliation.status).toBe(200);
    const result = (await reconciliation.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
    };
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe('999999999999999999.99');
  }, 70_000);

  it('rejects a rollback that would overdraw the wallet over HTTP', async () => {
    const playerId = randomUUID();
    const created = await request('/wallets', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    const winId = randomUUID();
    const common = {
      providerId: 'provider-a',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'rollback-negative',
      money: { amount: '50.00', currency: 'BRL' },
    };
    const submit = (body: object) =>
      request('/wagering/transactions', {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify(body),
      });
    expect(
      (
        await submit({
          ...common,
          externalTransactionId: winId,
          kind: 'WIN',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await submit({
          ...common,
          externalTransactionId: randomUUID(),
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(201);
    const rollback = await submit({
      ...common,
      externalTransactionId: randomUUID(),
      kind: 'ROLLBACK',
      referenceExternalTransactionId: winId,
    });
    expect(rollback.status).toBe(422);
    expect(await rollback.json()).toMatchObject({
      status: 'REJECTED',
      failureCode: 'ROLLBACK_NEGATIVE_BALANCE',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    const ledger = await request(`/wallets/${wallet.id}/ledger`);
    expect(ledger.status).toBe(200);
    expect(((await ledger.json()) as { items: unknown[] }).items).toHaveLength(
      2,
    );
    const reconciliation = await request(
      `/wallets/${wallet.id}/reconciliation`,
      {
        method: 'POST',
      },
    );
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: { amount: '10.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      checkedEntries: 2,
      consistent: true,
    });
  }, 70_000);

  it('authorizes HTTP, processes HTTP and SQS wagers, publishes events and reconciles', async () => {
    expect((await fetch(`${api}/health/ready`)).status).toBe(200);
    expect((await fetch(`${api}/wallets/${randomUUID()}`)).status).toBe(401);
    const playerId = randomUUID();
    const created = await request('/wallets', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    expect(wallet.id).toBeDefined();
    for (const [path, method] of [
      ['/wallets/not-a-uuid', 'GET'],
      ['/wallets/not-a-uuid/ledger', 'GET'],
      ['/wallets/not-a-uuid/reconciliation', 'POST'],
      ['/wagering/transactions/not-a-uuid', 'GET'],
      [`/wallets/${encodeURIComponent("' OR 1=1 --")}`, 'GET'],
    ]) {
      expect((await request(path, { method })).status).toBe(400);
    }
    for (const limit of ['abc', 'NaN', '1.5', '0', '101']) {
      expect(
        (await request(`/wallets/${wallet.id}/ledger?limit=${limit}`)).status,
      ).toBe(400);
    }
    expect(
      (
        await request('/wallets', {
          method: 'POST',
          body: JSON.stringify({
            playerId: randomUUID(),
            initialBalance: {
              amount: '1000000000000000000.00',
              currency: 'BRL',
            },
          }),
        })
      ).status,
    ).toBe(400);
    const base = {
      providerId: 'provider-a',
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'full-stack-game',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    };
    const httpId = randomUUID();
    const httpKey = randomUUID();
    const httpBody = { ...base, externalTransactionId: httpId };
    const submit = (body: object, key: string) =>
      request('/wagering/transactions', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    expect(
      (
        await submit(
          {
            ...httpBody,
            money: {
              amount: '99999999999999999999999999999999999999.00',
              currency: 'BRL',
            },
          },
          randomUUID(),
        )
      ).status,
    ).toBe(400);
    const first = await submit(httpBody, httpKey);
    expect(first.status).toBe(201);
    const firstResult = (await first.json()) as { transactionId: string };
    const replay = await submit(httpBody, httpKey);
    expect(replay.status).toBe(201);
    expect(
      ((await replay.json()) as { transactionId: string }).transactionId,
    ).toBe(firstResult.transactionId);
    expect(
      (
        await submit(
          { ...httpBody, money: { amount: '21.00', currency: 'BRL' } },
          httpKey,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await submit(
          { ...httpBody, providerId: 'other-provider' },
          randomUUID(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/wagering/transactions', {
          method: 'POST',
          body: JSON.stringify(httpBody),
        })
      ).status,
    ).toBe(400);
    const insufficient = await submit(
      {
        ...httpBody,
        externalTransactionId: randomUUID(),
        money: { amount: '1000.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(insufficient.status).toBe(422);
    expect(
      ((await insufficient.json()) as { failureCode: string }).failureCode,
    ).toBe('INSUFFICIENT_FUNDS');

    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            ...base,
            externalTransactionId,
            idempotencyKey: randomUUID(),
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
      }),
    );
    let transactionId = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await request(
        `/providers/provider-a/wagering/transactions/${externalTransactionId}`,
      );
      if (response.ok) {
        const transaction = (await response.json()) as {
          transactionId: string;
          status: string;
        };
        expect(transaction.status).toBe('PROCESSED');
        transactionId = transaction.transactionId;
        break;
      }
      if (response.status !== 404) {
        throw new Error(`Transaction lookup failed: HTTP ${response.status}`);
      }
      await Bun.sleep(250);
    }
    expect(transactionId).not.toBe('');
    const events = new Set<string>();
    const eventDeadline = Date.now() + 40_000;
    for (
      let attempt = 0;
      attempt < 500 && events.size < 2 && Date.now() < eventDeadline;
      attempt += 1
    ) {
      const batch = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
        }),
      );
      for (const message of batch.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) {
          throw new Error('Published message is missing body or receipt');
        }
        const event = JSON.parse(message.Body) as {
          eventType: string;
          data: { transactionId?: string };
        };
        if (event.data.transactionId === transactionId) {
          events.add(event.eventType);
        }
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: eventsUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
    expect(events.has('WagerTransactionProcessed')).toBe(true);
    expect(events.has('WalletBalanceChanged')).toBe(true);
    const balance = await request(`/wallets/${wallet.id}`);
    expect(balance.status).toBe(200);
    expect(
      ((await balance.json()) as { balance: { amount: string } }).balance
        .amount,
    ).toBe('70.00');
    const laterReplay = await submit(httpBody, httpKey);
    expect(laterReplay.status).toBe(201);
    expect(await laterReplay.json()).toMatchObject({
      transactionId: firstResult.transactionId,
      status: 'PROCESSED',
      balance: { amount: '80.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    const ledger = await request(`/wallets/${wallet.id}/ledger`);
    expect(ledger.status).toBe(200);
    const entries = (await ledger.json()) as { items: Array<{ id: string }> };
    expect(entries.items).toHaveLength(3);
    const maxPage = await request(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(maxPage.status).toBe(200);
    expect((await maxPage.json()) as { items: Array<{ id: string }> }).toMatchObject({
      items: entries.items,
      nextCursor: null,
    });
    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      const response = await request(`/wallets/${wallet.id}/ledger?${query}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page.items).toHaveLength(1);
      pages.push(page.items[0].id);
      expect(pages.length).toBeLessThanOrEqual(3);
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual(entries.items.map((entry) => entry.id));
    expect(new Set(pages).size).toBe(3);
    expect(
      (await request(`/wallets/${wallet.id}/ledger?cursor=invalid`)).status,
    ).toBe(400);

    const referenceId = randomUUID();
    const pendingResponse = await submit(
      {
        ...base,
        kind: 'ROLLBACK',
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: referenceId,
        money: { amount: '5.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(pendingResponse.status).toBe(202);
    const pending = (await pendingResponse.json()) as {
      transactionId: string;
    };
    expect(
      (
        await submit(
          {
            ...base,
            externalTransactionId: referenceId,
            money: { amount: '5.00', currency: 'BRL' },
          },
          randomUUID(),
        )
      ).status,
    ).toBe(201);
    let recoveredStatus = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await request(
        `/wagering/transactions/${pending.transactionId}`,
      );
      if (!response.ok) {
        throw new Error(`Pending lookup failed: HTTP ${response.status}`);
      }
      recoveredStatus = ((await response.json()) as { status: string }).status;
      if (recoveredStatus === 'PROCESSED') break;
      await Bun.sleep(250);
    }
    expect(recoveredStatus).toBe('PROCESSED');
    const finalBalance = await request(`/wallets/${wallet.id}`);
    expect(
      ((await finalBalance.json()) as { balance: { amount: string } }).balance
        .amount,
    ).toBe('70.00');
    const finalLedger = await request(`/wallets/${wallet.id}/ledger`);
    expect(
      ((await finalLedger.json()) as { items: unknown[] }).items,
    ).toHaveLength(5);
    const reconciliation = await request(
      `/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    );
    expect(reconciliation.status).toBe(200);
    expect(
      ((await reconciliation.json()) as { consistent: boolean }).consistent,
    ).toBe(true);
  }, 70_000);
});
