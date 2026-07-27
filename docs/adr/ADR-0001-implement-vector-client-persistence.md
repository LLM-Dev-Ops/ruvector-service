# ADR-0001: Implement Real Vector Persistence in VectorClient

**Status:** Proposed
**Date:** 2026-07-27

## Context

`ruvector-service` is the platform's designated sole persistence chokepoint. Every
other service is required to persist through it and is forbidden from connecting
directly to Google Cloud SQL. That mandate makes the correctness of this service's
persistence path a platform-wide invariant, not a local concern.

The vector half of that path does not exist. It is a set of stubs wrapped in
production-grade observability, which makes the service report success while
performing no vector work at all.

### Every vector operation is a stub

`src/clients/VectorClient.ts`:

| Method | Lines | Behavior |
|---|---|---|
| `connect()` | 85-95 | `// TODO: Implement actual connection logic (gRPC/TCP)` (:88), then `this.connected = true` (:90). No socket is opened. |
| `upsert()` | 114-146 | `// TODO: Implement actual upsert to RuvVector backend` (:127). Returns a literal `{ id, namespace, status: 'upserted' }` (:129-133). |
| `insert()` | 215-241 | `// Stub implementation - would make actual call to RuvVector` (:224). Echoes back `params.id` (:226-228). |
| `query()` | 246-275 | Stub (:258). Always returns `{ items: [], total: 0 }` (:259-263). |
| `similarity()` | 280-309 | Stub (:292). Always returns `{ neighbors: [] }` (:293-297). |
| `run_prediction()` | 319-349 | `// TODO: Implement actual prediction call` (:330). Returns `{ output: {}, confidence: 0.0 }` (:332-337). |
| `ping()` | 355-378 | `// TODO: Implement actual ping to RuvVector` (:369). Unconditionally `return true` (:372). |

### The observability around the stubs is real, which is what makes this dangerous

The circuit breaker is fully implemented — `checkCircuit()` (:165-177),
`recordSuccess()` (:182-189), `recordFailure()` (:194-210) — as are structured
logging and the Prometheus counters (`ruvvectorUpstreamErrorsTotal` in
`src/handlers/ingest.ts` and `src/handlers/predict.ts`). But because no stub body can
throw, `recordFailure()` is unreachable and the breaker can never open. The service
emits `'Vector upserted successfully'` (`VectorClient.ts:138`) and
`'Query completed'` (:267) for operations that touched nothing.

This propagates outward:

- `src/handlers/query.ts:46` returns an empty result set for every query, reported as
  a successful `200` with `pagination.total: 0`.
- `src/handlers/simulate.ts:48` returns zero neighbors for every simulation.
- `src/handlers/ingest.ts:39` returns `201` with `status: 'stored'` for data that was
  never stored.
- `src/handlers/health.ts:62` — `readyHandler` reports
  `dependencies: { ruvvector: 'connected' }` on the strength of `ping()`'s hardcoded
  `true`. The readiness probe cannot fail.
- `src/index.ts:531` wraps `connect()` in a `try/catch` that raises
  `'FATAL: VectorClient connection failed'` — a guard that can never fire.

`src/handlers/graph.ts:29-33` is the one honest stub: it returns `501 not_implemented`.

### The rest of the service is genuinely implemented

This is specifically a vector-path problem. `src/clients/DatabaseClient.ts` is a real
`pg` connection pool (:28-38) with retry-on-cold-start (:50-75) and full DDL for
plans, deployments, decisions, approvals, executions, learning events, and decision
events (:79-445). The plans/decisions/executions/approvals handlers persist through
it correctly.

Notably, `src/handlers/vectors.ts:87-102` *does* write to Postgres — but into a
`values JSONB` column (`DatabaseClient.ts:427-437`), not a `vector` column. There is
no vector type, no distance operator, and no HNSW index anywhere in the schema. The
`vectorClient.upsert()` call that follows (`vectors.ts:104-113`) is explicitly
best-effort and its failures are swallowed. So vectors are archived as opaque JSON and
are not searchable.

### The service URL points at the wrong thing entirely

