/**
 * Configuration tests - SPARC Compliant
 */

describe('Configuration - SPARC Compliant', () => {
  // Store original env
  const originalEnv = process.env;

  afterAll(() => {
    process.env = originalEnv;
  });

  // Import config after env setup
  const getConfig = () => {
    jest.resetModules();
    return require('../../src/config').config;
  };

  it('should load basic configuration from environment variables', () => {
    const config = getConfig();
    expect(config).toBeDefined();
    expect(config.port).toBeGreaterThan(0);
    expect(config.logLevel).toBeDefined();
  });

  it('should have RuvVector configuration without a separate service endpoint', () => {
    const config = getConfig();
    expect(config.ruvVector).toBeDefined();
    expect(config.ruvVector.timeout).toBeGreaterThan(0);
    // The vector backend is the database below — there is no second endpoint
    expect(config.ruvVector).not.toHaveProperty('serviceUrl');
    expect(config.ruvVector).not.toHaveProperty('apiKey');
    expect(config.ruvVector).not.toHaveProperty('poolSize');
  });

  it('should read the embedding dimension from the environment', () => {
    const config = getConfig();
    expect(config.ruvVector.embeddingDimension).toBe(
      Number(process.env.RUVVECTOR_EMBEDDING_DIM)
    );
  });

  it('should have circuit breaker configuration', () => {
    const config = getConfig();
    expect(config.circuitBreaker).toBeDefined();
    expect(config.circuitBreaker.threshold).toBeGreaterThan(0);
    expect(config.circuitBreaker.timeout).toBeGreaterThan(0);
    expect(config.circuitBreaker.resetTimeout).toBeGreaterThan(0);
  });

  it('should have metrics configuration', () => {
    const config = getConfig();
    expect(config.metrics).toBeDefined();
    expect(typeof config.metrics.enabled).toBe('boolean');
    expect(config.metrics.port).toBeGreaterThan(0);
  });

  it('should have shutdown configuration', () => {
    const config = getConfig();
    expect(config.shutdown).toBeDefined();
    expect(config.shutdown.timeout).toBeGreaterThan(0);
  });

  describe('Default value behavior', () => {
    it('should not default the embedding dimension', () => {
      const original = process.env.RUVVECTOR_EMBEDDING_DIM;
      delete process.env.RUVVECTOR_EMBEDDING_DIM;

      jest.resetModules();
      const { config: testConfig } = require('../../src/config');

      // 0 is the sentinel that startup assertions reject — guessing N would
      // corrupt every write, so there is deliberately no usable default.
      expect(testConfig.ruvVector.embeddingDimension).toBe(0);

      process.env.RUVVECTOR_EMBEDDING_DIM = original;
    });
  });

  describe('Deprecated one-v RUVECTOR_* aliases', () => {
    const restore: Record<string, string | undefined> = {};

    afterEach(() => {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('falls back to the one-v spelling and records a deprecation', () => {
      restore.RUVVECTOR_DB_HOST = process.env.RUVVECTOR_DB_HOST;
      restore.RUVECTOR_DB_HOST = process.env.RUVECTOR_DB_HOST;
      delete process.env.RUVVECTOR_DB_HOST;
      process.env.RUVECTOR_DB_HOST = 'legacy-host';

      jest.resetModules();
      const { config: testConfig, configDeprecations } = require('../../src/config');

      expect(testConfig.database.host).toBe('legacy-host');
      expect(configDeprecations.join('\n')).toContain('RUVECTOR_DB_HOST is deprecated');
    });

    it('prefers the canonical two-v spelling when both are set', () => {
      restore.RUVVECTOR_DB_HOST = process.env.RUVVECTOR_DB_HOST;
      restore.RUVECTOR_DB_HOST = process.env.RUVECTOR_DB_HOST;
      process.env.RUVVECTOR_DB_HOST = 'canonical-host';
      process.env.RUVECTOR_DB_HOST = 'legacy-host';

      jest.resetModules();
      const { config: testConfig, configDeprecations } = require('../../src/config');

      expect(testConfig.database.host).toBe('canonical-host');
      expect(configDeprecations.join('\n')).not.toContain('RUVECTOR_DB_HOST');
    });
  });
});
