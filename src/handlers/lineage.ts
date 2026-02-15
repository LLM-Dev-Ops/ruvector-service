/**
 * Lineage API Handlers
 * In-memory storage for lineage records
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

// In-memory storage
const lineageStore = new Map<string, any>();

// Validation schema for creating a lineage record
const createLineageSchema = z.object({
  id: z.string().min(1),
  artifact_id: z.string().min(1),
  artifact_category: z.string().min(1),
  simulation_id: z.string().min(1),
  plan_id: z.string().optional(),
  decision_context: z.unknown(),
  attribution: z.object({
    created_by: z.string().min(1),
    org_id: z.string().min(1),
  }),
  governance: z.object({
    gate_pipeline_version: z.string().min(1),
    synthesis_classification: z.string().min(1),
  }),
  created_at: z.string(),
});

/**
 * POST /v1/lineage — Store a lineage record
 */
export async function createLineageHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);

  try {
    const data = createLineageSchema.parse(req.body);
    lineageStore.set(data.id, data);

    logger.info({ traceId: executionMetadata.trace_id, lineageId: data.id }, 'Lineage record stored');

    res.status(201).json({
      accepted: true,
      id: data.id,
      timestamp: executionMetadata.timestamp,
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
    logger.error({ error }, 'Failed to store lineage record');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store lineage record',
      execution_metadata: executionMetadata,
    });
  }
}

/**
 * GET /v1/lineage/simulation/:simulationId/artifacts — Get all lineage records for a simulation
 */
export async function getLineageBySimulationHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { simulationId } = req.params;

  const artifacts: any[] = [];
  for (const record of lineageStore.values()) {
    if (record.simulation_id === simulationId) {
      artifacts.push(record);
    }
  }

  res.status(200).json({
    artifacts,
    execution_metadata: executionMetadata,
  });
}

/**
 * GET /v1/lineage/artifact/:artifactId — Get lineage for a specific artifact
 */
export async function getLineageByArtifactHandler(req: Request, res: Response): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { artifactId } = req.params;

  // Search by artifact_id field
  let found: any = null;
  for (const record of lineageStore.values()) {
    if (record.artifact_id === artifactId) {
      found = record;
      break;
    }
  }

  if (!found) {
    res.status(404).json({
      error: 'not_found',
      message: `Lineage for artifact ${artifactId} not found`,
      execution_metadata: executionMetadata,
    });
    return;
  }

  res.status(200).json({
    ...found,
    execution_metadata: executionMetadata,
  });
}
