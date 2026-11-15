import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { z } from 'zod';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

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

function signingClient(): JwksClient {
  if (!client || clientUri !== config.dataPlaneIdentity.jwksUri) {
    clientUri = config.dataPlaneIdentity.jwksUri;
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

function signingKey(header: JwtHeader, callback: SigningKeyCallback): void {
  if (
    header.alg !== 'ES256' ||
    typeof header.kid !== 'string' ||
    header.kid.length === 0 ||
    header.kid.trim() !== header.kid ||
    Object.prototype.hasOwnProperty.call(header, 'crit')
  ) {
    callback(new Error('JWT signing metadata is invalid'));
    return;
  }
  signingClient().getSigningKey(header.kid)
    .then((key) => callback(null, key.getPublicKey()))
    .catch((error: Error) => callback(error));
}

export async function verifyEndUserJwt(token: string): Promise<VerifiedEndUser> {
  const payload = await new Promise<JwtPayload>((resolve, reject) => {
    jwt.verify(token, signingKey, {
      algorithms: ['ES256'],
      issuer: config.dataPlaneIdentity.jwtIssuer,
      audience: config.dataPlaneIdentity.jwtAudience,
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
    payload.iss !== config.dataPlaneIdentity.jwtIssuer ||
    typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= 0
  ) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token lacks required claims');
  }
  const audiences = typeof payload.aud === 'string'
    ? [payload.aud]
    : Array.isArray(payload.aud) ? payload.aud : [];
  if (
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== 'string' || audience.length === 0) ||
    new Set(audiences).size !== audiences.length ||
    audiences.filter((audience) => audience === config.dataPlaneIdentity.jwtAudience).length !== 1
  ) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token has an invalid audience claim');
  }
  if (
    (audiences.length > 1 && payload.azp !== config.dataPlaneIdentity.jwtAudience) ||
    (payload.azp !== undefined && payload.azp !== config.dataPlaneIdentity.jwtAudience)
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
    issuer: payload.iss,
    subject: payload.sub,
    email: email === null ? null : email.data.toLowerCase(),
  };
}
