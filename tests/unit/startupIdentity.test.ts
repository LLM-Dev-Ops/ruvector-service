import { config } from '../../src/config';
import { assertDataPlaneIdentity } from '../../src/startup/assertions';

describe('identity provider startup assertions', () => {
  const original = { ...config.dataPlaneIdentity };

  afterEach(() => {
    Object.assign(config.dataPlaneIdentity, original);
  });

  it('accepts explicit HTTPS identity endpoints, 32-byte key and bounded scopes', () => {
    expect(() => assertDataPlaneIdentity()).not.toThrow();
  });

  it('rejects a malformed session encryption key', () => {
    config.dataPlaneIdentity.sessionEncryptionKey = Buffer.alloc(31).toString('base64');
    expect(() => assertDataPlaneIdentity()).toThrow(/exactly 32 bytes/);
  });

  it('rejects default scopes outside the provider allowlist', () => {
    config.dataPlaneIdentity.defaultScopes = JSON.stringify(['tenant:admin']);
    expect(() => assertDataPlaneIdentity()).toThrow(/subset of allowed scopes/);
  });

  it('rejects non-HTTPS JWT and verification endpoints', () => {
    config.dataPlaneIdentity.jwksUri = 'http://identity.test/jwks';
    expect(() => assertDataPlaneIdentity()).toThrow(/must be an HTTPS URL/);
  });

  it.each([
    ['service audience', 'serviceAudience', '', /SERVICE_AUDIENCE is required/],
    ['JWT issuer', 'jwtIssuer', '', /JWT_ISSUER is required/],
    ['JWT audience', 'jwtAudience', '', /JWT_AUDIENCE is required/],
    ['JWKS URI', 'jwksUri', '', /JWKS_URI is required/],
    ['verification URL', 'verificationUrl', '', /VERIFICATION_URL is required/],
  ])('rejects a missing %s', (_label, field, value, expected) => {
    (config.dataPlaneIdentity as unknown as Record<string, string>)[field] = value;
    expect(() => assertDataPlaneIdentity()).toThrow(expected);
  });

  it.each([
    ['principal bindings', 'principalOrgBindings', '{', /PRINCIPAL_ORG_BINDINGS must be valid JSON/],
    ['identity callers', 'identityCallerPrincipals', '{', /IDENTITY_CALLER_PRINCIPALS must be valid JSON/],
    ['scope configuration', 'allowedScopes', '{', /scope configuration must be valid JSON/],
  ])('rejects invalid JSON in %s', (_label, field, value, expected) => {
    (config.dataPlaneIdentity as unknown as Record<string, string>)[field] = value;
    expect(() => assertDataPlaneIdentity()).toThrow(expected);
  });

  it.each([
    ['empty bindings', 'principalOrgBindings', '{}', /at least one principal mapping/],
    ['array bindings', 'principalOrgBindings', '[]', /at least one principal mapping/],
    ['empty callers', 'identityCallerPrincipals', '[]', /at least one service principal/],
    ['malformed caller', 'identityCallerPrincipals', '["not-an-email"]', /at least one service principal/],
    ['empty allowed scopes', 'allowedScopes', '[]', /at least one scope/],
    ['non-string allowed scope', 'allowedScopes', '[1]', /at least one scope/],
    ['empty default scopes', 'defaultScopes', '[]', /non-empty subset/],
    ['non-string default scope', 'defaultScopes', '[1]', /non-empty subset/],
  ])('rejects %s', (_label, field, value, expected) => {
    (config.dataPlaneIdentity as unknown as Record<string, string>)[field] = value;
    expect(() => assertDataPlaneIdentity()).toThrow(expected);
  });

  it.each(['jwtIssuer', 'jwksUri', 'verificationUrl'])('rejects an invalid %s URL', (field) => {
    (config.dataPlaneIdentity as unknown as Record<string, string>)[field] = 'not-a-url';
    expect(() => assertDataPlaneIdentity()).toThrow(/must be an HTTPS URL/);
  });

  it('rejects a non-canonical base64 session key', () => {
    config.dataPlaneIdentity.sessionEncryptionKey = `${Buffer.alloc(32).toString('base64')}=`;
    expect(() => assertDataPlaneIdentity()).toThrow(/canonical base64/);
  });
});
