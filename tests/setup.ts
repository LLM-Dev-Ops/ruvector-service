/**
 * Jest setup file
 * Runs before each test suite
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.LOG_LEVEL = 'silent';

// REQUIRED: RUVVECTOR_SERVICE_URL (fail-fast if not set in production)
process.env.RUVVECTOR_SERVICE_URL = 'http://test-ruvvector:6379';

// OPTIONAL: RUVVECTOR_API_KEY (only if authentication required)
process.env.RUVVECTOR_API_KEY = 'test-api-key';

// Legacy vars (for backwards compatibility during transition)
process.env.RUVVECTOR_BASE_URL = 'http://localhost:8080';
process.env.ENTITLEMENT_SERVICE_URL = 'http://localhost:9000';
process.env.ENABLE_METRICS = 'false';

// Execution authority config for testing
process.env.EXECUTION_HMAC_SECRET = 'test-hmac-secret-minimum-32-chars-long-for-testing-only';

// Increase timeout for integration tests
jest.setTimeout(30000);
