import { DatabaseClient } from './DatabaseClient';
import logger from '../utils/logger';
import {
  VectorInsertParams,
  VectorInsertResult,
  VectorQueryParams,
  VectorQueryResult,
  VectorSimilarityParams,
  VectorSimilarityResult,
  PredictionResult,
} from '../types';
import {
  VECTOR_TABLE,
  VectorTypeName,
  isSupportedVectorType,
  vectorTypeExpression,
  toVectorLiteral,
  parseVectorLiteral,
} from './vectorSchema';

/**
 * Circuit breaker states as per SPARC specification
 */
export enum CircuitState {
  CLOSED = 'closed',      // Normal operation, requests pass through
  OPEN = 'open',          // Fail fast, return 503 immediately
  HALF_OPEN = 'half_open' // Allow limited requests to test recovery
}

/**
 * Circuit breaker configuration
 */
interface CircuitBreakerConfig {
  threshold: number;      // Failures before opening
  timeout: number;        // Time in open state (ms)
  resetTimeout: number;   // Time before full reset (ms)
}

/**
 * VectorClient configuration.
 *
 * There is no service URL or API key: the vector backend IS the Postgres
 * database this service already pools connections to (ADR-0001).
 */
export interface VectorClientConfig {
  timeout: number;
  embeddingDimension: number;
  circuitBreaker: CircuitBreakerConfig;
}

/**
 * Raised by operations this service deliberately does not implement.
 * Surfaces as 501, never as a fabricated result.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** Namespace used for writes that carry no explicit namespace (e.g. POST /ingest). */
export const DEFAULT_NAMESPACE = 'default';

interface VectorRow {
  id: string;
  namespace: string;
  embedding: string | null;
  payload: object;
  metadata: object;
  created_at: Date;
  distance: string | number | null;
}

/**
 * RuvVector client — a pgvector/ruvector repository over the existing
 * DatabaseClient connection pool.
 *
 * Contract (Layer 3):
 * - connect(): verify extension, table and column are present
 * - upsert(namespace, id, vector, metadata): insert or update a vector
 * - query(params): filtered + optional ANN search
 * - similarity(params): k-NN over context vectors
 * - ping(): real round-trip against the pool
 *
 * Implements the circuit breaker from the SPARC specification. Unlike the
 * previous stub, every operation below can genuinely fail, so recordFailure()
 * is reachable and the breaker can open.
 */
export class VectorClient {
  private db: DatabaseClient;
  private timeout: number;
  private embeddingDimension: number;
  private connected: boolean = false;
  private vectorType: VectorTypeName | null = null;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private circuitConfig: CircuitBreakerConfig;

  constructor(db: DatabaseClient, config: VectorClientConfig) {
    this.db = db;
    this.timeout = config.timeout;
    this.embeddingDimension = config.embeddingDimension;
    this.circuitConfig = config.circuitBreaker;
  }

  /**
   * Verify the vector backend is usable.
   *
   * Checks that the embedding column exists and that its declared dimension
   * matches configuration. Throws if the schema is not ready — a mismatch here
   * means every subsequent write would be silently wrong.
   */
  async connect(): Promise<void> {
    const result = await this.db.query<{ column_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = 'embedding'
         AND a.attnum > 0 AND NOT a.attisdropped`,
      [VECTOR_TABLE]
    );

    if (result.rows.length === 0) {
      throw new Error(
        `Vector schema not initialised: ${VECTOR_TABLE}.embedding does not exist. ` +
        'Run DatabaseClient.initialize() against a database with the ruvector or vector extension.'
      );
    }

    // format_type yields e.g. "ruvector(384)"
    const columnType = result.rows[0].column_type;
    const match = /^(\w+)\((\d+)\)$/.exec(columnType);
    if (!match) {
      throw new Error(
        `Vector schema unusable: ${VECTOR_TABLE}.embedding has type "${columnType}", ` +
        'expected a dimensioned vector type such as ruvector(N) or vector(N).'
      );
    }

    const [, typeName, declaredDimension] = match;
    if (!isSupportedVectorType(typeName)) {
      throw new Error(
        `Vector schema unusable: unsupported embedding type "${typeName}".`
      );
    }
    if (Number(declaredDimension) !== this.embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: ${VECTOR_TABLE}.embedding is ${columnType} but ` +
        `RUVVECTOR_EMBEDDING_DIM is ${this.embeddingDimension}. ` +
        'Changing the dimension requires a table rewrite — refusing to start.'
      );
    }

