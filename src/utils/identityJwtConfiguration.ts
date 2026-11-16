export interface EndUserJwtConfiguration {
  issuer: string;
  audience: string;
  jwksUri: string;
}

export function parseVerificationUrlConfiguration(value: unknown): string {
  try {
    return parseHttpsUrl(value, 'CLI verification URL', false);
  } catch {
    throw new Error(
      'CLI verification URL must be an HTTPS URL; use a canonical HTTPS URL without surrounding whitespace, credentials, query, or fragment'
    );
  }
}

function parseHttpsUrl(value: unknown, name: string, allowQuery: boolean): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`${name} must be an HTTPS URL without surrounding whitespace`);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.toString() !== value ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      (!allowQuery && url.search !== '')
    ) {
      throw new Error('not canonical https');
    }
  } catch {
    throw new Error(`${name} must be an HTTPS URL in canonical serialization without surrounding whitespace`);
  }
  return value;
}

export function parseEndUserJwtConfiguration(value: {
  issuer: unknown;
  audience: unknown;
  jwksUri: unknown;
}): EndUserJwtConfiguration {
  if (
    typeof value.audience !== 'string' ||
    value.audience.length === 0 ||
    value.audience.trim() !== value.audience
  ) {
    throw new Error('JWT audience must be a non-empty string without surrounding whitespace');
  }
  return {
    issuer: parseHttpsUrl(value.issuer, 'JWT issuer', false),
    audience: value.audience,
    jwksUri: parseHttpsUrl(value.jwksUri, 'JWKS URI', true),
  };
}
