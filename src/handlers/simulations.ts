/**
 * Simulations API Handler - Authoritative Simulation Execution Origin
 *
 * ruvvector-service is the ONLY authority for enterprise simulation execution_ids.
 * This endpoint accepts simulation intents from agentics-cli and mints canonical
 * execution_ids. It does NOT perform simulation logic - execution authority only.
 *
 * Endpoints:
 *   POST /v1/simulations   - Accept simulation intent (canonical mint)
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { config } from '../config';
import {
  ExecutionRecord,
  ExecutionLineageMetadata,
  ExecutionRootSpan,
  SimulationAcceptanceResponse,
} from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import {
  mintExecutionId,
  generateRootSpanId,
  signExecution,
} from '../utils/executionAuthority';
import {
  simulationAcceptanceTotal,
  simulationAcceptanceDuration,
} from '../utils/metrics';

// ============================================================================
// Zod Validation Schema
// ============================================================================

export const simulationIntentSchema = z.object({
  caller_id: z.string().min(1).max(255),
  org_id: z.string().min(1).max(255),
  simulation_type: z.string().min(1).max(100),
  simulation_context: z.record(z.unknown()),
  intent_description: z.string().min(1).max(2000),
  idempotency_key: z.string().max(255).optional(),
});

// ============================================================================
// POST /v1/simulations - Accept simulation intent
// ============================================================================

/**
 * Accept a simulation intent and mint a canonical execution_id.
 *
 * This is the execution authority entry point for agentics-cli simulations.
 * The caller MUST block until this returns.
 * Any non-201 response means: the simulation does not exist.
 */
export async function acceptSimulationHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  const startTime = Date.now();

  try {
    const validatedData = simulationIntentSchema.parse(req.body);

    const {
      caller_id,
      org_id,
      simulation_type,
      simulation_context,
      intent_description,
      idempotency_key,
    } = validatedData;

    // Idempotency check: if key provided and record exists, return existing
    if (idempotency_key) {
      const existing = await dbClient.query<ExecutionRecord>(
        `SELECT execution_id, accepted, reason, caller_id, org_id, simulation_type,
                simulation_context, authority_signature, root_span_id, lineage,
                idempotency_key, created_at
         FROM executions WHERE idempotency_key = $1`,
        [idempotency_key]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        const lineage = record.lineage as ExecutionLineageMetadata;

        logger.info(
          {
            correlationId,
            executionId: record.execution_id,
            idempotencyKey: idempotency_key,
          },
          'Idempotent simulation acceptance: returning existing record'
        );

        const response: SimulationAcceptanceResponse = {
          execution_id: record.execution_id,
          accepted: record.accepted,
          parent_span_id: lineage.root_span.span_id,
          authority_signature: record.authority_signature,
          lineage,
          created_at: record.created_at,
        };

        res.status(200).json(response);
        return;
      }
    }

    // Mint canonical execution_id
    const executionId = mintExecutionId();
    const rootSpanId = generateRootSpanId();
    const now = new Date().toISOString();

    // Sign the execution acceptance
    const authoritySignature = signExecution(
      executionId,
      now,
      config.execution.hmacSecret
    );

    // Build root execution span
    const rootSpan: ExecutionRootSpan = {
      span_id: rootSpanId,
      type: 'execution_root',
      parent_span_id: null,
      created_at: now,
    };

    // Build lineage metadata (merge intent_description into simulation_context)
    const enrichedContext = {
      ...simulation_context,
      intent_description,
    };

    const lineage: ExecutionLineageMetadata = {
      origin_service: 'ruvvector-service',
      origin_version: '1.0.0',
      acceptance_timestamp: now,
      root_span: rootSpan,
      caller_id,
      org_id,
      simulation_context: enrichedContext,
    };

    // INSERT into executions table (append-only)
    await dbClient.query(
      `INSERT INTO executions (execution_id, accepted, reason, caller_id, org_id,
                               simulation_type, simulation_context, authority_signature,
                               root_span_id, lineage, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        executionId,
        true,
        null,
        caller_id,
        org_id,
        simulation_type,
        JSON.stringify(enrichedContext),
        authoritySignature,
        rootSpanId,
        JSON.stringify(lineage),
        idempotency_key || null,
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
        callerId: caller_id,
        orgId: org_id,
        simulationType: simulation_type,
        rootSpanId,
        parentSpanId: rootSpanId,
        durationMs: Date.now() - startTime,
      },
      'Simulation intent accepted - canonical execution_id minted'
    );

    const response: SimulationAcceptanceResponse = {
      execution_id: executionId,
      accepted: true,
      parent_span_id: rootSpanId,
      authority_signature: authoritySignature,
      lineage,
      created_at: now,
    };

    res.status(201).json(response);
  } catch (error) {
    // Record duration on all paths
    const duration = (Date.now() - startTime) / 1000;
    simulationAcceptanceDuration.observe(duration);

    if (error instanceof z.ZodError) {
      simulationAcceptanceTotal.inc({ status: 'rejected' });

      logger.warn({ correlationId, errors: error.errors }, 'Simulation intent validation failed');
      res.status(400).json({
        error: 'validation_error',
        message: 'Request validation failed',
        correlationId,
        details: error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    // FAIL CLOSED: any non-validation error returns 500
    // If lineage storage is unavailable, the simulation MUST NOT exist.
    logger.error({ correlationId, error }, 'Failed to process simulation acceptance');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process simulation acceptance',
      correlationId,
    });
  }
}

export default {
  acceptSimulationHandler,
  simulationIntentSchema,
};
