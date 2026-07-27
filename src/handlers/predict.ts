import { Request, Response } from 'express';
import { VectorClient } from '../clients/VectorClient';
import logger from '../utils/logger';

/**
 * Request body for POST /predict
 */
interface PredictRequest {
  model: string;
}

/**
 * Handler for POST /predict
 *
 * Not implemented. This service is backed by a vector store, which performs
 * nearest-neighbour search rather than model inference — there is no prediction
 * backend to call. Returning 501 matches POST /graph; the previous 200 with a
 * fabricated `confidence: 0.0` was worse than an explicit "not built".
 */
export async function predictHandler(
  req: Request,
  res: Response,
  _vectorClient: VectorClient
): Promise<void> {
  const correlationId = req.correlationId;
  const body = req.body as PredictRequest;

  logger.info(
    {
      correlationId,
      tenant: req.entitlement?.tenant,
      model: body?.model,
      endpoint: '/predict'
    },
    'Predict requested but no inference backend exists'
  );

  res.status(501).json({
    error: 'not_implemented',
    message: 'Predict endpoint is not implemented: this service provides vector search, not model inference',
    correlationId,
  });
}

export default predictHandler;
