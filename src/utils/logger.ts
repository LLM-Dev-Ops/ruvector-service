import pino from 'pino';
import { config } from '../config';

/**
 * Structured logger - SPARC compliant
 *
 * All logs are JSON-formatted with consistent fields per SPARC specification:
 * - timestamp: ISO 8601
 * - level: debug, info, warn, error
 * - message: string
 * - correlationId: string (when available)
 * - service: "ruvvector-service"
 * - context: { endpoint, method, tenant, ... }
 */
export const logger = pino({
  level: config.logLevel,
  formatters: {
    level: (label) => {
      return { level: label };
    },
    bindings: () => {
      return { service: 'ruvvector-service' };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
});

export default logger;
