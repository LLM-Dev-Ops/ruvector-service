export function parsePrincipalOrgBindings(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Principal bindings must be valid JSON');
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('Principal bindings must contain at least one principal mapping');
  }

  const result: Record<string, string> = {};
  for (const [principal, organization] of Object.entries(parsed)) {
    const canonicalPrincipal = principal.toLowerCase();
    if (principal.trim() !== principal || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal)) {
      throw new Error('Principal binding keys must be email addresses without surrounding whitespace');
    }
    if (Object.prototype.hasOwnProperty.call(result, canonicalPrincipal)) {
      throw new Error('Principal binding keys must be unique ignoring case');
    }
    if (typeof organization !== 'string' || organization.length === 0 || organization.trim() !== organization) {
      throw new Error('Principal binding organization identifiers must be non-empty strings without surrounding whitespace');
    }
    result[canonicalPrincipal] = organization;
  }
  return result;
}
