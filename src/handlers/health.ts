import { Request, Response } from 'express';
import { HealthResponse, ReadyResponse } from '../types';
import { VectorClient } from '../clients/VectorClient';
import { DatabaseClient } from '../clients/DatabaseClient';
import logger from '../utils/logger';

/**
 * Handler for GET /health
 * Includes database connectivity check for Cloud Run
 *
 * Returns 200 when service and database are healthy
 */
export async function healthHandler(
  _req: Request,
  res: Response,
  dbClient?: DatabaseClient
): Promise<void> {
  try {
    // Check database connectivity if client is provided
    if (dbClient) {
      const dbHealthy = await dbClient.ping();
      if (!dbHealthy) {
        logger.warn('Health check failed - database not connected');
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          database: 'disconnected',
        });
        return;
      }
    }

    const response: HealthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error({ error }, 'Health check failed');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
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
