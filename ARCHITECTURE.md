# Architecture

## Domain boundaries

The code is organized by feature under `src/modules`:

- `wallets` owns wallet creation, balance operations, ledger reads, and reconciliation.
- `wagering` owns wager transactions, idempotency, business rules, and integration events.
- `messaging` owns the SQS consumer, transactional-outbox publisher, and pending-reference worker.
- `health` exposes liveness, readiness, and Prometheus metrics.
- `auth` adapts external OIDC identities and guards HTTP routes.
- `shared` owns cross-feature DTOs, environment key enums, validation utilities, structured logging, and process-local metric aggregation.

Feature-specific DTOs and enums live under each module's `dtos` and `enums` folders. HTTP controllers live under `controllers`, application services under `services`, and messaging consumers, publishers, and workers each have dedicated folders. Framework-independent business rules live under `domain`; inbox processing state and outbox event creation and retry scheduling are modeled separately from TypeORM persistence entities. Lease ownership and conditional updates remain database responsibilities. Runtime environment variables are parsed in the root `config/env/configuration.ts` and injected through Nest's `ConfigService`, using keys from `shared/enums/environment-globals.enum.ts`.

`WalletService` handles wallet creation, wallet and ledger reads, and reconciliation. `WageringService` handles submission, transaction queries, and pending-reference retries; it still coordinates wallet and ledger updates within the wager's database transaction. Wallet creation likewise writes the opening transaction, ledger, and outbox events atomically. `WalletsModule` imports the repository providers exported by `WageringModule` without a circular module dependency.

The domain types do not depend on NestJS or TypeORM. Factories construct domain state, and rehydration reconstructs persisted state. `Money` stores integer minor units as `bigint`; HTTP and event contracts use fixed-scale decimal strings. PostgreSQL stores exact values in `NUMERIC(20,2)`. No monetary calculation uses JavaScript `number`.

## PostgreSQL and financial invariants

TypeORM is used for entity mapping and migrations; it is an accepted challenge option and provides explicit PostgreSQL transactions and row-level locking without introducing another persistence stack. Schema synchronization is disabled. Migrations are versioned and support both `up` and `down`.

Wallet creation through the application starts at version 1. The database enforces `version >= 1` on insertion and enforces the increment rules on updates; a direct SQL insert can therefore choose a higher starting version.

Before migrating an existing database, investigate historical cross-kind reversals and `NaN` monetary values; the finite-value migration fails on `NaN`. Do not modify financial history merely to make a migration or rollback succeed. Reverting the optional `WIN` reference migration fails while processed `WIN` records with references exist. Stop older outbox publishers before applying the lease-token migration and starting the updated version.

Wallet, ledger, wager transaction, inbox, and outbox persistence are separated into feature repositories. The shared base contains protected TypeORM helpers; concrete repositories expose only the operations their domain needs. In particular, ledger entries have no repository update or delete operation. The repositories are stateless: transaction-specific operations receive the caller's `EntityManager` explicitly, rather than retaining a mutable manager between concurrent requests. The application service owns financial transaction boundaries, while the outbox repository owns the publisher's claim transaction and conditional lease updates.

Each financial operation executes in one PostgreSQL transaction:

1. Persist the wager transaction and, for SQS input, the inbox record.
2. Lock the target wallet row with `SELECT ... FOR UPDATE`.
3. Validate the player, currency, reference, reversal, and available balance.
4. Update the wallet, increment its version, and append its ledger entry.
5. Persist the terminal transaction state and integration events in the outbox.
6. Commit before returning an HTTP response or acknowledging an SQS message.

The database enforces unique wallets per player/currency, unique provider transaction identifiers and idempotency keys, one ledger entry per transaction/wallet, unique wallet ledger versions, non-negative balances, finite monetary values, and exact ledger arithmetic. Triggers reject ledger mutation, enforce wallet-version changes and terminal transaction states, and defer a check that each wallet balance equals its ledger sum until commit. Reconciliation reads the stored balance and ledger sum in one SQL statement, so both come from the same PostgreSQL statement snapshot.

`READ COMMITTED` row-level wallet locks serialize operations that compete for a wallet while allowing different wallets to progress independently. There is no process-local or global wallet lock. Database uniqueness protects idempotency, and a database trigger locks the referenced transaction and prevents an additional processed reversal, including across reversal kinds.

