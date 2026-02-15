/**
 * Deployments API Handlers for Cloud Run Service
 * Implements CRUD operations for Deployment storage in PostgreSQL
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseClient } from '../clients/DatabaseClient';
import {
  Deployment,
  DeploymentEnvironment,
  DeploymentStatus,
} from '../types';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import { buildExecutionMetadata } from '../utils/executionMetadata';

// Valid enum values
const VALID_ENVIRONMENTS: DeploymentEnvironment[] = ['development', 'staging', 'production'];
const VALID_STATUSES: DeploymentStatus[] = ['pending', 'previewed', 'running', 'completed', 'failed', 'rolled_back'];

// Validation schema for preview change
const previewChangeSchema = z.object({
  resource: z.string(),
  action: z.enum(['create', 'update', 'delete', 'unchanged']),
  details: z.string(),
});

// Validation schema for preview
const previewSchema = z.object({
  changes: z.array(previewChangeSchema),
  estimated_duration_seconds: z.number(),
  risk_level: z.enum(['low', 'medium', 'high']),
  requires_approval: z.boolean(),
  generated_at: z.string(),
});

// Validation schema for execution
const executionSchema = z.object({
  started_at: z.string(),
  completed_at: z.string().optional(),
  steps_completed: z.number(),
  steps_total: z.number(),
  advisory: z.boolean(),
  logs: z.array(z.string()),
});

// Validation schema for creating a deployment
export const createDeploymentSchema = z.object({
  id: z.string().uuid(),
  target_id: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production']),
  status: z.enum(['pending', 'previewed', 'running', 'completed', 'failed', 'rolled_back']),
  preview: previewSchema.nullable().optional(),
  execution: executionSchema.nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  version: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// Validation schema for updating a deployment
export const updateDeploymentSchema = z.object({
  status: z.enum(['pending', 'previewed', 'running', 'completed', 'failed', 'rolled_back']).optional(),
  preview: previewSchema.nullable().optional(),
  execution: executionSchema.nullable().optional(),
  updated_at: z.string().optional(),
  version: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

/**
 * POST /v1/deployments - Store a new deployment
 */
export async function createDeploymentHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    // Validate request body
    const validatedData = createDeploymentSchema.parse(req.body);

    const {
      id,
      target_id,
      environment,
      status,
      preview,
      execution,
      created_at,
      updated_at,
      version,
      metadata,
    } = validatedData;

    // Use provided timestamps or default to now
    const now = new Date().toISOString();
    const createdAt = created_at || now;
    const updatedAt = updated_at || now;
    const versionNum = version || 1;

    // Insert deployment into database
    await dbClient.query(
      `INSERT INTO deployments (id, target_id, environment, status, preview, execution, created_at, updated_at, version, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         target_id = EXCLUDED.target_id,
         environment = EXCLUDED.environment,
         status = EXCLUDED.status,
         preview = EXCLUDED.preview,
         execution = EXCLUDED.execution,
         updated_at = EXCLUDED.updated_at,
         version = EXCLUDED.version,
         metadata = EXCLUDED.metadata`,
      [
        id,
        target_id,
        environment,
        status,
        preview ? JSON.stringify(preview) : null,
        execution ? JSON.stringify(execution) : null,
        createdAt,
        updatedAt,
        versionNum,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    logger.info({ correlationId, deploymentId: id, environment, status }, 'Deployment stored successfully');

    const executionMetadata = buildExecutionMetadata(req);

    res.status(201).json({
      accepted: true,
      id,
      timestamp: executionMetadata.timestamp,
      execution_metadata: executionMetadata,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Deployment validation failed');
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

    logger.error({ correlationId, error }, 'Failed to store deployment');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store deployment',
      correlationId,
    });
  }
}

/**
 * GET /v1/deployments/:id - Retrieve a deployment by ID
 */
