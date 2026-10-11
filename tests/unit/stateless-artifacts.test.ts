import { Request, Response } from 'express';
import { DatabaseClient } from '../../src/clients/DatabaseClient';
import {
  createLineageHandler,
  getLineageByArtifactHandler,
  getLineageBySimulationHandler,
} from '../../src/handlers/lineage';
import {
  createErpMappingHandler,
  listErpMappingsHandler,
} from '../../src/handlers/erpMappings';
import {
  createIntegrationProposalHandler,
  listIntegrationProposalsHandler,
} from '../../src/handlers/integrationProposals';

jest.mock('../../src/utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  __esModule: true,
}));

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    header: jest.fn().mockReturnValue(undefined),
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as Request;
}

function mockRes(): Response & { json: jest.Mock; status: jest.Mock } {
  const res = {} as Response & { json: jest.Mock; status: jest.Mock };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockDb(rows: unknown[] = [], rowCount = rows.length): DatabaseClient {
  return {
    query: jest.fn().mockResolvedValue({ rows, rowCount }),
  } as unknown as DatabaseClient;
}

const createdAt = '2026-10-11T18:00:00.000Z';

describe('stateless append-only artifact handlers', () => {
  it('persists lineage with a parameterized append-only insert', async () => {
    const db = mockDb([{ id: 'lineage-1' }], 1);
    const req = mockReq({
      body: {
        id: 'lineage-1',
        artifact_id: 'artifact-1',
        artifact_category: 'simulation',
        simulation_id: 'simulation-1',
        decision_context: { decision: 'approve' },
        attribution: { created_by: 'agent', org_id: 'org-1' },
        governance: { gate_pipeline_version: '1', synthesis_classification: 'bounded' },
        created_at: createdAt,
      },
    });
    const res = mockRes();

    await createLineageHandler(req, res, db);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (id) DO NOTHING'),
      expect.arrayContaining(['lineage-1', 'artifact-1', 'simulation-1'])
    );
  });

  it('rejects a duplicate lineage id instead of mutating evidence', async () => {
    const db = mockDb([], 0);
    const res = mockRes();
    await createLineageHandler(
      mockReq({
        body: {
          id: 'lineage-1',
          artifact_id: 'artifact-1',
          artifact_category: 'simulation',
          simulation_id: 'simulation-1',
          decision_context: {},
          attribution: { created_by: 'agent', org_id: 'org-1' },
          governance: { gate_pipeline_version: '1', synthesis_classification: 'bounded' },
          created_at: createdAt,
        },
      }),
      res,
      db
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'immutable_conflict' }));
  });

  it('reads lineage by simulation from shared persistence', async () => {
    const row = {
      id: 'lineage-1',
      artifact_id: 'artifact-1',
      artifact_category: 'simulation',
      simulation_id: 'simulation-1',
      plan_id: null,
      decision_context: {},
      attribution: { created_by: 'agent', org_id: 'org-1' },
      governance: { gate_pipeline_version: '1', synthesis_classification: 'bounded' },
      created_at: new Date(createdAt),
    };
    const db = mockDb([row]);
    const res = mockRes();

    await getLineageBySimulationHandler(
      mockReq({ params: { simulationId: 'simulation-1' } }),
      res,
      db
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE simulation_id = $1'), ['simulation-1']);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ artifacts: [expect.objectContaining({ id: 'lineage-1', created_at: createdAt })] })
    );
  });

  it('returns 404 when durable artifact lineage does not exist', async () => {
    const res = mockRes();
    await getLineageByArtifactHandler(
      mockReq({ params: { artifactId: 'missing' } }),
      res,
      mockDb()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('persists ERP mappings append-only', async () => {
    const db = mockDb([{ id: 'erp-1' }], 1);
    const res = mockRes();
    await createErpMappingHandler(
      mockReq({
        body: {
          id: 'erp-1',
          type: 'erp_mapping',
          erp_type: 'sap',
          entity_type: 'invoice',
          proposed_implementation: { connector: 'bounded' },
          simulation_id: 'simulation-1',
          integration_proposal_ids: ['proposal-1'],
          attribution: { source: 'agent' },
          created_at: createdAt,
        },
      }),
      res,
      db
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO erp_mappings'),
      expect.arrayContaining(['erp-1', 'erp_mapping', 'simulation-1'])
    );
  });

  it('filters ERP mappings with a bound simulation id', async () => {
    const db = mockDb();
    await listErpMappingsHandler(
      mockReq({ query: { simulation_id: 'simulation-1' } }),
      mockRes(),
      db
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('simulation_id = $1'), ['simulation-1']);
  });

  it('persists integration proposals append-only', async () => {
    const db = mockDb([{ id: 'proposal-1' }], 1);
    const res = mockRes();
    await createIntegrationProposalHandler(
      mockReq({
        body: {
          id: 'proposal-1',
          type: 'integration_proposal',
          integration_name: 'sap',
          proposed_changes: { endpoint: '/bounded' },
          risks: [],
          dependencies: [],
          simulation_id: 'simulation-1',
          attribution: { source: 'agent' },
          created_at: createdAt,
        },
      }),
      res,
      db
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO integration_proposals'),
      expect.arrayContaining(['proposal-1', 'integration_proposal', 'simulation-1'])
    );
  });

  it('filters integration proposals with a bound simulation id', async () => {
    const db = mockDb();
    await listIntegrationProposalsHandler(
      mockReq({ query: { simulation_id: 'simulation-1' } }),
      mockRes(),
      db
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('simulation_id = $1'), ['simulation-1']);
  });

  it('fails closed when durable persistence is unavailable', async () => {
    const db = {
      query: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as DatabaseClient;
    const res = mockRes();
    await listIntegrationProposalsHandler(mockReq(), res, db);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'internal_error' }));
  });
});
