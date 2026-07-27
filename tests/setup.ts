/**
 * Jest setup file
 * Runs before each test suite
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.LOG_LEVEL = 'silent';

// REQUIRED: dimension of the vectors.embedding column. Kept small so fixtures
// stay readable; production must set the real embedding model's dimension.
process.env.RUVVECTOR_EMBEDDING_DIM = process.env.RUVVECTOR_EMBEDDING_DIM || '4';

// Database — this IS the vector store. Integration tests point these at a live
// ruvnet/ruvector-postgres container; unit tests never open a connection.
process.env.RUVVECTOR_DB_HOST = process.env.RUVVECTOR_DB_HOST || 'localhost';
process.env.RUVVECTOR_DB_PORT = process.env.RUVVECTOR_DB_PORT || '55432';
process.env.RUVVECTOR_DB_NAME = process.env.RUVVECTOR_DB_NAME || 'ruvector-postgres';
process.env.RUVVECTOR_DB_USER = process.env.RUVVECTOR_DB_USER || 'postgres';
process.env.RUVVECTOR_DB_PASSWORD = process.env.RUVVECTOR_DB_PASSWORD || 'adr1test';

process.env.ENTITLEMENT_SERVICE_URL = 'http://localhost:9000';
process.env.ENABLE_METRICS = 'false';

// Execution authority config for testing
process.env.EXECUTION_HMAC_SECRET = 'test-hmac-secret-minimum-32-chars-long-for-testing-only';

// Increase timeout for integration tests
jest.setTimeout(30000);
