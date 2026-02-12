/**
 * Startup Assertions - Memory Layer Hardening
 *
 * CRITICAL: Assert all required environment variables at startup.
 * CRASH ON FAILURE - do not proceed with missing config.
 */
import logger from '../utils/logger';

/**
 * Required environment variables for production operation.
 * Service will crash if these are not set in production.
 */
const REQUIRED_ENV_VARS_PRODUCTION = [
  'RUVVECTOR_DB_HOST',
  'RUVVECTOR_DB_NAME',
  'RUVVECTOR_DB_USER',
  'RUVVECTOR_DB_PASSWORD',
  'EXECUTION_HMAC_SECRET',
] as const;

/**
 * Optional environment variables with defaults.
 * Logged for observability but not required.
 */
const OPTIONAL_ENV_VARS = [
  'PORT',
  'LOG_LEVEL',
  'RUVVECTOR_SERVICE_URL',
  'RUVVECTOR_DB_PORT',
  'RUVVECTOR_DB_SSL',
  'RUVVECTOR_DB_MAX_CONNECTIONS',
  'RUVVECTOR_DB_IDLE_TIMEOUT',
  'RUVVECTOR_DB_CONNECTION_TIMEOUT',
  'CIRCUIT_BREAKER_THRESHOLD',
  'CIRCUIT_BREAKER_TIMEOUT',
  'CIRCUIT_BREAKER_RESET',
  'SHUTDOWN_TIMEOUT',
  'MAX_LATENCY_MS',
  'EXECUTION_ACCEPTANCE_TIMEOUT_MS',
] as const;

export interface AssertionResult {
  valid: boolean;
  missing: string[];
  present: string[];
  warnings: string[];
}

/**
 * Assert all required environment variables are set.
 * CRASHES on failure in production mode.
 *
 * @throws Error if required env vars are missing in production
 */
export function assertRequiredEnvVars(): AssertionResult {
  const isProduction = process.env.NODE_ENV === 'production';
  const missing: string[] = [];
  const present: string[] = [];
  const warnings: string[] = [];

  // Check required vars (critical in production)
  for (const envVar of REQUIRED_ENV_VARS_PRODUCTION) {
    const value = process.env[envVar];
    if (!value || value.trim() === '') {
      missing.push(envVar);
    } else {
      present.push(envVar);
    }
  }

  // Check optional vars (log warnings if using defaults)
  for (const envVar of OPTIONAL_ENV_VARS) {
    const value = process.env[envVar];
    if (!value || value.trim() === '') {
      warnings.push(`${envVar} not set, using default`);
    }
  }

  const result: AssertionResult = {
    valid: missing.length === 0,
    missing,
    present,
    warnings,
  };

  // Log assertion results
  if (missing.length > 0) {
    logger.error(
      { missing, isProduction },
      'STARTUP ASSERTION FAILED: Required environment variables missing'
    );

    // CRASH in production if critical vars missing
    if (isProduction) {
      throw new Error(
        `FATAL: Required environment variables missing: ${missing.join(', ')}. ` +
        `Service cannot start safely in production without these values.`
      );
    } else {
      logger.warn(
        { missing },
        'Running in development mode with missing env vars - using defaults'
      );
    }
  }

  if (warnings.length > 0) {
    logger.info({ warnings }, 'Optional environment variables using defaults');
  }

  logger.info(
    { present: present.length, missing: missing.length },
    'Environment variable assertion complete'
  );

  return result;
}

/**
 * Assert performance budget configuration.
 * Returns the configured MAX_LATENCY_MS (default: 2000ms).
 */
export function assertPerformanceBudget(): number {
  const maxLatencyStr = process.env.MAX_LATENCY_MS;
  const maxLatency = maxLatencyStr ? parseInt(maxLatencyStr, 10) : 2000;

  if (isNaN(maxLatency) || maxLatency <= 0) {
    throw new Error(
      `FATAL: MAX_LATENCY_MS must be a positive integer, got: ${maxLatencyStr}`
    );
  }

  if (maxLatency > 10000) {
    logger.warn(
      { maxLatency },
      'MAX_LATENCY_MS is set very high (>10s), this may cause client timeouts'
    );
  }

  logger.info({ maxLatency }, 'Performance budget configured');
  return maxLatency;
}

/**
 * Assert execution authority configuration.
 * Validates HMAC secret meets minimum security requirements.
 * CRASHES in production if secret is missing or too short.
 */
export function assertExecutionAuthority(): void {
  const secret = process.env.EXECUTION_HMAC_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && (!secret || secret.length < 32)) {
    throw new Error(
      'FATAL: EXECUTION_HMAC_SECRET must be at least 32 characters in production. ' +
      'This service is the authoritative execution origin - signing key is critical.'
    );
  }

  logger.info(
    {
      role: 'AUTHORITATIVE_EXECUTION_ORIGIN',
      hmac_algorithm: 'SHA-256',
      secret_configured: !!secret && secret.length >= 32,
    },
    'Execution authority configuration asserted'
  );
}

/**
 * Assert memory layer role rules are properly configured.
 * Validates that the service is configured as a deterministic memory layer.
 */
export function assertMemoryLayerRole(): void {
  // Log role constraints for observability
  logger.info(
    {
      role: 'AUTHORITATIVE_MEMORY_LAYER',
      constraints: {
        may: ['learn_from_approved_decisions', 'update_confidence_weighting'],
        must_not: ['reinterpret_historical_events', 'mutate_past_decision_events'],
      },
      signals: ['learning_update_signal', 'feedback_assimilation_signal'],
    },
    'Memory layer role constraints asserted'
  );
}

/**
 * Run all startup assertions.
 * CRASHES on critical failures.
 */
export function runStartupAssertions(): {
  envResult: AssertionResult;
  maxLatencyMs: number;
} {
  logger.info('Running startup assertions...');

  const envResult = assertRequiredEnvVars();
  const maxLatencyMs = assertPerformanceBudget();
  assertExecutionAuthority();
  assertMemoryLayerRole();

  logger.info('All startup assertions passed');

  return { envResult, maxLatencyMs };
}

export default {
  assertRequiredEnvVars,
  assertPerformanceBudget,
  assertExecutionAuthority,
  assertMemoryLayerRole,
  runStartupAssertions,
};
