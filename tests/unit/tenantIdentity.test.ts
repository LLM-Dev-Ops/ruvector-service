import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../src/middleware/errorHandler';
import { requireDataPlaneTenant, requireIdentityProviderCaller } from '../../src/middleware/tenantIdentity';
import { config } from '../../src/config';

function tokenValue(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256', typ: 'JWT', kid: 'google-key-1',
  })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${claims}.unsigned`;
}

function token(payload: Record<string, unknown>): string {
  return tokenValue(payload);
}

function rawToken(protectedHeader: string, payload: string): string {
  return `${Buffer.from(protectedHeader).toString('base64url')}.${Buffer.from(payload).toString('base64url')}.unsigned`;
}

function rawBytesToken(protectedHeader: Buffer, payload: Buffer): string {
  return `${protectedHeader.toString('base64url')}.${payload.toString('base64url')}.unsigned`;
}

function request(payload: Record<string, unknown>): Request {
  return {
    headers: { authorization: `Bearer ${token(payload)}` },
  } as unknown as Request;
}

describe('tenant-bound data-plane identity', () => {
  const originalBindings = config.dataPlaneIdentity.principalOrgBindings;
  const originalCallers = config.dataPlaneIdentity.identityCallerPrincipals;
  const originalAudience = config.dataPlaneIdentity.serviceAudience;

  afterEach(() => {
    config.dataPlaneIdentity.principalOrgBindings = originalBindings;
    config.dataPlaneIdentity.identityCallerPrincipals = originalCallers;
    config.dataPlaneIdentity.serviceAudience = originalAudience;
  });

  it('derives organization scope from the configured IAM principal binding', () => {
    const req = request({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.dataPlanePrincipal).toEqual({
      subject: 'iam-subject-1',
      principal: 'platform@test.example',
      organization_id: 'org-test',
      audience: 'https://ruvector.test',
      mapping_source: 'configured_principal_binding',
    });
  });

  it.each([
    ['wrong audience', { aud: 'https://other.test', email: 'platform@test.example', sub: 'iam-subject-1' }, 401, 'invalid_audience'],
    ['unmapped principal', { aud: 'https://ruvector.test', email: 'unknown@test.example', sub: 'iam-subject-2' }, 403, 'principal_not_mapped'],
  ])('fails closed for %s', (_case, claims, statusCode, code) => {
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(request(claims), {} as Response, next);

    const error = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.code).toBe(code);
  });

  it.each([
    ['duplicate audience entries', ['https://ruvector.test', 'https://ruvector.test']],
    ['an empty audience entry', ['https://ruvector.test', '']],
    ['a whitespace-only audience entry', ['https://ruvector.test', '   ']],
    ['a whitespace-padded audience entry', ['https://ruvector.test', ' other-service ']],
    ['a non-string audience entry', ['https://ruvector.test', 42]],
  ])('rejects a transport token with %s', (_case, aud) => {
    const req = request({
      aud, email: 'platform@test.example', sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'invalid_audience',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['a non-string principal email', { email: 42, sub: 'iam-subject-1' }],
    ['an empty principal email', { email: '', sub: 'iam-subject-1' }],
    ['a malformed principal email', { email: 'not-an-email', sub: 'iam-subject-1' }],
    ['a whitespace-padded principal email', { email: ' platform@test.example', sub: 'iam-subject-1' }],
    ['a non-string principal subject', { email: 'platform@test.example', sub: 42 }],
    ['an empty principal subject', { email: 'platform@test.example', sub: '' }],
    ['a whitespace-only principal subject', { email: 'platform@test.example', sub: '   ' }],
    ['a whitespace-padded principal subject', { email: 'platform@test.example', sub: ' iam-subject-1' }],
    ['an unpaired-surrogate principal subject', { email: 'platform@test.example', sub: '\uD800' }],
  ])('rejects transport identity with %s before principal binding', (_case, identity) => {
    const req = request({ aud: 'https://ruvector.test', ...identity });
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'claims'],
    ['a number', 42],
  ])('rejects %s transport JWT payload before principal binding', (_case, payload) => {
    const req = {
      headers: { authorization: `Bearer ${tokenValue(payload)}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'header'],
    ['a number', 42],
  ])('rejects %s transport JWT protected header before principal binding', (_case, protectedHeader) => {
    const header = Buffer.from(JSON.stringify(protectedHeader)).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    })).toString('base64url');
    const req = {
      headers: { authorization: `Bearer ${header}.${payload}.unsigned` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['a missing algorithm', { typ: 'JWT', kid: 'google-key-1' }],
    ['an alternate algorithm', { alg: 'none', typ: 'JWT', kid: 'google-key-1' }],
    ['a missing token type', { alg: 'RS256', kid: 'google-key-1' }],
    ['an alternate token type', { alg: 'RS256', typ: 'jwt', kid: 'google-key-1' }],
    ['a missing key identifier', { alg: 'RS256', typ: 'JWT' }],
    ['an empty key identifier', { alg: 'RS256', typ: 'JWT', kid: '' }],
    ['a whitespace-padded key identifier', { alg: 'RS256', typ: 'JWT', kid: ' google-key-1' }],
    ['an unpaired-surrogate key identifier', { alg: 'RS256', typ: 'JWT', kid: '\uD800' }],
    ['a non-string key identifier', { alg: 'RS256', typ: 'JWT', kid: 42 }],
    ['an unsupported critical-header declaration', {
      alg: 'RS256', typ: 'JWT', kid: 'google-key-1', crit: [],
    }],
  ])('rejects a transport JWT protected header with %s', (_case, protectedHeader) => {
    const header = Buffer.from(JSON.stringify(protectedHeader)).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    })).toString('base64url');
    const req = {
      headers: { authorization: `Bearer ${header}.${payload}.unsigned` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('rejects duplicate protected-header member names before principal binding', () => {
    const iam = rawToken(
      '{"alg":"none","alg":"RS256","typ":"JWT","kid":"google-key-1"}',
      '{"aud":"https://ruvector.test","email":"platform@test.example","sub":"iam-subject-1"}'
    );
    const req = {
      headers: { authorization: `Bearer ${iam}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('rejects duplicate payload member names before principal binding', () => {
    const iam = rawToken(
      '{"alg":"RS256","typ":"JWT","kid":"google-key-1"}',
      '{"aud":"https://other.test","aud":"https://ruvector.test","email":"platform@test.example","sub":"iam-subject-1"}'
    );
    const req = {
      headers: { authorization: `Bearer ${iam}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['protected-header', true],
    ['payload', false],
  ])('rejects malformed UTF-8 in the transport JWT %s before principal binding', (_case, invalidHeader) => {
    const validHeader = Buffer.from('{"alg":"RS256","typ":"JWT","kid":"google-key-1"}');
    const validPayload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    }));
    const invalidHeaderBytes = Buffer.concat([
      Buffer.from('{"alg":"RS256","typ":"JWT","kid":"google-key-1","x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const invalidPayloadBytes = Buffer.concat([
      Buffer.from('{"aud":"https://ruvector.test","email":"platform@test.example","sub":"iam-subject-1","x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const req = {
      headers: { authorization: `Bearer ${rawBytesToken(
        invalidHeader ? invalidHeaderBytes : validHeader,
        invalidHeader ? validPayload : invalidPayloadBytes,
      )}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['protected-header', true],
    ['payload', false],
  ])('rejects a UTF-8 byte-order mark in the transport JWT %s before principal binding', (
    _case,
    markedHeader,
  ) => {
    const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
    const validHeader = Buffer.from('{"alg":"RS256","typ":"JWT","kid":"google-key-1"}');
    const validPayload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    }));
    const req = {
      headers: { authorization: `Bearer ${rawBytesToken(
        markedHeader ? Buffer.concat([byteOrderMark, validHeader]) : validHeader,
        markedHeader ? validPayload : Buffer.concat([byteOrderMark, validPayload]),
      )}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('rejects a noncanonical padded transport JWT payload before principal binding', () => {
    const canonical = token({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    });
    const [header, payload, signature] = canonical.split('.');
    const req = {
      headers: { authorization: `Bearer ${header}.${payload}=.${signature}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['an empty protected-header component', (payload: string) => `.${payload}.unsigned`],
    ['an empty signature component', (payload: string) => `header.${payload}.`],
  ])('rejects %s before principal binding', (_case, malformedToken) => {
    const payload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    })).toString('base64url');
    const req = {
      headers: { authorization: `Bearer ${malformedToken(payload)}` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('rejects a noncanonical protected-header component before principal binding', () => {
    const payload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    })).toString('base64url');
    const req = {
      headers: { authorization: `Bearer AB.${payload}.unsigned` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('rejects a noncanonical signature component before principal binding', () => {
    const header = Buffer.from(JSON.stringify({
      alg: 'RS256', typ: 'JWT', kid: 'google-key-1',
    })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    })).toString('base64url');
    const req = {
      headers: { authorization: `Bearer ${header}.${payload}.AB` },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('requires a Cloud Run IAM bearer identity', () => {
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant({ headers: {} } as Request, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
  });

  it.each([
    ['duplicate X-Serverless-Authorization credentials', (iam: string) => ({
      'x-serverless-authorization': [`Bearer ${iam}`, `Bearer ${iam}`],
    })],
    ['duplicate Authorization credentials', (iam: string) => ({
      authorization: [`Bearer ${iam}`, `Bearer ${iam}`],
    })],
    ['a whitespace-padded X-Serverless-Authorization credential', (iam: string) => ({
      'x-serverless-authorization': `Bearer ${iam} `,
    })],
    ['a whitespace-padded Authorization credential', (iam: string) => ({
      authorization: `Bearer ${iam} `,
    })],
  ])('rejects %s before principal binding', (_case, headers) => {
    const iam = token({
      aud: 'https://ruvector.test', email: 'platform@test.example', sub: 'iam-subject-1',
    });
    const req = { headers: headers(iam) } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['duplicate raw X-Serverless-Authorization credentials', 'x-serverless-authorization'],
    ['duplicate raw Authorization credentials', 'authorization'],
  ])('rejects %s before principal binding', (_case, headerName) => {
    const iam = token({
      aud: 'https://ruvector.test', email: 'platform@test.example', sub: 'iam-subject-1',
    });
    const canonicalName = headerName === 'authorization'
      ? 'Authorization'
      : 'X-Serverless-Authorization';
    const req = {
      headers: { [headerName]: `Bearer ${iam}` },
      rawHeaders: [canonicalName, `Bearer ${iam}`, canonicalName, `Bearer ${iam}`],
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it.each([
    ['duplicate raw principal keys', '{"platform@test.example":"org-a","platform@test.example":"org-b"}'],
    ['case-insensitive duplicate principals', '{"Platform@test.example":"org-a","platform@test.example":"org-b"}'],
    ['non-string organization identifiers', '{"platform@test.example":42}'],
    ['empty organization identifiers', '{"platform@test.example":""}'],
    ['malformed principal keys', '{"not-an-email":"org-a"}'],
  ])('fails closed at request time for %s', (_case, bindings) => {
    config.dataPlaneIdentity.principalOrgBindings = bindings;
    const req = request({
      aud: 'https://ruvector.test', email: 'platform@test.example', sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: 'identity_configuration_error',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('fails closed at request time for a non-canonical service audience', () => {
    config.dataPlaneIdentity.serviceAudience = ' https://ruvector.test ';
    const req = request({
      aud: 'https://ruvector.test', email: 'platform@test.example', sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: 'identity_configuration_error',
    });
    expect(req.dataPlanePrincipal).toBeUndefined();
  });

  it('allows an explicitly configured IAM principal to perform identity bootstrap', () => {
    const req = request({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireIdentityProviderCaller(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.identityProviderCaller).toEqual({
      subject: 'iam-subject-1',
      principal: 'platform@test.example',
      audience: 'https://ruvector.test',
    });
  });

  it('keeps Cloud Run transport identity separate from the end-user JWT', () => {
    const iam = token({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    });
    const req = {
      headers: {
        'x-serverless-authorization': `Bearer ${iam}`,
        authorization: 'Bearer end-user-jwt',
      },
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    requireIdentityProviderCaller(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.identityProviderCaller.principal).toBe('platform@test.example');
  });

  it('rejects an IAM principal that is not allowlisted for identity bootstrap', () => {
    const next = jest.fn() as NextFunction;
    requireIdentityProviderCaller(request({
      aud: 'https://ruvector.test',
      email: 'unknown@test.example',
      sub: 'iam-subject-2',
    }), {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: 'identity_caller_not_allowed',
    });
  });

  it.each([
    ['case-insensitive duplicate callers', '["Platform@test.example","platform@test.example"]'],
    ['whitespace-padded callers', '[" platform@test.example"]'],
    ['malformed callers', '["not-an-email"]'],
    ['non-string callers', '[42]'],
  ])('fails closed at request time for %s', (_case, callers) => {
    config.dataPlaneIdentity.identityCallerPrincipals = callers;
    const req = request({
      aud: 'https://ruvector.test',
      email: 'platform@test.example',
      sub: 'iam-subject-1',
    });
    const next = jest.fn() as NextFunction;

    requireIdentityProviderCaller(req, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: 'identity_configuration_error',
    });
    expect(req.identityProviderCaller).toBeUndefined();
  });
});
