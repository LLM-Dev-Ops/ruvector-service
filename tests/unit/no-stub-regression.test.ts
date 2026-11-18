/**
 * Regression guard (ADR-0001 Verification).
 *
 * The vector path shipped as stubs wrapped in production-grade observability,
 * so the service reported success while doing no work. These checks fail the
 * build if that pattern comes back.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../src');
const CLIENTS_DIR = join(SRC, 'clients');

/** Markers that accompanied the original hollow implementation. */
const STUB_MARKERS = [/TODO:\s*Implement actual/i, /Stub implementation/i];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('client stub regression guard', () => {
  const files = sourceFiles(CLIENTS_DIR);

  it('finds client sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s contains no stub markers', (file) => {
    const contents = readFileSync(file, 'utf8');
    for (const marker of STUB_MARKERS) {
      expect(contents).not.toMatch(marker);
    }
  });
});

describe('configuration defaults', () => {
  it('no source file defaults any endpoint to port 6379', () => {
    // 6379 is the Redis port. It was the default for a vector service that was
    // described as gRPC/TCP and reached over HTTP — three inconsistent claims
    // about an endpoint that never existed. The endpoint concept is now gone.
    const offenders = sourceFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('6379')
    );

    expect(offenders).toEqual([]);
  });

  it('no source file references a separate vector service URL', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /RUVV?ECTOR_SERVICE_URL/.test(readFileSync(file, 'utf8'))
    );

    expect(offenders).toEqual([]);
  });
});

describe('identity entitlement storage', () => {
  const databaseClient = readFileSync(join(CLIENTS_DIR, 'DatabaseClient.ts'), 'utf8');

  it('preserves the full safe-integer API-key limit range for new and existing tables', () => {
    expect(databaseClient).toMatch(/max_api_keys BIGINT NOT NULL/);
    expect(databaseClient).toMatch(
      /BEGIN;[\s\S]*DROP VIEW IF EXISTS data_plane_identity_lookup;[\s\S]*ALTER TABLE data_plane_identity_organizations[\s\S]*ALTER COLUMN max_api_keys TYPE BIGINT;[\s\S]*CREATE VIEW data_plane_identity_lookup AS[\s\S]*COMMIT;/
    );
    expect(databaseClient).toMatch(
      /CREATE VIEW data_plane_identity_lookup AS[\s\S]*k\.scopes/
    );
    expect(databaseClient).not.toMatch(/max_api_keys INTEGER NOT NULL/);
  });
});