    this.vectorType = typeName;
    this.connected = true;
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;

    logger.info(
      { vectorType: typeName, dimension: this.embeddingDimension, table: VECTOR_TABLE },
      'Vector backend ready'
    );
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Upsert a vector with metadata (insert or update)
   * SPARC Contract: upsert(namespace, id, vector, metadata) -> Promise<UpsertResult>
   */
  async upsert(
    namespace: string,
    id: string,
    vector: number[],
    metadata: Record<string, unknown>,
    payload: object = {}
  ): Promise<UpsertResult> {
    this.checkCircuit();

    const startTime = Date.now();
    const cast = this.vectorCast();
    const literal = this.toValidatedLiteral(vector);

    try {
      const result = await this.db.query<{ inserted: boolean }>(
        `INSERT INTO ${VECTOR_TABLE} (id, namespace, "values", payload, metadata, embedding, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::${cast}, NOW(), NOW())
         ON CONFLICT (namespace, id) DO UPDATE SET
           "values" = EXCLUDED."values",
           payload = EXCLUDED.payload,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          id,
          namespace,
          JSON.stringify(vector),
          JSON.stringify(payload),
          JSON.stringify(metadata),
          literal,
        ]
      );

      this.recordSuccess();

      const status: UpsertResult['status'] = result.rows[0]?.inserted ? 'created' : 'updated';
      logger.info(
        { namespace, id, status, duration: Date.now() - startTime },
        'Vector upserted'
      );

      return { id, namespace, status };
    } catch (error) {
      this.recordFailure();
      logger.error({ error, namespace, id }, 'Failed to upsert vector');
      throw error;
    }
  }

  /**
   * Get timeout configuration
   */
  getTimeout(): number {
    return this.timeout;
  }

  /**
   * Get the embedding dimension enforced by this client
   */
  getEmbeddingDimension(): number {
    return this.embeddingDimension;
  }

  /**
   * Get circuit breaker state (for metrics)
   */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /**
   * Check if circuit breaker allows request
   */
  private checkCircuit(): void {
    if (this.circuitState === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;

      // Check if we should transition to half-open
      if (timeSinceFailure >= this.circuitConfig.timeout) {
        this.circuitState = CircuitState.HALF_OPEN;
        logger.info('Circuit breaker transitioning to half-open state');
      } else {
        throw new Error('Circuit breaker is open - RuvVector unavailable');
      }
    }
  }

  /**
   * Record a successful operation
   */
  private recordSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Successful request in half-open state - close the circuit
      this.circuitState = CircuitState.CLOSED;
      logger.info('Circuit breaker closed after successful request');
    }
    // Reset the counter so transient failures do not accumulate across a
    // healthy period and trip the breaker later.
    this.failureCount = 0;
  }

  /**
   * Record a failed operation
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Failed in half-open state - open the circuit again
      this.circuitState = CircuitState.OPEN;
      logger.warn('Circuit breaker reopened after failure in half-open state');
    } else if (this.failureCount >= this.circuitConfig.threshold) {
      // Threshold exceeded - open the circuit
      this.circuitState = CircuitState.OPEN;
      logger.warn(
        { failureCount: this.failureCount, threshold: this.circuitConfig.threshold },
        'Circuit breaker opened due to failure threshold'
      );
    }
  }

  /**
   * Insert a vector — a namespaced upsert. There is only one write path.
   */
  async insert(params: VectorInsertParams): Promise<VectorInsertResult> {
    const namespace = params.namespace ?? DEFAULT_NAMESPACE;
    const result = await this.upsert(
      namespace,
      params.id,
      params.vector,
      params.metadata as Record<string, unknown>,
      params.payload
    );
    return { id: result.id };
  }

  /**
   * Query vectors by filters, with optional ANN similarity ordering.
   */
  async query(params: VectorQueryParams): Promise<VectorQueryResult> {
    this.checkCircuit();

    const startTime = Date.now();
    const values: unknown[] = [];
    const where: string[] = [];

    this.appendFilters(params.filters, where, values);
    this.appendTimeRange(params.timeRange, where, values);

    // Everything bound so far appears in the WHERE clause, so the count query
    // takes exactly these. The ANN literal, limit and offset are select-only.
    const whereParams = [...values];

    let distanceExpr = 'NULL::double precision';
    let orderBy = 'created_at DESC, id ASC';

    if (params.vector) {
      const cast = this.vectorCast();
      values.push(this.toValidatedLiteral(params.vector));
      distanceExpr = `embedding <=> $${values.length}::${cast}`;
      orderBy = 'distance ASC, id ASC';
      where.push('embedding IS NOT NULL');
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    values.push(params.limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(params.offset);
    const offsetPlaceholder = `$${values.length}`;

    try {
      const [rows, counted] = await Promise.all([
        this.db.query<VectorRow>(
          `SELECT id, namespace, embedding::text AS embedding, payload, metadata, created_at,
                  ${distanceExpr} AS distance
           FROM ${VECTOR_TABLE}
           ${whereClause}
           ORDER BY ${orderBy}
           LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
          values
        ),
        this.db.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM ${VECTOR_TABLE} ${whereClause}`,
          whereParams
        ),
      ]);

      this.recordSuccess();

      const result: VectorQueryResult = {
        items: rows.rows.map((row) => ({
          id: row.id,
          score: toSimilarity(row.distance),
          vector: parseVectorLiteral(row.embedding),
          payload: row.payload,
          metadata: row.metadata,
        })),
        total: Number(counted.rows[0]?.total ?? 0),
        executionTime: Date.now() - startTime,
      };

      logger.info(
        { returned: result.items.length, total: result.total, duration: result.executionTime },
        'Query completed'
      );

      return result;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'Failed to query vectors');
      throw error;
    }
  }

  /**
   * Find nearest neighbours for each context vector.
   *
   * Results from every context vector are merged, de-duplicated by id keeping
   * the best score, and truncated to k in descending similarity order.
   */
  async similarity(params: VectorSimilarityParams): Promise<VectorSimilarityResult> {
    this.checkCircuit();

    const startTime = Date.now();
    const cast = this.vectorCast();

    try {
      const best = new Map<string, VectorSimilarityResult['neighbors'][number]>();

      for (const contextVector of params.contextVectors) {
        const literal = this.toValidatedLiteral(contextVector);
        const rows = await this.db.query<VectorRow>(
          `SELECT id, namespace, embedding::text AS embedding, payload, metadata, created_at,
                  embedding <=> $1::${cast} AS distance
           FROM ${VECTOR_TABLE}
           WHERE embedding IS NOT NULL
             AND 1 - (embedding <=> $1::${cast}) >= $2
           ORDER BY distance ASC, id ASC
           LIMIT $3`,
          [literal, params.threshold, params.k]
        );

        for (const row of rows.rows) {
          const score = toSimilarity(row.distance) ?? 0;
          const existing = best.get(row.id);
          if (existing && existing.score >= score) continue;
          best.set(row.id, {
            id: row.id,
            score,
            vector: parseVectorLiteral(row.embedding),
            payload: row.payload,
            metadata: params.includeMetadata ? row.metadata : undefined,
          });
        }
      }

      this.recordSuccess();

      const neighbors = [...best.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, params.k);

      const result: VectorSimilarityResult = {
        neighbors,
        processed: params.contextVectors.length,
        executionTime: Date.now() - startTime,
      };

      logger.info(
        { processed: result.processed, neighbors: neighbors.length, duration: result.executionTime },
        'Similarity search completed'
      );

      return result;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'Failed to find similar vectors');
      throw error;
    }
  }

  /**
   * Not implemented. pgvector/ruvector performs nearest-neighbour search, not
   * model inference — there is no prediction backend behind this service.
   */
  async run_prediction(model: string, _input: PredictionInput): Promise<PredictionResult> {
    logger.warn({ model }, 'Prediction requested but no inference backend exists');
    throw new NotImplementedError(
      'run_prediction is not implemented: this service is backed by a vector store, not an inference runtime'
    );
  }

  /**
   * Health check — executes a real query against the pool.
   * SPARC: vectorClient.ping()
   */
  async ping(): Promise<boolean> {
    // Check circuit breaker - but don't throw on open for health checks
    if (this.circuitState === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.circuitConfig.timeout) {
        this.circuitState = CircuitState.HALF_OPEN;
      } else {
        return false;
      }
    }

    try {
      const result = await this.db.query<{ ping: number }>(
        `SELECT 1 AS ping FROM ${VECTOR_TABLE} LIMIT 0`
      );
      // A reachable table returns a result object even with zero rows.
      if (!result) {
        this.recordFailure();
        return false;
      }
      this.recordSuccess();
      return true;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'RuvVector health check failed');
      return false;
    }
  }

  /**
   * Build the `<type>(<dimension>)` cast used in every vector expression.
   * Both components are validated, never caller-supplied.
   */
  private vectorCast(): string {
    if (!this.vectorType) {
      throw new Error('VectorClient is not connected — call connect() first');
    }
    return vectorTypeExpression(this.vectorType, this.embeddingDimension);
  }

  private toValidatedLiteral(vector: number[]): string {
    if (vector.length !== this.embeddingDimension) {
      throw new Error(
        `Vector has ${vector.length} dimensions, expected ${this.embeddingDimension}`
      );
    }
    return toVectorLiteral(vector);
  }

  /**
   * Translate caller filters into parameterised predicates.
   *
   * Filter keys and values are always bound as parameters — never interpolated
   * into SQL text — so a hostile key cannot alter the statement.
   */
  private appendFilters(
    filters: object | undefined,
    where: string[],
    values: unknown[]
  ): void {
    if (!filters) return;

    const { namespace, metadata, ...rest } = filters as Record<string, unknown> & {
      namespace?: unknown;
      metadata?: Record<string, unknown>;
    };

    if (namespace !== undefined) {
      values.push(String(namespace));
      where.push(`namespace = $${values.length}`);
    }

    const metadataFilters: Record<string, unknown> = { ...rest, ...(metadata ?? {}) };

    for (const [key, value] of Object.entries(metadataFilters)) {
      if (value === undefined || value === null) continue;

      values.push(key);
      const keyPlaceholder = `$${values.length}`;

      if (Array.isArray(value)) {
        values.push(value.map((entry) => String(entry)));
        where.push(`metadata ->> ${keyPlaceholder} = ANY($${values.length}::text[])`);
      } else {
        values.push(String(value));
        where.push(`metadata ->> ${keyPlaceholder} = $${values.length}`);
      }
    }
  }

  private appendTimeRange(
    timeRange: { start: string; end: string } | undefined,
    where: string[],
    values: unknown[]
  ): void {
    if (!timeRange) return;

    values.push(timeRange.start);
    where.push(`created_at >= $${values.length}`);
    values.push(timeRange.end);
    where.push(`created_at <= $${values.length}`);
  }
}

/**
 * Cosine distance -> cosine similarity. `<=>` returns distance in [0, 2];
 * similarity is the complement.
 */
function toSimilarity(distance: string | number | null): number | undefined {
  if (distance === null || distance === undefined) return undefined;
  return 1 - Number(distance);
}

/**
 * Upsert operation result type
 */
export interface UpsertResult {
  id: string;
  namespace: string;
  status: 'upserted' | 'created' | 'updated';
}

/**
 * Prediction input type - can be vector or structured data
 */
export type PredictionInput = number[] | Record<string, unknown>;

export default VectorClient;
