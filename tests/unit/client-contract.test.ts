/**
 * VectorClient behaviour tests against an injected database.
 *
 * The previous version of this file asserted only that methods existed and
 * returned promises. It passed against a client that did nothing, which is why
 * a fully stubbed vector path shipped (ADR-0001). These tests assert what the
 * client actually sends to Postgres and how it reacts to what comes back —
 * assertions a hollow implementation cannot satisfy.
 *
 * The round-trip gate lives in tests/integration/vector-persistence.test.ts and
 * runs against a real container. This file covers the logic around it.
 */

import { QueryResult, QueryResultRow } from 'pg';
import {
  VectorClient,
  VectorClientConfig,
  NotImplementedError,
  CircuitState,
  DEFAULT_NAMESPACE,
} from '../../src/clients/VectorClient';
import { DatabaseClient } from '../../src/clients/DatabaseClient';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

/**
 * Minimal stand-in for DatabaseClient that records statements and replays
 * queued responses. Only VectorClient's use of `query()` is modelled.
 */
class RecordingDatabase {
  readonly calls: RecordedQuery[] = [];
  private responses: Array<QueryResultRow[] | Error> = [];

  enqueue(rows: QueryResultRow[] | Error): void {
    this.responses.push(rows);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.calls.push({ text, params: params ?? [] });

    const next = this.responses.shift() ?? [];
    if (next instanceof Error) {
      throw next;
    }
    return {
      rows: next as T[],
      rowCount: next.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    };
  }

  get lastCall(): RecordedQuery {
    return this.calls[this.calls.length - 1];
  }

  asDatabaseClient(): DatabaseClient {
    return this as unknown as DatabaseClient;
  }
}

const DIMENSION = 4;
const VECTOR = [0.1, 0.2, 0.3, 0.4];

const testConfig: VectorClientConfig = {
  timeout: 5000,
  embeddingDimension: DIMENSION,
  circuitBreaker: {
    threshold: 3,
    timeout: 10000,
    resetTimeout: 30000,
  },
};

/** A connected client whose schema probe reported ruvector(4). */
async function connectedClient(db: RecordingDatabase): Promise<VectorClient> {
  db.enqueue([{ column_type: `ruvector(${DIMENSION})` }]);
  const client = new VectorClient(db.asDatabaseClient(), testConfig);
  await client.connect();
  db.calls.length = 0;
  return client;
}

describe('VectorClient.connect', () => {
  it('reads the real column type and reports connected', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    expect(client.isConnected()).toBe(true);
  });

  it('throws when the embedding column does not exist', async () => {
    const db = new RecordingDatabase();
    db.enqueue([]);
    const client = new VectorClient(db.asDatabaseClient(), testConfig);

    await expect(client.connect()).rejects.toThrow(/embedding does not exist/);
    expect(client.isConnected()).toBe(false);
  });

  it('refuses to start when the schema dimension disagrees with config', async () => {
    const db = new RecordingDatabase();
    db.enqueue([{ column_type: 'ruvector(1536)' }]);
    const client = new VectorClient(db.asDatabaseClient(), testConfig);

    await expect(client.connect()).rejects.toThrow(/dimension mismatch/i);
  });

  it('rejects a non-vector column type', async () => {
    const db = new RecordingDatabase();
    db.enqueue([{ column_type: 'jsonb' }]);
    const client = new VectorClient(db.asDatabaseClient(), testConfig);

    await expect(client.connect()).rejects.toThrow(/expected a dimensioned vector type/);
  });
});

describe('VectorClient.upsert', () => {
  it('issues a real INSERT ... ON CONFLICT carrying the vector literal', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([{ inserted: true }]);

    const result = await client.upsert('ns', 'vec-1', VECTOR, { tag: 'alpha' });

    expect(result).toEqual({ id: 'vec-1', namespace: 'ns', status: 'created' });
    expect(db.lastCall.text).toContain('INSERT INTO vectors');
    expect(db.lastCall.text).toContain('ON CONFLICT (namespace, id) DO UPDATE');
    expect(db.lastCall.text).toContain('::ruvector(4)');
    expect(db.lastCall.params).toContain('[0.1,0.2,0.3,0.4]');
  });

  it('reports updated when the row already existed', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([{ inserted: false }]);

    const result = await client.upsert('ns', 'vec-1', VECTOR, {});

    expect(result.status).toBe('updated');
  });

  it('rejects a vector whose length does not match the schema', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    await expect(client.upsert('ns', 'vec-1', [0.1, 0.2], {})).rejects.toThrow(
      /2 dimensions, expected 4/
    );
    expect(db.calls).toHaveLength(0);
  });

  it('propagates database failures instead of reporting success', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue(new Error('connection terminated'));

    await expect(client.upsert('ns', 'vec-1', VECTOR, {})).rejects.toThrow(
      'connection terminated'
    );
  });
});