`src/config/index.ts:103` defaults `RUVVECTOR_SERVICE_URL` to `http://localhost:6379`
— the Redis port, with an HTTP scheme, for a backend the code comments describe as
gRPC/TCP. Three mutually inconsistent claims about one endpoint. The same value is
baked into `Dockerfile:61`, and `.env.example:14-15` declares a fourth variant
(`RUVVECTOR_HOST=ruvvector.infra.svc.cluster.local`, `RUVVECTOR_PORT=6379`) using
variable names `src/config/index.ts` never reads.

There is no vector service on 6379. The real backend is Postgres on 5432:

- `infra/docker-compose.yml:58-63` — `ruvnet/ruvector:latest`, port 5432, healthcheck
  `pg_isready` (:78-79). `infra/README.md:77` states RuvVector *is* the Postgres
  service and that no service named `postgres` exists.
- `integrations/docker-compose.yml:2-8` — `ruvnet/ruvector-postgres:latest`, port 5432.
- `infra/docker/postgres/init/01-init-pgvector.sql:20-26` —
  `CREATE EXTENSION IF NOT EXISTS ruvector;` with a `CREATE EXTENSION vector` fallback.
  The header comment (:3-10) describes it as pgvector-compatible, supplying the
  standard `vector` type and HNSW indexes plus graph/hyperbolic/GNN extras.

The decisive point: **`config.database` (`src/config/index.ts:110-120`) already points
at this exact backend** — `RUVVECTOR_DB_PORT` 5432, `RUVVECTOR_DB_NAME`
`ruvector-postgres`, with Cloud SQL instance `agentics-dev:us-central1:ruvector-postgres`
in `cloudbuild.yaml:29-30`. `DatabaseClient` is already connected to the vector
database. `VectorClient` invented a second, non-existent transport to reach the same
host.

### Naming drift

Three spellings are live across the workspace and are not interchangeable at runtime:
`RUVECTOR_*` (one v, ~590 occurrences, used by most consumer repos), `RUVVECTOR_*`
(two v, ~40, the only form `src/config/index.ts` reads), and the `ruvector`/`ruvvector`
split between this repo's directory name and its `package.json:2` name.

This has already produced a broken deployment: `scripts/deploy-cloudrun.sh:56-63` sets
`RUVECTOR_SERVICE_URL`, `RUVECTOR_DB_HOST`, `RUVECTOR_DB_USER` — one-v names that
`src/config/index.ts` never reads — so that Cloud Run revision silently falls back to
every default, including `RUVVECTOR_DB_HOST=localhost` and an empty password. The
same file hardcodes a production database password in plaintext at line 18.

### `integrations/ruvvector-service` is not a duplicate

The brief's duplicate-implementation claim is **refuted**. That directory is a
different, unrelated service: 512 lines total, no `VectorClient`, no vector
operations, a single `telemetry_events` table (`src/database.ts:17-33`), listening on
port 3100 (`src/index.ts:10`) with three routes — `POST /ingest`, `GET /query`,
`GET /health` (`src/server.ts:208-212`).

It is a **name collision**, which is arguably worse than a fork: both projects declare
`"name": "ruvvector-service"` in `package.json`, and both expose `/ingest` and
`/query` with incompatible semantics (telemetry events vs. vectors). Nothing in either
repo distinguishes them, so a consumer resolving "the ruvvector service" can reach
either one.

## Decision

**Reimplement `VectorClient` as a repository over the existing `DatabaseClient` pool,
using the `ruvector`/pgvector extension on Postgres. Delete the gRPC/TCP service-URL
concept entirely.**

The fabricated transport is not worth building. The backend is Postgres, this service
already holds a pooled connection to it, and pgvector's `vector` type with HNSW
indexing supplies every operation the contract needs. Adding a second connection path
to the same host would be pure overhead.

Concretely:

1. **`VectorClient` takes a `DatabaseClient`, not a `serviceUrl`.** `VectorClientConfig`
   loses `serviceUrl`, `apiKey`, and `poolSize`; it keeps `timeout` and
   `circuitBreaker`. `connect()` becomes an extension/schema readiness check rather
   than a no-op assignment.

