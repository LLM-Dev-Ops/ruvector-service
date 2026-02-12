import { Request, Response } from 'express';
import { acceptSimulationHandler } from '../../src/handlers/simulations';

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
  simulationAcceptanceTotal: { inc: jest.fn() },
  simulationAcceptanceDuration: { observe: jest.fn() },
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

function mockDbClient(queryImpl?: jest.Mock) {
  return {
    query: queryImpl || jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as any;
}

describe('Simulation Handlers', () => {
  describe('acceptSimulationHandler', () => {
    const validBody = {
      caller_id: 'agentics-cli',
      org_id: 'org-12345',
      simulation_type: 'enterprise_deployment',
      simulation_context: { objective: 'Deploy auth service' },
      intent_description: 'Simulate deploying the authentication service to production',
    };

    it('should accept valid simulation intent and return 201 with execution_id and parent_span_id', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: expect.stringMatching(/^exec-/),
          accepted: true,
          parent_span_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          ),
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

    it('should return parent_span_id matching lineage.root_span.span_id', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.parent_span_id).toBe(responseBody.lineage.root_span.span_id);
    });

    it('should return 400 for missing caller_id', async () => {
      const req = mockReq({
        body: { ...validBody, caller_id: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

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

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing simulation_type', async () => {
      const req = mockReq({
        body: { ...validBody, simulation_type: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing simulation_context', async () => {
      const req = mockReq({
        body: { ...validBody, simulation_context: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing intent_description', async () => {
      const req = mockReq({
        body: { ...validBody, intent_description: undefined },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    });

    it('should return 400 for intent_description exceeding 2000 chars', async () => {
      const req = mockReq({
        body: { ...validBody, intent_description: 'x'.repeat(2001) },
      });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    });

    it('should return 200 for duplicate idempotency_key (idempotent replay)', async () => {
      const storedLineage = {
        origin_service: 'ruvvector-service',
        origin_version: '1.0.0',
        acceptance_timestamp: '2024-01-01T00:00:00Z',
        root_span: {
          span_id: '660e8400-e29b-41d4-a716-446655440001',
          type: 'execution_root',
          parent_span_id: null,
          created_at: '2024-01-01T00:00:00Z',
        },
        caller_id: 'agentics-cli',
        org_id: 'org-12345',
        simulation_context: {
          objective: 'Deploy auth service',
          intent_description: 'Simulate deploying the authentication service to production',
        },
      };

      const existingRecord = {
        execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
        accepted: true,
        reason: null,
        authority_signature: 'abc123',
        lineage: storedLineage,
        created_at: '2024-01-01T00:00:00Z',
      };

      const req = mockReq({
        body: { ...validBody, idempotency_key: 'idem-sim-1' },
      });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [existingRecord], rowCount: 1 })
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: 'exec-550e8400-e29b-41d4-a716-446655440000',
          accepted: true,
          parent_span_id: '660e8400-e29b-41d4-a716-446655440001',
        })
      );
    });

    it('should return 500 on DB error (fail closed)', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockRejectedValue(new Error('connection refused'))
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

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

      await acceptSimulationHandler(req as Request, res as Response, db);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.lineage.root_span.type).toBe('execution_root');
      expect(responseBody.lineage.root_span.parent_span_id).toBeNull();
      expect(responseBody.lineage.root_span.span_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should set x-correlation-id response header', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.setHeader).toHaveBeenCalledWith(
        'x-correlation-id',
        expect.any(String)
      );
    });

    it('should persist intent_description in simulation_context', async () => {
      const req = mockReq({ body: validBody });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      // The INSERT call is the first (no idempotency_key, so no SELECT first)
      const insertCall = queryFn.mock.calls[0];
      const simulationContextParam = insertCall[1][6]; // 7th param = simulation_context (JSON-stringified)
      const parsed = JSON.parse(simulationContextParam);
      expect(parsed.intent_description).toBe(
        'Simulate deploying the authentication service to production'
      );
    });

    it('should record accepted metric on success', async () => {
      const { simulationAcceptanceTotal } = require('../../src/utils/metrics');
      simulationAcceptanceTotal.inc.mockClear();

      const req = mockReq({ body: validBody });
      const res = mockRes();
      const db = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(simulationAcceptanceTotal.inc).toHaveBeenCalledWith({ status: 'accepted' });
    });

    it('should record rejected metric on validation error', async () => {
      const { simulationAcceptanceTotal } = require('../../src/utils/metrics');
      simulationAcceptanceTotal.inc.mockClear();

      const req = mockReq({ body: {} });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(simulationAcceptanceTotal.inc).toHaveBeenCalledWith({ status: 'rejected' });
    });

    it('should record duration metric on both success and failure', async () => {
      const { simulationAcceptanceDuration } = require('../../src/utils/metrics');
      simulationAcceptanceDuration.observe.mockClear();

      // Success path
      const req1 = mockReq({ body: validBody });
      const res1 = mockRes();
      const db1 = mockDbClient(
        jest.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      );

      await acceptSimulationHandler(req1 as Request, res1 as Response, db1);
      expect(simulationAcceptanceDuration.observe).toHaveBeenCalledTimes(1);

      simulationAcceptanceDuration.observe.mockClear();

      // Failure path (validation error)
      const req2 = mockReq({ body: {} });
      const res2 = mockRes();
      const db2 = mockDbClient();

      await acceptSimulationHandler(req2 as Request, res2 as Response, db2);
      expect(simulationAcceptanceDuration.observe).toHaveBeenCalledTimes(1);
    });
  });
});
