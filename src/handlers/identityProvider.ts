import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { PoolClient } from 'pg';
import {
  IdentityApiKeyLookupSchema,
  IdentityApiKeyResponseSchema,
  IdentityCliSessionAuthorizeSchema,
  IdentityCliSessionAuthorizedSchema,
  IdentityCliSessionCreateSchema,
  IdentityCliSessionCreatedSchema,
  IdentityCliSessionPollSchema,
  IdentityEntitlementResponseSchema,
} from '@llm-dev-ops/contracts';
import { DatabaseClient } from '../clients/DatabaseClient';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { VerifiedEndUser, verifyEndUserJwt } from '../utils/identityJwt';
import { parseIdentityScopeConfiguration } from '../utils/identityScopes';

interface ApiKeyRow {
  key_id: string;
  organization_id: string;
  name: string;
  scopes: unknown;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
}

interface EntitlementRow {
  organization_id: string;
  plan: 'free' | 'developer' | 'team' | 'enterprise';
  max_requests: number | string;
  max_tokens: number | string;
  max_api_keys: number | string;
}

interface ApiKeyLimitRow {
  max_api_keys: number | string;
  active_api_keys: number | string;
}

interface IdentityMembershipRow {
  issuer: string;
  subject: string;
  organization_id: string;
  email: string;
  payment_status: 'paid' | 'unpaid' | 'trial' | 'internal';
  role: string;
}

interface CliSessionRow {
  session_code: string;
  status: 'pending' | 'completed';
  requested_scopes: string[];
  organization_id: string | null;
  key_id: string | null;
  authorized_issuer: string | null;
  authorized_subject: string | null;
  encrypted_api_key: string | null;
  expires_at: Date | string;
}

interface CliSessionMembershipRow {
  email: string;
  payment_status: 'paid' | 'unpaid' | 'trial' | 'internal';
  role: 'owner';
}

interface ActiveApiKeyRow {
  key_id: string;
  key_hash: string;
  scopes: unknown;
}

export type EndUserVerifier = (token: string) => Promise<VerifiedEndUser>;

const SESSION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function identityScopeConfiguration(): { allowed: string[]; defaults: string[] } {
  try {
    return parseIdentityScopeConfiguration(
      config.dataPlaneIdentity.allowedScopes,
      config.dataPlaneIdentity.defaultScopes
    );
  } catch (error) {
    throw new AppError(
      503,
      'identity_configuration_error',
      error instanceof Error ? error.message : 'Identity scope configuration is invalid'
    );
  }
}

function allowedScopes(): Set<string> {
  return new Set(identityScopeConfiguration().allowed);
}

function requestedScopes(scopes: string[] | undefined): string[] {
  const configured = identityScopeConfiguration();
  const selected = scopes?.length ? scopes : configured.defaults;
  const allowed = new Set(configured.allowed);
  if (selected.some((scope) => !allowed.has(scope))) {
    throw new AppError(400, 'scope_not_allowed', 'CLI session requested an unsupported scope');
  }
  return selected;
}

function isCurrentScopeList(value: unknown): value is string[] {
  const allowed = allowedScopes();
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((scope) => typeof scope === 'string' && scope.length > 0 && allowed.has(scope)) &&
    new Set(value).size === value.length;
}

function activeApiKeyScopes(value: unknown): string[] {
  if (!isCurrentScopeList(value)) {
    throw new AppError(404, 'api_key_not_found', 'API key is not active');
  }
  return value;
}

function storedSessionScopes(value: unknown): string[] {
  const allowed = allowedScopes();
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((scope) => typeof scope !== 'string' || scope.length === 0 || !allowed.has(scope)) ||
    new Set(value).size !== value.length
  ) {
    throw new AppError(500, 'invalid_session_scopes', 'CLI session scope state is invalid');
  }
  return value;
}

function sessionCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (value) => SESSION_ALPHABET[value % SESSION_ALPHABET.length]).join('');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encryptionKey(): Buffer {
  const key = Buffer.from(config.dataPlaneIdentity.sessionEncryptionKey, 'base64');
  if (key.length !== 32) {
    throw new AppError(503, 'identity_configuration_error', 'CLI session encryption key is invalid');
  }
  return key;
}

function encryptApiKey(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptApiKey(value: string): string {
  const parts = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) {
    throw new AppError(500, 'invalid_encrypted_session_key', 'Persisted CLI key envelope is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), parts[0]);
  decipher.setAuthTag(parts[1]);
  try {
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'invalid_encrypted_session_key', 'Persisted CLI key envelope cannot be authenticated');
  }
}

function endUserToken(req: Request): string {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) {
    throw new AppError(401, 'end_user_authentication_required', 'End-user JWT is required');
  }
  const token = value.slice('Bearer '.length);
  if (token.startsWith('agentics_')) {
    throw new AppError(401, 'end_user_jwt_required', 'API keys cannot authorize CLI sessions');
  }
  return token;
}

function timestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function entitlementInteger(value: number | string, field: string): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new AppError(500, 'invalid_entitlement_value', `${field} is not a safe non-negative integer`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AppError(500, 'invalid_entitlement_value', `${field} is not a safe non-negative integer`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(500, 'invalid_entitlement_value', `${field} exceeds the lossless JSON integer range`);
  }
  return Number(parsed);
}

async function lockActiveApiKey(
  client: PoolClient,
  keyId: string,
  organizationId: string
): Promise<ActiveApiKeyRow | undefined> {
  const locked = await client.query<ActiveApiKeyRow>(
    `SELECT key_id, key_hash, scopes
       FROM data_plane_api_keys
      WHERE key_id = $1 AND organization_id = $2
      FOR SHARE`,
    [keyId, organizationId]
  );
  const key = locked.rows[0];
  if (!key || !isCurrentScopeList(key.scopes)) return undefined;

  // NOW() is fixed at transaction start. Evaluate activity only after the key
  // row lock is held so expiry cannot pass while this request waits on a lock.
  const activity = await client.query<{ is_active: boolean }>(
    `SELECT is_active = TRUE
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > clock_timestamp()) AS is_active
       FROM data_plane_api_keys
      WHERE key_id = $1 AND organization_id = $2`,
    [keyId, organizationId]
  );
  return activity.rows[0]?.is_active ? key : undefined;
}

function lookupRequest(req: Request): { key_hash: string } {
  const parsed = IdentityApiKeyLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'API key lookup request is invalid', parsed.error.issues);
  }
  return parsed.data;
}

export async function lookupApiKeyHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const input = lookupRequest(req);
  const result = await db.query<ApiKeyRow>(
    `SELECT key_id, organization_id, name, scopes, created_at, expires_at, last_used_at
       FROM data_plane_api_keys
      WHERE key_hash = $1
        AND is_active = TRUE
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [input.key_hash]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, 'api_key_not_found', 'API key is not active');
  }

  res.status(200).json(IdentityApiKeyResponseSchema.parse({
    key_id: row.key_id,
    organization_id: row.organization_id,
    name: row.name,
    scopes: activeApiKeyScopes(row.scopes),
    created_at: timestamp(row.created_at),
    expires_at: timestamp(row.expires_at),
    last_used_at: timestamp(row.last_used_at),
  }));
}

export async function lookupEntitlementHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const input = lookupRequest(req);
  const result = await db.query<EntitlementRow>(
    `SELECT organization_id, plan, max_requests, max_tokens, max_api_keys
       FROM data_plane_identity_lookup
      WHERE key_hash = $1
        AND is_active = TRUE
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [input.key_hash]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, 'entitlement_not_found', 'Entitlement is not available for an active API key');
  }

  res.status(200).json(IdentityEntitlementResponseSchema.parse({
    organization_id: row.organization_id,
    plan: row.plan,
    max_requests: entitlementInteger(row.max_requests, 'max_requests'),
    max_tokens: entitlementInteger(row.max_tokens, 'max_tokens'),
    max_api_keys: entitlementInteger(row.max_api_keys, 'max_api_keys'),
  }));
}

export async function createCliSessionHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const parsed = IdentityCliSessionCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'CLI session request is invalid', parsed.error.issues);
  }
  const scopes = requestedScopes(parsed.data.scopes);
  const code = sessionCode();
  const deviceCode = randomBytes(32).toString('hex');
  const inserted = await db.query<{ expires_at: Date | string }>(
    `INSERT INTO data_plane_cli_sessions
       (session_code, device_code_hash, cli_name, cli_version, hostname, requested_scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '10 minutes')
     RETURNING expires_at`,
    [code, sha256(deviceCode), parsed.data.cli_name ?? null, parsed.data.cli_version ?? null,
      parsed.data.hostname ?? null, JSON.stringify(scopes)]
  );
  const verification = new URL(config.dataPlaneIdentity.verificationUrl);
  verification.searchParams.set('code', code);
  res.status(201).json(IdentityCliSessionCreatedSchema.parse({
    session_code: code,
    device_code: deviceCode,
    verification_url: verification.toString(),
    expires_at: timestamp(inserted.rows[0].expires_at),
    expires_in_seconds: 600,
    poll_interval_seconds: 5,
  }));
}

