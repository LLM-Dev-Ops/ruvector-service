import { Request, Response } from 'express';
import { HealthResponse, ReadyResponse } from '../types';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';

/**
 * Handler for GET /health
 * SPARC: Basic liveness probe
 *
 * Returns 200 when service is running
 */
export function healthHandler(_req: Request, res: Response): void {
  // SPARC: RETURN success(200, { status: 'healthy', timestamp: NOW() })
  const response: HealthResponse = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(response);
}

/**
 * Handler for GET /ready
 * SPARC: Readiness probe that checks upstream dependencies
 *
 * Uses vectorClient.ping() to verify RuvVector connectivity
 */
export async function readyHandler(
  _req: Request,
  res: Response,
  vectorClient: VectorClient
): Promise<void> {
  try {
    // SPARC: Check upstream dependencies - vectorClient.ping()
    const ruvvectorConnected = await vectorClient.ping();

    if (ruvvectorConnected) {
      // SPARC: RETURN success(200, { status: 'ready', dependencies: { ruvvector: 'connected' } })
      const response: ReadyResponse = {
        status: 'ready',
        dependencies: {
          ruvvector: 'connected',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(200).json(response);
    } else {
      // SPARC: RETURN error(503, { status: 'not ready', dependencies: { ruvvector: 'disconnected' } })
      logger.warn('Service not ready - RuvVector connection failed');
      const response: ReadyResponse = {
        status: 'not ready',
        dependencies: {
          ruvvector: 'disconnected',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(503).json(response);
    }
  } catch (error) {
    logger.error({ error }, 'Readiness check failed');

    const response: ReadyResponse = {
      status: 'not ready',
      dependencies: {
        ruvvector: 'disconnected',
      },
      timestamp: new Date().toISOString(),
    };

    res.status(503).json(response);
  }
}

export default { healthHandler, readyHandler };
