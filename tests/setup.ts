/**
 * Jest setup file
 * Runs before each test suite
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.LOG_LEVEL = 'silent';
process.env.RUVVECTOR_BASE_URL = 'http://localhost:8080';
process.env.RUVVECTOR_API_KEY = 'test-api-key';
process.env.ENTITLEMENT_SERVICE_URL = 'http://localhost:9000';
process.env.ENABLE_METRICS = 'false';

// Increase timeout for integration tests
jest.setTimeout(30000);
