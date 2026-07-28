# ADR-0003: Fix Swallowed Startup Error Logging (and the `RUVVECTOR_EMBEDDING_DIM` Gap It Hid)

**Status:** Implemented (source changes only — steps 1-4; steps 5-8 remain open, see below)
**Date:** 2026-07-27

## Context

Redeploying `ruvvector-service` from the newly-merged `main` — which implements real
pgvector persistence per [ADR-0001](./ADR-0001-implement-vector-client-persistence.md)
instead of the previously stubbed `VectorClient` — produced revision
`ruvvector-service-00052-dxg`, which crash-loops on startup. There is no outage:
`ruvvector-service-00051-gwp` remains `latestReadyRevisionName` and serves 100% of
traffic. Cloud Run reports `HealthCheckContainerError`.

### The logs say almost nothing

Real logs from the failed revision (`gcloud logging read ... --order=asc`), one full
crash cycle:

```
2026-07-27T21:02:15.954Z  Starting ruvvector-service              info
2026-07-27T21:02:15.956Z  Running startup assertions...           info
2026-07-27T21:02:15.956Z  Optional environment variables using defaults   info
2026-07-27T21:02:15.956Z  Environment variable assertion complete  info   {"present":5,"missing":0}
2026-07-27T21:02:15.956Z  Performance budget configured           info
2026-07-27T21:02:15.957Z  Failed to start server                  fatal  {"error":{}}
2026-07-27T21:02:16.480Z  Container called exit(1).
```

This cycle repeated identically six-plus times. `"error":{}` is the entire diagnostic
payload for a fatal crash.

### Why the error is empty

Two facts combine.

`src/index.ts:634-636` — the top-level catch logs the caught value under the key
`error`:

```ts
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
```

`src/utils/logger.ts:29-34` — the pino instance (pino 8.21.0) registers an `Error`
serializer, but binds it to the key `err`:

```ts
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
```

Pino applies serializers **by property name**. The logged key is `error`; the
registered serializer is `err`; they never meet. The `Error` instance therefore falls
through to pino's default JSON serialization, and `Error.prototype.message`, `.stack`,
and `.name` are **non-enumerable own properties** — `JSON.stringify(new Error('boom'))`
is `'{}'`. Hence `"error":{}`.

This is not isolated to one call site. Repo-wide there are **62** `logger.*` calls that
pass a caught value under the key `error` (or `error: err`), including every
startup-hardening path that would otherwise explain a failure:

| Site | Line |
|---|---|
| `src/index.ts` | `532` `'VectorClient connection failed'`, `599` graceful shutdown, `609` `'Uncaught exception'`, `635` `'Failed to start server'` |
| `src/startup/healthCheck.ts` | `76`, `103`, `130`, `161` — connectivity, table, index, append-only checks |
| `src/clients/DatabaseClient.ts` | `55`, `162` migration check, `465` `'Failed to initialize database'`, `582`, `601` |
| `src/guards/immutability.ts` | `156` integrity check |

Every one of these emits `{}` for an `Error`. The service is, in effect, undebuggable
at startup — precisely where it is designed to crash hard.

`src/index.ts:614` has a related variant: `logger.fatal({ reason, promise }, 'Unhandled
promise rejection')` — `reason` is conventionally an `Error` and is likewise unserialized.

### What actually failed

Even with `{}`, the surviving log sequence pins the failure to a single statement.

`src/startup/assertions.ts:213-231` runs the assertions in a fixed order, each logging
on success:

```ts
  logger.info('Running startup assertions...');            // :217  ← seen
  const envResult = assertRequiredEnvVars();               // :223  ← seen (":106")
  const maxLatencyMs = assertPerformanceBudget();          // :224  ← seen (":135")
  assertEmbeddingDimension();                              // :225  ← NO log emitted
  assertExecutionAuthority();                              // :226
  assertMemoryLayerRole();                                 // :227
  logger.info('All startup assertions passed');            // :229
```

`'Performance budget configured'` (`:135`) is present. `'Embedding dimension asserted'`
(`:186`) is absent. The throw is inside `assertEmbeddingDimension()`.

`src/startup/assertions.ts:173-188`:

