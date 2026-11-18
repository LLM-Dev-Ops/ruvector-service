import { createHash, randomUUID } from 'crypto';
import { Request, Response } from 'express';
import {
  UsageLedgerBalanceResponseSchema,
  UsageLedgerEntryAppendRequestSchema,
  UsageLedgerEntryResponseSchema,
  UsageLedgerReservationActionRequestSchema,
  UsageLedgerReservationCreateRequestSchema,
  UsageLedgerReservationResponseSchema,
} from '@llm-dev-ops/contracts';
import { QueryResult, QueryResultRow } from 'pg';
import { DatabaseClient } from '../clients/DatabaseClient';
import { AppError } from '../middleware/errorHandler';

interface UsageEntryRow {
  id: string | number | bigint;
  entry_type: 'grant' | 'debit' | 'reservation_consume';
  amount: string;
  balance_after: string;
  correlation_id: string;
  user_id: string | null;
  service: string | null;
  run_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  request_hash: string;
}

interface ReservationRow {
  id: string;
  amount: string;
  status: 'active' | 'consumed' | 'cancelled' | 'expired';
  correlation_id: string;
  user_id: string | null;
  service: string | null;
  run_id: string | null;
  metadata: Record<string, unknown>;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  request_hash: string;
  final_action: 'consume' | 'cancel' | null;
  final_idempotency_key: string | null;
  final_request_hash: string | null;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decimal(value: string | number): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AppError(500, 'invalid_persisted_amount', 'Persisted usage amount is invalid');
  return parsed.toFixed(6);
}

function entry(row: UsageEntryRow) {
  return {
    id: String(row.id), entry_type: row.entry_type, amount: decimal(row.amount), balance_after: decimal(row.balance_after),
    correlation_id: row.correlation_id, user_id: row.user_id, service: row.service, run_id: row.run_id,
    metadata: row.metadata ?? {}, created_at: new Date(row.created_at).toISOString(),
  };
}

