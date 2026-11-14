import { Request, Response } from 'express';
import { createHash } from 'crypto';
import {
  appendUsageEntryHandler,
  cancelUsageReservationHandler,
  consumeUsageReservationHandler,
  createUsageReservationHandler,
  getUsageBalanceHandler,
} from '../../src/handlers/usageLedger';

const reservationId = '123e4567-e89b-42d3-a456-426614174000';

function request(body: unknown = {}): Request {
  return {
    body,
    params: { reservation_id: reservationId },
    query: {},
    dataPlanePrincipal: {
      subject: 'iam-subject-1', principal: 'platform@test.example', organization_id: 'org-test',
      audience: 'https://ruvector.test', mapping_source: 'configured_principal_binding',
    },
  } as unknown as Request;
}

function response(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function usageEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 17, entry_type: 'grant', amount: '10.000000', balance_after: '10.000000',
    correlation_id: 'corr-1', user_id: null, service: 'platform', run_id: null,
    metadata: {}, created_at: '2026-11-12T02:00:00.000Z', request_hash: 'unused', ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: reservationId, amount: '4.000000', status: 'active', correlation_id: 'corr-2',
    user_id: null, service: 'platform', run_id: null, metadata: {},
    expires_at: '2099-11-12T03:00:00.000Z', created_at: '2026-11-12T02:00:00.000Z',
    updated_at: '2026-11-12T02:00:00.000Z', request_hash: 'unused', final_action: null,
    final_idempotency_key: null, final_request_hash: null, ...overrides,
  };
}

function transactionalDb(rows: unknown[]) {
  const client = { query: jest.fn(), release: jest.fn() };
  for (const row of rows) client.query.mockResolvedValueOnce(row);
  return { client, db: { getClient: jest.fn().mockResolvedValue(client) } };
}

