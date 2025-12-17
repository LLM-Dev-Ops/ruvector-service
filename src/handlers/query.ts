import { Request, Response } from 'express';
import { QueryRequest, QueryResponse, QueryResult } from '../types';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';
import { ruvvectorUpstreamErrorsTotal } from '../utils/metrics';
import { AppError } from '../middleware/errorHandler';

/**
 * Handler for POST /query
 * SPARC: Retrieve historical events and vector state based on query parameters
 *
 * Boundaries (per SPARC):
 * - Does NOT implement complex aggregations
 * - Does NOT cache results
 * - Does NOT implement query optimization beyond parameter pass-through
 * - Does NOT join across data sources
 */
export async function queryHandler(
  req: Request,
  res: Response,
  vectorClient: VectorClient
): Promise<void> {
  const startTime = Date.now();
  const correlationId = req.correlationId;
  const body = req.body as QueryRequest;

  try {
    // Set defaults per SPARC
    const limit = body.limit ?? 100;
    const offset = body.offset ?? 0;

    logger.info(
      {
        correlationId,
        tenant: req.entitlement?.tenant,
        hasQueryVector: !!body.queryVector,
        limit,
        offset,
        endpoint: '/query'
      },
      'Processing query request'
    );

    // SPARC Step 3: Build vector query
    // SPARC Step 4: Execute query against RuvVector
    const result = await vectorClient.query({
      vector: body.queryVector ?? undefined,
      filters: body.filters,
      timeRange: body.timeRange,
      limit,
      offset,
    });

    const queryTime = Date.now() - startTime;

    // Transform results to API format per SPARC response spec
    const results: QueryResult[] = result.items.map(item => ({
      eventId: item.id,
      similarity: item.score ?? null,
      timestamp: (item.metadata as any)?.timestamp || new Date().toISOString(),
      payload: item.payload,
      metadata: item.metadata,
    }));

    // SPARC Step 5: Return results
    const response: QueryResponse = {
      results,
      pagination: {
        total: result.total,
        limit,
        offset,
        hasMore: result.total > (offset + limit),
      },
      metadata: {
        correlationId,
        queryTime,
      },
    };

    logger.info(
      { correlationId, resultCount: results.length, total: result.total, queryTime },
      'Query completed successfully'
    );

    res.status(200).json(response);
  } catch (error) {
    // SPARC: logError('Vector query failed', error, headers['x-correlation-id'])
    logger.error({ correlationId, error }, 'Vector query failed');

    // Track upstream error metric
    ruvvectorUpstreamErrorsTotal.inc({ type: 'query_failed' });

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

export default queryHandler;
