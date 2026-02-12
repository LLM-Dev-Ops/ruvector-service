import {
  mintExecutionId,
  isValidExecutionId,
  generateRootSpanId,
  signExecution,
  verifyExecutionSignature,
  EXECUTION_ID_PREFIX,
} from '../../src/utils/executionAuthority';

describe('Execution Authority Utilities', () => {
  const TEST_SECRET = 'test-hmac-secret-minimum-32-chars-long-for-testing-only';

  describe('mintExecutionId', () => {
    it('should mint an execution_id with correct prefix', () => {
      const id = mintExecutionId();
      expect(id).toBeDefined();
      expect(id.startsWith(EXECUTION_ID_PREFIX)).toBe(true);
    });

    it('should mint unique execution_ids', () => {
      const id1 = mintExecutionId();
      const id2 = mintExecutionId();
      expect(id1).not.toBe(id2);
    });

    it('should contain a valid UUID after the prefix', () => {
      const id = mintExecutionId();
      const uuidPart = id.slice(EXECUTION_ID_PREFIX.length);
      expect(uuidPart).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('isValidExecutionId', () => {
    it('should return true for valid execution_id', () => {
      const id = mintExecutionId();
      expect(isValidExecutionId(id)).toBe(true);
    });

    it('should return false for missing prefix', () => {
      expect(isValidExecutionId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('should return false for wrong prefix', () => {
      expect(isValidExecutionId('run-550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('should return false for invalid UUID portion', () => {
      expect(isValidExecutionId('exec-not-a-uuid')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidExecutionId('')).toBe(false);
    });
  });

  describe('generateRootSpanId', () => {
    it('should generate a valid UUID', () => {
      const spanId = generateRootSpanId();
      expect(spanId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should generate unique span IDs', () => {
      const span1 = generateRootSpanId();
      const span2 = generateRootSpanId();
      expect(span1).not.toBe(span2);
    });
  });

  describe('signExecution', () => {
    it('should produce a valid hex signature (64 chars for SHA-256)', () => {
      const sig = signExecution('exec-123', '2024-01-01T00:00:00Z', TEST_SECRET);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce deterministic signatures for same inputs', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const execId = 'exec-550e8400-e29b-41d4-a716-446655440000';
      const sig1 = signExecution(execId, timestamp, TEST_SECRET);
      const sig2 = signExecution(execId, timestamp, TEST_SECRET);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different execution_ids', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const sig1 = signExecution('exec-aaa', timestamp, TEST_SECRET);
      const sig2 = signExecution('exec-bbb', timestamp, TEST_SECRET);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('verifyExecutionSignature', () => {
    it('should verify a valid signature', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const execId = mintExecutionId();
      const sig = signExecution(execId, timestamp, TEST_SECRET);
      expect(verifyExecutionSignature(execId, timestamp, sig, TEST_SECRET)).toBe(true);
    });

    it('should reject a tampered execution_id', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const execId = mintExecutionId();
      const sig = signExecution(execId, timestamp, TEST_SECRET);
      expect(verifyExecutionSignature('exec-tampered', timestamp, sig, TEST_SECRET)).toBe(false);
    });

    it('should reject a tampered timestamp', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const execId = mintExecutionId();
      const sig = signExecution(execId, timestamp, TEST_SECRET);
      expect(verifyExecutionSignature(execId, '2025-01-01T00:00:00Z', sig, TEST_SECRET)).toBe(false);
    });

    it('should reject a signature from a different secret', () => {
      const timestamp = '2024-01-01T00:00:00Z';
      const execId = mintExecutionId();
      const sig = signExecution(execId, timestamp, 'wrong-secret-that-is-long-enough-32chars');
      expect(verifyExecutionSignature(execId, timestamp, sig, TEST_SECRET)).toBe(false);
    });

    it('should reject a malformed signature', () => {
      const execId = mintExecutionId();
      expect(verifyExecutionSignature(execId, '2024-01-01T00:00:00Z', 'not-hex', TEST_SECRET)).toBe(false);
    });
  });
});
