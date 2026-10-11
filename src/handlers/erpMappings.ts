/** Append-only ERP mappings persisted through the existing RuVector database. */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

export const createErpMappingSchema = z.object({
  id: z.string().min(1),
  type: z.literal('erp_mapping'),
  erp_type: z.string().min(1),
  entity_type: z.string().min(1),
  proposed_implementation: z.unknown(),
  simulation_id: z.string().min(1),
  integration_proposal_ids: z.array(z.string()),
  attribution: z.unknown(),
  created_at: z.string().datetime({ offset: true }),
});

type ErpMapping = z.infer<typeof createErpMappingSchema>;
type ErpMappingRow = Omit<ErpMapping, 'created_at'> & { created_at: string | Date };

function serializeRow(row: ErpMappingRow): ErpMapping {
  return { ...row, created_at: new Date(row.created_at).toISOString() };
}

export async function createErpMappingHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  try {
    const data = createErpMappingSchema.parse(req.body);
    const result = await dbClient.query<{ id: string }>(
      `INSERT INTO erp_mappings
         (id, type, erp_type, entity_type, proposed_implementation, simulation_id,
          integration_proposal_ids, attribution, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        data.id,
        data.type,
        data.erp_type,
        data.entity_type,
        JSON.stringify(data.proposed_implementation),
        data.simulation_id,
        JSON.stringify(data.integration_proposal_ids),
        JSON.stringify(data.attribution),
        data.created_at,
      ]
    );

    if (result.rowCount === 0) {
      res.status(409).json({
        error: 'immutable_conflict',
        message: `ERP mapping ${data.id} already exists`,
        execution_metadata: executionMetadata,
      });
      return;
    }

    logger.info({ traceId: executionMetadata.trace_id, mappingId: data.id }, 'ERP mapping stored');
    res.status(201).json({ accepted: true, id: data.id, execution_metadata: executionMetadata });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Request validation failed',
        details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
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

export async function listErpMappingsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const simulationId = typeof req.query.simulation_id === 'string' ? req.query.simulation_id : undefined;

  try {
    const result = simulationId
      ? await dbClient.query<ErpMappingRow>(
          `SELECT id, type, erp_type, entity_type, proposed_implementation,
                  simulation_id, integration_proposal_ids, attribution, created_at
           FROM erp_mappings WHERE simulation_id = $1
           ORDER BY created_at ASC, id ASC`,
          [simulationId]
        )
      : await dbClient.query<ErpMappingRow>(
          `SELECT id, type, erp_type, entity_type, proposed_implementation,
                  simulation_id, integration_proposal_ids, attribution, created_at
           FROM erp_mappings ORDER BY created_at ASC, id ASC`
        );

    res.status(200).json({
      mappings: result.rows.map(serializeRow),
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    logger.error({ error, simulationId }, 'Failed to list ERP mappings');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list ERP mappings',
      execution_metadata: executionMetadata,
    });
  }
}
