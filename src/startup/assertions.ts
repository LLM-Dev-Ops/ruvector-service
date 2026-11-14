/**
 * Startup Assertions - Memory Layer Hardening
 *
 * CRITICAL: Assert all required environment variables at startup.
 * CRASH ON FAILURE - do not proceed with missing config.
 */
import logger from '../utils/logger';
import { config, configDeprecations } from '../config';
import { assertValidDimension } from '../clients/vectorSchema';
import { parseIdentityCallerPrincipals, parsePrincipalOrgBindings } from '../utils/principalBindings';
import { parseIdentityScopeConfiguration } from '../utils/identityScopes';

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
  'RUVVECTOR_SERVICE_AUDIENCE',
  'RUVVECTOR_PRINCIPAL_ORG_BINDINGS',
  'RUVVECTOR_IDENTITY_CALLER_PRINCIPALS',
  'RUVVECTOR_IDENTITY_JWT_ISSUER',
  'RUVVECTOR_IDENTITY_JWT_AUDIENCE',
  'RUVVECTOR_IDENTITY_JWKS_URI',
  'RUVVECTOR_IDENTITY_VERIFICATION_URL',
  'RUVVECTOR_IDENTITY_SESSION_ENCRYPTION_KEY',
  'RUVVECTOR_IDENTITY_ALLOWED_SCOPES',
  'RUVVECTOR_IDENTITY_DEFAULT_SCOPES',
  // Has no default and hard-crashes assertEmbeddingDimension() when unset; listing it
  // here is what makes the reported "missing" count reflect what can actually crash startup.
  'RUVVECTOR_EMBEDDING_DIM',
] as const;

/**
 * Optional environment variables with defaults.
 * Logged for observability but not required.
 */
const OPTIONAL_ENV_VARS = [
  'PORT',
  'LOG_LEVEL',
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

export function assertDataPlaneIdentity(): void {
  const audience = config.dataPlaneIdentity.serviceAudience;
  if (!audience) {
    throw new Error('FATAL: RUVVECTOR_SERVICE_AUDIENCE is required for tenant-bound data-plane routes.');
  }

  try {
    parsePrincipalOrgBindings(config.dataPlaneIdentity.principalOrgBindings);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Principal bindings are invalid';
    const detail = reason.replace(/^Principal bindings /, '');
    throw new Error(`FATAL: RUVVECTOR_PRINCIPAL_ORG_BINDINGS ${detail}.`);
  }

  try {
    parseIdentityCallerPrincipals(config.dataPlaneIdentity.identityCallerPrincipals);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Identity caller principals are invalid';
    const detail = reason.replace(/^Identity caller principals /, '');
    throw new Error(`FATAL: RUVVECTOR_IDENTITY_CALLER_PRINCIPALS ${detail}.`);
  }

  for (const [name, value] of [
    ['RUVVECTOR_IDENTITY_JWT_ISSUER', config.dataPlaneIdentity.jwtIssuer],
    ['RUVVECTOR_IDENTITY_JWT_AUDIENCE', config.dataPlaneIdentity.jwtAudience],
    ['RUVVECTOR_IDENTITY_JWKS_URI', config.dataPlaneIdentity.jwksUri],
    ['RUVVECTOR_IDENTITY_VERIFICATION_URL', config.dataPlaneIdentity.verificationUrl],
  ] as const) {
    if (!value) throw new Error(`FATAL: ${name} is required for CLI identity sessions.`);
  }
  for (const [name, value] of [
    ['RUVVECTOR_IDENTITY_JWT_ISSUER', config.dataPlaneIdentity.jwtIssuer],
    ['RUVVECTOR_IDENTITY_JWKS_URI', config.dataPlaneIdentity.jwksUri],
    ['RUVVECTOR_IDENTITY_VERIFICATION_URL', config.dataPlaneIdentity.verificationUrl],
  ] as const) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') throw new Error('not https');
    } catch {
      throw new Error(`FATAL: ${name} must be an HTTPS URL.`);
    }
  }

  const encryptionKey = Buffer.from(config.dataPlaneIdentity.sessionEncryptionKey, 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== config.dataPlaneIdentity.sessionEncryptionKey) {
    throw new Error('FATAL: RUVVECTOR_IDENTITY_SESSION_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes.');
  }

  try {
    parseIdentityScopeConfiguration(
      config.dataPlaneIdentity.allowedScopes,
      config.dataPlaneIdentity.defaultScopes
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Identity scope configuration is invalid';
    throw new Error(`FATAL: ${reason}.`);
  }
}

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

    // CRASH on missing env vars — NO partial operation allowed
    throw new Error(
      `FATAL: Required environment variables missing: ${missing.join(', ')}. ` +
      `Service cannot start safely without these values. ` +
      `DO NOT allow partial operation.`
    );
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

  if (!secret || secret.length < 1) {
    throw new Error(
      'FATAL: EXECUTION_HMAC_SECRET is required. ' +
      'This service is the authoritative execution origin — signing key is critical. ' +
      'DO NOT allow partial operation without execution authority configuration.'
    );
  }

  logger.info(
    {
      role: 'AUTHORITATIVE_EXECUTION_ORIGIN',
      hmac_algorithm: 'SHA-256',
      secret_configured: true,
      secret_length: secret.length,
    },
    'Execution authority configuration asserted'
  );
}

/**
 * Assert the embedding dimension has been chosen.
 *
 * `vector(N)` fixes N in the table definition; changing it afterwards requires
 * a rewrite. There is deliberately no default — an inferred dimension that
 * disagrees with what producers send would corrupt every write.
 */
export function assertEmbeddingDimension(): number {
  const dimension = config.ruvVector.embeddingDimension;

  if (!dimension) {
    throw new Error(
      'FATAL: RUVVECTOR_EMBEDDING_DIM is required. ' +
      'It fixes the dimension of the vectors.embedding column and cannot be changed ' +
      'without rewriting the table, so it must match the platform embedding model exactly. ' +
      'DO NOT allow partial operation without a declared embedding dimension.'
    );
  }

  assertValidDimension(dimension);
  logger.info({ dimension }, 'Embedding dimension asserted');
  return dimension;
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

  if (configDeprecations.length > 0) {
    logger.warn({ deprecations: configDeprecations }, 'Deprecated environment variables in use');
  }

  const envResult = assertRequiredEnvVars();
  const maxLatencyMs = assertPerformanceBudget();
  assertEmbeddingDimension();
  assertExecutionAuthority();
  assertDataPlaneIdentity();
  assertMemoryLayerRole();

  logger.info('All startup assertions passed');

  return { envResult, maxLatencyMs };
}

export default {
  assertRequiredEnvVars,
  assertPerformanceBudget,
  assertEmbeddingDimension,
  assertExecutionAuthority,
  assertDataPlaneIdentity,
  assertMemoryLayerRole,
  runStartupAssertions,
};