export async function authorizeCliSessionHandler(
  req: Request,
  res: Response,
  db: DatabaseClient,
  verify: EndUserVerifier = verifyEndUserJwt
): Promise<void> {
  const parsed = IdentityCliSessionAuthorizeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'CLI session authorization is invalid', parsed.error.issues);
  }
  const routeCode = String(req.params.session_code ?? '');
  if (parsed.data.session_code !== routeCode) {
    throw new AppError(400, 'session_code_mismatch', 'CLI session code does not match the route');
  }
  const user = await verify(endUserToken(req));
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cli-session:${routeCode}`]);
    const membershipResult = await client.query<IdentityMembershipRow>(
      `SELECT issuer, subject, organization_id, email, payment_status, role
         FROM data_plane_identity_memberships
        WHERE issuer = $1 AND subject = $2 AND is_active = TRUE
        FOR SHARE`,
      [user.issuer, user.subject]
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      throw new AppError(403, 'identity_membership_required', 'Verified user has no active tenant membership');
    }
    if (membership.role !== 'owner') {
      throw new AppError(403, 'identity_owner_required', 'Only an active tenant owner may authorize CLI API keys');
    }
    if (user.email && user.email !== membership.email.toLowerCase()) {
      throw new AppError(403, 'identity_membership_mismatch', 'Verified user identity does not match tenant membership');
    }

    const selected = await client.query<CliSessionRow>(
      `SELECT session_code, status, requested_scopes, organization_id, key_id,
              authorized_issuer, authorized_subject, encrypted_api_key, expires_at, NULL::text AS email,
              NULL::text AS payment_status, NULL::text AS role
         FROM data_plane_cli_sessions
        WHERE session_code = $1
        FOR UPDATE`,
      [routeCode]
    );
    const session = selected.rows[0];
    if (!session) throw new AppError(404, 'session_not_found', 'CLI session was not found');
    // NOW() is fixed at transaction start in PostgreSQL. Re-read expiry from
    // the persistence wall clock only after the session row lock is held so a
    // waiter cannot authorize a session that expired while it was blocked.
    const expiry = await client.query<{ is_unexpired: boolean }>(
      `SELECT s.expires_at > clock_timestamp() AS is_unexpired
         FROM data_plane_cli_sessions s
        WHERE s.session_code = $1`,
      [routeCode]
    );
    if (!expiry.rows[0]?.is_unexpired) {
      throw new AppError(410, 'session_expired', 'CLI session has expired');
    }
    if (session.status === 'completed') {
      if (session.organization_id !== membership.organization_id
        || session.authorized_issuer !== membership.issuer
        || session.authorized_subject !== membership.subject
        || !session.key_id) {
        throw new AppError(409, 'session_already_authorized', 'CLI session was authorized by another identity');
      }
      const replayedKey = await lockActiveApiKey(
        client,
        session.key_id,
        membership.organization_id
      );
      if (!replayedKey) {
        throw new AppError(409, 'session_key_not_active', 'CLI session key is not active for this tenant');
      }
      await client.query('COMMIT');
      res.status(200).json(IdentityCliSessionAuthorizedSchema.parse({
        success: true,
        organization_id: membership.organization_id,
        key_id: session.key_id,
      }));
      return;
    }

    const storedScopes = storedSessionScopes(session.requested_scopes);
    const scopes = parsed.data.scopes ?? storedScopes;
    const allowed = allowedScopes();
    if (scopes.some((scope) => !allowed.has(scope) || !storedScopes.includes(scope))) {
      throw new AppError(400, 'scope_escalation', 'Authorized scopes must be a subset of requested scopes');
    }

    // Serialize key creation per tenant so concurrent CLI sessions cannot each
    // observe the same available slot and exceed the authoritative entitlement.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`identity-api-keys:${membership.organization_id}`]
    );
    const limitResult = await client.query<ApiKeyLimitRow>(
      `SELECT o.max_api_keys,
              COUNT(k.key_id) FILTER (
                WHERE k.is_active = TRUE
                  AND k.revoked_at IS NULL
                  AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp())
              )::bigint AS active_api_keys
         FROM data_plane_identity_organizations o
         LEFT JOIN data_plane_api_keys k ON k.organization_id = o.organization_id
        WHERE o.organization_id = $1
        GROUP BY o.max_api_keys`,
      [membership.organization_id]
    );
    const limit = limitResult.rows[0];
    if (!limit) {
      throw new AppError(500, 'invalid_api_key_entitlement', 'Tenant API key entitlement is invalid');
    }
    const maxApiKeys = entitlementInteger(limit.max_api_keys, 'max_api_keys');
    const activeApiKeys = entitlementInteger(limit.active_api_keys, 'active_api_keys');
    if (activeApiKeys >= maxApiKeys) {
      throw new AppError(409, 'api_key_limit_reached', 'Tenant API key limit has been reached');
    }

    const plaintextKey = `agentics_sk_cli_${randomBytes(32).toString('hex')}`;
    const keyId = randomUUID();
    await client.query(
      `INSERT INTO data_plane_api_keys
         (key_id, organization_id, name, scopes, key_hash, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE)`,
      [keyId, membership.organization_id, parsed.data.key_name ?? `CLI Key ${new Date().toISOString().slice(0, 10)}`,
        JSON.stringify(scopes), sha256(plaintextKey)]
    );
    await client.query(
      `UPDATE data_plane_cli_sessions
          SET status = 'completed', authorized_issuer = $2, authorized_subject = $3,
              organization_id = $4, key_id = $5, encrypted_api_key = $6, completed_at = NOW()
        WHERE session_code = $1`,
      [routeCode, membership.issuer, membership.subject, membership.organization_id,
        keyId, encryptApiKey(plaintextKey)]
    );
    await client.query('COMMIT');
    res.status(200).json(IdentityCliSessionAuthorizedSchema.parse({
      success: true,
      organization_id: membership.organization_id,
      key_id: keyId,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pollCliSessionHandler(
  req: Request,
  res: Response,
  db: DatabaseClient
): Promise<void> {
  const deviceCode = String(req.params.device_code ?? '');
  if (!/^[a-f0-9]{64}$/.test(deviceCode)) {
    throw new AppError(400, 'validation_error', 'device_code must be 64 lowercase hexadecimal characters');
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const selected = await client.query<CliSessionRow>(
      `SELECT s.session_code, s.status, s.requested_scopes, s.organization_id, s.key_id,
              s.authorized_issuer, s.authorized_subject, s.encrypted_api_key, s.expires_at
         FROM data_plane_cli_sessions s
        WHERE s.device_code_hash = $1
        FOR UPDATE`,
      [sha256(deviceCode)]
    );
    const session = selected.rows[0];
    if (!session) throw new AppError(404, 'session_not_found', 'CLI session was not found');
    const expiry = await client.query<{ is_unexpired: boolean }>(
      `SELECT s.expires_at > clock_timestamp() AS is_unexpired
         FROM data_plane_cli_sessions s
        WHERE s.session_code = $1`,
      [session.session_code]
    );
    if (!expiry.rows[0]?.is_unexpired) {
      throw new AppError(410, 'session_expired', 'CLI session has expired');
    }
    if (session.status === 'pending') {
      await client.query('COMMIT');
      res.status(200).json(IdentityCliSessionPollSchema.parse({ status: 'pending' }));
      return;
    }
    if (!session.organization_id || !session.key_id
      || !session.authorized_issuer || !session.authorized_subject) {
      throw new AppError(500, 'invalid_session_identity', 'Completed CLI session lacks tenant identity');
    }
    const membershipResult = await client.query<CliSessionMembershipRow>(
      `SELECT email, payment_status, role
         FROM data_plane_identity_memberships
        WHERE issuer = $1 AND subject = $2 AND organization_id = $3
          AND is_active = TRUE
        FOR SHARE`,
      [session.authorized_issuer, session.authorized_subject, session.organization_id]
    );
    const membership = membershipResult.rows[0];
    if (!membership || membership.role !== 'owner') {
      throw new AppError(403, 'session_membership_inactive', 'Authorizing tenant membership is no longer active');
    }
    let activeKey: ActiveApiKeyRow | undefined;
    if (session.encrypted_api_key) {
      const key = await lockActiveApiKey(client, session.key_id, session.organization_id);
      if (!key) {
        throw new AppError(410, 'session_api_key_inactive', 'Authorized API key is no longer active');
      }
      activeKey = key;
    }
    const plaintextKey = session.encrypted_api_key ? decryptApiKey(session.encrypted_api_key) : undefined;
    if (plaintextKey) {
      const plaintextHash = sha256(plaintextKey);
      if (!activeKey || !/^[a-f0-9]{64}$/.test(activeKey.key_hash) ||
          !timingSafeEqual(Buffer.from(plaintextHash, 'hex'), Buffer.from(activeKey.key_hash, 'hex'))) {
        throw new AppError(
          500,
          'session_api_key_binding_mismatch',
          'Encrypted CLI key is not bound to the authorized API key'
        );
      }
      await client.query(
        `UPDATE data_plane_cli_sessions
            SET encrypted_api_key = NULL, key_delivered_at = NOW()
          WHERE session_code = $1`,
        [session.session_code]
      );
    }
    await client.query('COMMIT');
    res.status(200).json(IdentityCliSessionPollSchema.parse({
      status: 'completed',
      ...(plaintextKey ? { api_key: plaintextKey } : {}),
      email: membership.email,
      payment_status: membership.payment_status,
      organization_id: session.organization_id,
      role: membership.role,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
