# ADR-0004: Persist service artifacts in PostgreSQL

## Status

Accepted

## Context

The lineage, ERP mapping, and integration proposal endpoints stored records in
process-local `Map` instances. Cloud Run can start multiple instances and can
replace any instance at any time. A process-local store therefore loses records
on restart and produces different answers depending on which instance handles a
request.

`ruvector-service` already owns the configured RuVector PostgreSQL connection.
The service must remain stateless and must not introduce another database.

## Decision

Store lineage records, ERP mappings, and integration proposals in append-only
tables in the existing PostgreSQL database. Create the tables idempotently
during database initialization. Bind every request value as a query parameter,
return `409 immutable_conflict` when a caller reuses an identifier, and do not
provide mutation or deletion endpoints for these evidence records.

Exercise the handlers with unit tests and exercise persistence across two
Express application instances with PostgreSQL 16 plus pgvector in Linux CI.
Pin the CI actions and service image by immutable revision or digest, and use a
committed npm lock file for deterministic dependency installation.

## Consequences

- Records survive process replacement and remain consistent across instances.
- The existing RuVector-backed PostgreSQL service remains the only persistence
  layer.
- Deployments require the configured database to be reachable; failures remain
  fail-closed instead of silently falling back to process memory.
- Schema initialization remains intentionally additive. A future managed
  migration workflow can adopt the tables without changing their contracts.

## Rollback

Revert the implementation commit to restore the previous handlers and schema
initialization. This leaves the additive tables and their audit records intact;
dropping them is a separate, explicitly reviewed database operation.
