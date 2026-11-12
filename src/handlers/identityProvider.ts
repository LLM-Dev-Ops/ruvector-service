import { Request, Response } from 'express';
import {
  IdentityApiKeyLookupSchema,
  IdentityApiKeyResponseSchema,
  IdentityEntitlementResponseSchema,
} from '@llm-dev-ops/contracts';
import { DatabaseClient } from '../clients/DatabaseClient';
import { AppError } from '../middleware/errorHandler';

interface ApiKeyRow {
  key_id: string;
  organization_id: string;
  name: string;
  scopes: string[];
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

function timestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
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
    scopes: row.scopes,
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
    max_requests: Number(row.max_requests),
    max_tokens: Number(row.max_tokens),
    max_api_keys: Number(row.max_api_keys),
  }));
}
