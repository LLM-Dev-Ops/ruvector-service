import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { z } from 'zod';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import {
  parseEndUserJwtConfiguration,
  type EndUserJwtConfiguration,
} from './identityJwtConfiguration';
import { assertUniqueTopLevelJsonMembers } from './jsonMembers';

export interface VerifiedEndUser {
  issuer: string;
  subject: string;
  email: string | null;
}

let client: JwksClient | undefined;
let clientUri: string | undefined;

const EndUserEmailSchema = z.string().email().refine(
  (value) => value.trim() === value,
  'Email must not contain surrounding whitespace'
);

function signingClient(jwksUri: string): JwksClient {
  if (!client || clientUri !== jwksUri) {
    clientUri = jwksUri;
    client = jwksClient({
      jwksUri: clientUri,
      cache: true,
      cacheMaxAge: 600_000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 10_000,
    });
  }
  return client;
}

function signingKey(
  configuration: EndUserJwtConfiguration,
  header: JwtHeader,
  callback: SigningKeyCallback
): void {
  if (
    header.alg !== 'ES256' ||
    header.typ !== 'JWT' ||
    typeof header.kid !== 'string' ||
    header.kid.length === 0 ||
    header.kid.trim() !== header.kid ||
    Object.prototype.hasOwnProperty.call(header, 'crit')
  ) {
    callback(new Error('JWT signing metadata is invalid'));
    return;
  }
  signingClient(configuration.jwksUri).getSigningKey(header.kid)
    .then((key) => callback(null, key.getPublicKey()))
    .catch((error: Error) => callback(error));
}

function assertUniqueJwtMembers(token: string): void {
  try {
    const segments = token.split('.');
    if (segments.length !== 3 || segments[0].length === 0 || segments[1].length === 0) {
      throw new Error('JWT compact serialization is invalid');
    }
    assertUniqueTopLevelJsonMembers(Buffer.from(segments[0], 'base64url').toString('utf8'));
    assertUniqueTopLevelJsonMembers(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token is invalid or expired');
  }
}

export async function verifyEndUserJwt(token: string): Promise<VerifiedEndUser> {
  let identityConfiguration: EndUserJwtConfiguration;
  try {
    identityConfiguration = parseEndUserJwtConfiguration({
      issuer: config.dataPlaneIdentity.jwtIssuer,
      audience: config.dataPlaneIdentity.jwtAudience,
      jwksUri: config.dataPlaneIdentity.jwksUri,
    });
  } catch (error) {
    throw new AppError(
      503,
      'identity_configuration_error',
      error instanceof Error ? error.message : 'JWT verification configuration is invalid'
    );
  }
  assertUniqueJwtMembers(token);
  const payload = await new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(token, (header, callback) => signingKey(identityConfiguration, header, callback), {
      algorithms: ['ES256'],
      issuer: identityConfiguration.issuer,
      audience: identityConfiguration.audience,
    }, (error, decoded) => {
      if (error || !decoded || typeof decoded === 'string') {
        reject(error ?? new Error('JWT payload is invalid'));
        return;
      }
      resolve(decoded);
    });
  }).catch(() => {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token is invalid or expired');
  });

  if (
    typeof payload.sub !== 'string' || payload.sub.length === 0 ||
    payload.sub.trim() !== payload.sub ||
    payload.iss !== identityConfiguration.issuer ||
    typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= 0
  ) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token lacks required claims');
  }
  const audiences = typeof payload.aud === 'string'
    ? [payload.aud]
    : Array.isArray(payload.aud) ? payload.aud : [];
  if (
    audiences.length === 0 ||
    audiences.some((audience) =>
      typeof audience !== 'string' || audience.length === 0 || audience.trim() !== audience
    ) ||
    new Set(audiences).size !== audiences.length ||
    audiences.filter((audience) => audience === identityConfiguration.audience).length !== 1
  ) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token has an invalid audience claim');
  }
  if (
    (audiences.length > 1 && payload.azp !== identityConfiguration.audience) ||
    (payload.azp !== undefined && payload.azp !== identityConfiguration.audience)
  ) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token has an invalid authorized party');
  }
  const email = payload.email === undefined
    ? null
    : EndUserEmailSchema.safeParse(payload.email);
  if (email !== null && !email.success) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token has an invalid email claim');
  }
  return {
    issuer: identityConfiguration.issuer,
    subject: payload.sub,
    email: email === null ? null : email.data.toLowerCase(),
  };
}
