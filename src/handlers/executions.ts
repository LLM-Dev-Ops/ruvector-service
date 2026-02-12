/**
 * Executions API Handlers - Authoritative Execution Origin
 *
 * ruvvector-service is the ONLY authority for enterprise simulation execution_ids.
 * No simulation may proceed without a synchronous acceptance from this service.
 * If this service is unreachable, slow, or errors - the simulation MUST NOT exist.
 *
 * Endpoints:
 *   POST /v1/executions/accept   - Synchronous execution acceptance (canonical mint)
 *   GET  /v1/executions/:id      - Retrieve execution record
 *   GET  /v1/executions          - List executions
 *   POST /v1/executions/validate - Validate execution_id + signature
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { config } from '../config';
import {
  ExecutionRecord,
  ExecutionLineageMetadata,
  ExecutionRootSpan,
  AcceptExecutionResponse,
  ValidateExecutionResponse,
} from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import {
  mintExecutionId,
  generateRootSpanId,
  signExecution,
  verifyExecutionSignature,
} from '../utils/executionAuthority';
import {
  executionAcceptanceTotal,
  executionAcceptanceDuration,
  executionValidationTotal,
} from '../utils/metrics';

// ============================================================================
// Zod Validation Schemas
// ============================================================================

export const acceptExecutionSchema = z.object({
  caller_id: z.string().min(1).max(255),
  org_id: z.string().min(1).max(255),
  simulation_type: z.string().min(1).max(100),
  simulation_context: z.record(z.unknown()),
  idempotency_key: z.string().max(255).optional(),
});

export const validateExecutionSchema = z.object({
  execution_id: z.string().min(1),
  authority_signature: z.string().min(1),
});

// ============================================================================
// POST /v1/executions/accept - Synchronous execution acceptance
// ============================================================================

/**
 * Accept an execution request and mint a canonical execution_id.
 *
 * This is the ONLY way to obtain a valid execution_id.
 * The caller MUST block until this returns.
 * Any non-201 response means: the simulation does not exist.
 */
export async function acceptExecutionHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  const startTime = Date.now();

  try {
    const validatedData = acceptExecutionSchema.parse(req.body);

    const {
      caller_id,
      org_id,
      simulation_type,
      simulation_context,
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

        logger.info(
          {
            correlationId,
            executionId: record.execution_id,
            idempotencyKey: idempotency_key,
          },
          'Idempotent execution acceptance: returning existing record'
        );

        const response: AcceptExecutionResponse = {
          execution_id: record.execution_id,
          accepted: record.accepted,
          reason: record.reason,
          authority_signature: record.authority_signature,
          lineage: record.lineage as ExecutionLineageMetadata,
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

    // Build lineage metadata
    const lineage: ExecutionLineageMetadata = {
      origin_service: 'ruvvector-service',
      origin_version: '1.0.0',
      acceptance_timestamp: now,
      root_span: rootSpan,
      caller_id,
      org_id,
      simulation_context,
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
        JSON.stringify(simulation_context),
        authoritySignature,
        rootSpanId,
        JSON.stringify(lineage),
        idempotency_key || null,
        now,
      ]
    );

    // Record metrics
    executionAcceptanceTotal.inc({ status: 'accepted' });
    const duration = (Date.now() - startTime) / 1000;
    executionAcceptanceDuration.observe(duration);

    logger.info(
      {
        correlationId,
        executionId,
        callerId: caller_id,
        orgId: org_id,
        simulationType: simulation_type,
        rootSpanId,
        durationMs: Date.now() - startTime,
      },
      'Execution accepted - canonical execution_id minted'
    );

    const response: AcceptExecutionResponse = {
      execution_id: executionId,
      accepted: true,
      reason: null,
      authority_signature: authoritySignature,
      lineage,
      created_at: now,
    };

    res.status(201).json(response);
  } catch (error) {
    // Record rejection metric on validation errors
    const duration = (Date.now() - startTime) / 1000;
    executionAcceptanceDuration.observe(duration);

    if (error instanceof z.ZodError) {
      executionAcceptanceTotal.inc({ status: 'rejected' });

      logger.warn({ correlationId, errors: error.errors }, 'Execution acceptance validation failed');
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

    logger.error({ correlationId, error }, 'Failed to process execution acceptance');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to process execution acceptance',
      correlationId,
    });
  }
}

