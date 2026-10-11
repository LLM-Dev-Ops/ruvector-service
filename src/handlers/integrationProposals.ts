/** Append-only integration proposals persisted through the existing RuVector database. */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import logger from '../utils/logger';

export const createProposalSchema = z.object({
  id: z.string().min(1),
  type: z.literal('integration_proposal'),
  integration_name: z.string().min(1),
  proposed_changes: z.unknown(),
  risks: z.unknown(),
  dependencies: z.unknown(),
  simulation_id: z.string().min(1),
  plan_id: z.string().optional(),
  attribution: z.unknown(),
  created_at: z.string().datetime({ offset: true }),
});

type IntegrationProposal = z.infer<typeof createProposalSchema>;
type IntegrationProposalRow = Omit<IntegrationProposal, 'created_at'> & { created_at: string | Date };

function serializeRow(row: IntegrationProposalRow): IntegrationProposal {
  return { ...row, created_at: new Date(row.created_at).toISOString() };
}

export async function createIntegrationProposalHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  try {
    const data = createProposalSchema.parse(req.body);
    const result = await dbClient.query<{ id: string }>(
      `INSERT INTO integration_proposals
         (id, type, integration_name, proposed_changes, risks, dependencies,
          simulation_id, plan_id, attribution, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        data.id,
        data.type,
        data.integration_name,
        JSON.stringify(data.proposed_changes),
        JSON.stringify(data.risks),
        JSON.stringify(data.dependencies),
        data.simulation_id,
        data.plan_id ?? null,
        JSON.stringify(data.attribution),
        data.created_at,
      ]
    );

    if (result.rowCount === 0) {
      res.status(409).json({
        error: 'immutable_conflict',
        message: `Integration proposal ${data.id} already exists`,
        execution_metadata: executionMetadata,
      });
      return;
    }

    logger.info({ traceId: executionMetadata.trace_id, proposalId: data.id }, 'Integration proposal stored');
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
    logger.error({ error }, 'Failed to store integration proposal');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store integration proposal',
      execution_metadata: executionMetadata,
    });
  }
}

export async function listIntegrationProposalsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const executionMetadata = buildExecutionMetadata(req);
  const simulationId = typeof req.query.simulation_id === 'string' ? req.query.simulation_id : undefined;

  try {
    const result = simulationId
      ? await dbClient.query<IntegrationProposalRow>(
          `SELECT id, type, integration_name, proposed_changes, risks, dependencies,
                  simulation_id, plan_id, attribution, created_at
           FROM integration_proposals WHERE simulation_id = $1
           ORDER BY created_at ASC, id ASC`,
          [simulationId]
        )
      : await dbClient.query<IntegrationProposalRow>(
          `SELECT id, type, integration_name, proposed_changes, risks, dependencies,
                  simulation_id, plan_id, attribution, created_at
           FROM integration_proposals ORDER BY created_at ASC, id ASC`
        );

    res.status(200).json({
      proposals: result.rows.map(serializeRow),
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    logger.error({ error, simulationId }, 'Failed to list integration proposals');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list integration proposals',
      execution_metadata: executionMetadata,
    });
  }
}