describe('VectorClient.insert', () => {
  it('delegates to the single upsert write path using the default namespace', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([{ inserted: true }]);

    const result = await client.insert({
      id: 'event-1',
      vector: VECTOR,
      payload: { test: 'data' },
      metadata: { source: 's' },
    });

    expect(result).toEqual({ id: 'event-1' });
    expect(db.calls).toHaveLength(1);
    expect(db.lastCall.text).toContain('INSERT INTO vectors');
    expect(db.lastCall.params).toContain(DEFAULT_NAMESPACE);
  });
});

describe('VectorClient.query', () => {
  it('orders by cosine distance when a query vector is supplied', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([
      {
        id: 'vec-1',
        namespace: 'ns',
        embedding: '[0.1,0.2,0.3,0.4]',
        payload: {},
        metadata: { tag: 'alpha' },
        created_at: new Date(),
        distance: 0,
      },
    ]);
    db.enqueue([{ total: '1' }]);

    const result = await client.query({ vector: VECTOR, limit: 10, offset: 0 });

    const select = db.calls[0];
    expect(select.text).toContain('embedding <=> $1::ruvector(4)');
    expect(select.text).toContain('ORDER BY distance ASC');
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe('vec-1');
    // distance 0 -> similarity 1
    expect(result.items[0].score).toBe(1);
    expect(result.items[0].vector).toEqual(VECTOR);
  });

  it('returns whatever the database returns, including nothing', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);
    db.enqueue([{ total: '0' }]);

    const result = await client.query({ vector: VECTOR, limit: 10, offset: 0 });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('binds filter keys and values as parameters, never as SQL text', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);
    db.enqueue([{ total: '0' }]);

    const hostileKey = "x'; DROP TABLE vectors; --";
    await client.query({
      filters: { namespace: 'ns', [hostileKey]: 'value', type: ['a', 'b'] },
      limit: 10,
      offset: 0,
    });

    const select = db.calls[0];
    expect(select.text).not.toContain('DROP TABLE');
    expect(select.text).toContain('metadata ->> $2 = $3');
    expect(select.text).toContain('= ANY($5::text[])');
    expect(select.params).toContain(hostileKey);
    expect(select.params).toContainEqual(['a', 'b']);
  });

  it('binds timeRange bounds as parameters', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);
    db.enqueue([{ total: '0' }]);

    await client.query({
      timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' },
      limit: 5,
      offset: 0,
    });

    const select = db.calls[0];
    expect(select.text).toContain('created_at >= $1');
    expect(select.text).toContain('created_at <= $2');
    expect(select.params.slice(0, 2)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
    ]);
  });

  it('excludes limit and offset from the count query', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);
    db.enqueue([{ total: '7' }]);

    await client.query({ filters: { namespace: 'ns' }, limit: 10, offset: 20 });

    const [select, count] = db.calls;
    expect(select.params).toEqual(['ns', 10, 20]);
    expect(count.params).toEqual(['ns']);
    expect(count.text).toContain('COUNT(*)');
  });

  it('binds the count query to exactly the placeholders its WHERE clause uses', async () => {
    // The ANN literal is referenced only in the SELECT list, so passing it to
    // the count statement makes Postgres reject the bind.
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);
    db.enqueue([{ total: '0' }]);

    await client.query({
      vector: VECTOR,
      filters: { namespace: 'ns' },
      limit: 10,
      offset: 0,
    });

    const count = db.calls[1];
    const placeholders = new Set(count.text.match(/\$\d+/g) ?? []);
    expect(count.params).toHaveLength(placeholders.size);
    expect(count.params).toEqual(['ns']);
  });
});

