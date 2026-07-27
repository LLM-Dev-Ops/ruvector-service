/**
 * Vector schema primitives shared by DatabaseClient (DDL) and VectorClient (DML).
 *
 * The backend is Postgres with a vector extension. Two are supported because
 * they are not interchangeable at the type level:
 *
 * - `ruvector` — what ruvnet/ruvector-postgres:latest ships (verified 0.3.0,
 *   PostgreSQL 17.9). It provides the `ruvector` type, `<=>`/`<->`/`<#>`
 *   operators and `ruvector_cosine_ops` for HNSW. It does NOT provide
 *   pgvector's `vector` type.
 * - `vector` — stock pgvector, which Cloud SQL provides.
 *
 * Type and dimension are interpolated into DDL/casts because Postgres does not
 * accept parameters there, so both are validated against a fixed allowlist and
 * an integer bound before ever reaching SQL text.
 */

export const VECTOR_TABLE = 'vectors';

/** Preference order: use whichever extension the server actually has. */
export const SUPPORTED_VECTOR_TYPES = ['ruvector', 'vector'] as const;

export type VectorTypeName = (typeof SUPPORTED_VECTOR_TYPES)[number];

/** pgvector's hard ceiling on indexable dimensions. */
const MAX_DIMENSION = 16000;

export function isSupportedVectorType(name: string): name is VectorTypeName {
  return (SUPPORTED_VECTOR_TYPES as readonly string[]).includes(name);
}

export function assertValidDimension(dimension: number): number {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_DIMENSION) {
    throw new Error(
      `Embedding dimension must be an integer between 1 and ${MAX_DIMENSION}, got: ${dimension}`
    );
  }
  return dimension;
}

/** Build a validated `<type>(<dimension>)` expression for DDL and casts. */
export function vectorTypeExpression(type: VectorTypeName, dimension: number): string {
  if (!isSupportedVectorType(type)) {
    throw new Error(`Unsupported vector type: ${type}`);
  }
  return `${type}(${assertValidDimension(dimension)})`;
}

/** Operator class backing the HNSW cosine index for the given type. */
export function cosineOperatorClass(type: VectorTypeName): string {
  if (!isSupportedVectorType(type)) {
    throw new Error(`Unsupported vector type: ${type}`);
  }
  return `${type}_cosine_ops`;
}

/**
 * Encode a JS number array as a vector literal (`[1,2,3]`).
 * Rejects non-finite values, which Postgres would otherwise reject opaquely.
 */
export function toVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Vector must be a non-empty number array');
  }
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new Error('Vector components must be finite numbers');
    }
  }
  return `[${vector.join(',')}]`;
}

/** Decode a vector literal returned by `embedding::text`. */
export function parseVectorLiteral(literal: string | null | undefined): number[] | undefined {
  if (!literal) return undefined;
  const inner = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.length === 0) return [];
  return inner.split(',').map(Number);
}
