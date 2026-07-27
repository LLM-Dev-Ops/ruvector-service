/**
 * ADR-0001 primary gate: real vector persistence.
 *
 * Runs against a live ruvnet/ruvector-postgres container. No mocks, no fakes —
 * the assertion that matters is that an upsert followed by a query returns the
 * same vector from a real backend, which the previous stub could not satisfy.
 *
 *   docker run -d --name ruvector-test \
 *     -e POSTGRES_PASSWORD=adr1test -e POSTGRES_DB=ruvector-postgres \
 *     -p 55432:5432 ruvnet/ruvector-postgres:latest
 *
 * Connection settings come from RUVVECTOR_DB_* (see tests/setup.ts).
 */
import { DatabaseClient } from '../../src/clients/DatabaseClient';
import { VectorClient } from '../../src/clients/VectorClient';
import { CircuitState } from '../../src/clients/VectorClient';
import { config } from '../../src/config';

const DIMENSION = config.ruvVector.embeddingDimension;

const dbConfig = {
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  maxConnections: 5,
  idleTimeoutMs: 5000,
  connectionTimeoutMs: 5000,
  ssl: config.database.ssl,
  embeddingDimension: DIMENSION,
};

const circuitBreaker = { threshold: 3, timeout: 10000, resetTimeout: 30000 };

/** Deterministic unit-ish vector: one dominant component plus a fixed tail. */
function vectorAt(index: number): number[] {
  return Array.from({ length: DIMENSION }, (_, i) =>
    i === index % DIMENSION ? 1 : 0.01 * ((i + index) % 7)
  );
}

