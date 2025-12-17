import { config } from '../../src/config';

describe('Configuration - SPARC Compliant', () => {
  it('should load basic configuration from environment variables', () => {
    expect(config).toBeDefined();
    expect(config.port).toBeGreaterThan(0);
    expect(config.logLevel).toBeDefined();
  });

  it('should have RuvVector configuration (SPARC env vars)', () => {
    expect(config.ruvVector).toBeDefined();
    expect(config.ruvVector.host).toBeDefined();
    expect(config.ruvVector.port).toBeGreaterThan(0);
    expect(config.ruvVector.timeout).toBeGreaterThan(0);
    expect(config.ruvVector.poolSize).toBeGreaterThan(0);
  });

  it('should have circuit breaker configuration', () => {
    expect(config.circuitBreaker).toBeDefined();
    expect(config.circuitBreaker.threshold).toBeGreaterThan(0);
    expect(config.circuitBreaker.timeout).toBeGreaterThan(0);
    expect(config.circuitBreaker.resetTimeout).toBeGreaterThan(0);
  });

  it('should have metrics configuration', () => {
    expect(config.metrics).toBeDefined();
    expect(typeof config.metrics.enabled).toBe('boolean');
    expect(config.metrics.port).toBeGreaterThan(0);
  });

  it('should have shutdown configuration', () => {
    expect(config.shutdown).toBeDefined();
    expect(config.shutdown.timeout).toBeGreaterThan(0);
  });
});
