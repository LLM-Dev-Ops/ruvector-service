import { createHash } from 'crypto';
import { Request, Response } from 'express';
import {
  SimulationEventsAppendRequestSchema,
  SimulationEventsResponseSchema,
  type SimulationEvent,
  type SimulationEventsAppendRequest,
} from '@llm-dev-ops/contracts';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { AppError } from '../middleware/errorHandler';

interface StoredEvent {
  id: string | number | bigint;
  simulation_id: string;
  seq: number;
  ts: Date | string;
  kind: string;
  payload: unknown;
  request_hash: string;
}

function event(row: StoredEvent): SimulationEvent {
  return {
    id: String(row.id),
    simulation_id: row.simulation_id,
    seq: row.seq,
    ts: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
    kind: row.kind as SimulationEvent['kind'],
    payload: row.payload,
  };
}

function requestHash(request: SimulationEventsAppendRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ simulation_id: request.simulation_id, events: request.events }))
    .digest('hex');
}

export async function appendSimulationEventsHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const parsed = SimulationEventsAppendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'Simulation event append request is invalid', parsed.error.issues);
  }

  const organizationId = req.dataPlanePrincipal.organization_id;
  const input = parsed.data;
  const hash = requestHash(input);
  const client = await db.getClient();

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${organizationId}:${input.simulation_id}`,
    ]);

    const existing = await client.query<StoredEvent>(
      `SELECT id, simulation_id, seq, ts, kind, payload, request_hash
         FROM data_plane_simulation_events
        WHERE organization_id = $1 AND batch_idempotency_key = $2
        ORDER BY batch_index ASC`,
      [organizationId, input.idempotency_key]
    );

    if (existing.rows.length > 0) {
      const sameRequest = existing.rows.length === input.events.length && existing.rows.every((row) => row.request_hash === hash);
      if (!sameRequest) {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency key was already used for a different simulation event batch');
      }
      await client.query('COMMIT');
      res.status(200).json(SimulationEventsResponseSchema.parse({
        organization_id: organizationId,
        replayed: true,
        events: existing.rows.map(event),
      }));
      return;
    }

    const sequence = await client.query<{ max: number | null }>(
      `SELECT MAX(seq) AS max
         FROM data_plane_simulation_events
        WHERE organization_id = $1 AND simulation_id = $2`,
      [organizationId, input.simulation_id]
    );
    let nextSeq = (sequence.rows[0]?.max ?? 0) + 1;
    const persisted: SimulationEvent[] = [];

    for (const [batchIndex, item] of input.events.entries()) {
      const inserted = await client.query<StoredEvent>(
        `INSERT INTO data_plane_simulation_events
           (organization_id, simulation_id, seq, kind, payload, batch_idempotency_key, batch_index, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, simulation_id, seq, ts, kind, payload, request_hash`,
        [organizationId, input.simulation_id, nextSeq, item.kind, item.payload, input.idempotency_key, batchIndex, hash]
      );
      persisted.push(event(inserted.rows[0]));
      nextSeq += 1;
    }

    await client.query('COMMIT');
    res.status(201).json(SimulationEventsResponseSchema.parse({
      organization_id: organizationId,
      replayed: false,
      events: persisted,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function replaySimulationEventsHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const simulationId = z.string().uuid().safeParse(req.params.simulation_id);
  if (!simulationId.success) {
    throw new AppError(400, 'validation_error', 'simulation_id must be a UUID');
  }

  let cursor: bigint;
  try {
    cursor = BigInt(String(req.query.after_id ?? '0'));
    if (cursor < 0n) throw new Error('negative');
  } catch {
    throw new AppError(400, 'validation_error', 'after_id must be a non-negative integer');
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 1000) || 1000, 1), 10_000);
  const organizationId = req.dataPlanePrincipal.organization_id;

  const rows = await db.query<StoredEvent>(
    `SELECT id, simulation_id, seq, ts, kind, payload, request_hash
       FROM data_plane_simulation_events
      WHERE organization_id = $1 AND simulation_id = $2 AND id > $3
      ORDER BY id ASC
      LIMIT $4`,
    [organizationId, simulationId.data, cursor.toString(), limit]
  );

  res.status(200).json(SimulationEventsResponseSchema.parse({
    organization_id: organizationId,
    replayed: true,
    events: rows.rows.map(event),
  }));
}
