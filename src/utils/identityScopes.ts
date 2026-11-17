import { isWellFormedUnicode } from './utf8';

export interface IdentityScopeConfiguration {
  allowed: string[];
  defaults: string[];
}

function hasUnicodeC0OrC1Control(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function hasUnicodeWhitespace(value: string): boolean {
  return /\p{White_Space}/u.test(value);
}

function hasUnicodeFormatControl(value: string): boolean {
  return /\p{Cf}/u.test(value);
}

function hasUnicodeNoncharacter(value: string): boolean {
  return /\p{Noncharacter_Code_Point}/u.test(value);
}

function hasUnicodePrivateUse(value: string): boolean {
  return /\p{Co}/u.test(value);
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
    typeof scope !== 'string' ||
    scope.length === 0 ||
    scope.trim() !== scope ||
    !isWellFormedUnicode(scope) ||
    scope.normalize('NFC') !== scope ||
    hasUnicodeC0OrC1Control(scope) ||
    hasUnicodeWhitespace(scope) ||
    hasUnicodeFormatControl(scope) ||
    hasUnicodeNoncharacter(scope) ||
    hasUnicodePrivateUse(scope)
  )) {
    throw new Error(
      `${name} entries must be non-empty strings in exact NFC normalization without Unicode whitespace characters, Unicode C0/C1 control characters, Unicode format controls, Unicode noncharacter code points, or Unicode private-use code points and contain only Unicode scalar values`
    );
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
