/**
 * Execution Metadata Helper
 * Generates execution_metadata object for all API responses.
 */
import { randomUUID } from 'crypto';
import { Request } from 'express';

export interface ExecutionMetadata {
  trace_id: string;
  timestamp: string;
  service: string;
}

/**
 * Build execution_metadata from request context.
 * Uses X-Correlation-ID header if present, otherwise generates a new UUID.
 */
export function buildExecutionMetadata(req: Request): ExecutionMetadata {
  const traceId = (req.header('X-Correlation-ID') as string) || randomUUID();
  return {
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    service: 'ruvvector-service',
  };
}
