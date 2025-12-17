import logger from '../utils/logger';
import {
  VectorInsertParams,
  VectorInsertResult,
  VectorQueryParams,
  VectorQueryResult,
  VectorSimilarityParams,
  VectorSimilarityResult,
} from '../types';

/**
 * Circuit breaker states as per SPARC specification
 */
enum CircuitState {
  CLOSED = 'closed',      // Normal operation, requests pass through
  OPEN = 'open',          // Fail fast, return 503 immediately
  HALF_OPEN = 'half_open' // Allow limited requests to test recovery
}

/**
 * Circuit breaker configuration
 */
interface CircuitBreakerConfig {
  threshold: number;      // Failures before opening
  timeout: number;        // Time in open state (ms)
  resetTimeout: number;   // Time before full reset (ms)
}

/**
 * VectorClient configuration matching SPARC spec
 */
export interface VectorClientConfig {
  host: string;
  port: number;
  timeout: number;
  poolSize: number;
  circuitBreaker: CircuitBreakerConfig;
}

/**
 * Client for interacting with RuvVector backend service
 * Implements circuit breaker pattern as per SPARC specification
 */
export class VectorClient {
  private host: string;
  private port: number;
  private timeout: number;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private circuitConfig: CircuitBreakerConfig;

  constructor(config: VectorClientConfig) {
    this.host = config.host;
    this.port = config.port;
    this.timeout = config.timeout;
    this.circuitConfig = config.circuitBreaker;
  }

  /**
   * Get timeout configuration
   */
  getTimeout(): number {
    return this.timeout;
  }

  /**
   * Get circuit breaker state (for metrics)
   */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /**
   * Check if circuit breaker allows request
   */
  private checkCircuit(): void {
    if (this.circuitState === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;

      // Check if we should transition to half-open
      if (timeSinceFailure >= this.circuitConfig.timeout) {
        this.circuitState = CircuitState.HALF_OPEN;
        logger.info('Circuit breaker transitioning to half-open state');
      } else {
        throw new Error('Circuit breaker is open - RuvVector unavailable');
      }
    }
  }

  /**
   * Record a successful operation
   */
  private recordSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Successful request in half-open state - close the circuit
      this.circuitState = CircuitState.CLOSED;
      this.failureCount = 0;
      logger.info('Circuit breaker closed after successful request');
    }
  }

  /**
   * Record a failed operation
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Failed in half-open state - open the circuit again
      this.circuitState = CircuitState.OPEN;
      logger.warn('Circuit breaker reopened after failure in half-open state');
    } else if (this.failureCount >= this.circuitConfig.threshold) {
      // Threshold exceeded - open the circuit
      this.circuitState = CircuitState.OPEN;
      logger.warn(
        { failureCount: this.failureCount, threshold: this.circuitConfig.threshold },
        'Circuit breaker opened due to failure threshold'
      );
    }
  }

  /**
   * Insert a vector with metadata into RuvVector
   */
  async insert(params: VectorInsertParams): Promise<VectorInsertResult> {
    const startTime = Date.now();

    // Check circuit breaker
    this.checkCircuit();

    try {
      logger.debug({ id: params.id }, 'Inserting vector');

      // Stub implementation - would make actual call to RuvVector
      // In production, this would use gRPC/TCP connection to RuvVector
      const result: VectorInsertResult = {
        id: params.id,
      };

      this.recordSuccess();

      const duration = Date.now() - startTime;
      logger.info({ id: params.id, duration }, 'Vector inserted successfully');

      return result;
    } catch (error) {
      this.recordFailure();
      logger.error({ error, id: params.id }, 'Failed to insert vector');
      throw error;
    }
  }

  /**
   * Query vectors based on filters and optional similarity search
   */
  async query(params: VectorQueryParams): Promise<VectorQueryResult> {
    const startTime = Date.now();

    // Check circuit breaker
    this.checkCircuit();

    try {
      logger.debug(
        { hasVector: !!params.vector, limit: params.limit, offset: params.offset },
        'Querying vectors'
      );

      // Stub implementation - would make actual call to RuvVector
      const result: VectorQueryResult = {
        items: [],
        total: 0,
        executionTime: Date.now() - startTime,
      };

      this.recordSuccess();

      logger.info({ total: result.total, duration: result.executionTime }, 'Query completed');

      return result;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'Failed to query vectors');
      throw error;
    }
  }

  /**
   * Find similar vectors based on context vectors (similarity/simulate)
   */
  async similarity(params: VectorSimilarityParams): Promise<VectorSimilarityResult> {
    const startTime = Date.now();

    // Check circuit breaker
    this.checkCircuit();

    try {
      logger.debug(
        { contextCount: params.contextVectors.length, k: params.k, threshold: params.threshold },
        'Finding similar vectors'
      );

      // Stub implementation - would make actual call to RuvVector
      const result: VectorSimilarityResult = {
        neighbors: [],
        processed: params.contextVectors.length,
        executionTime: Date.now() - startTime,
      };

      this.recordSuccess();

      logger.info({ processed: result.processed, duration: result.executionTime }, 'Similarity search completed');

      return result;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'Failed to find similar vectors');
      throw error;
    }
  }

  /**
   * Health check - verify connection to RuvVector (ping)
   * SPARC: vectorClient.ping()
   */
  async ping(): Promise<boolean> {
    // Check circuit breaker - but don't throw on open for health checks
    if (this.circuitState === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.circuitConfig.timeout) {
        this.circuitState = CircuitState.HALF_OPEN;
      } else {
        return false;
      }
    }

    try {
      logger.debug({ host: this.host, port: this.port }, 'RuvVector health check');

      // Stub implementation - would make actual ping to RuvVector
      // In production, this would verify TCP/gRPC connectivity
      this.recordSuccess();
      return true;
    } catch (error) {
      this.recordFailure();
      logger.error({ error }, 'RuvVector health check failed');
      return false;
    }
  }

  /**
   * Get connection info for logging
   */
  getConnectionInfo(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }
}

export default VectorClient;