```ts
export function assertEmbeddingDimension(): number {
  const dimension = config.ruvVector.embeddingDimension;

  if (!dimension) {
    throw new Error(
      'FATAL: RUVVECTOR_EMBEDDING_DIM is required. ' + ...
    );
  }
  assertValidDimension(dimension);
  logger.info({ dimension }, 'Embedding dimension asserted');
```

`src/config/index.ts:136` supplies the sentinel that makes this throw:

```ts
    embeddingDimension: getEnvNumber('RUVVECTOR_EMBEDDING_DIM', 0),
```

`0` is falsy, so an unset variable takes the `!dimension` branch. And the variable **is**
unset on the failed revision. Verified against live infrastructure:

```
$ gcloud run revisions describe ruvvector-service-00052-dxg --region=us-central1 \
    --project=agentics-dev --format='value(spec.containers[0].env[].name)'
NODE_ENV;LOG_LEVEL;MAX_LATENCY_MS;RUVVECTOR_DB_SSL;RUVVECTOR_DB_HOST;
RUVVECTOR_DB_PORT;RUVVECTOR_DB_NAME;RUVVECTOR_DB_USER;RUVVECTOR_DB_PASSWORD;
EXECUTION_HMAC_SECRET
```

No `RUVVECTOR_EMBEDDING_DIM`. The env list of the healthy `00051` is byte-identical:
the redeploy inherited the previous revision's environment, and the old stubbed code
never required a dimension, so the gap was invisible until this release introduced the
assertion.

Three further facts corroborate this and rule out the database:

1. **`"present":5,"missing":0` is structurally incapable of catching this.**
   `REQUIRED_ENV_VARS_PRODUCTION` (`src/startup/assertions.ts:15-21`) contains exactly
   five entries — `RUVVECTOR_DB_HOST`, `RUVVECTOR_DB_NAME`, `RUVVECTOR_DB_USER`,
   `RUVVECTOR_DB_PASSWORD`, `EXECUTION_HMAC_SECRET` — and `RUVVECTOR_EMBEDDING_DIM` is
   not among them. The count of 5 confirms the list was checked in full and that the
   dimension was never part of it. Two different notions of "required" coexist in the
   codebase and disagree.

2. **Timing rules out all I/O.** `15.956Z` → `15.957Z` is roughly one millisecond
   between the last assertion and the fatal. No TCP connect, TLS handshake, Cloud SQL
   dial, `CREATE EXTENSION`, or HNSW index build occurred. Everything database-related
   lives *after* the assertions — `new DatabaseClient(...)` / `await
   dbClient.initialize()` at `src/index.ts:479-494`, `verifyStorageHealth` at `:501`,
   `assertHistoricalDataIntegrity` at `:506`, `vectorClient.connect()` at `:529`. None
   of it ran. The Cloud SQL instance, the `cloudsql-instances` annotation, and the
   pgvector/HNSW migration are **not** implicated in this failure.

3. **The repo's own deploy script sets the variable; this deploy bypassed it.**
   `scripts/deploy-cloudrun.sh:23` hard-fails without it
   (`${RUVVECTOR_EMBEDDING_DIM:?Set RUVVECTOR_EMBEDDING_DIM ...}`) and passes it at
   `:61`. The service metadata instead shows
   `run.googleapis.com/build-source-location: gs://run-sources-agentics-dev-us-central1/
   services/ruvvector-service/1785185733...zip` — an ad-hoc `gcloud run deploy --source`,
   which never executed the guard.

**Confidence: very high (~97%).** The remaining ~3% is the one alternative consistent
with the same log window: `assertValidDimension()` (`src/clients/vectorSchema.ts:32-39`)
rejecting a *malformed* value. That would require the variable to be set, which
`gcloud run revisions describe` contradicts. Only the real error message closes the gap
completely — which is exactly what part (a) exists to produce.

### Downstream state (not the cause of this crash; relevant to the next one)

- The Cloud SQL instance is stock **`POSTGRES_15`**, `RUNNABLE`, `db-f1-micro`, no
  database flags — *not* the `ruvnet/ruvector-postgres:latest` image ADR-0001's plan
  assumed. The `ruvector` extension is not installable on managed Cloud SQL. This is
  already handled: `DatabaseClient.ts:530-545` iterates `SUPPORTED_VECTOR_TYPES =
  ['ruvector', 'vector']` (`src/clients/vectorSchema.ts:21`), tolerates the failed
  `CREATE EXTENSION ruvector`, and falls back to stock pgvector, which Cloud SQL PG15
  provides. ADR-0001's open question — "the pgvector fallback must be verified to cover
  us" — is answered in the affirmative *by construction*, though still unverified at
  runtime.
