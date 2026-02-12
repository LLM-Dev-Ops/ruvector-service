import { Registry, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Prometheus metrics registry - SPARC compliant
 *
 * Metrics exposed on /metrics endpoint per SPARC specification:
 * - ruvvector_requests_total: Total requests by endpoint and status
 * - ruvvector_request_duration_seconds: Request latency by endpoint
 * - ruvvector_upstream_errors_total: RuvVector errors by type
 * - ruvvector_circuit_breaker_state: Circuit breaker state (0=closed, 1=open)
 * - ruvvector_active_connections: Active RuvVector connections
 */

export const register = new Registry();

// Add default labels
register.setDefaultLabels({
  service: 'ruvvector-service',
});

/**
 * SPARC: ruvvector_requests_total
 * Total requests by endpoint and status
 */
export const ruvvectorRequestsTotal = new Counter({
  name: 'ruvvector_requests_total',
  help: 'Total requests by endpoint and status',
  labelNames: ['endpoint', 'status'],
  registers: [register],
});

/**
 * SPARC: ruvvector_request_duration_seconds
 * Request latency by endpoint
 */
export const ruvvectorRequestDuration = new Histogram({
  name: 'ruvvector_request_duration_seconds',
  help: 'Request latency by endpoint',
  labelNames: ['endpoint'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * SPARC: ruvvector_upstream_errors_total
 * RuvVector errors by type
 */
export const ruvvectorUpstreamErrorsTotal = new Counter({
  name: 'ruvvector_upstream_errors_total',
  help: 'RuvVector errors by type',
  labelNames: ['type'],
  registers: [register],
});

/**
 * SPARC: ruvvector_circuit_breaker_state
 * Circuit breaker state (0=closed, 1=open)
 */
export const ruvvectorCircuitBreakerState = new Gauge({
  name: 'ruvvector_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open)',
  registers: [register],
});

/**
 * SPARC: ruvvector_active_connections
 * Active RuvVector connections
 */
export const ruvvectorActiveConnections = new Gauge({
  name: 'ruvvector_active_connections',
  help: 'Active RuvVector connections',
  registers: [register],
});

// Additional useful metrics (not in SPARC but good for observability)

/**
 * Error counter by type and endpoint
 */
export const errorTotal = new Counter({
  name: 'ruvvector_errors_total',
  help: 'Total errors by type and endpoint',
  labelNames: ['type', 'endpoint'],
  registers: [register],
});

/**
 * Execution acceptance counter
 * Tracks accepted vs rejected execution requests
 */
export const executionAcceptanceTotal = new Counter({
  name: 'ruvvector_execution_acceptance_total',
  help: 'Total execution acceptance requests by status',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Execution acceptance latency
 * Tracks time to process acceptance requests
 */
export const executionAcceptanceDuration = new Histogram({
  name: 'ruvvector_execution_acceptance_duration_seconds',
  help: 'Execution acceptance processing latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

/**
 * Execution validation counter
 * Tracks valid vs invalid signature validations
 */
export const executionValidationTotal = new Counter({
  name: 'ruvvector_execution_validation_total',
  help: 'Total execution validation requests by result',
  labelNames: ['result'],
  registers: [register],
});

export default {
  register,
  ruvvectorRequestsTotal,
  ruvvectorRequestDuration,
  ruvvectorUpstreamErrorsTotal,
  ruvvectorCircuitBreakerState,
  ruvvectorActiveConnections,
  errorTotal,
  executionAcceptanceTotal,
  executionAcceptanceDuration,
  executionValidationTotal,
};
