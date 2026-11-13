import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../src/middleware/errorHandler';
import { requireDataPlaneTenant, requireIdentityProviderCaller } from '../../src/middleware/tenantIdentity';
import { config } from '../../src/config';

function token(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${claims}.unsigned`;
}

function request(payload: Record<string, unknown>): Request {
  return {
    headers: { authorization: `Bearer ${token(payload)}` },
  } as unknown as Request;
}

describe('tenant-bound data-plane identity', () => {
  const originalBindings = config.dataPlaneIdentity.principalOrgBindings;

  afterEach(() => {
    config.dataPlaneIdentity.principalOrgBindings = originalBindings;
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

  it('requires a Cloud Run IAM bearer identity', () => {
    const next = jest.fn() as NextFunction;

    requireDataPlaneTenant({ headers: {} } as Request, {} as Response, next);

    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      code: 'unauthenticated',
    });
  });

  it.each([
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
});