- **The dimension value itself is an unresolved, one-way decision.** ADR-0001's
  implementation plan item 1 says explicitly: *"Everything below is blocked on this
  number; do not guess it."* The only evidenced producer value in the workspace is
  `copilot-agent/.env.example:114` → `EMBEDDING_DIMENSIONS=1536`. This ADR treats 1536
  as a *candidate requiring confirmation*, not a decision, because
  `VectorClient.connect()` (`src/clients/VectorClient.ts:151-157`) refuses to start on
  any mismatch against the live column, and correcting a wrong choice means a table
  rewrite.
- The `cloudsql-instances` annotation is present, yet `RUVVECTOR_DB_HOST` comes from a
  secret with `RUVVECTOR_DB_SSL=true`, which suggests a TCP path to a public IP rather
  than the `/cloudsql/...` unix socket. Unverified — secret values were deliberately not
  read. If it is TCP, the annotation is inert and harmless.

## Decision

Two decisions, at different confidence levels. They ship together but stand
independently.

### (a) Startup errors must be logged with their real message, name, and stack

An unhandled startup failure must never again be reduced to `{}`. This is not
negotiable for a service whose stated design is to *crash hard* on misconfiguration:
a hard crash is only a safety property if the operator can read why.

The fix is **one line in the serializer map**, not 62 edits at the call sites:

```ts
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,   // ← the key this codebase actually uses
  },
```

Rationale for the serializer over per-site rewrites:

- It repairs all 62 sites atomically, including the four startup-hardening paths that
  matter most, with no chance of missing one.
- `pino.stdSerializers.err` emits `type`, `message`, `stack`, and walks `cause` chains
  and any custom enumerable properties — strictly more than a hand-rolled
  `{ message, stack, name }` triple, and it correctly passes non-`Error` values through.
- It cannot regress the existing `err` key, which is retained.

Explicitly rejected: pino's `errorKey: 'error'` option, which configures exactly this
behavior but was introduced in **pino 9.0**. This repo is on **8.21.0**
(`node_modules/pino/package.json`), so it is unavailable without a major-version bump
that this ADR does not want to couple to an incident fix.

Also in scope: `src/index.ts:614` gains `reason` handling so unhandled rejections are
legible too.

### (b) The underlying failure is an unset `RUVVECTOR_EMBEDDING_DIM`, and the two "required" lists must be reconciled

The crash is `assertEmbeddingDimension()` throwing `FATAL: RUVVECTOR_EMBEDDING_DIM is
required`, because the variable is absent from the revision's environment
(evidence above, ~97% confidence).

Beyond setting the variable, the *structural* defect is that
`REQUIRED_ENV_VARS_PRODUCTION` and the individual `assert*` functions encode two
disagreeing definitions of "required". A variable that hard-crashes startup must appear
in the list whose job is to report missing required variables — otherwise the
`"missing":0` log actively misleads the operator, as it did here. `RUVVECTOR_EMBEDDING_DIM`
is added to that list so the failure is named in the first assertion rather than
discovered two steps later.

Deployment configuration is likewise not something to re-derive by hand per release:
the redeploy must go through `scripts/deploy-cloudrun.sh`, or the variable must be set
on the service so it is inherited by every subsequent revision.

## Consequences

**Positive**

- Startup failures become self-diagnosing. The next bad deploy costs one log read
  instead of a live investigation across `gcloud`, source, and log archaeology.
- All 62 error-logging sites are fixed by one change; no site-by-site audit debt.
- `"missing":N` becomes trustworthy — it will name every variable that can crash startup.
- The environment gap that this incident exposed is closed at both the config layer and
  the deploy layer.

**Negative / accepted**

- **Log volume and content change.** `stdSerializers.err` emits full stack traces where
  `{}` was emitted before. Log size grows and stacks may include file paths. This is the
  intended trade: a stack in a log is worth far more than the bytes it costs.