The ledger cursor encodes its `(createdAt, id)` position as base64url and orders both fields descending using a matching index. The API accepts a page size from 1 to 100 and reads at most one extra row to determine whether there is another page, rather than loading the full ledger into application memory. The cursor is stable for a given ledger snapshot and is validated before use; separate requests do not share a database snapshot, so concurrent inserts can appear in a later traversal.

## Idempotency and money

The required `Idempotency-Key` is globally unique. Its payload hash is SHA-256 over canonical JSON of the business fields; object keys are sorted, and the key header, correlation ID, and transport metadata are excluded. The hash algorithm and field set are therefore independent of JSON property order and transport retries.

Idempotency is not guaranteed by an in-memory cache: the transaction and inbox records, payload hashes, and database uniqueness constraints provide the durable guarantees. The OIDC `jose` library does cache downloaded public JWKS keys in process memory for token verification; that authentication cache is unrelated to transaction idempotency. Metrics counters are also process-local state, not an idempotency mechanism.

An identical key/hash pair returns the persisted transaction and balance snapshot. A different hash for the same key is a conflict. The transaction row, unique index, wallet lock, ledger entry, and outbox are committed atomically. A concurrent unique-key loser reads the committed row after its transaction rolls back. For SQS, it then commits the logical message's inbox record in a new transaction before acknowledging the replay.

Amounts are input as non-negative strings with at most 18 integer digits and exactly two decimal places, matching `NUMERIC(20,2)`. No rounding is performed: invalid scale is rejected. Financial operations must be strictly positive. A credit that would exceed the maximum wallet balance is rejected with `BALANCE_LIMIT_EXCEEDED`. Different currencies cannot be added, subtracted, or applied to a wallet. New inputs are restricted to currency codes supported by the runtime's `Intl.supportedValuesOf('currency')`; persisted codes are rehydrated independently of the runtime's current list. All accepted currencies use the challenge's fixed two-decimal scale, not their real-world minor-unit conventions.

## Transaction rules and ordering

- `BET` debits and rejects with `INSUFFICIENT_FUNDS` when funds are insufficient.
- `WIN` credits and may reference a processed `BET` from the same provider, player, wallet, currency, and round. A missing referenced bet is handled by the pending-reference worker; the win amount may differ from the bet.
- `LOSS` records a processed wager without changing the wallet or adding a ledger entry.
- `REFUND` credits a processed `BET` once.
- `ROLLBACK` reverses a processed `BET`, `WIN`, or `REFUND` once; a debit that would overdraw the wallet is rejected as `ROLLBACK_NEGATIVE_BALANCE`.
- References must match provider, player, wallet, currency, and round. Reversal amounts must equal the referenced transaction amount.

The challenge explicitly prohibits duplicate reversals of the same kind. To avoid a double credit, this implementation adopts the stricter interpretation that a particular transaction can have only one processed reversal across both kinds. A rollback of a refund is still allowed because the refund is a different referenced transaction. The new migration protects future writes without changing historical records; existing cross-kind reversals must be reviewed separately and are not silently corrected.

Missing references are persisted as `PENDING_REFERENCE`. By default, a worker checks due rows every second and retries with exponential backoff, starting at five seconds. The eighth unsuccessful attempt becomes an auditable `REJECTED` transaction with `REFERENCE_NOT_FOUND`. `MAX_PENDING_REFERENCE_ATTEMPTS` can be set from 1 to 100 and counts the initial submission as an attempt; changing it affects pending transactions on their next attempt. Transient database operations use at most `MAX_DATABASE_ATTEMPTS` attempts (default 3, range 1–10). Changing these limits changes retry behavior; malformed values prevent startup.

`FAILED` is terminal and auditable. The deliberately narrow permanent-failure classification is PostgreSQL `42501` (insufficient privilege) thrown during the transaction callback. Only after an explicitly confirmed rollback does a separate transaction record `FAILED` with `INFRASTRUCTURE_PERMISSION_DENIED`, a processing timestamp and, for an SQS request, the processed inbox record. Unique constraints and row locks preserve the result of a competing operation. If recording the failure also fails, no success or terminal result is fabricated. A failed rollback causes the PostgreSQL connection to be closed instead of returned to the pool. Commit errors, connection failures and other unknown outcomes are not classified as `FAILED`; recognized transient errors are retried and then surfaced as unavailable. Fixing permissions does not change a terminal transaction; submitting a genuinely new operation requires a new external transaction ID and idempotency key.

