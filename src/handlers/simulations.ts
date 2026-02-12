/**
 * POST /v1/simulations — Execution Authority Minting Gate
 *
 * Bounded Context: Execution Authority
 * ruvvector-service is the sole execution authority.
 *
 * This endpoint ONLY mints execution authority.
 * It does NOT validate enterprise policy, compute cost, or run simulation logic.
 * Authority first. Enterprise validation happens downstream.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { AcceptanceResponse, AuthoritySpan } from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import {
  mintExecutionId,
  generateRootSpanId,
} from '../utils/executionAuthority';
import {
  simulationAcceptanceTotal,
  simulationAcceptanceDuration,
} from '../utils/metrics';

// ============================================================================
// AcceptanceRequestSchema
// ============================================================================

export const acceptanceRequestSchema = z.object({
  intent_description: z.string().min(1).max(2000),
  caller_id: z.string().min(1).max(255).optional(),
  org_id: z.string().min(1).max(255).optional(),
  simulation_type: z.string().min(1).max(100).optional(),
  simulation_context: z.record(z.unknown()).optional(),
});

// ============================================================================
// POST /v1/simulations — Mint execution authority
// ============================================================================

export async function acceptSimulationHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  const startTime = Date.now();

  try {
    // Validate — only intent_description is required
    const validatedData = acceptanceRequestSchema.parse(req.body);

    const {
      intent_description,
      caller_id,
      org_id,
      simulation_type,
      simulation_context,
    } = validatedData;

    // Mint canonical execution_id
    const executionId = mintExecutionId();
    const rootSpanId = generateRootSpanId();
    const now = new Date().toISOString();

    // Create ROOT authority span
    const rootSpan: AuthoritySpan = {
      span_id: rootSpanId,
      type: 'authority',
      origin: 'ruvector-service',
      parent: null,
      created_at: now,
    };

    // Persist lineage seed
    const lineageSeed = {
      root_span: rootSpan,
      intent_description,
      ...(caller_id && { caller_id }),
      ...(org_id && { org_id }),
      ...(simulation_context && { simulation_context }),
    };

    await dbClient.query(
      `INSERT INTO executions (execution_id, accepted, reason, caller_id, org_id,
                               simulation_type, simulation_context, authority_signature,
                               root_span_id, lineage, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        executionId,
        true,
        null,
        caller_id || null,
        org_id || null,
        simulation_type || null,
        JSON.stringify(simulation_context || {}),
        'authority-mint',
        rootSpanId,
        JSON.stringify(lineageSeed),
        null,
        now,
      ]
    );

    // Record metrics
    simulationAcceptanceTotal.inc({ status: 'accepted' });
    const duration = (Date.now() - startTime) / 1000;
    simulationAcceptanceDuration.observe(duration);

    logger.info(
      {
        correlationId,
        executionId,
        rootSpanId,
        durationMs: Date.now() - startTime,
      },
      'Execution authority minted'
    );

    const response: AcceptanceResponse = {
      execution_id: executionId,
      parent_span_id: rootSpanId,
      authority: 'ruvector-service',
      accepted: true,
      timestamp: now,
    };

    res.status(200).json(response);
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    simulationAcceptanceDuration.observe(duration);

    if (error instanceof z.ZodError) {
      simulationAcceptanceTotal.inc({ status: 'rejected' });

      logger.warn({ correlationId, errors: error.errors }, 'Acceptance validation failed');
      res.status(400).json({
        error: 'validation_error',
        message: 'intent_description is required',
        correlationId,
        details: error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    // FAIL CLOSED: lineage persistence failure → no execution authority exists
    logger.error({ correlationId, error }, 'Lineage persistence failed');
    res.status(500).json({
      error: 'internal_error',
      message: 'Lineage persistence failed',
      correlationId,
    });
  }
}

export default {
  acceptSimulationHandler,
  acceptanceRequestSchema,
};