describe('vector persistence against a live ruvector-postgres', () => {
  let db: DatabaseClient;
  let client: VectorClient;
  const namespace = `adr1-${Date.now()}`;
  const otherNamespace = `${namespace}-other`;

  beforeAll(async () => {
    db = new DatabaseClient(dbConfig);
    await db.initialize();

    client = new VectorClient(db, {
      timeout: 5000,
      embeddingDimension: DIMENSION,
      circuitBreaker,
    });
    await client.connect();
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM vectors WHERE namespace = $1 OR namespace = $2', [
        namespace,
        otherNamespace,
      ]);
      await db.close();
    }
  });

  it('exposes a dimensioned vector column and an HNSW index', async () => {
    const column = await db.query<{ column_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'vectors' AND a.attname = 'embedding'`
    );
    expect(column.rows[0].column_type).toMatch(
      new RegExp(`^(ruvector|vector)\\(${DIMENSION}\\)$`)
    );

    const index = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_vectors_embedding_hnsw'`
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain('hnsw');
    expect(index.rows[0].indexdef).toMatch(/cosine_ops/);
  });

  // ADR Verification steps 1-2: the assertion the stub cannot satisfy
  it('returns the same vector that was upserted', async () => {
    const vector = vectorAt(0);

    await client.upsert(namespace, 'vec-1', vector, { tag: 'alpha' });

    const result = await client.query({
      vector,
      filters: { namespace },
      limit: 1,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('vec-1');
    expect(result.items[0].metadata).toEqual({ tag: 'alpha' });
    expect(result.items[0].vector).toEqual(vector);

    // score is cosine similarity; distance = 1 - score must be under 1e-6
    const distance = 1 - (result.items[0].score as number);
    expect(distance).toBeLessThan(1e-6);
  });

  // ADR Verification step 3: update, not insert
  it('updates in place when the same id is upserted with a different vector', async () => {
    const replacement = vectorAt(1);

    const result = await client.upsert(namespace, 'vec-1', replacement, { tag: 'beta' });
    expect(result.status).toBe('updated');

    const requeried = await client.query({
      vector: replacement,
      filters: { namespace },
      limit: 10,
      offset: 0,
    });

    expect(requeried.items[0].id).toBe('vec-1');
    expect(requeried.items[0].vector).toEqual(replacement);
    expect(requeried.items[0].metadata).toEqual({ tag: 'beta' });

    const rows = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM vectors WHERE namespace = $1',
      [namespace]
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  // ADR Verification step 4: real empty result, not an unconditional []
  it('isolates namespaces', async () => {
    const vector = vectorAt(1);

    const isolated = await client.query({
      vector,
      filters: { namespace: otherNamespace },
      limit: 10,
      offset: 0,
    });
    expect(isolated.items).toHaveLength(0);
    expect(isolated.total).toBe(0);

    // ...and the same query without the namespace filter still finds the row,
    // proving the empty result above came from the filter, not from doing nothing
    const unfiltered = await client.query({ vector, limit: 10, offset: 0 });
    expect(unfiltered.items.length).toBeGreaterThan(0);
  });

  // ADR Verification step 5
  it('returns exactly k neighbours in ascending distance order over 100 vectors', async () => {
    for (let i = 0; i < 100; i++) {
      await client.upsert(namespace, `bulk-${i}`, vectorAt(i), { i });
    }

    const result = await client.similarity({
      contextVectors: [vectorAt(3)],
      k: 5,
      threshold: 0,
      includeMetadata: true,
    });

    expect(result.neighbors).toHaveLength(5);
    expect(result.processed).toBe(1);

    const scores = result.neighbors.map((n) => n.score);
    const descending = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(descending);

    // nearest neighbour is an exact match for the probe vector
    expect(1 - scores[0]).toBeLessThan(1e-6);
  });

  it('honours the similarity threshold', async () => {
    const strict = await client.similarity({
      contextVectors: [vectorAt(3)],
      k: 50,
      threshold: 0.999999,
      includeMetadata: false,
    });

    expect(strict.neighbors.length).toBeGreaterThan(0);
    for (const neighbor of strict.neighbors) {
      expect(neighbor.score).toBeGreaterThanOrEqual(0.999999);
    }
    expect(strict.neighbors.length).toBeLessThan(100);
  });

  it('rejects a vector of the wrong dimension rather than storing it', async () => {
    await expect(
      client.upsert(namespace, 'bad-dim', [0.1, 0.2], {})
    ).rejects.toThrow(/dimensions, expected/);

    const rows = await db.query(
      'SELECT id FROM vectors WHERE namespace = $1 AND id = $2',
      [namespace, 'bad-dim']
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('survives a client restart — persistence is in the database, not in process', async () => {
    const fresh = new DatabaseClient(dbConfig);
    await fresh.initialize();
    const freshClient = new VectorClient(fresh, {
      timeout: 5000,
      embeddingDimension: DIMENSION,
      circuitBreaker,
    });
    await freshClient.connect();

    try {
      // filter on vec-1's distinctive metadata: the bulk rows share its vector
      const result = await freshClient.query({
        vector: vectorAt(1),
        filters: { namespace, tag: 'beta' },
        limit: 1,
        offset: 0,
      });
      expect(result.items[0].id).toBe('vec-1');
      expect(result.items[0].vector).toEqual(vectorAt(1));
    } finally {
      await fresh.close();
    }
  });

  it('ping reflects real connectivity', async () => {
    await expect(client.ping()).resolves.toBe(true);
  });
});

/**
 * Negative path: with no reachable database every vector operation must throw,
 * the breaker must open, and ping() must report not-ready. Uses an unroutable
 * port rather than stopping the shared container.
 */
describe('circuit breaker against an unreachable backend', () => {
  let db: DatabaseClient;
  let client: VectorClient;

  beforeAll(() => {
    db = new DatabaseClient({
      ...dbConfig,
      port: 1,
      connectionTimeoutMs: 500,
    });
    client = new VectorClient(db, {
      timeout: 1000,
      embeddingDimension: DIMENSION,
      circuitBreaker,
    });
    // Bypass connect(): the schema probe would fail first. The breaker is what
    // is under test, not startup.
    (client as unknown as { vectorType: string; connected: boolean }).vectorType = 'ruvector';
    (client as unknown as { connected: boolean }).connected = true;
  });

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  it('throws on query, opens the breaker, then fails fast', async () => {
    for (let attempt = 0; attempt < circuitBreaker.threshold; attempt++) {
      await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow();
    }

    expect(client.getCircuitState()).toBe(CircuitState.OPEN);

    await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow(
      /Circuit breaker is open/
    );
  });

  it('reports not-ready via ping while the breaker is open', async () => {
    await expect(client.ping()).resolves.toBe(false);
  });
});