describe('tenant-bound usage ledger provider', () => {
  it('appends a grant atomically under the IAM-bound tenant', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ current_balance: '0', reserved_amount: '0' }] },
      { rows: [usageEntry()] }, { rows: [] },
    ]);
    const res = response();

    await appendUsageEntryHandler(request({
      idempotency_key: 'grant-1', entry_type: 'grant', amount: '10', correlation_id: 'corr-1', service: 'platform',
    }), res, db as any);

    expect(client.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(client.query.mock.calls[1][1]).toEqual(['org-test:usage-ledger']);
    expect(client.query.mock.calls[4][1][0]).toBe('org-test');
    expect(client.query.mock.calls[4][1]).toEqual(expect.arrayContaining(['10.000000', 'grant-1']));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ organization_id: 'org-test', replayed: false }));
  });

  it('rejects a debit that would spend reserved balance', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ current_balance: '10', reserved_amount: '8' }] }, { rows: [] },
    ]);
    await expect(appendUsageEntryHandler(request({
      idempotency_key: 'debit-1', entry_type: 'debit', amount: '3', correlation_id: 'corr-1',
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 409, code: 'insufficient_balance' });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting reuse of an entry idempotency key', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [usageEntry({ request_hash: 'different' })] }, { rows: [] },
    ]);
    await expect(appendUsageEntryHandler(request({
      idempotency_key: 'grant-1', entry_type: 'grant', amount: '11', correlation_id: 'corr-1',
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 409, code: 'idempotency_conflict' });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('replays an identical entry append without a second write', async () => {
    const input = { idempotency_key: 'grant-1', entry_type: 'grant', amount: '10', correlation_id: 'corr-1' } as const;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [usageEntry({ request_hash: requestHash })] }, { rows: [] },
    ]);
    const res = response();
    await appendUsageEntryHandler(request(input), res, db as any);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }));
    expect(client.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO'))).toBe(false);
  });

  it('rejects client-supplied organization scope before persistence', async () => {
    const db = { getClient: jest.fn() };
    await expect(appendUsageEntryHandler(request({
      organization_id: 'attacker', idempotency_key: 'grant-2', entry_type: 'grant', amount: '1', correlation_id: 'corr-1',
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it('reports balance and live reservations from one tenant-only statement', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ current_balance: '12', reserved_amount: '4' }] }) };
    const res = response();
    await getUsageBalanceHandler(request(), res, db as any);
    expect(db.query.mock.calls[0][0]).toContain('organization_id = $1');
    expect(db.query.mock.calls[0][1]).toEqual(['org-test']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-test', current_balance: '12.000000', reserved_amount: '4.000000', available_balance: '8.000000',
    }));
  });

  it('creates a reservation atomically after serializable availability validation', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ current_balance: '12', reserved_amount: '3' }] },
      { rows: [reservation()] }, { rows: [] },
    ]);
    const res = response();
    await createUsageReservationHandler(request({
      idempotency_key: 'reserve-1', amount: '4', ttl_seconds: 600, correlation_id: 'corr-2', service: 'platform',
    }), res, db as any);
    expect(client.query.mock.calls[4][0]).toContain('data_plane_usage_reservations');
    expect(client.query.mock.calls[4][1][1]).toBe('org-test');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects a reservation when live holds exhaust available balance', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ current_balance: '5', reserved_amount: '4' }] }, { rows: [] },
    ]);
    await expect(createUsageReservationHandler(request({
      idempotency_key: 'reserve-2', amount: '2', ttl_seconds: 60, correlation_id: 'corr-2',
    }), response(), db as any)).rejects.toMatchObject({ statusCode: 409, code: 'insufficient_balance' });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('consumes a reservation and ledger entry in the same transaction', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [reservation()] },
      { rows: [{ current_balance: '12', reserved_amount: '4' }] }, { rows: [] },
      { rows: [reservation({ status: 'consumed', final_action: 'consume', final_idempotency_key: 'consume-1' })] },
      { rows: [] },
    ]);
    const res = response();
    await consumeUsageReservationHandler(request({ idempotency_key: 'consume-1', correlation_id: 'corr-3' }), res, db as any);
    expect(client.query.mock.calls[5][0]).toContain("'reservation_consume'");
    expect(client.query.mock.calls[5][1]).toEqual(expect.arrayContaining(['org-test', '-4.000000', '8.000000', 'consume-1']));
    expect(client.query.mock.calls[6][0]).toContain('UPDATE data_plane_usage_reservations');
    expect(client.query.mock.calls[7][0]).toBe('COMMIT');
  });

  it('cancels without mutating the append-only entry stream', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [reservation()] },
      { rows: [reservation({ status: 'cancelled', final_action: 'cancel', final_idempotency_key: 'cancel-1' })] },
      { rows: [] },
    ]);
    await cancelUsageReservationHandler(request({ idempotency_key: 'cancel-1', correlation_id: 'corr-4' }), response(), db as any);
    expect(client.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO data_plane_usage_entries'))).toBe(false);
    expect(client.query.mock.calls[4][1]).toEqual(expect.arrayContaining(['org-test', reservationId, 'cancelled', 'cancel']));
  });

  it('rejects a reservation action idempotency key reused for another action', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] },
      { rows: [reservation({ final_action: 'cancel', final_idempotency_key: 'shared', final_request_hash: 'different' })] },
      { rows: [] },
    ]);
    await expect(consumeUsageReservationHandler(request({ idempotency_key: 'shared', correlation_id: 'corr-5' }), response(), db as any))
      .rejects.toMatchObject({ statusCode: 409, code: 'idempotency_conflict' });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('returns not found without leaking another tenant reservation', async () => {
    const { db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]);
    await expect(cancelUsageReservationHandler(request({ idempotency_key: 'cancel-x', correlation_id: 'corr-6' }), response(), db as any))
      .rejects.toMatchObject({ statusCode: 404, code: 'reservation_not_found' });
  });

  it('rejects an inactive reservation transition', async () => {
    const { db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [reservation({ status: 'consumed' })] }, { rows: [] },
    ]);
    await expect(cancelUsageReservationHandler(request({ idempotency_key: 'cancel-y', correlation_id: 'corr-7' }), response(), db as any))
      .rejects.toMatchObject({ statusCode: 409, code: 'reservation_not_active' });
  });

  it('expires a stale reservation and refuses consumption', async () => {
    const { client, db } = transactionalDb([
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [reservation({ expires_at: '2020-01-01T00:00:00.000Z' })] }, { rows: [] }, { rows: [] },
    ]);
    await expect(consumeUsageReservationHandler(request({ idempotency_key: 'consume-old', correlation_id: 'corr-8' }), response(), db as any))
      .rejects.toMatchObject({ statusCode: 409, code: 'reservation_expired' });
    expect(client.query.mock.calls[4][0]).toContain("status = 'expired'");
  });

  it('rejects malformed reservation identifiers before opening a transaction', async () => {
    const req = request({ idempotency_key: 'cancel-bad', correlation_id: 'corr-9' });
    req.params = { reservation_id: 'not-a-uuid' };
    const db = { getClient: jest.fn() };
    await expect(cancelUsageReservationHandler(req, response(), db as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.getClient).not.toHaveBeenCalled();
  });
});