function reservation(row: ReservationRow) {
  return {
    id: row.id, amount: decimal(row.amount), status: row.status, correlation_id: row.correlation_id,
    user_id: row.user_id, service: row.service, run_id: row.run_id, metadata: row.metadata ?? {},
    expires_at: new Date(row.expires_at).toISOString(), created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

async function balances(client: QueryExecutor, organizationId: string): Promise<{ current: number; reserved: number }> {
  const result = await client.query<{ current_balance: string; reserved_amount: string }>(
    `SELECT COALESCE((SELECT SUM(amount) FROM data_plane_usage_entries WHERE organization_id = $1), 0)::text AS current_balance,
            COALESCE((SELECT SUM(amount) FROM data_plane_usage_reservations
                       WHERE organization_id = $1 AND status = 'active' AND expires_at > NOW()), 0)::text AS reserved_amount`,
    [organizationId]
  );
  return { current: Number(result.rows[0].current_balance), reserved: Number(result.rows[0].reserved_amount) };
}

export async function appendUsageEntryHandler(req: Request, res: Response, db: DatabaseClient): Promise<void> {
  const parsed = UsageLedgerEntryAppendRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'validation_error', 'Usage ledger entry is invalid', parsed.error.issues);
  const organizationId = req.dataPlanePrincipal.organization_id;
  const input = parsed.data;
  const requestHash = hash(input);
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${organizationId}:usage-ledger`]);
    const existing = await client.query<UsageEntryRow>(
      `SELECT * FROM data_plane_usage_entries WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, input.idempotency_key]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used for a different usage entry');
      await client.query('COMMIT');
      res.status(200).json(UsageLedgerEntryResponseSchema.parse({ organization_id: organizationId, replayed: true, entry: entry(existing.rows[0]) }));
      return;
    }
    const totals = await balances(client, organizationId);
    const amount = Number(input.amount);
    if (input.entry_type === 'debit' && totals.current - totals.reserved < amount) {
      throw new AppError(409, 'insufficient_balance', 'Available usage balance is insufficient');
    }
    const signedAmount = input.entry_type === 'debit' ? -amount : amount;
    const inserted = await client.query<UsageEntryRow>(
      `INSERT INTO data_plane_usage_entries
         (organization_id, entry_type, amount, balance_after, idempotency_key, request_hash,
          correlation_id, user_id, service, run_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [organizationId, input.entry_type, decimal(signedAmount), decimal(totals.current + signedAmount), input.idempotency_key,
        requestHash, input.correlation_id, input.user_id ?? null, input.service ?? null, input.run_id ?? null, input.metadata ?? {}]
    );
    await client.query('COMMIT');
    res.status(201).json(UsageLedgerEntryResponseSchema.parse({ organization_id: organizationId, replayed: false, entry: entry(inserted.rows[0]) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function getUsageBalanceHandler(req: Request, res: Response, db: DatabaseClient): Promise<void> {
  const organizationId = req.dataPlanePrincipal.organization_id;
  const totals = await balances(db, organizationId);
  res.status(200).json(UsageLedgerBalanceResponseSchema.parse({
    organization_id: organizationId, current_balance: decimal(totals.current), reserved_amount: decimal(totals.reserved),
    available_balance: decimal(totals.current - totals.reserved), as_of: new Date().toISOString(),
  }));
}

export async function createUsageReservationHandler(req: Request, res: Response, db: DatabaseClient): Promise<void> {
  const parsed = UsageLedgerReservationCreateRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'validation_error', 'Usage reservation is invalid', parsed.error.issues);
  const organizationId = req.dataPlanePrincipal.organization_id;
  const input = parsed.data;
  const requestHash = hash(input);
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${organizationId}:usage-ledger`]);
    const existing = await client.query<ReservationRow>(
      `SELECT * FROM data_plane_usage_reservations WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, input.idempotency_key]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used for a different reservation');
      await client.query('COMMIT');
      res.status(200).json(UsageLedgerReservationResponseSchema.parse({ organization_id: organizationId, replayed: true, reservation: reservation(existing.rows[0]) }));
      return;
    }
    const totals = await balances(client, organizationId);
    if (totals.current - totals.reserved < Number(input.amount)) throw new AppError(409, 'insufficient_balance', 'Available usage balance is insufficient');
    const inserted = await client.query<ReservationRow>(
      `INSERT INTO data_plane_usage_reservations
         (id, organization_id, amount, status, idempotency_key, request_hash, correlation_id,
          user_id, service, run_id, metadata, expires_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,NOW() + ($11 * INTERVAL '1 second'))
       RETURNING *`,
      [randomUUID(), organizationId, decimal(input.amount), input.idempotency_key, requestHash, input.correlation_id,
        input.user_id ?? null, input.service ?? null, input.run_id ?? null, input.metadata ?? {}, input.ttl_seconds]
    );
    await client.query('COMMIT');
    res.status(201).json(UsageLedgerReservationResponseSchema.parse({ organization_id: organizationId, replayed: false, reservation: reservation(inserted.rows[0]) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function transitionReservation(req: Request, res: Response, db: DatabaseClient, action: 'consume' | 'cancel'): Promise<void> {
  const parsed = UsageLedgerReservationActionRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'validation_error', 'Reservation action is invalid', parsed.error.issues);
  const reservationId = String(req.params.reservation_id ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)) {
    throw new AppError(400, 'validation_error', 'reservation_id must be a UUID');
  }
  const organizationId = req.dataPlanePrincipal.organization_id;
  const requestHash = hash({ reservation_id: reservationId, action, ...parsed.data });
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${organizationId}:usage-ledger`]);
    const reused = await client.query<ReservationRow>(
      `SELECT * FROM data_plane_usage_reservations WHERE organization_id = $1 AND final_idempotency_key = $2`,
      [organizationId, parsed.data.idempotency_key]
    );
    if (reused.rows[0]) {
      const row = reused.rows[0];
      if (row.id !== reservationId || row.final_action !== action || row.final_request_hash !== requestHash) {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used for a different reservation action');
      }
      await client.query('COMMIT');
      res.status(200).json(UsageLedgerReservationResponseSchema.parse({ organization_id: organizationId, replayed: true, reservation: reservation(row) }));
      return;
    }
    const selected = await client.query<ReservationRow>(
      `SELECT * FROM data_plane_usage_reservations WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, reservationId]
    );
    const row = selected.rows[0];
    if (!row) throw new AppError(404, 'reservation_not_found', 'Reservation is not available for this organization');
    if (row.status !== 'active') throw new AppError(409, 'reservation_not_active', 'Reservation is no longer active');
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE data_plane_usage_reservations SET status = 'expired', updated_at = NOW() WHERE organization_id = $1 AND id = $2`, [organizationId, reservationId]);
      throw new AppError(409, 'reservation_expired', 'Reservation has expired');
    }
    if (action === 'consume') {
      const totals = await balances(client, organizationId);
      const amount = Number(row.amount);
      await client.query(
        `INSERT INTO data_plane_usage_entries
           (organization_id, entry_type, amount, balance_after, idempotency_key, request_hash,
            correlation_id, user_id, service, run_id, metadata)
         VALUES ($1,'reservation_consume',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [organizationId, decimal(-amount), decimal(totals.current - amount), parsed.data.idempotency_key, requestHash,
          parsed.data.correlation_id, row.user_id, row.service, row.run_id, { ...row.metadata, reservation_id: row.id }]
      );
    }
    const updated = await client.query<ReservationRow>(
      `UPDATE data_plane_usage_reservations
          SET status = $3, final_action = $4, final_idempotency_key = $5, final_request_hash = $6,
              correlation_id = $7, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [organizationId, reservationId, action === 'consume' ? 'consumed' : 'cancelled', action,
        parsed.data.idempotency_key, requestHash, parsed.data.correlation_id]
    );
    await client.query('COMMIT');
    res.status(200).json(UsageLedgerReservationResponseSchema.parse({ organization_id: organizationId, replayed: false, reservation: reservation(updated.rows[0]) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function consumeUsageReservationHandler(req: Request, res: Response, db: DatabaseClient): Promise<void> {
  return transitionReservation(req, res, db, 'consume');
}

export function cancelUsageReservationHandler(req: Request, res: Response, db: DatabaseClient): Promise<void> {
  return transitionReservation(req, res, db, 'cancel');
}
