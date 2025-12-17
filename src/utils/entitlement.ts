import { EntitlementContext } from '../types';
import logger from './logger';

/**
 * Entitlement check result
 */
export interface EntitlementResult {
  allowed: boolean;
  tenant?: string;
  scope?: string;
  reason?: string;
}

/**
 * Decode Base64 entitlement context
 * SPARC spec: x-entitlement-context header contains Base64-encoded JSON
 */
export function decodeEntitlementContext(encodedContext: string): EntitlementContext {
  try {
    const decoded = Buffer.from(encodedContext, 'base64').toString('utf-8');
    return JSON.parse(decoded) as EntitlementContext;
  } catch (error) {
    throw new Error('Entitlement decode error');
  }
}

/**
 * Check entitlement - SPARC compliant stub
 *
 * Per SPARC specification:
 * - Validates entitlement format only
 * - Actual entitlement enforcement is deferred to gateway/mesh layer
 * - No billing logic implemented
 * - No quota enforcement
 * - No rate limiting
 * - No tier/plan validation
 *
 * Always returns allowed: true if format is valid
 */
export function checkEntitlement(entitlementContext: string | undefined): EntitlementResult {
  // SPARC: IF entitlementContext IS NULL OR entitlementContext IS EMPTY
  if (!entitlementContext || entitlementContext.trim() === '') {
    return {
      allowed: false,
      reason: 'Missing entitlement context'
    };
  }

  try {
    // SPARC: parsed = decodeEntitlementContext(entitlementContext)
    const parsed = decodeEntitlementContext(entitlementContext);

    // SPARC: Validate structure only - no business rules
    // IF NOT hasRequiredFields(parsed, ['tenant', 'scope'])
    if (!parsed.tenant || !parsed.scope) {
      return {
        allowed: false,
        reason: 'Invalid entitlement structure'
      };
    }

    // Log for observability (SPARC: logEntitlementCheck)
    logger.debug(
      { tenant: parsed.tenant, scope: parsed.scope },
      'Entitlement check passed'
    );

    // SPARC: Always allow - real enforcement happens upstream
    return {
      allowed: true,
      tenant: parsed.tenant,
      scope: parsed.scope
    };

  } catch (error) {
    // SPARC: CATCH error → RETURN { allowed: false, reason: 'Entitlement decode error' }
    return {
      allowed: false,
      reason: 'Entitlement decode error'
    };
  }
}

/**
 * Encode entitlement context to Base64 (utility for testing)
 */
export function encodeEntitlementContext(context: EntitlementContext): string {
  return Buffer.from(JSON.stringify(context)).toString('base64');
}

export default { checkEntitlement, decodeEntitlementContext, encodeEntitlementContext };