// ============================================================================
// GET /v1/executions/:id - Retrieve execution record
// ============================================================================

export async function getExecutionHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        error: 'validation_error',
        message: 'execution_id is required',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query<ExecutionRecord>(
      `SELECT execution_id, accepted, reason, caller_id, org_id, simulation_type,
              simulation_context, authority_signature, root_span_id, lineage,
              idempotency_key, created_at
       FROM executions WHERE execution_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Execution with ID ${id} not found`,
        correlationId,
      });
      return;
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to retrieve execution');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve execution',
      correlationId,
    });
  }
}

// ============================================================================
// GET /v1/executions - List executions
// ============================================================================

export async function listExecutionsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const {
      caller_id,
      org_id,
      status,
      limit = '50',
      offset = '0',
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 1000);
    const parsedOffset = Math.max(parseInt(offset as string, 10) || 0, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (caller_id) {
      params.push(caller_id);
      conditions.push(`caller_id = $${params.length}`);
    }

    if (org_id) {
      params.push(org_id);
      conditions.push(`org_id = $${params.length}`);
    }

    if (status === 'accepted' || status === 'rejected') {
      params.push(status === 'accepted');
      conditions.push(`accepted = $${params.length}`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Count total
    const countResult = await dbClient.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM executions ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch page
    const dataParams = [...params, parsedLimit, parsedOffset];
    const result = await dbClient.query<ExecutionRecord>(
      `SELECT execution_id, accepted, reason, caller_id, org_id, simulation_type,
              simulation_context, authority_signature, root_span_id, lineage,
              idempotency_key, created_at
       FROM executions ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.status(200).json({
      data: result.rows,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to list executions');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list executions',
      correlationId,
    });
  }
}

// ============================================================================
// POST /v1/executions/validate - Validate execution_id + authority signature
// ============================================================================

/**
 * Validate that an execution_id was genuinely minted by this service.
 * Downstream services use this to verify execution authority.
 */
export async function validateExecutionHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const validatedData = validateExecutionSchema.parse(req.body);

    const { execution_id, authority_signature } = validatedData;

    // Look up the execution record
    const result = await dbClient.query<ExecutionRecord>(
      `SELECT execution_id, authority_signature, created_at
       FROM executions WHERE execution_id = $1`,
      [execution_id]
    );

    if (result.rows.length === 0) {
      executionValidationTotal.inc({ result: 'not_found' });

      const response: ValidateExecutionResponse = {
        valid: false,
        execution_id,
        reason: 'execution_not_found',
      };
      res.status(200).json(response);
      return;
    }

    const record = result.rows[0];

    // Verify the signature by recomputing from stored data
    const isValid = verifyExecutionSignature(
      record.execution_id,
      record.created_at,
      authority_signature,
      config.execution.hmacSecret
    );

    if (isValid) {
      executionValidationTotal.inc({ result: 'valid' });
    } else {
      executionValidationTotal.inc({ result: 'invalid' });
    }

    const response: ValidateExecutionResponse = {
      valid: isValid,
      execution_id,
      reason: isValid ? null : 'signature_mismatch',
    };

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Execution validation request failed');
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

    logger.error({ correlationId, error }, 'Failed to validate execution');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to validate execution',
      correlationId,
    });
  }
}

export default {
  acceptExecutionHandler,
  getExecutionHandler,
  listExecutionsHandler,
  validateExecutionHandler,
  acceptExecutionSchema,
  validateExecutionSchema,
};
