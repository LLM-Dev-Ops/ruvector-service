/**
 * Startup Module - Hardened Initialization
 *
 * Exports all startup utilities for memory layer hardening.
 */
export {
  assertRequiredEnvVars,
  assertPerformanceBudget,
  assertEmbeddingDimension,
  assertMemoryLayerRole,
  runStartupAssertions,
  type AssertionResult,
} from './assertions';

export {
  verifyStorageHealth,
  quickHealthCheck,
  type StorageHealthResult,
} from './healthCheck';
