import { Request, Response } from 'express';
import {
  acceptExecutionHandler,
  getExecutionHandler,
  listExecutionsHandler,
  validateExecutionHandler,
} from '../../src/handlers/executions';

// Mock config
jest.mock('../../src/config', () => ({
  config: {
    execution: {
      hmacSecret: 'test-hmac-secret-minimum-32-chars-long-for-testing-only',
      acceptanceTimeoutMs: 5000,
    },
  },
}));

// Mock metrics
jest.mock('../../src/utils/metrics', () => ({
  executionAcceptanceTotal: { inc: jest.fn() },
  executionAcceptanceDuration: { observe: jest.fn() },
  executionValidationTotal: { inc: jest.fn() },
}));

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  __esModule: true,
}));

function mockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

function mockRes(): Response & { json: jest.Mock; status: jest.Mock; setHeader: jest.Mock } {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

// Mock DatabaseClient
function mockDbClient(queryImpl?: jest.Mock) {
  return {
    query: queryImpl || jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as any;
}

describe('Execution Handlers', () => {
  describe('acceptExecutionHandler', () => {
    const validBody = {
      caller_id: 'agentics-simulation-engine',
      org_id: 'org-12345',
      simulation_type: 'enterprise_deployment',
      simulation_context: { objective: 'Deploy auth service' },
    };

    it('should accept valid request and return 201 with execution_id', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: expect.stringMatching(/^exec-/),
          accepted: true,
          reason: null,
          authority_signature: expect.stringMatching(/^[0-9a-f]{64}$/),
          lineage: expect.objectContaining({
            origin_service: 'ruvvector-service',
            root_span: expect.objectContaining({
              type: 'execution_root',
              parent_span_id: null,
            }),
          }),
        })
      );
    });

    it('should return 400 for missing caller_id', async () => {
      const req = mockReq({
        body: { ...validBody, caller_id: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    });

    it('should return 400 for missing org_id', async () => {
      const req = mockReq({
        body: { ...validBody, org_id: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing simulation_type', async () => {
      const req = mockReq({
        body: { ...validBody, simulation_type: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing simulation_context', async () => {
      const req = mockReq({
        body: { ...validBody, simulation_context: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 200 for duplicate idempotency_key (idempotent replay)', async () => {
      const existingRecord = {
        execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
        accepted: true,
        reason: null,
        authority_signature: 'abc123',
        lineage: {
          origin_service: 'ruvvector-service',
          origin_version: '1.0.0',
          acceptance_timestamp: '2024-01-01T00:00:00Z',
          root_span: {
            span_id: '660e8400-e29b-41d4-a716-446655440001',
            type: 'execution_root',
            parent_span_id: null,
            created_at: '2024-01-01T00:00:00Z',
          },
          caller_id: 'agentics-simulation-engine',
          org_id: 'org-12345',
          simulation_context: {},
        },
        created_at: '2024-01-01T00:00:00Z',
      };

      const req = mockReq({
        body: { ...validBody, idempotency_key: 'idem-key-1' },
      });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [existingRecord], rowCount: 1 })
      );

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
          accepted: true,
        })
      );
    });

    it('should return 500 on DB error', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockRejectedValue(new Error('connection refused'))
      );

      await acceptExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'internal_error' })
      );
    });

    it('should include root_span with type execution_root and null parent_span_id', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptExecutionHandler(req as Request, res as Response, db);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.lineage.root_span.type).toBe('execution_root');
      expect(responseBody.lineage.root_span.parent_span_id).toBeNull();
      expect(responseBody.lineage.root_span.span_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('getExecutionHandler', () => {
    it('should return 200 with execution record for existing ID', async () => {
      const record = {
        execution_id: 'exec-test',
        accepted: true,
        reason: null,
        caller_id: 'test',
        org_id: 'org-1',
        simulation_type: 'test',
        simulation_context: {},
        authority_signature: 'sig',
        root_span_id: 'span-1',
        lineage: {},
        idempotency_key: null,
        created_at: '2024-01-01T00:00:00Z',
      };

      const req = mockReq({ params: { id: 'exec-test' } });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [record], rowCount: 1 })
      );

      await getExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(record);
    });

    it('should return 404 for non-existent execution_id', async () => {
      const req = mockReq({ params: { id: 'exec-nonexistent' } });
      const res = mockRes();
      const db = mockDbClient();

      await getExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'not_found' })
      );
    });
  });

  describe('listExecutionsHandler', () => {
    it('should return 200 with paginated results', async () => {
      const queryFn = jest.fn()
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            { execution_id: 'exec-1', accepted: true },
            { execution_id: 'exec-2', accepted: true },
          ],
          rowCount: 2,
        });

      const req = mockReq({ query: {} });
      const res = mockRes();
      const db = mockDbClient(queryFn);

      await listExecutionsHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 2,
          limit: 50,
          offset: 0,
        })
      );
    });

    it('should pass caller_id filter', async () => {
      const queryFn = jest.fn()
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const req = mockReq({ query: { caller_id: 'test-caller' } });
      const res = mockRes();
      const db = mockDbClient(queryFn);

      await listExecutionsHandler(req as Request, res as Response, db);

      // Verify caller_id was passed as parameter
      expect(queryFn.mock.calls[0][1]).toContain('test-caller');
    });
  });

  describe('validateExecutionHandler', () => {
    it('should return valid: true for genuine signature', async () => {
      // Import signing function to create a real signature
      const { signExecution } = require('../../src/utils/executionAuthority');
      const secret = 'test-hmac-secret-minimum-32-chars-long-for-testing-only';
      const execId = 'exec-550e8400-e29b-41d4-a716-446655440000';
      const timestamp = '2024-01-01T00:00:00.000Z';
      const sig = signExecution(execId, timestamp, secret);

      const req = mockReq({
        body: { execution_id: execId, authority_signature: sig },
      });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({
          rows: [{
            execution_id: execId,
            authority_signature: sig,
            created_at: timestamp,
          }],
          rowCount: 1,
        })
      );

      await validateExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ valid: true, execution_id: execId })
      );
    });

    it('should return valid: false for tampered signature', async () => {
      const req = mockReq({
        body: {
          execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
          authority_signature: 'a'.repeat(64),
        },
      });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({
          rows: [{
            execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
            authority_signature: 'b'.repeat(64),
            created_at: '2024-01-01T00:00:00.000Z',
          }],
          rowCount: 1,
        })
      );

      await validateExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ valid: false, reason: 'signature_mismatch' })
      );
    });

    it('should return valid: false for non-existent execution_id', async () => {
      const req = mockReq({
        body: {
          execution_id: 'exec-nonexistent',
          authority_signature: 'a'.repeat(64),
        },
      });
      const res = mockRes();
      const db = mockDbClient();

      await validateExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ valid: false, reason: 'execution_not_found' })
      );
    });

    it('should return 400 for missing fields', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const db = mockDbClient();

      await validateExecutionHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    });
  });
});
