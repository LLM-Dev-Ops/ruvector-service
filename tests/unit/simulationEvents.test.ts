import { Request, Response } from 'express';
import {
  appendSimulationEventsHandler,
  replaySimulationEventsHandler,
} from '../../src/handlers/simulationEvents';
import { AppError } from '../../src/middleware/errorHandler';

const simulationId = '11111111-1111-4111-8111-111111111111';

function request(body: unknown = {}): Request {
  return {
    body,
    params: { simulation_id: simulationId },
    query: {},
    dataPlanePrincipal: {
      subject: 'iam-subject-1',
      principal: 'platform@test.example',
      organization_id: 'org-test',
      audience: 'https://ruvector.test',
      mapping_source: 'configured_principal_binding',
    },
  } as unknown as Request;
}

function response(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function stored(id: number, seq: number, kind: string, requestHash = 'hash') {
  return {
    id,
    simulation_id: simulationId,
    seq,
    ts: '2026-11-12T00:00:00.000Z',
    kind,
    payload: { seq },
    request_hash: requestHash,
  };
}

describe('tenant-bound simulation event persistence', () => {
  it('serializes sequence allocation and persists an ordered idempotent batch', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ max: 7 }] })
      .mockResolvedValueOnce({ rows: [stored(30, 8, 'started')] })
      .mockResolvedValueOnce({ rows: [stored(31, 9, 'completed')] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { getClient: jest.fn().mockResolvedValue(client) };
    const res = response();

    await appendSimulationEventsHandler(request({
      simulation_id: simulationId,
      idempotency_key: 'batch-1',
      events: [
        { kind: 'started', payload: { seq: 8 } },
        { kind: 'completed', payload: { seq: 9 } },
      ],
    }), res, db as any);

    expect(client.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[1][1]).toEqual([`org-test:${simulationId}`]);
    expect(client.query.mock.calls[4][1]).toEqual(expect.arrayContaining(['org-test', simulationId, 8, 'started', 'batch-1', 0]));
    expect(client.query.mock.calls[5][1]).toEqual(expect.arrayContaining(['org-test', simulationId, 9, 'completed', 'batch-1', 1]));
    expect(client.query.mock.calls[6][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-test',
      replayed: false,
      events: [expect.objectContaining({ seq: 8 }), expect.objectContaining({ seq: 9 })],
    }));
  });

  it('rejects client organization fields before touching persistence', async () => {
    const db = { getClient: jest.fn() };

    await expect(appendSimulationEventsHandler(request({
      organization_id: 'attacker-org',
      simulation_id: simulationId,
      idempotency_key: 'batch-2',
      events: [{ kind: 'created', payload: {} }],
    }), response(), db as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'validation_error',
    });
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different request and rolls back', async () => {
    const existing = stored(40, 1, 'created', 'different-hash');
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { getClient: jest.fn().mockResolvedValue(client) };

    await expect(appendSimulationEventsHandler(request({
      simulation_id: simulationId,
      idempotency_key: 'batch-used',
      events: [{ kind: 'created', payload: {} }],
    }), response(), db as any)).rejects.toBeInstanceOf(AppError);

    expect(client.query.mock.calls[3][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('replays only the authenticated tenant in durable cursor order', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [stored(51, 4, 'metric')] }) };
    const req = request();
    req.query = { after_id: '50', limit: '25' };
    const res = response();

    await replaySimulationEventsHandler(req, res, db as any);

    expect(db.query.mock.calls[0][0]).toContain('organization_id = $1');
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY id ASC');
    expect(db.query.mock.calls[0][1]).toEqual(['org-test', simulationId, '50', 25]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-test',
      events: [expect.objectContaining({ id: '51', seq: 4 })],
    }));
  });
});
