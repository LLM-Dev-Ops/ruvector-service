import { generateCorrelationId, getOrCreateCorrelationId } from '../../src/utils/correlation';

describe('Correlation Utilities', () => {
  describe('generateCorrelationId', () => {
    it('should generate a valid UUID', () => {
      const id = generateCorrelationId();

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate unique IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(id1).not.toBe(id2);
    });
  });

  describe('getOrCreateCorrelationId', () => {
    it('should extract correlation ID from x-correlation-id header', () => {
      const headers = {
        'x-correlation-id': 'test-correlation-id',
      };

      const id = getOrCreateCorrelationId(headers);
      expect(id).toBe('test-correlation-id');
    });

    it('should extract correlation ID from x-request-id header', () => {
      const headers = {
        'x-request-id': 'test-request-id',
      };

      const id = getOrCreateCorrelationId(headers);
      expect(id).toBe('test-request-id');
    });

    it('should prefer x-correlation-id over x-request-id', () => {
      const headers = {
        'x-correlation-id': 'correlation-id',
        'x-request-id': 'request-id',
      };

      const id = getOrCreateCorrelationId(headers);
      expect(id).toBe('correlation-id');
    });

    it('should generate new ID if no header present', () => {
      const headers = {};

      const id = getOrCreateCorrelationId(headers);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should handle array header values', () => {
      const headers = {
        'x-correlation-id': ['first-id', 'second-id'],
      };

      const id = getOrCreateCorrelationId(headers);
      expect(id).toBe('first-id');
    });
  });
});
