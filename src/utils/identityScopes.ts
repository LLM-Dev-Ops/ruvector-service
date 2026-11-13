export interface IdentityScopeConfiguration {
  allowed: string[];
  defaults: string[];
}

function parseScopeList(value: string, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${name} must contain at least one scope`);
  }
  if (parsed.some((scope) =>
    typeof scope !== 'string' || scope.length === 0 || scope.trim() !== scope
  )) {
    throw new Error(`${name} entries must be non-empty strings without surrounding whitespace`);
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${name} entries must be unique`);
  }
  return parsed;
}

export function parseIdentityScopeConfiguration(
  allowedValue: string,
  defaultValue: string
): IdentityScopeConfiguration {
  const allowed = parseScopeList(allowedValue, 'Identity allowed scope configuration');
  const defaults = parseScopeList(defaultValue, 'Identity default scope configuration');
  const allowedSet = new Set(allowed);
  if (defaults.some((scope) => !allowedSet.has(scope))) {
    throw new Error('Identity default scopes must be a non-empty subset of allowed scopes');
  }
  return { allowed, defaults };
}
