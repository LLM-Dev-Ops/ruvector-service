import { Request, Response } from 'express';
import {
  getResultIndexHandler,
  listResultIndexHandler,
  storeResultIndexHandler,
} from '../../src/handlers/resultIndex';
import { AppError } from '../../src/middleware/errorHandler';

function result() {
  return {
    run_id: 'run-1',
    scenario_id: 'scenario-1',
    execution_id: 'exec-1',
    simulation_id: 'sim-1',
    parent_span_id: 'span-1',
    simulation_resolution: 'micro',
    repo_name: 'agentics-platform',
    environment: 'staging',
    status: 'completed',
    execution_metadata: {
      execution_id: 'exec-1',
      proof_hash: 'proof-1',
      layers_executed: ['completion'],
      schema_version: '1.0.0',
      environment: 'staging',
      started_at: '2026-11-12T00:00:00.000Z',
      completed_at: '2026-11-12T00:00:01.000Z',
      duration_ms: 1000,
    },
    executionProof: {
      proof_hash: 'proof-1',
      layerRecords: [{
        layer_name: 'completion',
        status: 'passed',
        duration_ms: 1000,
        assertions_passed: 3,
        assertions_failed: 0,
      }],
      generated_at: '2026-11-12T00:00:01.000Z',
    },
    result_summary: {
      assertions_passed: 3,
      assertions_failed: 0,
      total_layers: 1,
      mandatory_layers_complete: true,
      artifacts: [{ artifact_type: 'log', storage_url: 'gs://bucket/result.log' }],
    },
    correlation_id: 'correlation-1',
  };
}

function request(body: unknown = {}): Request {
  return {
    body,
    params: { result_id: 'exec-1' },
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

function stored(id = 41, hash = 'request-hash') {
  return {
    id,
    stored_at: '2026-11-12T00:00:02.000Z',
    result: result(),
    request_hash: hash,
  };
}

describe('tenant-bound result index provider', () => {
  it('stores the canonical packet atomically under its authenticated tenant', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored()] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { getClient: jest.fn().mockResolvedValue(client) };
    const res = response();

    await storeResultIndexHandler(request({ idempotency_key: 'result-1', result: result() }), res, db as any);

    expect(client.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[1][1]).toEqual(['org-test:result:run-1']);
    expect(client.query.mock.calls[4][1]).toEqual(expect.arrayContaining([
      'org-test', 'run-1', 'exec-1', 'sim-1', 'scenario-1', 'staging', 'completed', 'result-1',
    ]));
    expect(client.query.mock.calls[5][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-test',
      replayed: false,
      entry: expect.objectContaining({ id: '41', result: result() }),
    }));
  });

  it('rejects client organization scope before persistence', async () => {
    const db = { getClient: jest.fn() };

    await expect(storeResultIndexHandler(request({
      organization_id: 'attacker-org',
      idempotency_key: 'result-2',
      result: result(),
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it('replays the same idempotent request and rejects conflicting reuse', async () => {
    const firstClient = { query: jest.fn(), release: jest.fn() };
    firstClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored(42, 'same')] })
      .mockResolvedValueOnce({ rows: [] });
    const firstDb = { getClient: jest.fn().mockResolvedValue(firstClient) };
    const input = { idempotency_key: 'result-3', result: result() };

    // Capture the production hash on a first dry pass through the hash check.
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(JSON.stringify(input.result)).digest('hex');
    firstClient.query.mockReset();
    firstClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored(42, hash)] })
      .mockResolvedValueOnce({ rows: [] });
    const replayRes = response();

    await storeResultIndexHandler(request(input), replayRes, firstDb as any);
    expect(replayRes.status).toHaveBeenCalledWith(200);
    expect(replayRes.json).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }));

    const conflictClient = { query: jest.fn(), release: jest.fn() };
    conflictClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored(43, 'different')] })
      .mockResolvedValueOnce({ rows: [] });
    const conflictDb = { getClient: jest.fn().mockResolvedValue(conflictClient) };

    await expect(storeResultIndexHandler(request(input), response(), conflictDb as any)).rejects.toBeInstanceOf(AppError);
    expect(conflictClient.query.mock.calls[3][0]).toBe('ROLLBACK');
  });

  it('rejects a second write to the same tenant run id and rolls back', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored(45)] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { getClient: jest.fn().mockResolvedValue(client) };

    await expect(storeResultIndexHandler(request({
      idempotency_key: 'different-key',
      result: result(),
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 409, code: 'run_conflict' });
    expect(client.query.mock.calls[4][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('resolves run, execution, or simulation IDs only inside the authenticated tenant', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [stored(44)] }) };
    const res = response();

    await getResultIndexHandler(request(), res, db as any);

    expect(db.query.mock.calls[0][0]).toContain('organization_id = $1');
    expect(db.query.mock.calls[0][0]).toContain('run_id = $2 OR execution_id = $2 OR simulation_id = $2');
    expect(db.query.mock.calls[0][1]).toEqual(['org-test', 'exec-1']);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects invalid result identifiers and missing tenant results', async () => {
    const invalid = request();
    invalid.params = { result_id: '' };
    const db = { query: jest.fn() };
    await expect(getResultIndexHandler(invalid, response(), db as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'validation_error',
    });
    expect(db.query).not.toHaveBeenCalled();

    db.query.mockResolvedValue({ rows: [] });
    await expect(getResultIndexHandler(request(), response(), db as any)).rejects.toMatchObject({
      statusCode: 404,
      code: 'result_not_found',
    });
  });

  it('lists a stable tenant cursor with bound filters', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [stored(51), stored(52)] }) };
    const req = request();
    req.query = { after_id: '50', limit: '25', environment: 'staging', status: 'completed' };
    const res = response();

    await listResultIndexHandler(req, res, db as any);

    expect(db.query.mock.calls[0][0]).toContain('organization_id = $1 AND id > $2');
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY id ASC');
    expect(db.query.mock.calls[0][1]).toEqual(['org-test', '50', 'staging', 'completed', 25]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-test',
      next_after_id: '52',
    }));
  });

  it.each([
    [{ after_id: '-1' }, 'after_id'],
    [{ after_id: 'not-an-integer' }, 'after_id'],
    [{ environment: '' }, 'environment'],
    [{ status: ['completed', 'failed'] }, 'status'],
  ])('rejects an invalid replay query %#', async (query, field) => {
    const req = request();
    req.query = query;
    const db = { query: jest.fn() };

    await expect(listResultIndexHandler(req, response(), db as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'validation_error',
      message: expect.stringContaining(field),
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
