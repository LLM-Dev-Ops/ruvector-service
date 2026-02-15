/**
 * ERP Mappings API Handlers
 * In-memory storage for ERP surface mappings
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

// In-memory storage
const erpMappingsStore = new Map<string, any>();

const createErpMappingSchema = z.object({
  id: z.string().min(1),
  type: z.literal('erp_mapping'),
  erp_type: z.string().min(1),
  entity_type: z.string().min(1),
  proposed_implementation: z.unknown(),
  simulation_id: z.string().min(1),
  integration_proposal_ids: z.array(z.string()),
  attribution: z.unknown(),
  created_at: z.string(),
});

/**
 * POST /v1/erp-mappings — Store ERP surface mapping
 */
export async function createErpMappingHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);

  try {
    const data = createErpMappingSchema.parse(req.body);
    erpMappingsStore.set(data.id, data);

    logger.info({ traceId: executionMetadata.trace_id, mappingId: data.id }, 'ERP mapping stored');

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
    logger.error({ error }, 'Failed to store ERP mapping');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store ERP mapping',
      execution_metadata: executionMetadata,
    });
  }
}

/**
 * GET /v1/erp-mappings?simulation_id=X — List ERP mappings for simulation
 */
export async function listErpMappingsHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { simulation_id } = req.query;

  const mappings: any[] = [];
  for (const record of erpMappingsStore.values()) {
    if (!simulation_id || record.simulation_id === simulation_id) {
      mappings.push(record);
    }
  }

  res.status(200).json({
    mappings,
    execution_metadata: executionMetadata,
  });
}
