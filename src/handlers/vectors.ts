/**
 * Vectors API Handlers
 *
 * POST /v1/vectors/store — Persist vector embeddings (agent persistence layer)
 *
 * Called by copilot-agents with RUVECTOR_NAMESPACE to store agent vector embeddings.
 */
import { Request, Response } from 'express';
import { DatabaseClient } from '../clients/DatabaseClient';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';
import { getOrCreateCorrelationId } from '../utils/correlation';
import { buildExecutionMetadata } from '../utils/executionMetadata';

interface VectorEntry {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

interface StoreVectorsRequest {
  namespace: string;
  vectors: VectorEntry[];
}

/**
 * POST /v1/vectors/store — Store vector embeddings
 *
 * Body: { namespace: string, vectors: Array<{ id, values, metadata? }> }
 * Response: { stored: number, ids: string[] }
 */
export async function storeVectorsHandler(
  req: Request,
  res: Response,
  _dbClient: DatabaseClient,
  vectorClient: VectorClient
): Promise<void> {
  const correlationId = getOrCreateCorrelationId(req.headers);
  res.setHeader('x-correlation-id', correlationId);

  try {
    const body = req.body as StoreVectorsRequest;

    // Validate required fields
    if (!body.namespace || typeof body.namespace !== 'string') {
      res.status(400).json({
        error: 'validation_error',
        message: 'namespace is required and must be a string',
        correlationId,
      });
      return;
    }

    if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
      res.status(400).json({
        error: 'validation_error',
        message: 'vectors is required and must be a non-empty array',
        correlationId,
      });
      return;
    }

    // Validate each vector entry
    for (const vec of body.vectors) {
      if (!vec.id || typeof vec.id !== 'string') {
        res.status(400).json({
          error: 'validation_error',
          message: 'Each vector must have a string id',
          correlationId,
        });
        return;
      }
      if (!Array.isArray(vec.values) || vec.values.length === 0) {
        res.status(400).json({
          error: 'validation_error',
          message: `Vector ${vec.id}: values must be a non-empty number array`,
          correlationId,
        });
        return;
      }
    }

    const storedIds: string[] = [];

    // VectorClient writes the archived JSONB copy and the searchable embedding
    // in one statement against this same database, so there is no second,
    // best-effort write to swallow — a failure here is a persistence failure.
    for (const vec of body.vectors) {
      await vectorClient.upsert(body.namespace, vec.id, vec.values, vec.metadata || {});
      storedIds.push(vec.id);
    }

    logger.info(
      {
        correlationId,
        namespace: body.namespace,
        stored: storedIds.length,
        repo_name: 'ruvvector-service',
      },
      'Vectors stored successfully'
    );

    res.status(200).json({
      stored: storedIds.length,
      ids: storedIds,
      execution_metadata: buildExecutionMetadata(req),
    });
  } catch (error) {
    logger.error({ correlationId, error, repo_name: 'ruvvector-service' }, 'Failed to store vectors');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to store vectors',
      correlationId,
    });
  }
}

export default { storeVectorsHandler };
