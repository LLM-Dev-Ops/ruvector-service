import { generateKeyPairSync, sign as signBytes } from 'crypto';
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

function signedComponents(protectedHeader: string, payload: string): string {
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = signBytes('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${signingInput}.${signature}`;
}

function rawSignedToken(headerJson: string, payloadJson: string): string {
  return signedComponents(
    Buffer.from(headerJson).toString('base64url'),
    Buffer.from(payloadJson).toString('base64url'),
  );
}

function rawSignedBytesToken(protectedHeader: Buffer, payload: Buffer): string {
  return signedComponents(
    protectedHeader.toString('base64url'),
    payload.toString('base64url'),
  );
}

function noncanonicalComponent(canonical: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (canonical.length % 4 !== 2 && canonical.length % 4 !== 3) {
    throw new Error('Fixture must have unused base64url trailing bits');
  }
  const lastIndex = alphabet.indexOf(canonical.at(-1) ?? '');
  const alternate = canonical.slice(0, -1) + alphabet[lastIndex + 1];
  if (!Buffer.from(alternate, 'base64url').equals(Buffer.from(canonical, 'base64url'))) {
    throw new Error('Fixture alternate encoding changed the decoded value');
  }
  return alternate;
}

describe('end-user identity JWT verification', () => {
  beforeEach(() => {
    mockedJwks.mockReturnValue({
      getKeys: jest.fn().mockResolvedValue([
        { kid: 'test-key', alg: 'ES256', getPublicKey: () => publicKey },
      ]),
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
    ['JWT issuer', 'jwtIssuer', ' https://identity.test/auth/v1 '],
    ['JWT issuer with an explicit default port', 'jwtIssuer', 'https://identity.test:443/auth/v1'],
    ['JWT issuer with path dot segments', 'jwtIssuer', 'https://identity.test/auth/../auth/v1'],
    ['JWT issuer with embedded credentials', 'jwtIssuer', 'https://user:password@identity.test/auth/v1'],
    ['JWT issuer with a query', 'jwtIssuer', 'https://identity.test/auth/v1?tenant=example'],
    ['JWT issuer with a fragment', 'jwtIssuer', 'https://identity.test/auth/v1#issuer'],
    ['JWT audience', 'jwtAudience', ' authenticated '],
    ['JWKS URI', 'jwksUri', ' https://identity.test/.well-known/jwks.json '],
    ['JWKS URI with an explicit default port', 'jwksUri', 'https://identity.test:443/.well-known/jwks.json'],
    ['JWKS URI with path dot segments', 'jwksUri', 'https://identity.test/keys/../.well-known/jwks.json'],
    ['JWKS URI with embedded credentials', 'jwksUri', 'https://user:password@identity.test/.well-known/jwks.json'],
    ['JWKS URI with a fragment', 'jwksUri', 'https://identity.test/.well-known/jwks.json#keys'],
  ])('fails closed for non-canonical %s configuration before verification', async (
    _case,
    field,
    value,
  ) => {
    const identityConfig = config.dataPlaneIdentity as unknown as Record<string, string>;
    const original = identityConfig[field];
    identityConfig[field] = value;
    try {
      await expect(verifyEndUserJwt(token())).rejects.toMatchObject({
        statusCode: 503,
        code: 'identity_configuration_error',
      });
    } finally {
      identityConfig[field] = original;
    }
  });

  it('rejects a multi-audience token without an authorized party', async () => {
    const ambiguousAudience = jwt.sign({
      email: 'owner@example.test',
      aud: ['authenticated', 'other-client'],
    }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(ambiguousAudience)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });

  it('accepts a multi-audience token only when azp identifies this client', async () => {
    const boundAudience = jwt.sign({
      email: 'owner@example.test',
      aud: ['authenticated', 'other-client'],
      azp: 'authenticated',
    }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(boundAudience)).resolves.toMatchObject({
      issuer: 'https://identity.test/auth/v1',
      subject: 'user-1',
    });
  });

  it('rejects a token whose authorized party is another client', async () => {
    const wrongAuthorizedParty = jwt.sign({
      email: 'owner@example.test',
      aud: ['authenticated', 'other-client'],
      azp: 'other-client',
    }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(wrongAuthorizedParty)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });

  it.each([
    ['duplicate audience entries', ['authenticated', 'authenticated']],
    ['an empty audience entry', ['authenticated', '']],
    ['a whitespace-only audience entry', ['authenticated', '   ']],
    ['a whitespace-padded audience entry', ['authenticated', ' other-client ']],
  ])('rejects a multi-audience token with %s', async (_case, audience) => {
    const malformedAudience = jwt.sign({
      email: 'owner@example.test',
      aud: audience,
      azp: 'authenticated',
    }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(malformedAudience)).rejects.toMatchObject({
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

  it.each([
    [
      'duplicate protected-header members',
      '{"alg":"none","alg":"ES256","typ":"JWT","kid":"test-key"}',
      `{"iss":"https://identity.test/auth/v1","sub":"user-1","aud":"authenticated","exp":${Math.floor(Date.now() / 1000) + 300}}`,
    ],
    [
      'duplicate payload members',
      '{"alg":"ES256","typ":"JWT","kid":"test-key"}',
      `{"iss":"https://identity.test/auth/v1","sub":"attacker","sub":"user-1","aud":"authenticated","exp":${Math.floor(Date.now() / 1000) + 300}}`,
    ],
  ])('rejects %s before JWKS lookup', async (_case, headerJson, payloadJson) => {
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = 'https://identity.test/duplicate-json-jwks';
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);
    try {
      await expect(verifyEndUserJwt(rawSignedToken(headerJson, payloadJson))).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_end_user_token',
      });
      expect(getSigningKey).not.toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it.each([
    ['protected-header', true],
    ['payload', false],
  ])('rejects malformed UTF-8 in the %s before JWKS lookup', async (_case, invalidHeader) => {
    const validHeader = Buffer.from('{"alg":"ES256","typ":"JWT","kid":"test-key"}');
    const validPayload = Buffer.from(JSON.stringify({
      iss: 'https://identity.test/auth/v1',
      sub: 'user-1',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'owner@example.test',
    }));
    const invalidHeaderBytes = Buffer.concat([
      Buffer.from('{"alg":"ES256","typ":"JWT","kid":"test-key","x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const invalidPayloadBytes = Buffer.concat([
      Buffer.from(`{"iss":"https://identity.test/auth/v1","sub":"user-1","aud":"authenticated","exp":${Math.floor(Date.now() / 1000) + 300},"x":"`),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = 'https://identity.test/invalid-utf8-jwks';
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);
    try {
      await expect(verifyEndUserJwt(rawSignedBytesToken(
        invalidHeader ? invalidHeaderBytes : validHeader,
        invalidHeader ? validPayload : invalidPayloadBytes,
      ))).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_end_user_token',
      });
      expect(getSigningKey).not.toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it.each([
    ['protected-header', true],
    ['payload', false],
  ])('rejects a UTF-8 byte-order mark in the %s before JWKS lookup', async (_case, markedHeader) => {
    const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
    const validHeader = Buffer.from('{"alg":"ES256","typ":"JWT","kid":"test-key"}');
    const validPayload = Buffer.from(JSON.stringify({
      iss: 'https://identity.test/auth/v1',
      sub: 'user-1',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'owner@example.test',
    }));
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = 'https://identity.test/bom-jwks';
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);
    try {
      await expect(verifyEndUserJwt(rawSignedBytesToken(
        markedHeader ? Buffer.concat([byteOrderMark, validHeader]) : validHeader,
        markedHeader ? validPayload : Buffer.concat([byteOrderMark, validPayload]),
      ))).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_end_user_token',
      });
      expect(getSigningKey).not.toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it.each([
    ['protected-header', 0],
    ['payload', 1],
    ['signature', 2],
  ])('rejects a noncanonical %s component before JWKS lookup', async (_case, componentIndex) => {
    const headerJson = '{"alg":"ES256","typ":"JWT","kid":"test-key"}';
    const payloadJson = JSON.stringify({
      iss: 'https://identity.test/auth/v1',
      sub: 'user-1',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'owner@example.test',
    });
    const components = [
      Buffer.from(headerJson).toString('base64url'),
      Buffer.from(payloadJson).toString('base64url'),
    ];
    let candidate: string;
    if (componentIndex < 2) {
      components[componentIndex] = noncanonicalComponent(components[componentIndex]);
      candidate = signedComponents(components[0], components[1]);
    } else {
      const signed = signedComponents(components[0], components[1]).split('.');
      signed[2] = noncanonicalComponent(signed[2]);
      candidate = signed.join('.');
    }
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);

    await expect(verifyEndUserJwt(candidate)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
    expect(getSigningKey).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous JWKS response with duplicate key identifiers', async () => {
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = 'https://identity.test/duplicate-kid-jwks';
    const signingKeys = [
      { kid: 'test-key', alg: 'ES256', getPublicKey: () => publicKey },
      { kid: 'test-key', alg: 'ES256', getPublicKey: () => publicKey },
    ];
    const getKeys = jest.fn().mockResolvedValue(signingKeys);
    const jwks: {
      getKeys: jest.Mock<Promise<typeof signingKeys>, []>;
      getSigningKey: jest.Mock;
    } = {
      getKeys,
      getSigningKey: jest.fn(),
    };
    jwks.getSigningKey.mockImplementation(async (kid: string) => {
      const keys: typeof signingKeys = await jwks.getKeys();
      const key = keys.find((candidate) => candidate.kid === kid);
      if (!key) throw new Error('Signing key not found');
      return key;
    });
    mockedJwks.mockReturnValue(jwks as never);
    try {
      await expect(verifyEndUserJwt(token())).rejects.toMatchObject({
        statusCode: 401,
        code: 'invalid_end_user_token',
      });
      expect(getKeys).toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it.each([
    ['a non-string key id', 42],
    ['a whitespace-padded key id', ' test-key '],
    ['an unpaired-surrogate key id', '\uD800'],
  ])('rejects signing metadata with %s before JWKS lookup', async (caseName, kid) => {
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = `https://identity.test/${caseName.replaceAll(' ', '-')}-jwks`;
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);
    try {
      await expect(verifyEndUserJwt(unsignedMetadataToken(
        { alg: 'ES256', typ: 'JWT', kid },
        {
          iss: 'https://identity.test/auth/v1',
          sub: 'user-1',
          aud: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      ))).rejects.toMatchObject({ statusCode: 401, code: 'invalid_end_user_token' });
      expect(getSigningKey).not.toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it.each([
    ['a missing token type', undefined],
    ['an alternate token type', 'at+jwt'],
    ['a whitespace-padded token type', ' JWT '],
    ['a non-string token type', 42],
  ])('rejects signing metadata with %s before JWKS lookup', async (caseName, typ) => {
    const originalUri = config.dataPlaneIdentity.jwksUri;
    config.dataPlaneIdentity.jwksUri = `https://identity.test/${caseName.replaceAll(' ', '-')}-jwks`;
    const getSigningKey = jest.fn().mockResolvedValue({ getPublicKey: () => publicKey });
    mockedJwks.mockReturnValue({ getSigningKey } as never);
    const header: Record<string, unknown> = { alg: 'ES256', kid: 'test-key' };
    if (typ !== undefined) header.typ = typ;
    try {
      await expect(verifyEndUserJwt(unsignedMetadataToken(
        header,
        {
          iss: 'https://identity.test/auth/v1',
          sub: 'user-1',
          aud: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      ))).rejects.toMatchObject({ statusCode: 401, code: 'invalid_end_user_token' });
      expect(getSigningKey).not.toHaveBeenCalled();
    } finally {
      config.dataPlaneIdentity.jwksUri = originalUri;
    }
  });

  it('rejects a correctly signed token with an unsupported critical header', async () => {
    const unsupportedCriticalHeader = jwt.sign({ email: 'owner@example.test' }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
      header: { crit: ['tenant-binding'], 'tenant-binding': 'external' } as never,
    });
    await expect(verifyEndUserJwt(unsupportedCriticalHeader)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
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

  it.each([
    ['a non-string email', 42],
    ['an empty email', ''],
    ['a malformed email', 'not-an-email'],
    ['a whitespace-padded email', ' owner@example.test '],
  ])('rejects a correctly signed token with %s', async (_case, email) => {
    const malformedEmail = jwt.sign({ email }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(malformedEmail)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
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

  it('rejects a correctly signed token without an expiration claim', async () => {
    const withoutExpiration = jwt.sign({ email: 'owner@example.test' }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key', subject: 'user-1',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated',
    });
    await expect(verifyEndUserJwt(withoutExpiration)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });

  it('rejects a correctly signed token with a non-string subject', async () => {
    const malformedSubject = jwt.sign({ sub: 42 }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(malformedSubject)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });

  it.each([
    ['a whitespace-only subject', '   '],
    ['a whitespace-padded subject', ' user-1 '],
    ['an unpaired-surrogate subject', '\uD800'],
  ])('rejects a correctly signed token with %s', async (_case, sub) => {
    const malformedSubject = jwt.sign({ sub }, privateKey, {
      algorithm: 'ES256', keyid: 'test-key',
      issuer: 'https://identity.test/auth/v1', audience: 'authenticated', expiresIn: '5m',
    });
    await expect(verifyEndUserJwt(malformedSubject)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_end_user_token',
    });
  });
});
