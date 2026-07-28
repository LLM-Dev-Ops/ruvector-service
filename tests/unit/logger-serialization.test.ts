import pino from 'pino';
import { loggerSerializers } from '../../src/utils/logger';

function captureRecords(serializers: pino.LoggerOptions['serializers']): {
  log: pino.Logger;
  records: Record<string, any>[];
} {
  const records: Record<string, any>[] = [];
  const destination = {
    write(chunk: string) {
      records.push(JSON.parse(chunk));
    },
  };
  return { log: pino({ level: 'fatal', serializers }, destination), records };
}

describe('logger error serialization', () => {
  it('serializes an Error logged under the "error" key', () => {
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ error: new Error('boom') }, 'Failed to start server');

    expect(records).toHaveLength(1);
    expect(records[0].error).toEqual(
      expect.objectContaining({
        type: 'Error',
        message: 'boom',
      })
    );
    expect(records[0].error.stack).toMatch(/logger-serialization\.test\.ts/);
  });

  it('reports the concrete error class rather than a bare "Error"', () => {
    class DimensionError extends Error {}
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ error: new DimensionError('FATAL: RUVVECTOR_EMBEDDING_DIM is required') }, 'x');

    expect(records[0].error.type).toBe('DimensionError');
    expect(records[0].error.message).toBe('FATAL: RUVVECTOR_EMBEDDING_DIM is required');
  });

  it('serializes an Error logged under the "reason" key', () => {
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ reason: new Error('rejected') }, 'Unhandled promise rejection');

    expect(records[0].reason.message).toBe('rejected');
    expect(records[0].reason.stack).toBeTruthy();
  });

  it('walks the cause chain', () => {
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ error: new Error('outer', { cause: new Error('inner') }) }, 'x');

    expect(records[0].error.message).toContain('inner');
  });

  it('passes non-Error values through untouched', () => {
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ error: 'plain string' }, 'x');
    log.fatal({ error: { code: 'ENOENT' } }, 'x');

    expect(records[0].error).toBe('plain string');
    expect(records[1].error).toEqual({ code: 'ENOENT' });
  });

  it('still serializes the "err" key', () => {
    const { log, records } = captureRecords(loggerSerializers);

    log.fatal({ err: new Error('legacy key') }, 'x');

    expect(records[0].err.message).toBe('legacy key');
  });

  // Pins the exact defect this test file exists to prevent: an Error logged under a key
  // with no registered serializer renders as `{}`, because message/stack/name are
  // non-enumerable. This is what shipped to production as `{"error":{}}`.
  it('demonstrates the swallowed-error bug when "error" is not registered', () => {
    const { log, records } = captureRecords({ err: pino.stdSerializers.err });

    log.fatal({ error: new Error('boom') }, 'Failed to start server');

    expect(records[0].error).toEqual({});
  });
});
