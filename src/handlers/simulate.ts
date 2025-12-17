import { Request, Response } from 'express';
import { SimulateRequest, SimulateResponse, SimulateResult, SimulateNeighbor } from '../types';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';
import { ruvvectorUpstreamErrorsTotal } from '../utils/metrics';
import { AppError } from '../middleware/errorHandler';

/**
 * Handler for POST /simulate
 * SPARC: Trigger or coordinate simulation queries against the vector store
 *
 * Boundaries (per SPARC):
 * - Does NOT implement simulation logic (pass-through to RuvVector)
 * - Does NOT persist simulation results
 * - Does NOT orchestrate multi-step simulations
 * - Does NOT evaluate business conditions
 */
export async function simulateHandler(
  req: Request,
  res: Response,
  vectorClient: VectorClient
): Promise<void> {
  const startTime = Date.now();
  const correlationId = req.correlationId;
  const body = req.body as SimulateRequest;

  try {
    // Set defaults per SPARC
    const nearestNeighbors = body.nearestNeighbors ?? 10;
    const similarityThreshold = body.similarityThreshold ?? 0.0;
    const includeMetadata = body.includeMetadata ?? true;
    const includeVectors = body.includeVectors ?? false;

    logger.info(
      {
        correlationId,
        tenant: req.entitlement?.tenant,
        contextVectorCount: body.contextVectors.length,
        nearestNeighbors,
        similarityThreshold,
        endpoint: '/simulate'
      },
      'Processing simulate request'
    );

    // SPARC Step 3: Build simulation query
    // SPARC Step 4: Execute simulation query
    const vectorResult = await vectorClient.similarity({
      contextVectors: body.contextVectors,
      k: nearestNeighbors,
      threshold: similarityThreshold,
      includeMetadata,
    });

    // SPARC Step 5: Return simulation results
    // Transform results to API format per SPARC response spec
    const results: SimulateResult[] = body.contextVectors.map((_, contextIndex) => {
      const neighbors: SimulateNeighbor[] = vectorResult.neighbors.map(neighbor => ({
        eventId: neighbor.id,
        similarity: neighbor.score,
        vector: includeVectors ? (neighbor.vector ?? null) : undefined,
        payload: neighbor.payload,
        metadata: includeMetadata ? (neighbor.metadata ?? null) : undefined,
      }));

      return {
        contextIndex,
        neighbors,
      };
    });

    const executionTime = Date.now() - startTime;

    const response: SimulateResponse = {
      results,
      execution: {
        vectorsProcessed: vectorResult.processed,
        executionTime,
        correlationId,
      },
    };

    logger.info(
      { correlationId, vectorsProcessed: vectorResult.processed, executionTime },
      'Simulate completed successfully'
    );

    res.status(200).json(response);
  } catch (error) {
    // SPARC: logError('Simulation query failed', error, headers['x-correlation-id'])
    logger.error({ correlationId, error }, 'Simulation query failed');

    // Track upstream error metric
    ruvvectorUpstreamErrorsTotal.inc({ type: 'simulate_failed' });

    // SPARC: RETURN error(502, 'Upstream service error')
    if (error instanceof Error) {
      if (error.message.includes('Circuit breaker')) {
        throw new AppError(503, 'service_unavailable', 'Service temporarily unavailable');
      }
      throw new AppError(502, 'upstream_error', 'Upstream service error');
    }
    throw error;
  }
}

export default simulateHandler;