- **Error logs may now expose values that were previously invisible.** Error messages in
  this codebase interpolate configuration — e.g. `VectorClient.ts:153-155` prints the
  configured dimension, and `DatabaseClient.ts:548-549` prints extension failure text.
  None of the audited startup messages interpolate credentials, and `EXECUTION_HMAC_SECRET`
  is only ever logged by length (`assertions.ts:155-163`). Worth re-checking whenever a
  new `throw` interpolates config, and worth reading alongside
  [ADR-0002](./ADR-0002-secrets-management-and-credential-exposure.md).
- **Setting the dimension is effectively irreversible.** Once `vector(N)` is created and
  rows are written, changing `N` means a table rewrite and a backfill. Confirming the
  producer's true dimension is therefore a blocking prerequisite, not a follow-up.
- **Fixing the logging will very likely reveal further failures.** Steps 2-4 of
  `startServer()` (`src/index.ts:494-535`) have never executed against this Cloud SQL
  instance with real persistence. Expect the *next* revision to surface a genuine
  database or schema error — that is the logging fix working, not a new regression.
- The plaintext database password at `scripts/deploy-cloudrun.sh:18` remains a live
  secret leak. It is out of scope here (ADR-0002 owns it) but the script is on this
  ADR's recommended path, so it should be remediated before the script is adopted as the
  standard deploy route.

**Neutral**

- No change to runtime behavior, request handling, or the crash-on-misconfiguration
  posture. This ADR changes what gets *written down* when the service crashes, and one
  environment variable.

## Implementation Plan

Steps 1-4 are **done** (source-only). Steps 5-8 are **open** and require an operator
decision; nothing in this repo performs them.

1. **Fix the serializer.** In `src/utils/logger.ts:29-34`, add
   `error: pino.stdSerializers.err` alongside the existing `err` entry. Do not modify
   the 62 call sites.

2. **Fix the rejection handler.** In `src/index.ts:613-616`, serialize `reason` — either
   log it under a serialized key or pass it through `pino.stdSerializers.err` — so
   unhandled rejections carry a message and stack.

3. **Add a regression test.** Assert that `logger.fatal({ error: new Error('boom') },
   'x')` produces a record whose `error.message` is `'boom'` and whose `error.stack` is
   non-empty. Capture output with a pino destination stream. This test is the guard that
   keeps the incident from recurring silently.

4. **Reconcile the required-variable lists.** Add `RUVVECTOR_EMBEDDING_DIM` to
   `REQUIRED_ENV_VARS_PRODUCTION` (`src/startup/assertions.ts:15-21`). Keep
   `assertEmbeddingDimension()` — it additionally range-validates — but the missing-variable
   case should now be named by the first assertion. Update
   `tests/unit/config.test.ts` and `tests/setup.ts:13` if the expected count of 5 is
   asserted anywhere.

5. **Confirm the embedding dimension — STILL OPEN, blocking, do not guess.** Resolve
   ADR-0001 plan item 1: audit what `copilot-agent` and `platform-agents/src/index.ts`
   actually POST to `/v1/vectors/store`.

   The **only** candidate value evidenced anywhere in this workspace is **1536**, from
   `copilot-agent/.env.example:114` (`EMBEDDING_DIMENSIONS=1536`). That is an example
   file, not a confirmed producer configuration, and it is therefore a *candidate*, not
   a decision.

   Setting this value is a **ONE-WAY DOOR**. `vector(N)` fixes N in the table
   definition; `VectorClient.connect()` (`src/clients/VectorClient.ts:151-157`) refuses
   to start on any mismatch against the live column, and correcting a wrong choice
   after rows exist means a table rewrite plus a full backfill.

   Consequently `RUVVECTOR_EMBEDDING_DIM` **must not be given a default in code**, and
   in particular must not be silently defaulted to 1536. It stays a required env var
   with no default (`src/config/index.ts:136` supplies the falsy sentinel `0` precisely
   so that an unset value crashes rather than guesses). The real value is supplied at
   deploy time by a human who has confirmed it against the live producer.

6. **Set the variable on the service** (a separate, operator-approved action — **not**
   part of this ADR's authorship, and not to be performed while `00051` is serving
   without sign-off). Either run `RUVVECTOR_EMBEDDING_DIM=<confirmed> ./scripts/deploy-cloudrun.sh`,
   or set it on the service so all future revisions inherit it:
   `gcloud run services update ruvvector-service --region=us-central1
   --update-env-vars RUVVECTOR_EMBEDDING_DIM=<confirmed>`.

