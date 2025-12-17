import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ErrorResponse } from '../types';
import logger from '../utils/logger';
import { errorTotal } from '../utils/metrics';
import { getOrCreateCorrelationId } from '../utils/correlation';

/**
 * Custom error class for application errors
 * SPARC error codes: validation_error, missing_header, invalid_vector_dimension,
 * entitlement_error, upstream_error, upstream_timeout, service_unavailable, internal_error
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown[]
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Global error handler middleware
 * SPARC: All errors follow a consistent format
 */
export function errorHandler(
  err: Error | AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const correlationId = req.correlationId || getOrCreateCorrelationId(req.headers);

  // Handle Zod validation errors
  // SPARC: 400 validation_error - Request body failed validation
  if (err instanceof ZodError) {
    const errorResponse: ErrorResponse = {
      error: 'validation_error',
      message: 'Request validation failed',
      correlationId,
      details: err.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    };

    errorTotal.inc({ type: 'validation_error', endpoint: req.path });

    logger.warn(
      { correlationId, errors: err.errors, endpoint: req.path },
      'Validation error'
    );

    res.status(400).json(errorResponse);
    return;
  }

  // Handle custom application errors
  if (err instanceof AppError) {
    const errorResponse: ErrorResponse = {
      error: err.code,
      message: err.message,
      correlationId,
      details: err.details,
    };

    errorTotal.inc({ type: err.code, endpoint: req.path });

    // Log at appropriate level based on error type
    if (err.statusCode >= 500) {
      logger.error(
        { correlationId, code: err.code, statusCode: err.statusCode, endpoint: req.path },
        err.message
      );
    } else {
      logger.warn(
        { correlationId, code: err.code, statusCode: err.statusCode, endpoint: req.path },
        err.message
      );
    }

    res.status(err.statusCode).json(errorResponse);
    return;
  }

  // Handle unknown errors
  // SPARC: 500 internal_error - Unexpected internal error
  const errorResponse: ErrorResponse = {
    error: 'internal_error',
    message: 'An unexpected error occurred',
    correlationId,
  };

  errorTotal.inc({ type: 'internal_error', endpoint: req.path });

  logger.error(
    { correlationId, error: err, stack: err.stack, endpoint: req.path },
    'Unexpected error'
  );

  res.status(500).json(errorResponse);
}

/**
 * Not found handler - must be registered after all routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const correlationId = req.correlationId || getOrCreateCorrelationId(req.headers);

  const errorResponse: ErrorResponse = {
    error: 'not_found',
    message: `Route ${req.method} ${req.path} not found`,
    correlationId,
  };

  errorTotal.inc({ type: 'not_found', endpoint: req.path });

  logger.warn(
    { correlationId, method: req.method, endpoint: req.path },
    'Route not found'
  );

  res.status(404).json(errorResponse);
}

export default { errorHandler, notFoundHandler, AppError };