export async function getDeploymentHandler(
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
        message: 'Invalid deployment ID format (must be UUID)',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query<Deployment>(
      `SELECT id, target_id, environment, status, preview, execution, created_at, updated_at, version, metadata
       FROM deployments WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Deployment not found',
        id,
      });
      return;
    }

    const row = result.rows[0];

    // Format response
    const deployment: Deployment = {
      id: row.id,
      target_id: row.target_id,
      environment: row.environment,
      status: row.status,
      preview: row.preview,
      execution: row.execution,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      version: row.version,
      metadata: row.metadata,
    };

    logger.info({ correlationId, deploymentId: id }, 'Deployment retrieved successfully');
    res.status(200).json({
      ...deployment,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to retrieve deployment');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to retrieve deployment',
      correlationId,
    });
  }
}

/**
 * PUT /v1/deployments/:id - Update a deployment
 */
export async function updateDeploymentHandler(
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
        message: 'Invalid deployment ID format (must be UUID)',
        correlationId,
      });
      return;
    }

    // Validate request body
    const validatedData = updateDeploymentSchema.parse(req.body);

    // Check if deployment exists and get current version
    const existingResult = await dbClient.query<Deployment>(
      'SELECT id, version FROM deployments WHERE id = $1',
      [id]
    );

    if (existingResult.rows.length === 0) {
      res.status(404).json({
        error: 'Deployment not found',
      });
      return;
    }

    const currentVersion = existingResult.rows[0].version;

    // Check for version conflict (optimistic locking)
    if (validatedData.version !== undefined && validatedData.version !== currentVersion + 1) {
      res.status(409).json({
        error: 'Version conflict',
        current_version: currentVersion,
        requested_version: validatedData.version,
      });
      return;
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (validatedData.status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      params.push(validatedData.status);
      paramIndex++;
    }

    if (validatedData.preview !== undefined) {
      updates.push(`preview = $${paramIndex}`);
      params.push(validatedData.preview ? JSON.stringify(validatedData.preview) : null);
      paramIndex++;
    }

    if (validatedData.execution !== undefined) {
      updates.push(`execution = $${paramIndex}`);
      params.push(validatedData.execution ? JSON.stringify(validatedData.execution) : null);
      paramIndex++;
    }

    if (validatedData.metadata !== undefined) {
      updates.push(`metadata = $${paramIndex}`);
      params.push(validatedData.metadata ? JSON.stringify(validatedData.metadata) : null);
      paramIndex++;
    }

    // Always update updated_at and increment version
    const updatedAt = validatedData.updated_at || new Date().toISOString();
    updates.push(`updated_at = $${paramIndex}`);
    params.push(updatedAt);
    paramIndex++;

    updates.push(`version = $${paramIndex}`);
    const newVersion = validatedData.version || currentVersion + 1;
    params.push(newVersion);
    paramIndex++;

    // Add the ID as the last parameter
    params.push(id);

    const updateQuery = `
      UPDATE deployments
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, target_id, environment, status, preview, execution, created_at, updated_at, version, metadata
    `;

    const result = await dbClient.query<Deployment>(updateQuery, params);

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Deployment not found',
      });
      return;
    }

    const row = result.rows[0];

    // Format response
    const deployment: Deployment = {
      id: row.id,
      target_id: row.target_id,
      environment: row.environment,
      status: row.status,
      preview: row.preview,
      execution: row.execution,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      version: row.version,
      metadata: row.metadata,
    };

    logger.info({ correlationId, deploymentId: id, newVersion: deployment.version }, 'Deployment updated successfully');
    res.status(200).json({
      updated: true,
      id,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn({ correlationId, errors: error.errors }, 'Deployment update validation failed');
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

    logger.error({ correlationId, error }, 'Failed to update deployment');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to update deployment',
      correlationId,
    });
  }
}

/**
 * GET /v1/deployments - List deployments with optional filtering
 */
export async function listDeploymentsHandler(
  req: Request,
  res: Response,
  dbClient: DatabaseClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const { environment, status, limit = '50', offset = '0' } = req.query;

    // Validate and sanitize pagination
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 1000);
    const parsedOffset = Math.max(parseInt(offset as string, 10) || 0, 0);

    // Validate environment if provided
    if (environment && typeof environment === 'string' && !VALID_ENVIRONMENTS.includes(environment as DeploymentEnvironment)) {
      res.status(400).json({
        error: 'validation_error',
        message: `Invalid environment. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
        correlationId,
      });
      return;
    }

    // Validate status if provided
    if (status && typeof status === 'string' && !VALID_STATUSES.includes(status as DeploymentStatus)) {
      res.status(400).json({
        error: 'validation_error',
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        correlationId,
      });
      return;
    }

    // Build query with filters
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (environment && typeof environment === 'string') {
      conditions.push(`environment = $${paramIndex}`);
      params.push(environment);
      paramIndex++;
    }

    if (status && typeof status === 'string') {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM deployments ${whereClause}`;
    const countResult = await dbClient.query<{ total: string }>(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    // Get deployments with pagination
    const selectQuery = `
      SELECT id, target_id, environment, status, preview, execution, created_at, updated_at, version, metadata
      FROM deployments
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(parsedLimit, parsedOffset);

    const result = await dbClient.query<Deployment>(selectQuery, params);

    const deployments: Deployment[] = result.rows.map(row => ({
      id: row.id,
      target_id: row.target_id,
      environment: row.environment,
      status: row.status,
      preview: row.preview,
      execution: row.execution,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      version: row.version,
      metadata: row.metadata,
    }));

    logger.info(
      { correlationId, environment, status, count: deployments.length, total },
      'Deployments listed successfully'
    );

    res.status(200).json({
      deployments,
      total,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to list deployments');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list deployments',
      correlationId,
    });
  }
}

/**
 * DELETE /v1/deployments/:id - Delete a deployment by ID
 */
export async function deleteDeploymentHandler(
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
        message: 'Invalid deployment ID format (must be UUID)',
        correlationId,
      });
      return;
    }

    const result = await dbClient.query(
      'DELETE FROM deployments WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({
        error: 'Deployment not found',
      });
      return;
    }

    logger.info({ correlationId, deploymentId: id }, 'Deployment deleted successfully');

    res.status(200).json({
      deleted: true,
      id,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error }, 'Failed to delete deployment');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to delete deployment',
      correlationId,
    });
  }
}

export default {
  createDeploymentHandler,
  getDeploymentHandler,
  updateDeploymentHandler,
  listDeploymentsHandler,
  deleteDeploymentHandler,
  createDeploymentSchema,
  updateDeploymentSchema,
};
