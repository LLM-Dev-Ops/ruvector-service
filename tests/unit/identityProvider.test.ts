import { Request, Response } from 'express';
import { createCipheriv, createHash } from 'crypto';
import {
  authorizeCliSessionHandler,
  createCliSessionHandler,
  lookupApiKeyHandler,
  lookupEntitlementHandler,
  pollCliSessionHandler,
} from '../../src/handlers/identityProvider';
import { config } from '../../src/config';

const keyHash = 'a'.repeat(64);

function deliveryBinding(sessionCode: string, organizationId: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    key_id: keyId,
    organization_id: organizationId,
    session_code: sessionCode,
  }), 'utf8');
}

function encryptedDelivery(
  value: string,
  sessionCode = 'ABCDEFGH',
  organizationId = 'org-test',
  keyId = 'c433a3fa-1d07-4e56-bf30-b9019c7f1415'
): string {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  cipher.setAAD(deliveryBinding(sessionCode, organizationId, keyId));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function response(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('IAM-scoped identity provider', () => {
  const originalAllowedScopes = config.dataPlaneIdentity.allowedScopes;
  const originalDefaultScopes = config.dataPlaneIdentity.defaultScopes;

  afterEach(() => {
    config.dataPlaneIdentity.allowedScopes = originalAllowedScopes;
    config.dataPlaneIdentity.defaultScopes = originalDefaultScopes;
  });

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
      max_tokens: '1000000', max_api_keys: '10', scopes: ['simulation:run'],
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

  it.each([
    ['max_requests', '9007199254740992'],
    ['max_tokens', '9007199254740992'],
    ['max_api_keys', '9007199254740992'],
  ])('fails closed instead of rounding an unsafe %s entitlement', async (field, value) => {
    const row = {
      organization_id: 'org-test', plan: 'enterprise', max_requests: '10000',
      max_tokens: '1000000', max_api_keys: '10', scopes: ['simulation:run'], [field]: value,
    };
    const db = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const res = response();

    await expect(lookupEntitlementHandler(
      { body: { key_hash: keyHash } } as Request,
      res,
      db as never
    )).rejects.toMatchObject({ statusCode: 500, code: 'invalid_entitlement_value' });
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each([
    ['retired scope', ['simulation:run', 'tenant:admin']],
    ['duplicate scope', ['simulation:run', 'simulation:run']],
    ['empty scope list', []],
    ['malformed persisted scope list', { scope: 'simulation:run' }],
  ])('fails closed without resolving entitlements for a key with a %s', async (_case, scopes) => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      organization_id: 'org-test', plan: 'developer', max_requests: '10000',
      max_tokens: '1000000', max_api_keys: '10', scopes,
    }] }) };
    const res = response();

    await expect(lookupEntitlementHandler(
      { body: { key_hash: keyHash } } as Request,
      res,
      db as never
    )).rejects.toMatchObject({ statusCode: 404, code: 'entitlement_not_found' });
    expect(res.json).not.toHaveBeenCalled();
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

  it.each([
    ['retired scope', ['simulation:run', 'tenant:admin']],
    ['duplicate scope', ['simulation:run', 'simulation:run']],
    ['empty scope list', []],
    ['malformed persisted scope list', { scope: 'simulation:run' }],
  ])('fails closed without disclosing a key with a %s', async (_case, scopes) => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
      organization_id: 'org-test',
      name: 'cli',
      scopes,
      created_at: new Date('2026-11-12T00:00:00Z'),
      expires_at: null,
      last_used_at: null,
    }] }) };
    const res = response();

    await expect(lookupApiKeyHandler(
      { body: { key_hash: keyHash } } as Request,
      res,
      db as never
    )).rejects.toMatchObject({ statusCode: 404, code: 'api_key_not_found' });
    expect(res.json).not.toHaveBeenCalled();
  });

  it('creates a bounded CLI session while persisting only a device-code hash', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ expires_at: '2030-01-01T00:10:00Z' }] }) };
    const res = response();
    await createCliSessionHandler({ body: {
      cli_name: 'agentics-cli', scopes: ['platform:read'],
    } } as Request, res, db as never);

    const created = (res.json as jest.Mock).mock.calls[0][0];
    expect(created.session_code).toMatch(/^[A-Z0-9]{8}$/);
    expect(created.device_code).toMatch(/^[a-f0-9]{64}$/);
    expect(created.verification_url).toBe(`https://platform.test/cli/auth?code=${created.session_code}`);
    expect(db.query.mock.calls[0][1][1]).toBe(createHash('sha256').update(created.device_code).digest('hex'));
    expect(db.query.mock.calls[0][1]).not.toContain(created.device_code);
  });

  it('rejects tenant injection and unsupported scopes before creating a CLI session', async () => {
    const db = { query: jest.fn() };
    await expect(createCliSessionHandler({ body: {
      organization_id: 'attacker', scopes: ['platform:read'],
    } } as Request, response(), db as never)).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createCliSessionHandler({ body: {
      scopes: ['tenant:admin'],
    } } as Request, response(), db as never)).rejects.toMatchObject({ code: 'scope_not_allowed' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('authorizes with a verified user membership and delivers the encrypted key exactly once', async () => {
    let encryptedKey = '';
    let insertedKeyHash = '';
    const authorizationClient = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'pending', requested_scopes: ['platform:read'],
          organization_id: null, key_id: null, encrypted_api_key: null,
          expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        if (sql.includes('FROM data_plane_identity_organizations')) return { rows: [{
          max_api_keys: 10, active_api_keys: 1,
        }] };
        if (sql.includes('INSERT INTO data_plane_api_keys')) insertedKeyHash = String(params?.[4]);
        if (sql.includes('UPDATE data_plane_cli_sessions')) encryptedKey = String(params?.[5]);
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const authorizeDb = { getClient: jest.fn().mockResolvedValue(authorizationClient) };
    const authorizeRes = response();
    await authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' },
      body: { session_code: 'ABCDEFGH', scopes: ['platform:read'] },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, authorizeRes, authorizeDb as never, async () => ({
      issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'owner@example.test',
    }));

    expect(authorizeRes.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, organization_id: 'org-test', key_id: expect.any(String),
    }));
    const issuedKeyId = String((authorizeRes.json as jest.Mock).mock.calls[0][0].key_id);
    expect((authorizeRes.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('api_key');
    expect(authorizationClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['identity-api-keys:org-test']
    );
    expect(authorizationClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM data_plane_cli_sessions[\s\S]*FOR UPDATE/),
      ['ABCDEFGH']
    );
    expect(authorizationClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/expires_at > clock_timestamp\(\)[\s\S]*AS is_unexpired/),
      ['ABCDEFGH']
    );
    const authorizationLockIndex = authorizationClient.query.mock.calls.findIndex(([sql]) =>
      /FROM data_plane_cli_sessions[\s\S]*FOR UPDATE/.test(String(sql)));
    const authorizationExpiryIndex = authorizationClient.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('expires_at > clock_timestamp()'));
    expect(authorizationExpiryIndex).toBeGreaterThan(authorizationLockIndex);
    expect(encryptedKey).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encryptedKey).not.toContain('agentics_sk_cli_');

    const deviceCode = 'b'.repeat(64);
    const pollClient = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: issuedKeyId,
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: encryptedKey, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: true }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: issuedKeyId,
          key_hash: insertedKeyHash,
          scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pollDb = { getClient: jest.fn().mockResolvedValue(pollClient) };
    const pollRes = response();
    await pollCliSessionHandler({ params: { device_code: deviceCode } } as unknown as Request, pollRes, pollDb as never);

    const completed = (pollRes.json as jest.Mock).mock.calls[0][0];
    expect(completed).toEqual(expect.objectContaining({
      status: 'completed', email: 'owner@example.test', organization_id: 'org-test', role: 'owner',
    }));
    expect(completed.api_key).toMatch(/^agentics_sk_cli_[a-f0-9]{64}$/);
    expect(insertedKeyHash).toBe(createHash('sha256').update(completed.api_key).digest('hex'));
    expect(pollClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM data_plane_identity_memberships[\s\S]*FOR SHARE/),
      ['https://identity.test/auth/v1', 'user-1', 'org-test']
    );
    expect(pollClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM data_plane_api_keys[\s\S]*FOR SHARE/),
      [issuedKeyId, 'org-test']
    );
    expect(pollClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM data_plane_cli_sessions s[\s\S]*FOR UPDATE/),
      [createHash('sha256').update(deviceCode).digest('hex')]
    );
    expect(pollClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/s\.expires_at > clock_timestamp\(\)[\s\S]*AS is_unexpired/),
      ['ABCDEFGH']
    );
    const pollLockIndex = pollClient.query.mock.calls.findIndex(([sql]) =>
      /FROM data_plane_cli_sessions s[\s\S]*FOR UPDATE/.test(String(sql)));
    const pollExpiryIndex = pollClient.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('expires_at > clock_timestamp()'));
    expect(pollExpiryIndex).toBeGreaterThan(pollLockIndex);
    const pollKeyLockIndex = pollClient.query.mock.calls.findIndex(([sql]) =>
      /FROM data_plane_api_keys[\s\S]*FOR SHARE/.test(String(sql)));
    const pollKeyActivityIndex = pollClient.query.mock.calls.findIndex(([sql]) =>
      /expires_at > clock_timestamp\(\)[\s\S]*AS is_active/.test(String(sql)));
    expect(pollKeyActivityIndex).toBeGreaterThan(pollKeyLockIndex);
    expect(pollClient.query).toHaveBeenCalledWith(expect.stringContaining('encrypted_api_key = NULL'), ['ABCDEFGH']);
  });

  it('rejects authorization scope escalation and missing tenant membership', async () => {
    const makeClient = (membership: boolean) => ({
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: membership ? [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] : [] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'pending', requested_scopes: ['platform:read'],
          organization_id: null, key_id: null, encrypted_api_key: null,
          expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    });
    const verifier = async () => ({
      issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'owner@example.test',
    });
    const request = {
      params: { session_code: 'ABCDEFGH' },
      body: { session_code: 'ABCDEFGH', scopes: ['platform:write'] },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request;
    await expect(authorizeCliSessionHandler(
      request, response(), { getClient: jest.fn().mockResolvedValue(makeClient(true)) } as never, verifier
    )).rejects.toMatchObject({ code: 'scope_escalation' });
    await expect(authorizeCliSessionHandler(
      request, response(), { getClient: jest.fn().mockResolvedValue(makeClient(false)) } as never, verifier
    )).rejects.toMatchObject({ code: 'identity_membership_required' });
  });

  it('rejects a non-owner membership before reading or mutating the CLI session', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'member@example.test', payment_status: 'paid', role: 'member',
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'member@example.test' })))
      .rejects.toMatchObject({ statusCode: 403, code: 'identity_owner_required' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM data_plane_cli_sessions'), expect.anything()
    );
  });

  it('rejects ambiguous active memberships before reading or mutating the CLI session', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [
          {
            issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-one',
            email: 'owner@example.test', payment_status: 'paid', role: 'owner',
          },
          {
            issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-two',
            email: 'owner@example.test', payment_status: 'paid', role: 'owner',
          },
        ] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'owner@example.test' })))
      .rejects.toMatchObject({ statusCode: 403, code: 'identity_membership_ambiguous' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM data_plane_cli_sessions'), expect.anything()
    );
  });

  it.each([
    ['at the active key limit', { max_api_keys: 2, active_api_keys: 2 }, 'api_key_limit_reached', 409],
    ['with a missing entitlement row', null, 'invalid_api_key_entitlement', 500],
    ['with an unsafe API-key limit', {
      max_api_keys: '9007199254740992', active_api_keys: '0',
    }, 'invalid_entitlement_value', 500],
  ])('rejects key creation %s inside the tenant-serialized transaction', async (
    _case, entitlement, code, statusCode
  ) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'pending', requested_scopes: ['platform:read'],
          organization_id: null, key_id: null, encrypted_api_key: null,
          expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        if (sql.includes('FROM data_plane_identity_organizations')) {
          return { rows: entitlement ? [entitlement] : [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'owner@example.test' })))
      .rejects.toMatchObject({ code, statusCode });

    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['identity-api-keys:org-test']
    );
    const tenantLockIndex = client.query.mock.calls.reduce((found, [sql], index) =>
      String(sql).includes('pg_advisory_xact_lock') ? index : found, -1);
    const activeKeyCountIndex = client.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('FROM data_plane_identity_organizations'));
    expect(activeKeyCountIndex).toBeGreaterThan(tenantLockIndex);
    const activeKeyCountSql = String(client.query.mock.calls[activeKeyCountIndex][0]);
    expect(activeKeyCountSql).toContain('k.expires_at > clock_timestamp()');
    expect(activeKeyCountSql).not.toContain('k.expires_at > NOW()');
    expect(activeKeyCountSql).toContain(')::bigint AS active_api_keys');
    expect(activeKeyCountSql).not.toContain(')::integer AS active_api_keys');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO data_plane_api_keys'), expect.anything()
    );
  });

  it('uses configured default scopes and rejects malformed session input', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ expires_at: '2030-01-01T00:10:00Z' }] }) };
    await createCliSessionHandler({ body: {} } as Request, response(), db as never);
    expect(db.query.mock.calls[0][1][5]).toBe(JSON.stringify(['platform:read']));

    await expect(createCliSessionHandler(
      { body: { scopes: [1] } } as unknown as Request, response(), db as never
    )).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createCliSessionHandler(
      { body: { scopes: ['platform:read', 'platform:read'] } } as Request,
      response(),
      db as never
    )).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createCliSessionHandler(
      { body: { scopes: [] } } as Request,
      response(),
      db as never
    )).rejects.toMatchObject({ code: 'validation_error' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['duplicate allowed scopes', 'allowedScopes', '["platform:read","platform:read"]'],
    ['whitespace-padded allowed scopes', 'allowedScopes', '[" platform:read"]'],
    ['duplicate default scopes', 'defaultScopes', '["platform:read","platform:read"]'],
    ['whitespace-padded default scopes', 'defaultScopes', '["platform:read "]'],
    ['default scopes outside the allowlist', 'defaultScopes', '["tenant:admin"]'],
  ])('fails closed at request time for %s', async (_case, field, value) => {
    (config.dataPlaneIdentity as unknown as Record<string, string>)[field] = value;
    const db = { query: jest.fn() };

    await expect(createCliSessionHandler(
      { body: {} } as Request,
      response(),
      db as never
    )).rejects.toMatchObject({ statusCode: 503, code: 'identity_configuration_error' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate', ['platform:read', 'platform:read']],
    ['empty', []],
  ])('rejects %s authorization scopes before identity or persistence access', async (_case, scopes) => {
    const verify = jest.fn();
    const db = { getClient: jest.fn() };
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' },
      body: { session_code: 'ABCDEFGH', scopes },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, response(), db as never, verify)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []],
    ['duplicate', ['platform:read', 'platform:read']],
    ['retired', ['retired:scope']],
    ['malformed', [1]],
  ])('rejects %s persisted session scopes before key entitlement or creation', async (_case, requestedScopes) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'pending', requested_scopes: requestedScopes,
          organization_id: null, key_id: null, encrypted_api_key: null,
          expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer verified-user-jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: 'owner@example.test' })))
      .rejects.toMatchObject({ statusCode: 500, code: 'invalid_session_scopes' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['identity-api-keys:org-test']
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO data_plane_api_keys'), expect.anything()
    );
  });

  it.each([
    ['missing JWT', {}, 'end_user_authentication_required'],
    ['API key in place of JWT', { authorization: 'Bearer agentics_sk_cli_bad' }, 'end_user_jwt_required'],
  ])('rejects %s before opening a transaction', async (_case, headers, code) => {
    const db = { getClient: jest.fn() };
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' },
      body: { session_code: 'ABCDEFGH' }, headers,
    } as unknown as Request, response(), db as never)).rejects.toMatchObject({ code });
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it('rejects route/body session mismatch before user verification', async () => {
    const verify = jest.fn();
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' },
      body: { session_code: 'JKLMNPQR' }, headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, response(), {} as never, verify)).rejects.toMatchObject({
      code: 'session_code_mismatch',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ['email mismatch', {
      session: { status: 'pending', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true },
      userEmail: 'attacker@example.test', code: 'identity_membership_mismatch',
    }],
    ['missing session', { session: null, code: 'session_not_found' }],
    ['expired session', { session: {
      status: 'pending', expires_at: '2030-01-01T00:10:00Z', is_unexpired: false,
    }, code: 'session_expired' }],
    ['completed cross-tenant session', {
      session: {
        status: 'completed', organization_id: 'org-other', key_id: 'existing',
        expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
      },
      code: 'session_already_authorized',
    }],
  ])('fails closed for %s', async (_case, scenario) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: scenario.session ? [{
          session_code: 'ABCDEFGH', requested_scopes: ['platform:read'], organization_id: null,
          key_id: null, encrypted_api_key: null, email: null, payment_status: null, role: null,
          ...scenario.session,
        }] : [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1',
      email: 'userEmail' in scenario ? scenario.userEmail : null })))
      .rejects.toMatchObject({ code: scenario.code });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    if (_case === 'completed cross-tenant session') {
      expect(client.query.mock.calls.some(([sql]) =>
        String(sql).includes('expires_at > clock_timestamp()'))).toBe(false);
    }
  });

  it('replays a completed authorization idempotently for the same tenant', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: null, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: true }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          key_hash: 'a'.repeat(64), scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const res = response();
    await authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, res, { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: null }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
    }));
    const replayKeyLockIndex = client.query.mock.calls.findIndex(([sql]) =>
      /FROM data_plane_api_keys[\s\S]*FOR SHARE/.test(String(sql)));
    const replayKeyActivityIndex = client.query.mock.calls.findIndex(([sql]) =>
      /expires_at > clock_timestamp\(\)[\s\S]*AS is_active/.test(String(sql)));
    expect(replayKeyLockIndex).toBeGreaterThan(-1);
    expect(replayKeyActivityIndex).toBeGreaterThan(replayKeyLockIndex);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO data_plane_api_keys'), expect.anything());
  });

  it.each([
    ['issuer', 'https://other-identity.test/auth/v1', 'user-1'],
    ['subject', 'https://identity.test/auth/v1', 'user-2'],
  ])('rejects completed authorization replay by a different %s before key access', async (
    _case, authorizedIssuer, authorizedSubject
  ) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: authorizedIssuer, authorized_subject: authorizedSubject,
          encrypted_api_key: null, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: null })))
      .rejects.toMatchObject({ statusCode: 409, code: 'session_already_authorized' });
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes('expires_at > clock_timestamp()'))).toBe(false);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM data_plane_api_keys'), expect.anything());
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each([
    ['missing', false],
    ['cross-tenant', false],
    ['revoked', true],
    ['expired', true],
  ])('fails closed when a completed authorization references a %s key', async (_case, keyExists) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: null, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
          email: null, payment_status: null, role: null,
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: false }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: keyExists ? [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415', key_hash: 'a'.repeat(64),
          scopes: ['platform:read'],
        }] : [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const res = response();
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, res, { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: null })))
      .rejects.toMatchObject({ statusCode: 409, code: 'session_key_not_active' });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []],
    ['duplicate', ['platform:read', 'platform:read']],
    ['retired', ['retired:scope']],
    ['malformed', { scope: 'platform:read' }],
  ])('fails closed when a completed authorization key has %s scopes', async (_case, scopes) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          issuer: 'https://identity.test/auth/v1', subject: 'user-1', organization_id: 'org-test',
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_cli_sessions')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: null, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415', key_hash: 'a'.repeat(64), scopes,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await expect(authorizeCliSessionHandler({
      params: { session_code: 'ABCDEFGH' }, body: { session_code: 'ABCDEFGH' },
      headers: { authorization: 'Bearer jwt' },
    } as unknown as Request, response(), { getClient: jest.fn().mockResolvedValue(client) } as never,
    async () => ({ issuer: 'https://identity.test/auth/v1', subject: 'user-1', email: null })))
      .rejects.toMatchObject({ statusCode: 409, code: 'session_key_not_active' });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('AS is_active'), expect.anything());
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each([
    ['malformed device code', 'short', null, 'validation_error'],
    ['unknown device code', 'c'.repeat(64), null, 'session_not_found'],
    ['expired session', 'c'.repeat(64), {
      status: 'pending', expires_at: '2030-01-01T00:10:00Z', is_unexpired: false,
    }, 'session_expired'],
    ['missing completed identity', 'c'.repeat(64), {
      status: 'completed', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
      organization_id: null,
    }, 'invalid_session_identity'],
  ])('rejects polling with %s', async (_case, deviceCode, session, code) => {
    const client = {
      query: jest.fn(async (sql: string) => sql.includes('FROM data_plane_cli_sessions s')
        ? { rows: session ? [{
          session_code: 'ABCDEFGH', requested_scopes: ['platform:read'], key_id: null,
          encrypted_api_key: null, email: null, payment_status: null, role: null,
          organization_id: null, ...session,
        }] : [] }
        : { rows: [] }),
      release: jest.fn(),
    };
    const db = { getClient: jest.fn().mockResolvedValue(client) };
    await expect(pollCliSessionHandler(
      { params: { device_code: deviceCode } } as unknown as Request, response(), db as never
    )).rejects.toMatchObject({ code });
    if (code === 'validation_error') expect(db.getClient).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked membership'],
    ['membership moved to another tenant'],
  ])('refuses one-time key delivery after %s', async (_case) => {
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: 'not-decrypted', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(pollCliSessionHandler(
      { params: { device_code: 'e'.repeat(64) } } as unknown as Request,
      response(), { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toMatchObject({ statusCode: 403, code: 'session_membership_inactive' });

    const membershipCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM data_plane_identity_memberships'));
    const membershipSql = String(membershipCall?.[0]);
    expect(membershipSql).toContain('organization_id = $3');
    expect(membershipSql).toContain('is_active = TRUE');
    expect(membershipSql).toContain('FOR SHARE');
    expect(membershipCall?.[1]).toEqual(['https://identity.test/auth/v1', 'user-1', 'org-test']);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
  });

  it('refuses delivery after the issued key is revoked or expired', async () => {
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: 'not-decrypted', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: false }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415', key_hash: 'a'.repeat(64),
          scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(pollCliSessionHandler(
      { params: { device_code: 'f'.repeat(64) } } as unknown as Request,
      response(), { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toMatchObject({ statusCode: 410, code: 'session_api_key_inactive' });

    const keyLockIndex = client.query.mock.calls.findIndex(([sql]) =>
      /FROM data_plane_api_keys[\s\S]*FOR SHARE/.test(String(sql)));
    const keyActivityIndex = client.query.mock.calls.findIndex(([sql]) =>
      /expires_at > clock_timestamp\(\)[\s\S]*AS is_active/.test(String(sql)));
    expect(keyLockIndex).toBeGreaterThan(-1);
    expect(keyActivityIndex).toBeGreaterThan(keyLockIndex);
    expect(String(client.query.mock.calls[keyActivityIndex][0])).not.toContain('NOW()');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
  });

  it.each([
    ['empty', []],
    ['duplicate', ['platform:read', 'platform:read']],
    ['retired', ['retired:scope']],
    ['malformed', { scope: 'platform:read' }],
  ])('refuses one-time delivery when the issued key has %s scopes', async (_case, scopes) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: 'not-decrypted', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415', key_hash: 'a'.repeat(64), scopes,
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    await expect(pollCliSessionHandler(
      { params: { device_code: 'f'.repeat(64) } } as unknown as Request,
      response(), { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toMatchObject({ statusCode: 410, code: 'session_api_key_inactive' });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('AS is_active'), expect.anything());
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
  });

  it('refuses delivery when the encrypted copy does not hash to the authorized key', async () => {
    const encryptedKey = encryptedDelivery(`agentics_sk_cli_${'1'.repeat(64)}`);
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415',
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: encryptedKey, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: true }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: 'c433a3fa-1d07-4e56-bf30-b9019c7f1415', key_hash: 'b'.repeat(64),
          scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(pollCliSessionHandler(
      { params: { device_code: 'a'.repeat(64) } } as unknown as Request,
      response(), { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toMatchObject({ statusCode: 500, code: 'session_api_key_binding_mismatch' });

    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
  });

  it('refuses a delivery envelope moved from another completed session', async () => {
    const plaintextKey = `agentics_sk_cli_${'2'.repeat(64)}`;
    const movedKeyId = 'd544b40b-2e18-4f67-9c41-ca12ad8f2526';
    const encryptedKey = encryptedDelivery(plaintextKey, 'OTHER123', 'org-test', movedKeyId);
    const res = response();
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: movedKeyId,
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: encryptedKey, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'owner@example.test', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: true }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: movedKeyId,
          key_hash: createHash('sha256').update(plaintextKey).digest('hex'),
          scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(pollCliSessionHandler(
      { params: { device_code: 'b'.repeat(64) } } as unknown as Request,
      res, { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toMatchObject({ statusCode: 500, code: 'invalid_encrypted_session_key' });

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rolls back without erasing the delivery copy when the completed response is invalid', async () => {
    const plaintextKey = `agentics_sk_cli_${'3'.repeat(64)}`;
    const keyId = 'e655c51c-3f29-4a78-ad52-db23be903637';
    const encryptedKey = encryptedDelivery(plaintextKey, 'ABCDEFGH', 'org-test', keyId);
    const res = response();
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
          session_code: 'ABCDEFGH', status: 'completed', requested_scopes: ['platform:read'],
          organization_id: 'org-test', key_id: keyId,
          authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
          encrypted_api_key: encryptedKey, expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        }] };
        if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
          email: 'not-an-email', payment_status: 'paid', role: 'owner',
        }] };
        if (sql.includes('AS is_active')) return { rows: [{ is_active: true }] };
        if (sql.includes('FROM data_plane_api_keys')) return { rows: [{
          key_id: keyId,
          key_hash: createHash('sha256').update(plaintextKey).digest('hex'),
          scopes: ['platform:read'],
        }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    await expect(pollCliSessionHandler(
      { params: { device_code: 'c'.repeat(64) } } as unknown as Request,
      res, { getClient: jest.fn().mockResolvedValue(client) } as never
    )).rejects.toBeDefined();

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('encrypted_api_key = NULL'), expect.anything()
    );
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns pending and redelivered-completed states without exposing a second key', async () => {
    const sessions = [
      { status: 'pending', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true },
      {
        status: 'completed', expires_at: '2030-01-01T00:10:00Z', is_unexpired: true,
        organization_id: 'org-test',
        authorized_issuer: 'https://identity.test/auth/v1', authorized_subject: 'user-1',
        encrypted_api_key: null,
      },
    ];
    for (const session of sessions) {
      const client = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('FROM data_plane_cli_sessions s')) return { rows: [{
            session_code: 'ABCDEFGH', requested_scopes: ['platform:read'], key_id: 'key',
            organization_id: null, encrypted_api_key: null, authorized_issuer: null,
            authorized_subject: null, ...session,
          }] };
          if (sql.includes('FROM data_plane_identity_memberships')) return { rows: [{
            email: 'owner@example.test', payment_status: 'paid', role: 'owner',
          }] };
          return { rows: [] };
        }),
        release: jest.fn(),
      };
      const res = response();
      await pollCliSessionHandler({ params: { device_code: 'd'.repeat(64) } } as unknown as Request,
        res, { getClient: jest.fn().mockResolvedValue(client) } as never);
      expect((res.json as jest.Mock).mock.calls[0][0]).not.toHaveProperty('api_key');
    }
  });
});
