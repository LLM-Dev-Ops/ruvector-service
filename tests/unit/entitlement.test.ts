import {
  checkEntitlement,
  decodeEntitlementContext,
  encodeEntitlementContext
} from '../../src/utils/entitlement';
import { EntitlementContext } from '../../src/types';

describe('Entitlement - SPARC Compliant', () => {
  describe('encodeEntitlementContext', () => {
    it('should encode context to Base64', () => {
      const context: EntitlementContext = {
        tenant: 'test-tenant',
        scope: 'ingest'
      };

      const encoded = encodeEntitlementContext(context);
      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');

      // Verify it's valid Base64
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      expect(JSON.parse(decoded)).toEqual(context);
    });
  });

  describe('decodeEntitlementContext', () => {
    it('should decode valid Base64 context', () => {
      const context: EntitlementContext = {
        tenant: 'test-tenant',
        scope: 'query'
      };
      const encoded = encodeEntitlementContext(context);

      const decoded = decodeEntitlementContext(encoded);

      expect(decoded.tenant).toBe('test-tenant');
      expect(decoded.scope).toBe('query');
    });

    it('should throw on invalid Base64', () => {
      expect(() => decodeEntitlementContext('not-valid-base64!!!')).toThrow();
    });

    it('should throw on invalid JSON', () => {
      const invalidJson = Buffer.from('not json').toString('base64');
      expect(() => decodeEntitlementContext(invalidJson)).toThrow();
    });
  });

  describe('checkEntitlement', () => {
    it('should return allowed: true for valid entitlement context', () => {
      const context: EntitlementContext = {
        tenant: 'test-tenant',
        scope: 'ingest'
      };
      const encoded = encodeEntitlementContext(context);

      const result = checkEntitlement(encoded);

      expect(result.allowed).toBe(true);
      expect(result.tenant).toBe('test-tenant');
      expect(result.scope).toBe('ingest');
    });

    it('should return allowed: false for missing context', () => {
      const result = checkEntitlement(undefined);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Missing entitlement context');
    });

    it('should return allowed: false for empty context', () => {
      const result = checkEntitlement('');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Missing entitlement context');
    });

    it('should return allowed: false for whitespace-only context', () => {
      const result = checkEntitlement('   ');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Missing entitlement context');
    });

    it('should return allowed: false for invalid Base64', () => {
      const result = checkEntitlement('invalid-base64!!!');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Entitlement decode error');
    });

    it('should return allowed: false for missing tenant', () => {
      const context = { scope: 'ingest' };
      const encoded = Buffer.from(JSON.stringify(context)).toString('base64');

      const result = checkEntitlement(encoded);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Invalid entitlement structure');
    });

    it('should return allowed: false for missing scope', () => {
      const context = { tenant: 'test-tenant' };
      const encoded = Buffer.from(JSON.stringify(context)).toString('base64');

      const result = checkEntitlement(encoded);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Invalid entitlement structure');
    });

    it('should accept context with optional fields', () => {
      const context: EntitlementContext = {
        tenant: 'test-tenant',
        scope: 'simulate',
        tier: 'premium',
        limits: { maxRequests: 1000 }
      };
      const encoded = encodeEntitlementContext(context);

      const result = checkEntitlement(encoded);

      expect(result.allowed).toBe(true);
      expect(result.tenant).toBe('test-tenant');
      expect(result.scope).toBe('simulate');
    });
  });
});
