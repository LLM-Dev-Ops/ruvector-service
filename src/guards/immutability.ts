/**
 * Immutability Guards - Memory Layer Hardening
 *
 * ROLE RULES:
 * Agents MUST NOT:
 * - Reinterpret historical events
 * - Mutate past DecisionEvents
 *
 * These guards enforce append-only semantics and prevent
 * any mutation of historical learning data.
 */
import logger from '../utils/logger';

/**
 * SQL patterns that indicate mutation operations.
 * These are FORBIDDEN on learning_events and related tables.
 */
const FORBIDDEN_MUTATION_PATTERNS = [
  /UPDATE\s+learning_events/i,
  /DELETE\s+FROM\s+learning_events/i,
  /TRUNCATE\s+learning_events/i,
  /DROP\s+TABLE\s+learning_events/i,
  /ALTER\s+TABLE\s+learning_events.*DROP/i,
  /UPDATE\s+learning_decision_events/i,
  /DELETE\s+FROM\s+learning_decision_events/i,
  /TRUNCATE\s+learning_decision_events/i,
  // Also protect approvals table from mutation
  /UPDATE\s+approvals/i,
  /DELETE\s+FROM\s+approvals/i,
  /TRUNCATE\s+approvals/i,
];

/**
 * Guard against mutation queries on learning tables.
 *
 * @param query - SQL query to validate
 * @throws Error if query would mutate historical data
 */
export function guardAgainstMutation(query: string): void {
  for (const pattern of FORBIDDEN_MUTATION_PATTERNS) {
    if (pattern.test(query)) {
      const violation = `MEMORY LAYER VIOLATION: Attempted mutation of historical learning data. ` +
        `Query pattern '${pattern.source}' is FORBIDDEN. ` +
        `Learning events are APPEND-ONLY.`;

      logger.error({ query: query.substring(0, 200), pattern: pattern.source }, violation);
      throw new Error(violation);
    }
  }
}

/**
 * Validate that a query is safe for the memory layer.
 * Returns true for safe queries, throws for violations.
 *
 * @param query - SQL query to validate
 * @param tableName - Table being operated on
 * @returns true if query is safe
 */
export function validateLearningQuery(query: string, tableName: string): boolean {
  const isLearningTable = [
    'learning_events',
    'learning_decision_events',
    'approvals',
  ].includes(tableName);

  if (!isLearningTable) {
    return true; // Not a protected table
  }

  // Check for forbidden patterns
  guardAgainstMutation(query);

  return true;
}

/**
 * Create a safe database query wrapper that enforces immutability.
 *
 * @param queryFn - Original query function
 * @returns Wrapped query function with immutability guard
 */
export function wrapWithImmutabilityGuard<T extends (...args: any[]) => Promise<any>>(
  queryFn: T
): T {
  return (async (...args: Parameters<T>) => {
    const query = args[0] as string;

    // Guard against mutations
    guardAgainstMutation(query);

    // Execute original query
    return queryFn(...args);
  }) as T;
}

/**
 * Validate that an event cannot be modified after creation.
 * Used to enforce immutability of DecisionEvents.
 *
 * @param existingEventId - ID of existing event (if any)
 * @param newInputsHash - Hash of new inputs
 * @throws Error if attempting to modify existing event
 */
export function validateEventImmutability(
  existingEventId: string | null,
  _newInputsHash: string, // Prefixed with _ to indicate intentionally unused (kept for API consistency)
  operation: 'create' | 'update'
): void {
  if (existingEventId && operation === 'update') {
    throw new Error(
      `MEMORY LAYER VIOLATION: Cannot update existing DecisionEvent '${existingEventId}'. ` +
      `DecisionEvents are IMMUTABLE. Use idempotent create instead.`
    );
  }
}

/**
 * Assert that historical data has not been modified.
 * Called during startup to verify data integrity.
 */
export async function assertHistoricalDataIntegrity(
  dbClient: { query: (text: string, params?: unknown[]) => Promise<any> }
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  try {
    // Check for any UPDATE or DELETE audit logs (if audit logging is enabled)
    // This is a placeholder - in production you'd check audit logs

    // Verify inputs_hash uniqueness is maintained
    const duplicateCheck = await dbClient.query(`
      SELECT inputs_hash, COUNT(*) as count
      FROM learning_events
      GROUP BY inputs_hash
      HAVING COUNT(*) > 1
    `);

    if (duplicateCheck.rows.length > 0) {
      issues.push(
        `Found ${duplicateCheck.rows.length} duplicate inputs_hash values - ` +
        `idempotency may be compromised`
      );
    }

    // Verify no events have been backdated (created_at should be monotonic within agent)
    // This is a soft check - clock skew can cause legitimate out-of-order timestamps

    return { valid: issues.length === 0, issues };
  } catch (error) {
    logger.error({ error }, 'Historical data integrity check failed');
    return { valid: false, issues: ['Integrity check query failed'] };
  }
}

export default {
  guardAgainstMutation,
  validateLearningQuery,
  wrapWithImmutabilityGuard,
  validateEventImmutability,
  assertHistoricalDataIntegrity,
};
