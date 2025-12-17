import { randomUUID } from 'crypto';

/**
 * Generate a correlation ID for request tracing
 * Uses UUID v4 format
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Extract correlation ID from request headers or generate a new one
 */
export function getOrCreateCorrelationId(headers: Record<string, string | string[] | undefined>): string {
  const correlationId = headers['x-correlation-id'] || headers['x-request-id'];

  if (typeof correlationId === 'string') {
    return correlationId;
  }

  if (Array.isArray(correlationId) && correlationId.length > 0) {
    return correlationId[0];
  }

  return generateCorrelationId();
}
