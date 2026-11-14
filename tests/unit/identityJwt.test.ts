import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { verifyEndUserJwt } from '../../src/utils/identityJwt';
import { config } from '../../src/config';

jest.mock('jwks-rsa');

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const mockedJwks = jwksClient as jest.MockedFunction<typeof jwksClient>;

function token(overrides: { issuer?: string; audience?: string } = {}): string {
  return jwt.sign({ email: 'Owner@Example.Test' }, privateKey, {
    algorithm: 'ES256',
    keyid: 'test-key',
    subject: 'user-1',
    issuer: overrides.issuer ?? 'https://identity.test/auth/v1',
    audience: overrides.audience ?? 'authenticated',
    expiresIn: '5m',
  });
}

function unsignedMetadataToken(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return [header, payload, { signature: true }]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
}

describe('end-user identity JWT verification', () => {
  beforeEach(() => {
    mockedJwks.mockReturnValue({
      getSigningKey: jest.fn().mockResolvedValue({ getPublicKey: () => publicKey }),
    } as never);
  });

  it('verifies signature, algorithm, issuer, audience and subject', async () => {
    await expect(verifyEndUserJwt(token())).resolves.toEqual({
      issuer: 'https://identity.test/auth/v1',
      subject: 'user-1',
      email: 'owner@example.test',
    });
  });

  it.each([
    ['wrong issuer', { issuer: 'https://attacker.test/auth/v1' }],
    ['wrong audience', { audience: 'other-client' }],
  ])('rejects a validly signed token with %s', async (_case, overrides) => {
    await expect(verifyEndUserJwt(token(overrides))).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });

  it.each([
    ['missing key id', { alg: 'ES256', typ: 'JWT' }],
    ['wrong algorithm', { alg: 'RS256', typ: 'JWT', kid: 'test-key' }],
  ])('rejects signing metadata with %s', async (_case, header) => {
    await expect(verifyEndUserJwt(unsignedMetadataToken(header, {
      iss: 'https://identity.test/auth/v1', sub: 'user-1', aud: 'authenticated',
    }))).rejects.toMatchObject({ statusCode: 401, code: 'invalid_end_user_token' });
  });

  it('fails closed when the JWKS lookup fails', async () => {
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = 'https://identity.test/rotated-jwks';
    mockedJwks.mockReturnValue({
      getSigningKey: jest.fn().mockRejectedValue(new Error('JWKS unavailable')),
    } as never);
    try {
      await expect(verifyEndUserJwt(token())).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_end_user_token',
      });
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it('accepts a token without email but never invents one', async () => {
    const withoutEmail = jwt.sign({}, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(withoutEmail)).resolves.toMatchObject({ email: null });
  });

  it('rejects a token without a subject claim', async () => {
    const withoutSubject = jwt.sign({}, privateKey, {
      algorithm: 'ES256', keyid: 'test-key',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(withoutSubject)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });
});
