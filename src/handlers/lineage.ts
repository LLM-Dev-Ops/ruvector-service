/**
 * Lineage API handlers.
 *
 * Records are append-only in the existing RuVector Cloud SQL database. Keeping
 * the data behind DatabaseClient makes the service stateless across Cloud Run
 * instances and prevents restarts from erasing audit evidence.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

export const createLineageSchema = z.object({
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
  created_at: z.string().datetime({ offset: true }),
});

type LineageRecord = z.infer<typeof createLineageSchema>;
type LineageRow = Omit<LineageRecord, 'created_at'> & { created_at: string | Date };

function serializeRow(row: LineageRow): LineageRecord {
  return { ...row, created_at: new Date(row.created_at).toISOString() };
}

export async function createLineageHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);

  try {
    const data = createLineageSchema.parse(req.body);
    const result = await dbClient.query<{ id: string }>(
      `INSERT INTO lineage_records
         (id, artifact_id, artifact_category, simulation_id, plan_id,
          decision_context, attribution, governance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        data.id,
        data.artifact_id,
        data.artifact_category,
        data.simulation_id,
        data.plan_id ?? null,
        JSON.stringify(data.decision_context),
        JSON.stringify(data.attribution),
        JSON.stringify(data.governance),
        data.created_at,
      ]
    );

    if (result.rowCount === 0) {
      res.status(409).json({
        error: 'immutable_conflict',
        message: `Lineage record ${data.id} already exists`,
        execution_metadata: executionMetadata,
      });
      return;
    }

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
        details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
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

export async function getLineageBySimulationHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { simulationId } = req.params;

  try {
    const result = await dbClient.query<LineageRow>(
      `SELECT id, artifact_id, artifact_category, simulation_id, plan_id,
              decision_context, attribution, governance, created_at
       FROM lineage_records
       WHERE simulation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [simulationId]
    );
    res.status(200).json({
      artifacts: result.rows.map(serializeRow),
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    logger.error({ error, simulationId }, 'Failed to retrieve lineage records');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve lineage records',
      execution_metadata: executionMetadata,
    });
  }
}

export async function getLineageByArtifactHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const { artifactId } = req.params;

  try {
    const result = await dbClient.query<LineageRow>(
      `SELECT id, artifact_id, artifact_category, simulation_id, plan_id,
              decision_context, attribution, governance, created_at
       FROM lineage_records
       WHERE artifact_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [artifactId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Lineage for artifact ${artifactId} not found`,
        execution_metadata: executionMetadata,
      });
      return;
    }

    res.status(200).json({
      ...serializeRow(result.rows[0]),
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    logger.error({ error, artifactId }, 'Failed to retrieve artifact lineage');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve artifact lineage',
      execution_metadata: executionMetadata,
    });
  }
}