The HTTP response for a recorded `FAILED` is 503, including on an idempotent replay. A `WagerTransactionFailed` outbox event is persisted atomically with the failed row; no balance or ledger change is made. If that event cannot be recorded, neither is the `FAILED` row. If a previously acknowledged `PENDING_REFERENCE` later fails during background reprocessing, the row becomes `FAILED` when it is still pending and the failure event is recorded; the original message is no longer available to send to the DLQ. Infrastructure failures other than the narrowly classified permission error are not guaranteed to produce a `FAILED` row.

## SQS inbox and transactional outbox

`wager-transactions.fifo` is the input queue. It has a five-receive redrive limit to `wager-transactions-dlq.fifo`. The consumer uses the same wager application service as HTTP, with a persistent inbox keyed by `(consumerName, messageId)` where `messageId` is the logical envelope ID, not the SQS transport ID. A reused envelope ID with a different body is a permanent conflict. Inbox receipt, wager state, wallet changes, ledger, and outbox records share one database transaction. A committed message is acknowledged only afterward; redelivery after a crash is suppressed by the inbox and transaction idempotency key.

Older deployments stored the SQS transport ID in the inbox. After upgrading, old in-flight deliveries may create an additional inbox record, but the persistent business idempotency key still prevents financial replay; operators should retain existing inbox and transaction records.

Invalid or conflicting messages and requests recorded as `FAILED` are sent to the transaction DLQ and acknowledged only after the DLQ send succeeds. If the send fails after the `FAILED` row and inbox commit, redelivery retrieves the failed transaction and retries the send. Duplicate DLQ messages remain possible, including beyond the FIFO deduplication window. Persisted business rejections are terminal and acknowledged. Transient processing failures are not acknowledged and use exponentially increasing visibility timeouts; the SQS redrive policy eventually moves exhausted retries to the DLQ. During shutdown, the consumer waits for in-flight work and returns messages from a completed long poll to visibility. The pending-reference worker also waits for its active run before shutdown.

The outbox stores versioned integration-event envelopes in the same transaction as the financial state. The four events required by the challenge and `WagerTransactionFailed` are represented by concrete event classes. A publisher leases rows using `FOR UPDATE SKIP LOCKED` and a 30-second lease, then sends them to `wager-events.fifo`. A crash after sending but before recording publication may publish the event again; stable event IDs and FIFO deduplication reduce duplicates, and downstream consumers must still deduplicate by event ID beyond SQS's deduplication window. After 12 failed publish attempts, the event is sent to `wager-events-dlq.fifo`; the outbox record remains for diagnosis.

Each publisher leases at most 10 events and sends up to five aggregate groups concurrently. A unique lease token fences database updates from a publisher whose lease has been replaced; timestamps use the database clock. Events within a group are sent sequentially within that batch; no global per-aggregate ordering is guaranteed across publishers, batches, retries, or lease expiration. A failed send is retried independently and later events can arrive first. SQS preserves the order in which it accepts messages in a FIFO group, not database commit order. Consumers must handle out-of-order delivery as well as duplicate events. The lease is not continuously renewed; sends exceeding 30 seconds can be retried concurrently by another publisher, and a send to SQS cannot be fenced by the database. On shutdown the publisher waits for active work and releases unstarted claims.

The integration suite publishes a real outbox event to an isolated FIFO queue, injects a second delivery with a different SQS deduplication ID, and exercises redelivery after a simulated failure between a downstream commit and acknowledgement. A test-only downstream adapter atomically stores `eventId` and its effect in PostgreSQL, proving deduplication for that adapter, including rollback before commit. This application does not implement the downstream systems; each real consumer must independently implement durable deduplication and commit its own effects atomically. FIFO's deduplication window is not a permanent exactly-once guarantee.

Deploy lease-token-aware publishers together: an older publisher does not honor the token and is not safe to run concurrently during a rolling upgrade. Stop older publishers before applying the migration and starting the updated ones.

