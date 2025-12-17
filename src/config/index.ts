import { config as dotenvConfig } from 'dotenv';

// Load environment variables from .env file
dotenvConfig();

/**
 * Configuration interface matching SPARC specification
 * All configuration via environment variables only
 */
interface Config {
  // Service configuration
  port: number;
  logLevel: string;

  // RuvVector connection (infra-provisioned)
  ruvVector: {
    host: string;
    port: number;
    timeout: number;      // Request timeout (ms)
    poolSize: number;     // Connection pool size
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
}

const getEnvVar = (key: string, defaultValue?: string): string => {
  const value = process.env[key];
  if (value === undefined && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue || '';
};

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
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
  const value = process.env[key];
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

  // RuvVector connection
  ruvVector: {
    host: getEnvVar('RUVVECTOR_HOST', 'localhost'),
    port: getEnvNumber('RUVVECTOR_PORT', 6379),
    timeout: getEnvNumber('RUVVECTOR_TIMEOUT', 30000),
    poolSize: getEnvNumber('RUVVECTOR_POOL_SIZE', 10),
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
};

export default config;
