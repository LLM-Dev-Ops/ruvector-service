import { Request, Response } from 'express';
import { lookupApiKeyHandler, lookupEntitlementHandler } from '../../src/handlers/identityProvider';

const keyHash = 'a'.repeat(64);

function response(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('IAM-scoped identity provider', () => {
  it('resolves tenant ownership from an active API-key hash without exposing the hash', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
      organization_id: 'org-test',
      name: 'cli',
      scopes: ['simulation:run'],
      created_at: new Date('2026-11-12T00:00:00Z'),
      expires_at: null,
      last_used_at: null,
    }] }) };
    const res = response();

    await lookupApiKeyHandler({ body: { key_hash: keyHash } } as Request, res, db as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('key_hash = $1'), [keyHash]);
    expect(res.json).toHaveBeenCalledWith({
      key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
      organization_id: 'org-test', name: 'cli', scopes: ['simulation:run'],
      created_at: '2026-11-12T00:00:00.000Z', expires_at: null, last_used_at: null,
    });
    expect((res.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('key_hash');
  });

  it.each([
    ['raw API key', { api_key: 'ag_live_secret' }],
    ['caller organization', { key_hash: keyHash, organization_id: 'attacker-org' }],
  ])('rejects %s before querying persistence', async (_case, body) => {
    const db = { query: jest.fn() };
    await expect(lookupApiKeyHandler({ body } as Request, response(), db as never))
      .rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns the entitlement bound to the same active key hash', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      organization_id: 'org-test', plan: 'developer', max_requests: '10000',
      max_tokens: '1000000', max_api_keys: '10',
    }] }) };
    const res = response();

    await lookupEntitlementHandler({ body: { key_hash: keyHash } } as Request, res, db as never);

    expect(db.query.mock.calls[0][0]).toContain('data_plane_identity_lookup');
    expect(db.query.mock.calls[0][1]).toEqual([keyHash]);
    expect(res.json).toHaveBeenCalledWith({
      organization_id: 'org-test', plan: 'developer', max_requests: 10000,
      max_tokens: 1000000, max_api_keys: 10,
    });
  });

  it('uses the same non-disclosing response for unknown and inactive keys', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(lookupApiKeyHandler(
      { body: { key_hash: keyHash } } as Request,
      response(),
      db as never
    )).rejects.toEqual(expect.objectContaining({
      statusCode: 404,
      code: 'api_key_not_found',
    }));
  });
});
