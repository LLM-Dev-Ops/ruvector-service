import { Request, Response } from 'express';
import { IngestRequest, IngestResponse } from '../types';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';
import { ruvvectorUpstreamErrorsTotal } from '../utils/metrics';
import { AppError } from '../middleware/errorHandler';

/**
 * Handler for POST /ingest
 * SPARC: Accept normalized event payloads and persist to vector storage
 *
 * Boundaries (per SPARC):
 * - Does NOT validate business rules
 * - Does NOT transform events beyond normalization verification
 * - Does NOT batch or aggregate events
 * - Does NOT implement retry logic (caller responsibility)
 */
export async function ingestHandler(
  req: Request,
  res: Response,
  vectorClient: VectorClient
): Promise<void> {
  const startTime = Date.now();
  const correlationId = req.correlationId;
  const body = req.body as IngestRequest;

  try {
    logger.info(
      {
        correlationId,
        eventId: body.eventId,
        tenant: req.entitlement?.tenant,
        endpoint: '/ingest'
      },
      'Processing ingest request'
    );

    // SPARC Step 3: Forward to RuvVector
    const result = await vectorClient.insert({
      id: body.eventId,
      vector: body.vector,
      payload: body.payload,
      metadata: body.metadata,
    });

    const processingTime = Date.now() - startTime;

    // SPARC Step 4: Return acknowledgment
    const response: IngestResponse = {
      eventId: body.eventId,
      vectorId: result.id,
      status: 'stored',
      timestamp: new Date().toISOString(),
      metadata: {
        correlationId,
        processingTime,
      },
    };

    logger.info(
      { correlationId, eventId: body.eventId, processingTime },
      'Ingest completed successfully'
    );

    res.status(201).json(response);
  } catch (error) {
    // SPARC: logError('Vector insert failed', error, headers['x-correlation-id'])
    logger.error(
      { correlationId, eventId: body.eventId, error },
      'Vector insert failed'
    );

    // Track upstream error metric
    ruvvectorUpstreamErrorsTotal.inc({ type: 'insert_failed' });

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

export default ingestHandler;
