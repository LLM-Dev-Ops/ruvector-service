import { NextFunction, Request, Response } from 'express';
import { DataPlanePrincipalSchema, type DataPlanePrincipal } from '@llm-dev-ops/contracts';
import { config } from '../config';
import { AppError } from './errorHandler';

declare module 'express-serve-static-core' {
  interface Request {
    dataPlanePrincipal: DataPlanePrincipal;
  }
}

interface CloudRunClaims {
  aud?: string | string[];
  email?: string;
  sub?: string;
}

function bearerToken(req: Request): string {
  const header = req.headers['x-serverless-authorization'] ?? req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM bearer identity is required');
  }
  return value.slice('Bearer '.length);
}

function decodeClaims(token: string): CloudRunClaims {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token is malformed');
  }
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as CloudRunClaims;
  } catch {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token payload is invalid');
  }
}

function principalBindings(): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(config.dataPlaneIdentity.principalOrgBindings);
  } catch {
    throw new AppError(503, 'identity_configuration_error', 'Principal bindings are not valid JSON');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(503, 'identity_configuration_error', 'Principal bindings are not configured');
  }
  return Object.fromEntries(
    Object.entries(value).map(([principal, organization]) => [principal.toLowerCase(), String(organization)])
  );
}

export function requireDataPlaneTenant(req: Request, _res: Response, next: NextFunction): void {
  try {
    const claims = decodeClaims(bearerToken(req));
    const audience = config.dataPlaneIdentity.serviceAudience;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience || !audiences.includes(audience)) {
      throw new AppError(401, 'invalid_audience', 'Cloud Run IAM identity token audience does not match this service');
    }
    if (!claims.email || !claims.sub) {
      throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token lacks principal claims');
    }

    const organization = principalBindings()[claims.email.toLowerCase()];
    if (!organization) {
      throw new AppError(403, 'principal_not_mapped', 'Authenticated principal has no organization binding');
    }

    req.dataPlanePrincipal = DataPlanePrincipalSchema.parse({
      subject: claims.sub,
      principal: claims.email.toLowerCase(),
      organization_id: organization,
      audience,
      mapping_source: 'configured_principal_binding',
    });
    next();
  } catch (error) {
    next(error);
  }
}

export default requireDataPlaneTenant;
