import { Request, Response } from 'express';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';

/**
 * Response body for GET /metadata
 */
interface MetadataResponse {
  service: string;
  version: string;
  endpoints: string[];
  connected: boolean;
  timestamp: string;
}

/**
 * Handler for GET /metadata
 * SPARC: Service metadata and capability discovery
 *
 * Returns information about the service and its capabilities
 */
export async function metadataHandler(
  req: Request,
  res: Response,
  vectorClient: VectorClient
): Promise<void> {
  const correlationId = req.correlationId || 'system';

  logger.info(
    {
      correlationId,
      endpoint: '/metadata'
    },
    'Processing metadata request'
  );

  // TODO: Enhance with dynamic capability detection
  const response: MetadataResponse = {
    service: 'ruvector-service',
    version: '1.0.0',
    endpoints: [
      'POST /ingest',
      'POST /query',
      'POST /simulate',
      'POST /graph',
      'POST /predict',
      'GET /metadata',
      'GET /health',
      'GET /ready',
      'GET /metrics',
    ],
    connected: vectorClient.isConnected(),
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(response);
}

export default metadataHandler;