describe('VectorClient.similarity', () => {
  it('applies the similarity threshold and returns neighbours by descending score', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([
      { id: 'far', embedding: null, payload: {}, metadata: {}, distance: 0.4 },
      { id: 'near', embedding: null, payload: {}, metadata: {}, distance: 0.1 },
    ]);

    const result = await client.similarity({
      contextVectors: [VECTOR],
      k: 5,
      threshold: 0.5,
      includeMetadata: true,
    });

    expect(db.lastCall.text).toContain('1 - (embedding <=> $1::ruvector(4)) >= $2');
    expect(db.lastCall.params).toEqual(['[0.1,0.2,0.3,0.4]', 0.5, 5]);
    expect(result.neighbors.map((n) => n.id)).toEqual(['near', 'far']);
    expect(result.neighbors[0].score).toBeCloseTo(0.9);
    expect(result.processed).toBe(1);
  });

  it('de-duplicates across context vectors and truncates to k', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([{ id: 'shared', embedding: null, payload: {}, metadata: {}, distance: 0.5 }]);
    db.enqueue([
      { id: 'shared', embedding: null, payload: {}, metadata: {}, distance: 0.1 },
      { id: 'other', embedding: null, payload: {}, metadata: {}, distance: 0.2 },
    ]);

    const result = await client.similarity({
      contextVectors: [VECTOR, VECTOR],
      k: 1,
      threshold: 0,
      includeMetadata: false,
    });

    expect(result.processed).toBe(2);
    expect(result.neighbors).toHaveLength(1);
    // best score for 'shared' wins over its worse duplicate
    expect(result.neighbors[0].id).toBe('shared');
    expect(result.neighbors[0].score).toBeCloseTo(0.9);
  });

  it('omits metadata when includeMetadata is false', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([{ id: 'a', embedding: null, payload: {}, metadata: { s: 1 }, distance: 0.1 }]);

    const result = await client.similarity({
      contextVectors: [VECTOR],
      k: 5,
      threshold: 0,
      includeMetadata: false,
    });

    expect(result.neighbors[0].metadata).toBeUndefined();
  });
});

describe('VectorClient.run_prediction', () => {
  it('throws NotImplementedError instead of fabricating a result', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    await expect(client.run_prediction('any-model', VECTOR)).rejects.toBeInstanceOf(
      NotImplementedError
    );
    expect(db.calls).toHaveLength(0);
  });
});

describe('VectorClient.ping', () => {
  it('executes a real query and returns true on success', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue([]);

    await expect(client.ping()).resolves.toBe(true);
    expect(db.lastCall.text).toContain('SELECT 1 AS ping FROM vectors');
  });

  it('returns false when the database is unreachable', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);
    db.enqueue(new Error('ECONNREFUSED'));

    await expect(client.ping()).resolves.toBe(false);
  });
});

describe('VectorClient circuit breaker', () => {
  it('opens after the failure threshold and then fails fast', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    for (let attempt = 0; attempt < testConfig.circuitBreaker.threshold; attempt++) {
      db.enqueue(new Error('connection terminated'));
      await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow();
    }

    expect(client.getCircuitState()).toBe(CircuitState.OPEN);

    const callsBefore = db.calls.length;
    await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow(
      /Circuit breaker is open/
    );
    // fails fast without touching the database
    expect(db.calls).toHaveLength(callsBefore);
  });

  it('reports not-ready via ping while the circuit is open', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    for (let attempt = 0; attempt < testConfig.circuitBreaker.threshold; attempt++) {
      db.enqueue(new Error('connection terminated'));
      await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow();
    }

    await expect(client.ping()).resolves.toBe(false);
  });

  it('does not accumulate failures across a healthy period', async () => {
    const db = new RecordingDatabase();
    const client = await connectedClient(db);

    for (let cycle = 0; cycle < 4; cycle++) {
      db.enqueue(new Error('transient'));
      await expect(client.query({ limit: 1, offset: 0 })).rejects.toThrow();

      db.enqueue([]);
      db.enqueue([{ total: '0' }]);
      await client.query({ limit: 1, offset: 0 });
    }

    expect(client.getCircuitState()).toBe(CircuitState.CLOSED);
  });
});
