/**
 * Latency Budget Middleware - Performance Enforcement
 *
 * PERFORMANCE BUDGET: MAX_LATENCY_MS=2000 (default)
 *
 * Enforces latency budget on all learning endpoints.
 * Logs violations but does not kill in-progress requests.
 */
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import {
  ruvvectorRequestDuration,
} from '../utils/metrics';

// Default latency budget: 2000ms
let MAX_LATENCY_MS = 2000;

/**
 * Configure the latency budget.
 * Called at startup with asserted value.
 */
export function configureLatencyBudget(maxLatencyMs: number): void {
  MAX_LATENCY_MS = maxLatencyMs;
  logger.info({ MAX_LATENCY_MS }, 'Latency budget configured');
}

/**
 * Get the current latency budget.
 */
export function getLatencyBudget(): number {
  return MAX_LATENCY_MS;
}

/**
 * Latency budget middleware.
 *
 * Tracks request duration and logs warnings when budget is exceeded.
 * Does NOT abort requests - memory layer operations must complete.
 */
export function latencyBudgetMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  const endpoint = req.path;

  // Track when response finishes
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const withinBudget = duration <= MAX_LATENCY_MS;

    // Log latency with budget status
    if (!withinBudget) {
      logger.warn(
        {
          endpoint,
          duration_ms: duration,
          budget_ms: MAX_LATENCY_MS,
          exceeded_by_ms: duration - MAX_LATENCY_MS,
          status: res.statusCode,
        },
        'LATENCY BUDGET EXCEEDED'
      );
    } else {
      logger.debug(
        {
          endpoint,
          duration_ms: duration,
          budget_ms: MAX_LATENCY_MS,
          headroom_ms: MAX_LATENCY_MS - duration,
        },
        'Request within latency budget'
      );
    }
  });

  next();
}

/**
 * Learning-specific latency middleware.
 *
 * Applied only to /learning/* endpoints which have stricter requirements.
 * Memory layer operations MUST complete - no timeouts on writes.
 */
export function learningLatencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  const endpoint = req.path;

  // Set response header with budget info
  res.setHeader('X-Latency-Budget-Ms', MAX_LATENCY_MS.toString());

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    // Emit metric for learning endpoints
    ruvvectorRequestDuration.observe(
      { endpoint: 'learning' },
      duration / 1000
    );

    // Strict warning for learning endpoints
    if (duration > MAX_LATENCY_MS) {
      logger.error(
        {
          endpoint,
          duration_ms: duration,
          budget_ms: MAX_LATENCY_MS,
          exceeded_by_ms: duration - MAX_LATENCY_MS,
          status: res.statusCode,
          method: req.method,
        },
        'LEARNING ENDPOINT LATENCY BUDGET EXCEEDED - investigate storage performance'
      );
    }
  });

  next();
}

export default {
  configureLatencyBudget,
  getLatencyBudget,
  latencyBudgetMiddleware,
  learningLatencyMiddleware,
};
