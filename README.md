# Distributed Wagering Processor

NestJS service for processing wager transactions with exact monetary arithmetic, persistent idempotency, a PostgreSQL ledger, and at-least-once SQS messaging.

## Stack

Bun 1.x, TypeScript, NestJS, PostgreSQL, TypeORM, AWS SQS with LocalStack, Keycloak, and Docker Compose.

## Run locally

Install Docker and Docker Compose. Create a local Keycloak client secret once; do not overwrite an existing file:

```powershell
# PowerShell
if (Test-Path "config\env\keycloak.local.env") { throw "Local secret already exists" }
$secret = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
[System.IO.File]::WriteAllText("$PWD\config\env\keycloak.local.env", "KEYCLOAK_LOCAL_CLIENT_SECRET=$secret`n")
```

```sh
# POSIX shell
test ! -e config/env/keycloak.local.env || { echo "Local secret already exists"; exit 1; }
docker run --rm --entrypoint bun oven/bun:1 -e "console.log('KEYCLOAK_LOCAL_CLIENT_SECRET='+crypto.randomUUID()+crypto.randomUUID())" > config/env/keycloak.local.env
```

Start the API and dependencies:

```sh
docker compose up --build -d
docker compose ps
```

The API is available at `http://localhost:3000`, Swagger at `http://localhost:3000/docs`, Keycloak at `http://localhost:8080`, and PostgreSQL at `localhost:5433`. Check `/health/ready` before using the API. Keycloak may take additional time to start. The PostgreSQL and LocalStack volumes retain local data.

### Run the API on the host

Install Bun and dependencies with `bun install --frozen-lockfile`. Create the Keycloak secret above, then:

```sh
docker compose up -d --wait postgres localstack keycloak
bun --no-env-file run queues:local
bun --no-env-file run migration:run
bun --no-env-file run start:dev
```

Do not run the Compose `app` and host API at the same time: they use the same port and queues. The shared `config/env/development.env` connects to the Compose database on `127.0.0.1:5433`; containers use `postgres:5432` to reach the same database. Process environment variables override the file. If port `5433` refuses connections, check `docker compose ps postgres`. Existing volumes may have different database credentials; do not delete data to troubleshoot.

For VS Code debugging, use **Debug API (Bun)** after starting the dependencies. Stop the Compose `app` first if it is running. The queue initializer must complete before the API starts.

## Authentication

Business endpoints require an external OIDC access token. The local Keycloak realm provides a `wagering-api` client for `provider-a`. In PowerShell, obtain a token without printing the client secret:

```powershell
$secret = (Get-Content config\env\keycloak.local.env | Where-Object { $_ -match '^KEYCLOAK_LOCAL_CLIENT_SECRET=' }) -replace '^KEYCLOAK_LOCAL_CLIENT_SECRET=', ''
$response = Invoke-RestMethod -Method Post -Uri 'http://localhost:8080/realms/wagering/protocol/openid-connect/token' -Body @{ grant_type = 'client_credentials'; client_id = 'wagering-api'; client_secret = $secret }
$response.access_token
```

Paste the token into Swagger's **Authorize** dialog. Treat it as a credential. Health and metrics endpoints are public. Wallet endpoints require a token, but the schema does not enforce provider-to-wallet ownership.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/wallets` | Create a wallet |
| GET | `/wallets/:walletId` | Read a wallet |
| GET | `/wallets/:walletId/ledger` | List ledger entries (`cursor`, `limit`) |
| POST | `/wallets/:walletId/reconciliation` | Compare wallet and ledger balances |
| POST | `/wagering/transactions` | Submit an idempotent wager |
| GET | `/wagering/transactions/:transactionId` | Read a transaction |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Read a provider transaction |
| GET | `/health/live`, `/health/ready`, `/metrics` | Health and metrics |

Wallet creation takes a `playerId` and `initialBalance`, for example `{"amount":"100.00","currency":"BRL"}`. At most one wallet per player and currency is allowed.

Wager submission requires an `Idempotency-Key` header and a provider ID matching the token. Amounts are decimal strings with two places. Repeating the same key and payload returns the original result; a different payload returns `409`. A processed wager returns `201`, a missing reference returns `202`, and a business rejection returns `422`. See Swagger for request schemas and other responses.

## Tests and checks

```sh
bun --no-env-file test
bun --no-env-file run build
bun --no-env-file run lint
```

Local tests skip cases requiring external services unless test connection settings are supplied. Run the integration and full-stack suites in separate isolated containers:

```sh
docker compose -p jungle-wagering-tests -f docker-compose.test.yml run --build --rm tests
docker compose -p jungle-wagering-e2e -f docker-compose.test.yml -f docker-compose.e2e.yml run --build --rm e2e
```

The E2E suite requires the local Keycloak secret created above. Tests modify their database and queues; never point them at shared or production services. The E2E test consumes messages from its event queue. Stop test dependencies without deleting data using `docker compose -p jungle-wagering-tests -f docker-compose.test.yml stop` and `docker compose -p jungle-wagering-e2e -f docker-compose.test.yml -f docker-compose.e2e.yml stop`.

The optional `docker compose --profile load run --build --rm load-test` writes wallets and transactions to the local application database; it is a bounded diagnostic, not a production benchmark.

## Design and operations

- Money uses integer minor units and fixed-scale strings; PostgreSQL stores exact numeric values.
- Wallet row locks, database constraints, and transactional ledger writes protect financial invariants across instances.
- Inbox and outbox records make processing durable; event consumers must still deduplicate event IDs.
- Migrations run automatically on startup. Run them explicitly with `bun --no-env-file run migration:run`; review existing data before migrations or downgrades.
- Local credentials are development-only. Production requires its own database, SQS and OIDC configuration and credentials.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for transaction boundaries, retries, migration precautions, security scope, and known limitations.
