import {
  SUPPORTED_VECTOR_TYPES,
  isSupportedVectorType,
  assertValidDimension,
  vectorTypeExpression,
  cosineOperatorClass,
  toVectorLiteral,
  parseVectorLiteral,
} from '../../src/clients/vectorSchema';

describe('vector type allowlist', () => {
  it('accepts only the two supported extension types', () => {
    expect([...SUPPORTED_VECTOR_TYPES]).toEqual(['ruvector', 'vector']);
    expect(isSupportedVectorType('ruvector')).toBe(true);
    expect(isSupportedVectorType('vector')).toBe(true);
    expect(isSupportedVectorType('jsonb')).toBe(false);
  });

  it('refuses to build an expression for an unlisted type', () => {
    expect(() => vectorTypeExpression('int' as never, 4)).toThrow(/Unsupported vector type/);
    expect(() => cosineOperatorClass('int' as never)).toThrow(/Unsupported vector type/);
  });

  it('pairs each type with its own cosine operator class', () => {
    expect(cosineOperatorClass('ruvector')).toBe('ruvector_cosine_ops');
    expect(cosineOperatorClass('vector')).toBe('vector_cosine_ops');
  });
});

describe('dimension validation', () => {
  it('accepts positive integers within pgvector limits', () => {
    expect(assertValidDimension(1)).toBe(1);
    expect(assertValidDimension(1536)).toBe(1536);
    expect(assertValidDimension(16000)).toBe(16000);
  });

  it.each([0, -1, 1.5, 16001, NaN])('rejects %p', (dimension) => {
    expect(() => assertValidDimension(dimension)).toThrow(/must be an integer/);
  });

  it('cannot be used to smuggle SQL into DDL', () => {
    expect(() => vectorTypeExpression('ruvector', '4); DROP TABLE vectors; --' as never)).toThrow(
      /must be an integer/
    );
  });
});

describe('vector literals', () => {
  it('round-trips through the Postgres text format', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    expect(parseVectorLiteral('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });

  it('rejects empty and non-finite vectors', () => {
    expect(() => toVectorLiteral([])).toThrow(/non-empty/);
    expect(() => toVectorLiteral([1, NaN])).toThrow(/finite numbers/);
    expect(() => toVectorLiteral([1, Infinity])).toThrow(/finite numbers/);
  });

  it('treats a missing embedding as absent rather than empty', () => {
    expect(parseVectorLiteral(null)).toBeUndefined();
    expect(parseVectorLiteral(undefined)).toBeUndefined();
  });
});
