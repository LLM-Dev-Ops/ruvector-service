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
import { DatabaseClient } from '../clients/DatabaseClient';
import {
  AcceptanceRequestSchema,
  AuthoritySpanSchema,
  LineageSeedSchema,
  validateContract,
  validateSpanIntegrity,
  ContractViolationError,
} from '../contracts';
import type { AcceptanceResponse, AuthoritySpan } from '../types';
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
// Payload Normalization
// ============================================================================

/**
 * Normalize incoming payload into canonical shape BEFORE validation.
 * agentics-cli may send the intent string under different field names.
 *
 * Priority: intent_description > intent > scenario > description
 */
export function normalizePayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.intent_description) return body;

  const intentValue = body.intent ?? body.scenario ?? body.description;
  if (intentValue !== undefined) {
    const { intent, scenario, description, ...rest } = body as Record<string, unknown>;
    return { ...rest, intent_description: intentValue };
  }

  return body;
}

// Re-export contract schema for backwards compatibility
export const acceptanceRequestSchema = AcceptanceRequestSchema;

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
    // Normalize — map intent/scenario/description → intent_description
    const normalized = normalizePayload(req.body || {});

    // MANDATORY: Runtime validation against contracts schema
    const validatedData = validateContract(AcceptanceRequestSchema, normalized);

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
      origin: 'ruvvector-service',
      parent: null,
      created_at: now,
    };

    // SPAN INTEGRITY: Validate authority span against contract schema
    validateContract(AuthoritySpanSchema, rootSpan);
    validateSpanIntegrity({
      span_id: rootSpan.span_id,
      parent_span_id: rootSpan.parent,
    });

    // Persist lineage seed — contract-aligned structure
    const lineageSeed = {
      root_span: rootSpan,
      intent_description,
      ...(caller_id && { caller_id }),
      ...(org_id && { org_id }),
      ...(simulation_context && { simulation_context }),
    };

    // LINEAGE STORAGE: Validate lineage seed against contract schema before storage
    validateContract(LineageSeedSchema, lineageSeed);

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
        repo_name: 'ruvvector-service',
        durationMs: Date.now() - startTime,
      },
      'Execution authority minted'
    );

    const response: AcceptanceResponse = {
      execution_id: executionId,
      parent_span_id: rootSpanId,
      authority: 'ruvvector-service',
      accepted: true,
      timestamp: now,
    };

    res.status(200).json(response);
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    simulationAcceptanceDuration.observe(duration);

    if (error instanceof ContractViolationError) {
      simulationAcceptanceTotal.inc({ status: 'rejected' });

      logger.warn({ correlationId, errors: error.details }, 'Acceptance contract violation');
      res.status(400).json({
        error: 'contract_violation',
        message: error.message,
        correlationId,
        details: error.details,
      });
      return;
    }

    // FAIL CLOSED: lineage persistence failure → no execution authority exists
    logger.error({ correlationId, error, repo_name: 'ruvvector-service' }, 'Lineage persistence failed');
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
