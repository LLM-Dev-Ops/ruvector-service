/**
 * Integration Proposals API Handlers
 * In-memory storage for integration proposals
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

// In-memory storage
const proposalsStore = new Map<string, any>();

const createProposalSchema = z.object({
  id: z.string().min(1),
  type: z.literal('integration_proposal'),
  integration_name: z.string().min(1),
  proposed_changes: z.unknown(),
  risks: z.unknown(),
  dependencies: z.unknown(),
  simulation_id: z.string().min(1),
  plan_id: z.string().optional(),
  attribution: z.unknown(),
  created_at: z.string(),
});

/**
 * POST /v1/integration-proposals — Store integration proposal
 */
export async function createIntegrationProposalHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);

  try {
    const data = createProposalSchema.parse(req.body);
    proposalsStore.set(data.id, data);

    logger.info({ traceId: executionMetadata.trace_id, proposalId: data.id }, 'Integration proposal stored');

    res.status(201).json({
      accepted: true,
      id: data.id,
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Request validation failed',
        details: error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
        execution_metadata: executionMetadata,
      });
      return;
    }
    logger.error({ error }, 'Failed to store integration proposal');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store integration proposal',
      execution_metadata: executionMetadata,
    });
  }
}

/**
 * GET /v1/integration-proposals?simulation_id=X — List proposals
 */
export async function listIntegrationProposalsHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { simulation_id } = req.query;

  const proposals: any[] = [];
  for (const record of proposalsStore.values()) {
    if (!simulation_id || record.simulation_id === simulation_id) {
      proposals.push(record);
    }
  }

  res.status(200).json({
    proposals,
    execution_metadata: executionMetadata,
  });
}
