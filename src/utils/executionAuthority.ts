/**
 * Execution Authority Utilities
 *
 * Implements canonical execution_id minting and HMAC-SHA256 authority signing.
 * ruvvector-service is the ONLY service authorized to mint execution_ids.
 * No other service may mint or substitute execution_ids.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Execution ID prefix - deterministic identifier for ruvvector-minted IDs.
 * Any execution_id not starting with this prefix was NOT minted by this authority.
 */
export const EXECUTION_ID_PREFIX = 'exec-';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mint a new canonical execution_id.
 * Format: "exec-{uuid}"
 *
 * ONLY ruvvector-service may call this function.
 * No other service may mint or substitute execution_ids.
 */
export function mintExecutionId(): string {
  return `${EXECUTION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Validate that an execution_id was minted by this authority.
 * Checks prefix format and UUID structure.
 */
export function isValidExecutionId(executionId: string): boolean {
  if (!executionId.startsWith(EXECUTION_ID_PREFIX)) {
    return false;
  }
  const uuidPart = executionId.slice(EXECUTION_ID_PREFIX.length);
  return UUID_REGEX.test(uuidPart);
}

/**
 * Generate root span ID for an execution.
 * This span is the ROOT of the entire execution trace tree.
 * type: "execution_root", parent_span_id: null.
 * All downstream spans MUST descend from this.
 */
export function generateRootSpanId(): string {
  return randomUUID();
}

/**
 * Sign an execution acceptance using HMAC-SHA256.
 *
 * The signature covers: execution_id + ":" + acceptance_timestamp
 * This proves the execution was accepted by ruvvector-service at the given time.
 *
 * @param executionId - The minted execution_id
 * @param timestamp - ISO timestamp of acceptance
 * @param secret - HMAC secret key (from EXECUTION_HMAC_SECRET env var)
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function signExecution(
  executionId: string,
  timestamp: string,
  secret: string
): string {
  const payload = `${executionId}:${timestamp}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an execution authority signature.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param executionId - The execution_id to verify
 * @param timestamp - The claimed acceptance timestamp
 * @param signature - The signature to verify
 * @param secret - HMAC secret key
 * @returns true if signature is valid
 */
export function verifyExecutionSignature(
  executionId: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = signExecution(executionId, timestamp, secret);
  if (expectedSignature.length !== signature.length) {
    return false;
  }
  try {
    const expected = Buffer.from(expectedSignature, 'hex');
    const actual = Buffer.from(signature, 'hex');
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
