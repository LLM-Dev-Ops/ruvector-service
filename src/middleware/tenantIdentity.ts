import { NextFunction, Request, Response } from 'express';
import { DataPlanePrincipalSchema, type DataPlanePrincipal } from '@llm-dev-ops/contracts';
import { z } from 'zod';
import { config } from '../config';
import { AppError } from './errorHandler';
import {
  parseIdentityCallerPrincipals,
  parsePrincipalOrgBindings,
  parseServiceAudience,
} from '../utils/principalBindings';
import { readSingleHeader } from '../utils/httpHeaders';
import { assertUniqueTopLevelJsonMembers } from '../utils/jsonMembers';
import { decodeStrictUtf8, isWellFormedUnicode } from '../utils/utf8';

declare module 'express-serve-static-core' {
  interface Request {
    dataPlanePrincipal: DataPlanePrincipal;
    identityProviderCaller: {
      subject: string;
      principal: string;
      audience: string;
    };
  }
}

interface CloudRunClaims {
  aud?: unknown;
  email?: unknown;
  sub?: unknown;
}

interface VerifiedIamClaims {
  email: string;
  sub: string;
  audience: string;
}

const TransportPrincipalEmailSchema = z.string().email().refine(
  (value) => value.trim() === value,
  'Principal email must not contain surrounding whitespace'
);

function bearerToken(req: Request): string {
  const serverlessAuthorization = readSingleHeader(req, 'x-serverless-authorization');
  const selected = serverlessAuthorization.present
    ? serverlessAuthorization
    : readSingleHeader(req, 'authorization');
  const header = selected.value;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM bearer identity is required');
  }
  const token = header.slice('Bearer '.length);
  if (token.length === 0 || token.trim() !== token) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM bearer identity is required');
  }
  return token;
}

function decodeClaims(token: string): CloudRunClaims {
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token is malformed');
  }
  try {
    const decodedSegments = segments.map((segment) => Buffer.from(segment, 'base64url'));
    if (decodedSegments.some((decoded, index) => decoded.toString('base64url') !== segments[index])) {
      throw new Error('JWT component encoding is not canonical');
    }
    const protectedHeaderJson = decodeStrictUtf8(decodedSegments[0]);
    assertUniqueTopLevelJsonMembers(protectedHeaderJson);
    const protectedHeader: unknown = JSON.parse(protectedHeaderJson);
    if (
      protectedHeader === null ||
      typeof protectedHeader !== 'object' ||
      Array.isArray(protectedHeader)
    ) {
      throw new Error('JWT protected header is not an object');
    }
    const header = protectedHeader as Record<string, unknown>;
    if (
      header.alg !== 'RS256' ||
      header.typ !== 'JWT' ||
      typeof header.kid !== 'string' ||
      header.kid.length === 0 ||
      header.kid.trim() !== header.kid ||
      !isWellFormedUnicode(header.kid) ||
      Object.prototype.hasOwnProperty.call(header, 'crit')
    ) {
      throw new Error('JWT protected header metadata is invalid');
    }
    const payloadJson = decodeStrictUtf8(decodedSegments[1]);
    assertUniqueTopLevelJsonMembers(payloadJson);
    const decoded: unknown = JSON.parse(payloadJson);
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('JWT payload is not an object');
    }
    return decoded as CloudRunClaims;
  } catch {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token payload is invalid');
  }
}

function requireIamClaims(req: Request): VerifiedIamClaims {
  let audience: string;
  try {
    audience = parseServiceAudience(config.dataPlaneIdentity.serviceAudience);
  } catch (error) {
    throw new AppError(
      503,
      'identity_configuration_error',
      error instanceof Error ? error.message : 'Service audience is invalid'
    );
  }
  const claims = decodeClaims(bearerToken(req));
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud) ? claims.aud : [];
  if (
    audiences.length === 0 ||
    audiences.some((entry) =>
      typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry ||
      !isWellFormedUnicode(entry)
    ) ||
    new Set(audiences).size !== audiences.length ||
    audiences.filter((entry) => entry === audience).length !== 1
  ) {
    throw new AppError(401, 'invalid_audience', 'Cloud Run IAM identity token audience does not match this service');
  }
  const email = TransportPrincipalEmailSchema.safeParse(claims.email);
  if (
    !email.success ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    claims.sub.trim() !== claims.sub ||
    !isWellFormedUnicode(claims.sub)
  ) {
    throw new AppError(401, 'unauthenticated', 'Cloud Run IAM identity token lacks principal claims');
  }
  return { email: email.data.toLowerCase(), sub: claims.sub, audience };
}

function identityCallerPrincipals(): Set<string> {
  try {
    return parseIdentityCallerPrincipals(config.dataPlaneIdentity.identityCallerPrincipals);
  } catch (error) {
    throw new AppError(
      503,
      'identity_configuration_error',
      error instanceof Error ? error.message : 'Identity caller principals are invalid'
    );
  }
}

function principalBindings(): Record<string, string> {
  try {
    return parsePrincipalOrgBindings(config.dataPlaneIdentity.principalOrgBindings);
  } catch (error) {
    throw new AppError(
      503,
      'identity_configuration_error',
      error instanceof Error ? error.message : 'Principal bindings are invalid'
    );
  }
}

export function requireDataPlaneTenant(req: Request, _res: Response, next: NextFunction): void {
  try {
    const claims = requireIamClaims(req);
    const organization = principalBindings()[claims.email];
    if (!organization) {
      throw new AppError(403, 'principal_not_mapped', 'Authenticated principal has no organization binding');
    }

    req.dataPlanePrincipal = DataPlanePrincipalSchema.parse({
      subject: claims.sub,
      principal: claims.email,
      organization_id: organization,
      audience: claims.audience,
      mapping_source: 'configured_principal_binding',
    });
    next();
  } catch (error) {
    next(error);
  }
}

export function requireIdentityProviderCaller(req: Request, _res: Response, next: NextFunction): void {
  try {
    const claims = requireIamClaims(req);
    if (!identityCallerPrincipals().has(claims.email)) {
      throw new AppError(403, 'identity_caller_not_allowed', 'Authenticated principal is not authorized for identity lookup');
    }
    req.identityProviderCaller = {
      subject: claims.sub,
      principal: claims.email,
      audience: claims.audience,
    };
    next();
  } catch (error) {
    next(error);
  }
}

export default requireDataPlaneTenant;
