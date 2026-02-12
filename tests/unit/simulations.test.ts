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

describe('POST /v1/simulations — Execution Authority Minting Gate', () => {
  // Minimal payload: only intent_description required
  const minimalBody = {
    intent_description: 'Deploy authentication service to production',
  };

  const fullBody = {
    intent_description: 'Deploy authentication service to production',
    caller_id: 'agentics-cli',
    org_id: 'org-12345',
    simulation_type: 'enterprise_deployment',
    simulation_context: { objective: 'Deploy auth service' },
  };

  describe('authority minting', () => {
    it('should mint execution authority with minimal payload and return 200', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: expect.stringMatching(/^exec-/),
          parent_span_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          ),
          authority: 'ruvector-service',
          accepted: true,
          timestamp: expect.any(String),
        })
      );
    });

    it('should accept full payload with optional fields', async () => {
      const req = mockReq({ body: fullBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_id: expect.stringMatching(/^exec-/),
          authority: 'ruvector-service',
          accepted: true,
        })
      );
    });

    it('should NOT require caller_id', async () => {
      const req = mockReq({ body: { intent_description: 'test' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should NOT require org_id', async () => {
      const req = mockReq({ body: { intent_description: 'test' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should NOT require simulation_type', async () => {
      const req = mockReq({ body: { intent_description: 'test' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should NOT require simulation_context', async () => {
      const req = mockReq({ body: { intent_description: 'test' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('payload normalization — CLI field name compatibility', () => {
    it('should accept "intent" and map to intent_description', async () => {
      const req = mockReq({ body: { intent: 'Run deployment simulation' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ accepted: true, authority: 'ruvector-service' })
      );
    });

    it('should accept "scenario" and map to intent_description', async () => {
      const req = mockReq({ body: { scenario: 'Migrate database to v2' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should accept "description" and map to intent_description', async () => {
      const req = mockReq({ body: { description: 'Scale API to 100 replicas' } });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should prefer intent_description over intent/scenario/description', async () => {
      const req = mockReq({
        body: {
          intent_description: 'canonical value',
          intent: 'ignored',
          scenario: 'ignored',
          description: 'ignored',
        },
      });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      const lineageSeed = JSON.parse(queryFn.mock.calls[0][1][9]);
      expect(lineageSeed.intent_description).toBe('canonical value');
    });

    it('should follow priority: intent > scenario > description', async () => {
      const req = mockReq({
        body: { intent: 'from intent', scenario: 'from scenario', description: 'from desc' },
      });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      const lineageSeed = JSON.parse(queryFn.mock.calls[0][1][9]);
      expect(lineageSeed.intent_description).toBe('from intent');
    });

    it('should preserve optional fields alongside normalized intent', async () => {
      const req = mockReq({
        body: { scenario: 'test sim', caller_id: 'agentics-cli', org_id: 'org-1' },
      });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(200);
      const insertParams = queryFn.mock.calls[0][1];
      expect(insertParams[3]).toBe('agentics-cli'); // caller_id
      expect(insertParams[4]).toBe('org-1'); // org_id
    });

    it('should return 400 when none of the intent fields exist', async () => {
      const req = mockReq({ body: { caller_id: 'cli' } });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('response contract', () => {
    it('should return exactly the specified response shape', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(
        ['accepted', 'authority', 'execution_id', 'parent_span_id', 'timestamp']
      );
    });

    it('should return authority as "ruvector-service"', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      const body = res.json.mock.calls[0][0];
      expect(body.authority).toBe('ruvector-service');
    });

    it('should return ISO8601 timestamp', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      const body = res.json.mock.calls[0][0];
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });

    it('should set x-correlation-id response header', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', expect.any(String));
    });
  });

  describe('root authority span', () => {
    it('should persist lineage seed with authority span', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      const insertParams = queryFn.mock.calls[0][1];
      const lineageSeed = JSON.parse(insertParams[9]); // 10th param = lineage
      expect(lineageSeed.root_span.type).toBe('authority');
      expect(lineageSeed.root_span.origin).toBe('ruvector-service');
      expect(lineageSeed.root_span.parent).toBeNull();
      expect(lineageSeed.root_span.span_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should return parent_span_id referencing the root span', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const queryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      const db = mockDbClient(queryFn);

      await acceptSimulationHandler(req as Request, res as Response, db);

      const body = res.json.mock.calls[0][0];
      const insertParams = queryFn.mock.calls[0][1];
      const lineageSeed = JSON.parse(insertParams[9]);
      expect(body.parent_span_id).toBe(lineageSeed.root_span.span_id);
    });
  });

  describe('validation — intent_description required', () => {
    it('should return 400 when intent_description missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'validation_error' })
      );
    });

    it('should return 400 when intent_description is empty string', async () => {
      const req = mockReq({ body: { intent_description: '' } });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when intent_description exceeds 2000 chars', async () => {
      const req = mockReq({ body: { intent_description: 'x'.repeat(2001) } });
      const res = mockRes();
      const db = mockDbClient();

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('fail closed', () => {
    it('should return 500 when lineage persistence fails', async () => {
      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockRejectedValue(new Error('connection refused')));

      await acceptSimulationHandler(req as Request, res as Response, db);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'internal_error',
          message: 'Lineage persistence failed',
        })
      );
    });
  });

  describe('metrics', () => {
    it('should record accepted metric on success', async () => {
      const { simulationAcceptanceTotal } = require('../../src/utils/metrics');
      simulationAcceptanceTotal.inc.mockClear();

      const req = mockReq({ body: minimalBody });
      const res = mockRes();
      const db = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));

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

    it('should record duration metric on all paths', async () => {
      const { simulationAcceptanceDuration } = require('../../src/utils/metrics');

      // Success
      simulationAcceptanceDuration.observe.mockClear();
      const req1 = mockReq({ body: minimalBody });
      const res1 = mockRes();
      const db1 = mockDbClient(jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }));
      await acceptSimulationHandler(req1 as Request, res1 as Response, db1);
      expect(simulationAcceptanceDuration.observe).toHaveBeenCalledTimes(1);

      // Failure
      simulationAcceptanceDuration.observe.mockClear();
      const req2 = mockReq({ body: {} });
      const res2 = mockRes();
      const db2 = mockDbClient();
      await acceptSimulationHandler(req2 as Request, res2 as Response, db2);
      expect(simulationAcceptanceDuration.observe).toHaveBeenCalledTimes(1);
    });
  });
});