7. **Redeploy with steps 1-6 in place** and read the resulting logs. Deploy with
   `--no-traffic` and promote only once healthy, so `00051` keeps serving throughout.

8. **Address the follow-on failure, if any,** using the now-real error message. Expect it
   to come from `dbClient.initialize()`, `verifyStorageHealth()`, or
   `vectorClient.connect()`.

## Verification

**Part (a) — the logging fix.** Verifiable locally, no deployment required:

- Unit test from step 3 passes: a logged `Error` yields a non-empty `message` and `stack`.
- Manual check: run the built image with `RUVVECTOR_EMBEDDING_DIM` deliberately unset and
  confirm the fatal record contains
  `"error":{"type":"Error","message":"FATAL: RUVVECTOR_EMBEDDING_DIM is required...","stack":"..."}`
  instead of `"error":{}`.

### Verification results (recorded 2026-07-28, local, no deployment)

Both parts were reproduced locally by running the built image with every required
variable set *except* `RUVVECTOR_EMBEDDING_DIM` — the exact environment of revision
`ruvvector-service-00052-dxg`.

**Before** (clean `main`) — reproduces the production incident exactly, including the
misleading `"missing":0`:

```
{"level":"info","present":5,"missing":0,"msg":"Environment variable assertion complete"}
{"level":"info","maxLatency":2000,"msg":"Performance budget configured"}
{"level":"fatal","error":{},"msg":"Failed to start server"}
exit=1
```

**After** (this ADR's changes) — the variable is now named by the *first* assertion, and
the fatal record carries type, message, and stack:

```
{"level":"error","missing":["RUVVECTOR_EMBEDDING_DIM"],"isProduction":true,
 "msg":"STARTUP ASSERTION FAILED: Required environment variables missing"}
{"level":"fatal","error":{"type":"Error","message":"FATAL: Required environment variables
 missing: RUVVECTOR_EMBEDDING_DIM. Service cannot start safely without these values.
 DO NOT allow partial operation.","stack":"Error: ...\n    at assertRequiredEnvVars
 (dist/startup/assertions.js:92:15)\n    at runStartupAssertions ..."},"msg":"Failed to start server"}
exit=1
```

This **confirms part (b)'s root-cause hypothesis** and closes the ADR's residual ~3%
(`assertValidDimension()` rejecting a malformed value): with the variable genuinely
absent, the missing-variable branch is the one taken.

Note that step 4 deliberately moves detection earlier, so the message quoted in the
prediction below is no longer the one emitted for the *unset* case. That message remains
reachable for a set-but-falsy value, and both `assertEmbeddingDimension()` paths were
verified to log real errors under the fix:

```
RUVVECTOR_EMBEDDING_DIM=0      → error.message = "FATAL: RUVVECTOR_EMBEDDING_DIM is required. ..."
RUVVECTOR_EMBEDDING_DIM=99999  → error.message = "Embedding dimension must be an integer between 1 and 16000, got: 99999"
```

**Part (b) — the root-cause hypothesis.** The prediction is falsifiable and precise. With
step 1 landed and the variable *still* unset, the fatal record must read:

```
FATAL: RUVVECTOR_EMBEDDING_DIM is required. It fixes the dimension of the
vectors.embedding column and cannot be changed without rewriting the table, so it
must match the platform embedding model exactly. DO NOT allow partial operation
without a declared embedding dimension.
```

If it does, part (b) is confirmed and step 6 is the fix. If a *different* message
appears, part (b) is wrong, part (a) is still correct and valuable, and the real message
supersedes this analysis — amend this ADR rather than debugging blind.

**Success criteria for the redeploy:**

- Logs show `'Embedding dimension asserted'` with the configured dimension, followed by
  `'All startup assertions passed'` and `'Server started successfully'`.
- The new revision reaches `Ready=True`; `latestReadyRevisionName` advances past
  `ruvvector-service-00051-gwp`.
- `GET /ready` returns 200.
- Throughout, `00051` continues serving until traffic is explicitly promoted.

**Guardrail:** no step in this plan modifies the running service without explicit
operator approval. Steps 1-5 are source changes only.
