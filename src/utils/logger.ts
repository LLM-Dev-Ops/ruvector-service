import pino from 'pino';
import { config } from '../config';

/**
 * Pino applies serializers by property name. `Error.prototype.message`/`.stack`/`.name`
 * are non-enumerable, so any Error logged under a key without a registered serializer
 * renders as `{}`. This codebase logs caught values under `error` (62 call sites) and
 * `reason` (unhandled rejections), so both must be registered alongside `err`.
 * pino 9's `errorKey` option would cover this; this service is on pino 8.
 */
export const loggerSerializers = {
  req: (req: { method: string; url: string }) => ({
    method: req.method,
    url: req.url,
  }),
  res: (res: { statusCode: number }) => ({
    statusCode: res.statusCode,
  }),
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,
  reason: pino.stdSerializers.err,
};

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
  serializers: loggerSerializers,
});

export default logger;
