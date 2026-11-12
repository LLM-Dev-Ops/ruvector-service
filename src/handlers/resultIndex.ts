import { createHash } from 'crypto';
import { Request, Response } from 'express';
import {
  ResultIndexListResponseSchema,
  ResultIndexResponseSchema,
  ResultIndexStoreRequestSchema,
  type ResultIndexDocument,
  type ResultIndexEntry,
  type ResultIndexStoreRequest,
} from '@llm-dev-ops/contracts';
import { DatabaseClient } from '../clients/DatabaseClient';
import { AppError } from '../middleware/errorHandler';

interface StoredResult {
  id: string | number | bigint;
  stored_at: Date | string;
  result: ResultIndexDocument;
  request_hash: string;
}

function entry(row: StoredResult): ResultIndexEntry {
  return {
    id: String(row.id),
    stored_at: row.stored_at instanceof Date
      ? row.stored_at.toISOString()
      : new Date(row.stored_at).toISOString(),
    result: row.result,
  };
}

function requestHash(request: ResultIndexStoreRequest): string {
  return createHash('sha256').update(JSON.stringify(request.result)).digest('hex');
}

export async function storeResultIndexHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const parsed = ResultIndexStoreRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'Result index store request is invalid', parsed.error.issues);
  }

  const organizationId = req.dataPlanePrincipal.organization_id;
  const input = parsed.data;
  const hash = requestHash(input);
  const client = await db.getClient();

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${organizationId}:result:${input.result.run_id}`,
    ]);

    const idempotent = await client.query<StoredResult>(
      `SELECT id, stored_at, result, request_hash
         FROM data_plane_results
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, input.idempotency_key]
    );
    if (idempotent.rows.length > 0) {
      const stored = idempotent.rows[0];
      if (stored.request_hash !== hash) {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used for a different result');
      }
      await client.query('COMMIT');
      res.status(200).json(ResultIndexResponseSchema.parse({
        organization_id: organizationId,
        replayed: true,
        entry: entry(stored),
      }));
      return;
    }

    const conflictingRun = await client.query<StoredResult>(
      `SELECT id, stored_at, result, request_hash
         FROM data_plane_results
        WHERE organization_id = $1 AND run_id = $2`,
      [organizationId, input.result.run_id]
    );
    if (conflictingRun.rows.length > 0) {
      throw new AppError(409, 'run_conflict', 'run_id is already indexed for this organization');
    }

    const result = input.result;
    const inserted = await client.query<StoredResult>(
      `INSERT INTO data_plane_results
         (organization_id, run_id, execution_id, simulation_id, scenario_id,
          environment, status, completed_at, result, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, stored_at, result, request_hash`,
      [
        organizationId,
        result.run_id,
        result.execution_id,
        result.simulation_id,
        result.scenario_id,
        result.environment,
        result.status,
        result.execution_metadata.completed_at,
        result,
        input.idempotency_key,
        hash,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json(ResultIndexResponseSchema.parse({
      organization_id: organizationId,
      replayed: false,
      entry: entry(inserted.rows[0]),
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getResultIndexHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const resultId = String(req.params.result_id ?? '');
  if (!resultId || resultId.length > 255) {
    throw new AppError(400, 'validation_error', 'result_id is required and must be at most 255 characters');
  }

  const organizationId = req.dataPlanePrincipal.organization_id;
  const result = await db.query<StoredResult>(
    `SELECT id, stored_at, result, request_hash
       FROM data_plane_results
      WHERE organization_id = $1
        AND (run_id = $2 OR execution_id = $2 OR simulation_id = $2)
      ORDER BY id DESC
      LIMIT 1`,
    [organizationId, resultId]
  );
  if (result.rows.length === 0) {
    throw new AppError(404, 'result_not_found', 'Result is not indexed for this organization');
  }

  res.status(200).json(ResultIndexResponseSchema.parse({
    organization_id: organizationId,
    replayed: true,
    entry: entry(result.rows[0]),
  }));
}

export async function listResultIndexHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  let afterId: bigint;
  try {
    afterId = BigInt(String(req.query.after_id ?? '0'));
    if (afterId < 0n) throw new Error('negative');
  } catch {
    throw new AppError(400, 'validation_error', 'after_id must be a non-negative integer');
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
  const filters: Array<[string, string]> = [];
  for (const [column, value] of [
    ['environment', req.query.environment],
    ['status', req.query.status],
    ['scenario_id', req.query.scenario_id],
  ] as const) {
    if (value !== undefined) {
      if (Array.isArray(value) || typeof value !== 'string' || !value || value.length > 255) {
        throw new AppError(400, 'validation_error', `${column} must be a non-empty string of at most 255 characters`);
      }
      filters.push([column, value]);
    }
  }

  const organizationId = req.dataPlanePrincipal.organization_id;
  const params: unknown[] = [organizationId, afterId.toString()];
  const clauses = filters.map(([column, value]) => {
    params.push(value);
    return `${column} = $${params.length}`;
  });
  params.push(limit);

  const result = await db.query<StoredResult>(
    `SELECT id, stored_at, result, request_hash
       FROM data_plane_results
      WHERE organization_id = $1 AND id > $2
        ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
      ORDER BY id ASC
      LIMIT $${params.length}`,
    params
  );
  const results = result.rows.map(entry);

  res.status(200).json(ResultIndexListResponseSchema.parse({
    organization_id: organizationId,
    results,
    next_after_id: results.at(-1)?.id ?? null,
  }));
}
