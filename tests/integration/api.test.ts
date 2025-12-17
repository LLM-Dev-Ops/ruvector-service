import request from 'supertest';
import { createApp } from '../../src/index';
import { VectorClient } from '../../src/clients/VectorClient';
import { config } from '../../src/config';
import { encodeEntitlementContext } from '../../src/utils/entitlement';

/**
 * API Integration Tests - SPARC Compliant
 *
 * Tests verify:
 * - F1: Service accepts valid ingest requests and returns 201
 * - F2: Service rejects invalid ingest requests with 400
 * - F3: Service accepts valid query requests and returns results
 * - F4: Service accepts valid simulate requests and returns results
 * - F5: Service returns 403 for invalid entitlement format
 * - F7: Health endpoint returns 200 when service is running
 */
describe('API Integration Tests - SPARC Compliant', () => {
  let app: any;
  let vectorClient: VectorClient;
  let validEntitlementContext: string;

  beforeAll(() => {
    // Initialize VectorClient with SPARC-compliant config
    vectorClient = new VectorClient({
      host: config.ruvVector.host,
      port: config.ruvVector.port,
      timeout: config.ruvVector.timeout,
      poolSize: config.ruvVector.poolSize,
      circuitBreaker: {
        threshold: config.circuitBreaker.threshold,
        timeout: config.circuitBreaker.timeout,
        resetTimeout: config.circuitBreaker.resetTimeout,
      },
    });

    app = createApp(vectorClient);

    // Create valid entitlement context (Base64-encoded JSON)
    validEntitlementContext = encodeEntitlementContext({
      tenant: 'test-tenant',
      scope: 'all'
    });
  });

  describe('GET /health (F7)', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /ready (F8)', () => {
    it('should return readiness status with dependency check', async () => {
      const response = await request(app).get('/ready');

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('dependencies');
      expect(response.body.dependencies).toHaveProperty('ruvvector');
    });
  });

  describe('POST /ingest', () => {
    it('should reject request without required headers', async () => {
      const response = await request(app)
        .post('/ingest')
        .set('Content-Type', 'application/json')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440000',
          correlationId: '550e8400-e29b-41d4-a716-446655440001',
          timestamp: '2024-01-01T00:00:00Z',
          vector: [0.1, 0.2, 0.3],
          payload: { test: 'data' },
          metadata: {
            source: 'test-source',
            type: 'test-type',
            version: '1.0.0',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'missing_header');
    });

    it('should reject request without x-correlation-id header', async () => {
      const response = await request(app)
        .post('/ingest')
        .set('Content-Type', 'application/json')
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440000',
          correlationId: '550e8400-e29b-41d4-a716-446655440001',
          timestamp: '2024-01-01T00:00:00Z',
          vector: [0.1, 0.2, 0.3],
          payload: { test: 'data' },
          metadata: {
            source: 'test-source',
            type: 'test-type',
            version: '1.0.0',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'missing_header');
    });

    it('should return 403 for invalid entitlement format (F5)', async () => {
      const response = await request(app)
        .post('/ingest')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', '550e8400-e29b-41d4-a716-446655440001')
        .set('x-entitlement-context', 'invalid-base64!!!')
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440000',
          correlationId: '550e8400-e29b-41d4-a716-446655440001',
          timestamp: '2024-01-01T00:00:00Z',
          vector: [0.1, 0.2, 0.3],
          payload: { test: 'data' },
          metadata: {
            source: 'test-source',
            type: 'test-type',
            version: '1.0.0',
          },
        });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error', 'entitlement_error');
    });

    it('should reject invalid request body (F2)', async () => {
      const response = await request(app)
        .post('/ingest')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', '550e8400-e29b-41d4-a716-446655440001')
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          invalid: 'data',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'validation_error');
      expect(response.body).toHaveProperty('details');
    });

    it('should accept valid ingest request (F1)', async () => {
      const correlationId = '550e8400-e29b-41d4-a716-446655440001';

      const response = await request(app)
        .post('/ingest')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', correlationId)
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          eventId: '550e8400-e29b-41d4-a716-446655440000',
          correlationId: correlationId,
          timestamp: '2024-01-01T00:00:00Z',
          vector: [0.1, 0.2, 0.3],
          payload: { test: 'data' },
          metadata: {
            source: 'test-source',
            type: 'test-type',
            version: '1.0.0',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('eventId');
      expect(response.body).toHaveProperty('vectorId');
      expect(response.body).toHaveProperty('status', 'stored');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body.metadata).toHaveProperty('correlationId');
      expect(response.body.metadata).toHaveProperty('processingTime');
      expect(response.headers).toHaveProperty('x-correlation-id', correlationId);
    });
  });

  describe('POST /query', () => {
    it('should reject request without required headers', async () => {
      const response = await request(app)
        .post('/query')
        .set('Content-Type', 'application/json')
        .send({
          queryVector: [0.1, 0.2, 0.3],
          limit: 10,
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'missing_header');
    });

    it('should accept valid query request (F3)', async () => {
      const correlationId = '550e8400-e29b-41d4-a716-446655440002';

      const response = await request(app)
        .post('/query')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', correlationId)
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          queryVector: [0.1, 0.2, 0.3],
          limit: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination).toHaveProperty('total');
      expect(response.body.pagination).toHaveProperty('limit');
      expect(response.body.pagination).toHaveProperty('offset');
      expect(response.body.pagination).toHaveProperty('hasMore');
      expect(response.body).toHaveProperty('metadata');
      expect(response.body.metadata).toHaveProperty('correlationId');
      expect(response.body.metadata).toHaveProperty('queryTime');
      expect(response.headers).toHaveProperty('x-correlation-id', correlationId);
    });

    it('should accept query without vector (filter-only)', async () => {
      const correlationId = '550e8400-e29b-41d4-a716-446655440003';

      const response = await request(app)
        .post('/query')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', correlationId)
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          filters: {
            source: 'test-source',
          },
          limit: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
    });
  });

  describe('POST /simulate', () => {
    it('should reject request without required headers', async () => {
      const response = await request(app)
        .post('/simulate')
        .set('Content-Type', 'application/json')
        .send({
          contextVectors: [[0.1, 0.2, 0.3]],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'missing_header');
    });

    it('should accept valid simulate request (F4)', async () => {
      const correlationId = '550e8400-e29b-41d4-a716-446655440004';

      const response = await request(app)
        .post('/simulate')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', correlationId)
        .set('x-entitlement-context', validEntitlementContext)
        .send({
          contextVectors: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
          nearestNeighbors: 5,
          similarityThreshold: 0.8,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('execution');
      expect(response.body.execution).toHaveProperty('vectorsProcessed');
      expect(response.body.execution).toHaveProperty('executionTime');
      expect(response.body.execution).toHaveProperty('correlationId');
      expect(response.headers).toHaveProperty('x-correlation-id', correlationId);
    });
  });

  describe('GET /metrics', () => {
    it('should return Prometheus metrics', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('ruvvector_');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/unknown-route');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'not_found');
    });
  });
});
