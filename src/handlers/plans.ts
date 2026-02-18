/**
 * Plans API Handlers for Cloud Run Service
 * Implements CRUD operations for RuvectorPlan storage in PostgreSQL
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import { RuvectorPlan } from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import { buildExecutionMetadata } from '../utils/executionMetadata';
import { firePlanStoredHooks } from '../utils/hooks';

// Validation schema for creating a plan
export const createPlanSchema = z.object({
  id: z.string().uuid(),
  intent: z.string().min(1),
  plan: z.record(z.unknown()),
  org_id: z.string().min(1),
  user_id: z.string().min(1),
  checksum: z.string().length(64),
});

/**
 * POST /v1/plans - Store a new plan
 */
export async function createPlanHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createPlanSchema.parse(req.body);

    const { id, intent, plan, org_id, user_id, checksum } = validatedData;

    // Insert plan into database
    await dbClient.query(
      `INSERT INTO plans (id, type, intent, plan, org_id, user_id, checksum, created_at)
       VALUES ($1, 'plan', $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         intent = EXCLUDED.intent,
         plan = EXCLUDED.plan,
         org_id = EXCLUDED.org_id,
         user_id = EXCLUDED.user_id,
         checksum = EXCLUDED.checksum`,
      [id, intent, JSON.stringify(plan), org_id, user_id, checksum]
    );

    logger.info({ correlationId, planId: id, orgId: org_id }, 'Plan stored successfully');

    const executionMetadata = buildExecutionMetadata(req);

    // Fire non-blocking post-store hooks to core bundles
    firePlanStoredHooks(
      { plan_id: id, intent, org_id, checksum, plan },
      executionMetadata.trace_id
    );

    res.status(201).json({
      accepted: true,
      id,
      timestamp: executionMetadata.timestamp,
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Plan validation failed');
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

    logger.error({ correlationId, error }, 'Failed to store plan');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store plan',
      correlationId,
    });
  }
}

/**
 * GET /v1/plans/:id - Retrieve a plan by ID
 */
export async function getPlanHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { id } = req.params;

    // Validate UUID format
    if (!z.string().uuid().safeParse(id).success) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Invalid plan ID format (must be UUID)',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query<RuvectorPlan>(
      `SELECT id, type, intent, plan, created_at, org_id, user_id, checksum
       FROM plans WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Plan with ID ${id} not found`,
        correlationId,
      });
      return;
    }

    const plan = result.rows[0];

    // Format response
    const response: RuvectorPlan = {
      id: plan.id,
      type: 'plan',
      intent: plan.intent,
      plan: plan.plan,
      created_at: new Date(plan.created_at).toISOString(),
      org_id: plan.org_id,
      user_id: plan.user_id,
      checksum: plan.checksum,
    };

    logger.info({ correlationId, planId: id }, 'Plan retrieved successfully');
    res.status(200).json({
      ...response,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to retrieve plan');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve plan',
      correlationId,
    });
  }
}

/**
 * GET /v1/plans - List plans with optional filtering
 */
export async function listPlansHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { org_id, limit = '50' } = req.query;

    // Validate and sanitize limit
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 1000);

    let query: string;
    let params: unknown[];

    if (org_id && typeof org_id === 'string') {
      query = `SELECT id, type, intent, plan, created_at, org_id, user_id, checksum
               FROM plans WHERE org_id = $1
               ORDER BY created_at DESC LIMIT $2`;
      params = [org_id, parsedLimit];
    } else {
      query = `SELECT id, type, intent, plan, created_at, org_id, user_id, checksum
               FROM plans ORDER BY created_at DESC LIMIT $1`;
      params = [parsedLimit];
    }

    const result = await dbClient.query<RuvectorPlan>(query, params);

    const plans: RuvectorPlan[] = result.rows.map(row => ({
      id: row.id,
      type: 'plan',
      intent: row.intent,
      plan: row.plan,
      created_at: new Date(row.created_at).toISOString(),
      org_id: row.org_id,
      user_id: row.user_id,
      checksum: row.checksum,
    }));

    logger.info(
      { correlationId, orgId: org_id, count: plans.length },
      'Plans listed successfully'
    );

    // Get total count
    let countQuery: string;
    let countParams: unknown[];

    if (org_id && typeof org_id === 'string') {
      countQuery = `SELECT COUNT(*) as total FROM plans WHERE org_id = $1`;
      countParams = [org_id];
    } else {
      countQuery = `SELECT COUNT(*) as total FROM plans`;
      countParams = [];
    }

    const countResult = await dbClient.query<{ total: string }>(countQuery, countParams);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    res.status(200).json({
      plans,
      total,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to list plans');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list plans',
      correlationId,
    });
  }
}

/**
 * DELETE /v1/plans/:id - Delete a plan by ID
 */
export async function deletePlanHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { id } = req.params;

    // Validate UUID format
    if (!z.string().uuid().safeParse(id).success) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Invalid plan ID format (must be UUID)',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query(
      'DELETE FROM plans WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({
        error: 'not_found',
        message: `Plan with ID ${id} not found`,
        correlationId,
      });
      return;
    }

    logger.info({ correlationId, planId: id }, 'Plan deleted successfully');

    res.status(200).json({
      deleted: true,
      id,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to delete plan');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to delete plan',
      correlationId,
    });
  }
}

export default {
  createPlanHandler,
  getPlanHandler,
  listPlansHandler,
  deletePlanHandler,
  createPlanSchema,
};