2. **`upsert`/`insert`/`query`/`similarity` become real SQL** against a `vectors` table
   with an `embedding vector(N)` column, using `<=>` (cosine) for similarity and an
   HNSW index. The existing `values JSONB` column is migrated.

3. **`ping()` executes a real query** and returns its outcome, so `GET /ready` can fail.

4. **Delete `RUVVECTOR_SERVICE_URL`** from `src/config/index.ts:101-107`,
   `Dockerfile:61`, and `.env.example:14-15`. There is no second endpoint to configure.
   This removes the 6379 error rather than correcting it.

5. **Standardize on the two-v `RUVVECTOR_*` prefix** — it is what the code reads, so
   this is the change with the smallest blast radius. Accept one-v `RUVECTOR_*` as a
   deprecated alias that logs a warning, giving consumer repos a migration window
   without an atomic cross-repo cutover.

6. **`run_prediction()` and `graphHandler` stop pretending.** pgvector does not do ML
   inference. Both return `501 not_implemented`, matching what `graph.ts:29-33`
   already does honestly. A fabricated `confidence: 0.0` is worse than an explicit
   "not built."

7. **Rename `integrations/ruvvector-service` to `integrations/telemetry-events-service`**
   (directory and `package.json` name). It is a telemetry service; the current name
   makes it indistinguishable from the persistence chokepoint.

## Consequences

**Positive**

- The platform's mandated persistence path actually persists. Failures become visible
  instead of being reported as `200 OK`.
- The circuit breaker becomes functional, because real SQL can throw and reach
  `recordFailure()`.
- `GET /ready` becomes a meaningful probe, so orchestrators can route away from broken
  revisions.
- One connection to one backend, instead of one real connection plus one imaginary one.

**Negative / accepted costs**

- **`GET /ready` will start failing in environments that are already broken** — notably
  the `deploy-cloudrun.sh` revision, which points at `localhost` with an empty
  password. This is the fix surfacing pre-existing breakage, not causing it, but it
  will look like a regression and should be expected.
- **Embedding dimension must be fixed at the schema level.** `vector(N)` requires a
  declared `N`. This is a one-way decision; changing it later means a table rewrite.
  Blocked on confirming the platform's embedding model.
- **Latency and load move onto the database.** Queries that previously returned `[]`
  instantly will now do real ANN search. Existing latency budgets
  (`src/middleware/latencyBudget.ts`) need re-baselining.
- **Consumers currently receiving empty results may break.** Any caller that
  accidentally depends on `/query` or `/simulate` returning nothing will see behavior
  change. This is a correction, but it is a behavioral break.
- **`/predict` regresses from `200` to `501`.** Callers receiving the fake
  `confidence: 0.0` will now get an explicit error.
- The `ruvector` extension's availability is untested from this service; the
  pgvector fallback in `01-init-pgvector.sql:20-26` must be verified to cover us.

**Out of scope**

The plaintext credential at `scripts/deploy-cloudrun.sh:18` is a live secret leak. It
needs rotation and removal, but that is a security incident, not an architecture
decision — it should not wait on this ADR.

## Implementation Plan

1. **Confirm the embedding dimension.** Audit what `copilot-agent` (which sets
   `RUVECTOR_NAMESPACE=agents`) and other producers actually send to
   `POST /v1/vectors/store`. Everything below is blocked on this number; do not guess it.

2. **Verify the extension.** Against `ruvnet/ruvector-postgres:latest`, confirm
   `CREATE EXTENSION ruvector` succeeds and that `vector`, `<=>`, and
   `USING hnsw` all work. If only the pgvector fallback is available, record that —
   it satisfies this ADR, and the GNN/hyperbolic features are not used here.

3. **Add schema DDL** in `DatabaseClient.initialize()`, alongside the existing
   `vectors` table at `src/clients/DatabaseClient.ts:427-445`: `CREATE EXTENSION`,
   an `embedding vector(N)` column, and
   `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`.

4. **Migrate `values JSONB` → `embedding vector(N)`**, backfilling existing rows.
   Retain `values` initially so the change is reversible; drop it in a later change
   once the new column is proven.

