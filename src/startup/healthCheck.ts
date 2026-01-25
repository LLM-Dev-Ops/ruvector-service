/**
 * Startup Health Check - Storage & Index Verification
 *
 * CRITICAL: Verify storage and index health before accepting traffic.
 * CRASH ON FAILURE - do not proceed with unhealthy storage.
 */
import { DatabaseClient } from '../clients/DatabaseClient';
import logger from '../utils/logger';

export interface StorageHealthResult {
  healthy: boolean;
  database: {
    connected: boolean;
    ping_ms: number;
  };
  tables: {
    verified: boolean;
    missing: string[];
  };
  indexes: {
    verified: boolean;
    missing: string[];
  };
}

/**
 * Required tables for memory layer operation.
 */
const REQUIRED_TABLES = [
  'decisions',
  'approvals',
  'learning_weights',
  'learning_events',
] as const;

/**
 * Required indexes for memory layer performance.
 */
const REQUIRED_INDEXES = [
  // Decisions indexes
  'idx_decisions_created_at',
  'idx_decisions_objective',
  'idx_decisions_confidence',
  // Approvals indexes
  'idx_approvals_decision_id',
  'idx_approvals_created_at',
  // Learning weights indexes
  'idx_learning_weights_source',
  'idx_learning_weights_target',
  'idx_learning_weights_weight',
  // Learning events indexes
  'idx_learning_events_agent_id',
  'idx_learning_events_decision_type',
  'idx_learning_events_created_at',
  'idx_learning_events_inputs_hash_unique',
] as const;

/**
 * Verify database connectivity with ping.
 */
async function verifyDatabaseConnection(
  dbClient: DatabaseClient
): Promise<{ connected: boolean; ping_ms: number }> {
  const start = Date.now();
  try {
    const connected = await dbClient.ping();
    const ping_ms = Date.now() - start;
    return { connected, ping_ms };
  } catch (error) {
    logger.error({ error }, 'Database connectivity check failed');
    return { connected: false, ping_ms: -1 };
  }
}

/**
 * Verify required tables exist.
 */
async function verifyTables(
  dbClient: DatabaseClient
): Promise<{ verified: boolean; missing: string[] }> {
  const missing: string[] = [];

  try {
    const result = await dbClient.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    const existingTables = new Set(result.rows.map(r => r.tablename));

    for (const table of REQUIRED_TABLES) {
      if (!existingTables.has(table)) {
        missing.push(table);
      }
    }

    return { verified: missing.length === 0, missing };
  } catch (error) {
    logger.error({ error }, 'Table verification failed');
    return { verified: false, missing: [...REQUIRED_TABLES] };
  }
}

/**
 * Verify required indexes exist.
 */
async function verifyIndexes(
  dbClient: DatabaseClient
): Promise<{ verified: boolean; missing: string[] }> {
  const missing: string[] = [];

  try {
    const result = await dbClient.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const existingIndexes = new Set(result.rows.map(r => r.indexname));

    for (const index of REQUIRED_INDEXES) {
      if (!existingIndexes.has(index)) {
        missing.push(index);
      }
    }

    return { verified: missing.length === 0, missing };
  } catch (error) {
    logger.error({ error }, 'Index verification failed');
    return { verified: false, missing: [...REQUIRED_INDEXES] };
  }
}

/**
 * Verify append-only constraints are in place.
 * Checks that learning_events has unique constraint on inputs_hash.
 */
async function verifyAppendOnlyConstraints(
  dbClient: DatabaseClient
): Promise<boolean> {
  try {
    const result = await dbClient.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'learning_events' AND constraint_type = 'UNIQUE'`
    );

    // Check for unique constraint on inputs_hash
    const hasUniqueConstraint = result.rows.some(
      (r) => (r as { constraint_name: string }).constraint_name.includes('inputs_hash')
    );

    if (!hasUniqueConstraint) {
      logger.warn(
        'learning_events table missing unique constraint on inputs_hash - idempotency may be compromised'
      );
    }

    return hasUniqueConstraint;
  } catch (error) {
    logger.error({ error }, 'Append-only constraint verification failed');
    return false;
  }
}

/**
 * Run complete storage health verification.
 * CRASHES on failure if in production mode.
 *
 * @param dbClient - Database client to verify
 * @throws Error if storage is unhealthy in production
 */
export async function verifyStorageHealth(
  dbClient: DatabaseClient
): Promise<StorageHealthResult> {
  const isProduction = process.env.NODE_ENV === 'production';

  logger.info('Verifying storage health...');

  // Run all checks in parallel
  const [database, tables, indexes, appendOnlyOk] = await Promise.all([
    verifyDatabaseConnection(dbClient),
    verifyTables(dbClient),
    verifyIndexes(dbClient),
    verifyAppendOnlyConstraints(dbClient),
  ]);

  const healthy = database.connected && tables.verified && indexes.verified;

  const result: StorageHealthResult = {
    healthy,
    database,
    tables,
    indexes,
  };

  // Log health status
  logger.info(
    {
      healthy,
      database_connected: database.connected,
      database_ping_ms: database.ping_ms,
      tables_verified: tables.verified,
      tables_missing: tables.missing,
      indexes_verified: indexes.verified,
      indexes_missing: indexes.missing,
      append_only_constraints: appendOnlyOk,
    },
    'Storage health verification complete'
  );

  // CRASH in production if storage is unhealthy
  if (!healthy && isProduction) {
    const errors: string[] = [];

    if (!database.connected) {
      errors.push('Database connection failed');
    }
    if (!tables.verified) {
      errors.push(`Missing tables: ${tables.missing.join(', ')}`);
    }
    if (!indexes.verified) {
      errors.push(`Missing indexes: ${indexes.missing.join(', ')}`);
    }

    throw new Error(
      `FATAL: Storage health check failed. Errors: ${errors.join('; ')}. ` +
      `Service cannot start safely without healthy storage.`
    );
  }

  if (!healthy) {
    logger.warn(
      { result },
      'Storage health check failed in development mode - proceeding with caution'
    );
  }

  return result;
}

/**
 * Run quick health check (for /health endpoint).
 * Does not crash on failure - returns health status.
 */
export async function quickHealthCheck(
  dbClient: DatabaseClient
): Promise<{ healthy: boolean; ping_ms: number }> {
  const { connected, ping_ms } = await verifyDatabaseConnection(dbClient);
  return { healthy: connected, ping_ms };
}

export default {
  verifyStorageHealth,
  quickHealthCheck,
};
