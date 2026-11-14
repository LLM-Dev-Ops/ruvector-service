import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

export interface VerifiedEndUser {
  issuer: string;
  subject: string;
  email: string | null;
}

let client: JwksClient | undefined;
let clientUri: string | undefined;

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
  if (header.alg !== 'ES256' || !header.kid) {
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

  if (!payload.sub || payload.iss !== config.dataPlaneIdentity.jwtIssuer) {
    throw new AppError(401, 'invalid_end_user_token', 'End-user identity token lacks required claims');
  }
  return {
    issuer: payload.iss,
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
  };
}
