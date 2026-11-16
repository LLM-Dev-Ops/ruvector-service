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

function assertUniqueJwksKeyIdentifiers(keys: unknown): void {
  if (!Array.isArray(keys)) {
    throw new Error('JWKS response must contain a key array');
  }
  const keyIdentifiers = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'object' || key === null || Array.isArray(key)) continue;
    const keyIdentifier = (key as Record<string, unknown>).kid;
    if (typeof keyIdentifier !== 'string') continue;
    if (keyIdentifiers.has(keyIdentifier)) {
      throw new Error('JWKS response contains an ambiguous key identifier');
    }
    keyIdentifiers.add(keyIdentifier);
  }
}

function signingClient(jwksUri: string): JwksClient {
  if (!client || clientUri !== jwksUri) {
    clientUri = jwksUri;
    const nextClient = jwksClient({
      jwksUri: clientUri,
      cache: true,
      cacheMaxAge: 600_000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 10_000,
    });
    const getKeys = nextClient.getKeys.bind(nextClient);
    nextClient.getKeys = async () => {
      const keys = await getKeys();
      assertUniqueJwksKeyIdentifiers(keys);
      return keys;
    };
    client = nextClient;
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

function assertCanonicalJwtSerialization(token: string): void {
  try {
    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment))
    ) {
      throw new Error('JWT compact serialization is invalid');
    }
    const decoded = segments.map((segment) => Buffer.from(segment, 'base64url'));
    if (decoded.some((value, index) => value.toString('base64url') !== segments[index])) {
      throw new Error('JWT component encoding is not canonical');
    }
    assertUniqueTopLevelJsonMembers(decoded[0].toString('utf8'));
    assertUniqueTopLevelJsonMembers(decoded[1].toString('utf8'));
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
  assertCanonicalJwtSerialization(token);
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