5. **Rewrite `src/clients/VectorClient.ts`:**
   - `VectorClientConfig` (:34-40) — drop `serviceUrl`/`apiKey`/`poolSize`; constructor
     (:65-70) accepts a `DatabaseClient`.
   - `connect()` (:85-95) — verify extension and table presence; throw on failure.
   - `upsert()` (:114-146) — `INSERT ... ON CONFLICT (namespace, id) DO UPDATE`.
   - `insert()` (:215-241) — delegate to `upsert()`; do not keep two write paths.
   - `query()` (:246-275) — `SELECT ... ORDER BY embedding <=> $1 LIMIT/OFFSET`, with
     `filters`/`timeRange` as parameterized `WHERE` clauses. **Never interpolate
     filter keys or values into SQL text.**
   - `similarity()` (:280-309) — k-NN per context vector with a distance threshold.
   - `ping()` (:355-378) — real `SELECT 1` against the pool; return its result.
   - `run_prediction()` (:319-349) — throw a typed `NotImplementedError`.
   - Delete `getConnectionInfo()` (:383-385) and `getApiKey()` (:76-78).

6. **Update `src/index.ts:516-529`** to construct `VectorClient` from `dbClient`, and
   `:545` to stop logging a `serviceUrl` that no longer exists.

7. **Make `predictHandler`** (`src/handlers/predict.ts:57-58`) return `501`, matching
   `graph.ts:29-33`.

8. **Promote the `vectors.ts` upsert from best-effort to required.** With `VectorClient`
   writing to the same database in the same transaction, the swallow-and-warn block at
   `src/handlers/vectors.ts:104-113` is obsolete — a failure there is now a real
   persistence failure and must surface as a `500`.

9. **Config and env cleanup:** remove `ruvVector.serviceUrl`/`apiKey`/`poolSize` from
   `src/config/index.ts:101-107`; add one-v alias handling with a deprecation warning;
   remove `RUVVECTOR_SERVICE_URL` from `Dockerfile:61`; rewrite `.env.example:14-15`
   to document the variables the code actually reads.

10. **Fix `scripts/deploy-cloudrun.sh:56-63`** to use two-v names, and move the
    hardcoded password (:18) to Secret Manager as `cloudbuild.yaml:29-30` already does.

11. **Rename the colliding service** — `integrations/ruvvector-service` →
    `integrations/telemetry-events-service`, including its `package.json` name — and
    update `integrations/docker-compose.yml:24-40`.

## Verification

The current `tests/unit/client-contract.test.ts` is why this shipped: it asserts only
that methods *exist* and return promises (`:44-71`). It passes against a client that
does nothing, and would pass against a client that returned random data. Method-shape
assertions cannot detect a hollow implementation and must not be the gate.

**Primary gate — round-trip against a real backend.** An integration test running
against a live `ruvnet/ruvector-postgres` container (no mocks, no fakes):

1. `upsert(ns, 'vec-1', [known 384-dim vector], { tag: 'alpha' })`
2. `query({ vector: <same vector>, limit: 1 })` must return exactly `vec-1`, with the
   stored metadata intact and a cosine distance `< 1e-6`.
3. `upsert` the same id with a *different* vector; re-query must return the new values
   and the row count for that namespace must still be 1 (update, not insert).
4. A query in a different namespace must return zero rows — proving namespace
   isolation, and distinguishing a real empty result from today's unconditional `[]`.
5. Insert 100 vectors; `similarity({ contextVectors: [v], k: 5 })` must return exactly
   5 neighbors in ascending distance order.

Step 2 is the assertion the stub cannot satisfy: **an upsert followed by a query must
return the same vector from a real backend.**

**Supporting checks**

- **Negative-path / circuit breaker:** stop the database container mid-test. `query()`
  must throw, `recordFailure()` must increment, the breaker must open after
  `threshold` failures, and `GET /ready` must return `503`. Today every one of these
  is unreachable.
- **Restart durability:** upsert, restart the service, query — the vector must
  survive. This distinguishes real persistence from in-process state.
- **CI guard against regression:** a grep-based check failing the build on
  `TODO: Implement actual` or `Stub implementation` under `src/clients/`.
- **Config assertion:** a unit test asserting no default anywhere in the repo
  references port 6379.