LocalStack queue creation is idempotent and configures FIFO queues and transaction redrive. PostgreSQL remains the source of financial correctness.

## HTTP status mapping

Business failure codes:

| Code                        | Meaning and provider action                                                        |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `WALLET_NOT_FOUND`          | Wallet does not exist; verify the wallet ID.                                       |
| `PLAYER_MISMATCH`           | Player does not own the specified wallet; correct the request.                     |
| `CURRENCY_MISMATCH`         | Currency differs from the wallet; correct the request.                             |
| `INSUFFICIENT_FUNDS`        | Bet would overdraw the wallet; do not retry as the same transaction.               |
| `BALANCE_LIMIT_EXCEEDED`    | Credit exceeds supported precision; investigate the amount.                        |
| `REFERENCE_NOT_FOUND`       | Reference remained absent until retry exhaustion; investigate ordering.            |
| `REFERENCE_INVALID`         | Referenced transaction kind or ledger is invalid; correct the reference.           |
| `REFERENCE_MISMATCH`        | Reference does not match the transaction context or is not processed; investigate. |
| `REFERENCE_AMOUNT_MISMATCH` | Reversal amount differs from its reference; correct the amount.                    |
| `ALREADY_REVERSED`          | Reference already has a processed reversal; do not reverse it again.               |
| `ROLLBACK_NEGATIVE_BALANCE` | Rollback would overdraw the wallet; investigate the account state.                 |
| `INVALID_TRANSACTION`       | Reserved for invalid domain transactions.                                          |

Terminal results are immutable: correcting a business request requires a new transaction and idempotency key.

- `400`: invalid payload, missing idempotency key, or invalid cursor/limit.
- `401`: missing, invalid, expired, or unverifiable bearer token.
- `403`: token provider identity does not match the provider in the request.
- `409`: duplicate wallet, conflicting idempotency key, or provider transaction ID conflict.
- `201`: transaction processed or business-rejected transactions are returned as `422`.
- `202`: accepted transaction awaiting its reference.
- `200`: wallet reconciliation completed.
- `422`: persisted business rejection, including insufficient funds and invalid reversals.
- `503`: transient database, messaging, or identity-provider failures, or an auditable terminal `FAILED` transaction.

The API processes HTTP wagers synchronously and returns the persisted result. The SQS consumer handles provider requests delivered through the input queue asynchronously.

## Observability and health

Logs are JSON and include available correlation, message, transaction, wallet, provider, and failure identifiers. Monetary payloads are not logged. The `/metrics` endpoint exposes transaction statuses, detected duplicates, database/message/outbox retries, DLQ depth, lock conflicts, outbox lag, and processing latency. Metrics are process-local and should be scraped from every running instance.

The outbox lag and DLQ depth are refreshed at most once per second while the publisher is running; values can be older during dependency failures or shutdown. DLQ counts from SQS are approximate. Lock-conflict counters do not measure time spent waiting for a wallet lock.

`/health/live` is independent of dependency availability. `/health/ready` verifies PostgreSQL and all four configured queues. Health endpoints are intentionally unauthenticated.

## Authentication and scope

Authentication does not earn challenge points, so no local user store or token issuer is implemented. HTTP business controllers use `ProviderJwtAuthGuard`, backed by `ProviderIdentityPort` and `OidcProviderIdentityService`, to verify external Keycloak OIDC access tokens against the configured issuer, audience, and remote JWKS. Only RS256 signatures are accepted; `providerId` and `sub` must be present. Wager submission and provider transaction lookup routes also require the request provider ID to match the verified claim. Health and metrics stay unauthenticated, while SQS remains an internal trusted channel and continues to use domain validation. Wallet routes require a valid provider token, but there is no provider-to-wallet ownership relation in the current schema, so the guard cannot enforce tenant-level wallet ownership.

## Known limitations

- The integration suite uses real PostgreSQL and LocalStack when their connection variables are set. The process-race test starts three independent Bun processes, but it does not kill a live process at each possible instruction boundary.
- Metrics are per process; no metrics backend or dashboard is bundled.
- The event FIFO queues are integration-event destinations; event consumers are outside this challenge's scope.
- The local load test is a bounded diagnostic rather than a production benchmark. Partial reversals and currencies with scales other than two decimal places are out of scope.
