/**
 * Configuration interface matching SPARC specification
 * All configuration via environment variables only - NO .env files, NO defaults for required vars
 */
interface Config {
  // Service configuration
  port: number;
  logLevel: string;

  // RuvVector vector-store behaviour.
  // There is no service URL: the vector backend is the Postgres database
  // configured below (ADR-0001).
  ruvVector: {
    timeout: number;             // Request timeout (ms)
    embeddingDimension: number;  // REQUIRED: declared dimension of vectors.embedding
  };

  // PostgreSQL Database configuration (for plans storage)
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    maxConnections: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    ssl: boolean;
  };

  // Circuit breaker configuration
  circuitBreaker: {
    threshold: number;    // Failures before opening
    timeout: number;      // Open state duration (ms)
    resetTimeout: number; // Time before full reset (ms)
  };

  // Metrics configuration
  metrics: {
    enabled: boolean;
    port: number;
  };

  // Shutdown configuration
  shutdown: {
    timeout: number;      // Graceful shutdown (ms)
  };

  // Execution authority configuration
  execution: {
    hmacSecret: string;            // HMAC-SHA256 signing secret for authority signatures
    acceptanceTimeoutMs: number;   // Max processing time for acceptance (ms)
  };
}

/**
 * Deprecation notices raised while reading configuration.
 *
 * Config is imported before the logger exists (the logger reads config), so
 * notices are buffered here and emitted by the startup assertions.
 */
export const configDeprecations: string[] = [];

/**
 * Read a `RUVVECTOR_*` variable, falling back to the one-v `RUVECTOR_*`
 * spelling used by most consumer repos.
 *
 * The two-v form is what this service reads, so it is canonical; the one-v form
 * is a deprecated alias that exists to give consumers a migration window rather
 * than forcing an atomic cross-repo cutover (ADR-0001).
 */
const readEnv = (key: string): string | undefined => {
  const canonical = process.env[key];
  if (canonical !== undefined && canonical !== '') {
    return canonical;
  }

  if (!key.startsWith('RUVVECTOR_')) {
    return undefined;
  }

  const alias = `RUVECTOR_${key.slice('RUVVECTOR_'.length)}`;
  const aliasValue = process.env[alias];
  if (aliasValue !== undefined && aliasValue !== '') {
    configDeprecations.push(
      `${alias} is deprecated and will be removed; set ${key} instead`
    );
    return aliasValue;
  }

  return undefined;
};

/**
 * Get optional environment variable with default
 */
const getEnvVar = (key: string, defaultValue: string): string => {
  return readEnv(key) ?? defaultValue;
};

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = readEnv(key);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
  }
  return parsed;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = readEnv(key);
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
};

/**
 * Configuration object - SPARC compliant
 * All values from environment variables
 */
export const config: Config = {
  // Required environment variables
  port: getEnvNumber('PORT', 3000),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),

  // RuvVector vector-store behaviour.
  // embeddingDimension has NO default: `vector(N)` fixes N at the schema level
  // and changing it later means a table rewrite, so it must be chosen
  // deliberately. 0 is a sentinel that startup assertions reject.
  ruvVector: {
    timeout: getEnvNumber('RUVVECTOR_TIMEOUT', 30000),
    embeddingDimension: getEnvNumber('RUVVECTOR_EMBEDDING_DIM', 0),
  },

  // PostgreSQL Database configuration — required for operation
  database: {
    host: getEnvVar('RUVVECTOR_DB_HOST', 'localhost'),
    port: getEnvNumber('RUVVECTOR_DB_PORT', 5432),
    name: getEnvVar('RUVVECTOR_DB_NAME', 'ruvector-postgres'),
    user: getEnvVar('RUVVECTOR_DB_USER', 'postgres'),
    password: getEnvVar('RUVVECTOR_DB_PASSWORD', ''),  // Validated at startup assertions
    maxConnections: getEnvNumber('RUVVECTOR_DB_MAX_CONNECTIONS', 20),
    idleTimeoutMs: getEnvNumber('RUVVECTOR_DB_IDLE_TIMEOUT', 30000),
    connectionTimeoutMs: getEnvNumber('RUVVECTOR_DB_CONNECTION_TIMEOUT', 10000),
    ssl: getEnvBoolean('RUVVECTOR_DB_SSL', false),
  },

  // Circuit breaker
  circuitBreaker: {
    threshold: getEnvNumber('CIRCUIT_BREAKER_THRESHOLD', 5),
    timeout: getEnvNumber('CIRCUIT_BREAKER_TIMEOUT', 30000),
    resetTimeout: getEnvNumber('CIRCUIT_BREAKER_RESET', 60000),
  },

  // Metrics
  metrics: {
    enabled: getEnvBoolean('METRICS_ENABLED', true),
    port: getEnvNumber('METRICS_PORT', 9090),
  },

  // Shutdown
  shutdown: {
    timeout: getEnvNumber('SHUTDOWN_TIMEOUT', 30000),
  },

  // Execution authority — HMAC secret is REQUIRED (validated at startup assertions phase)
  // NOTE: Do NOT throw here — config is loaded at import time before main() try/catch.
  // The startup assertions in assertions.ts validate this with proper logging.
  execution: {
    hmacSecret: getEnvVar('EXECUTION_HMAC_SECRET', ''),
    acceptanceTimeoutMs: getEnvNumber('EXECUTION_ACCEPTANCE_TIMEOUT_MS', 5000),
  },
};

export default config;
