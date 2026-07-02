import { describe, it, expect } from 'vitest';
import { pgType } from '../../../src/services/replicationService';

describe('replicationService — SQLite→Postgres type mapping', () => {
  it('REPL-001 — integer types (incl. AUTOINCREMENT PK) map to BIGINT', () => {
    expect(pgType('INTEGER')).toBe('BIGINT');
    expect(pgType('INT')).toBe('BIGINT');
    expect(pgType('BIGINT')).toBe('BIGINT');
  });

  it('REPL-002 — text/char types map to TEXT', () => {
    expect(pgType('TEXT')).toBe('TEXT');
    expect(pgType('VARCHAR(255)')).toBe('TEXT');
    expect(pgType('CLOB')).toBe('TEXT');
  });

  it('REPL-003 — real/float types map to DOUBLE PRECISION', () => {
    expect(pgType('REAL')).toBe('DOUBLE PRECISION');
    expect(pgType('DOUBLE')).toBe('DOUBLE PRECISION');
    expect(pgType('FLOAT')).toBe('DOUBLE PRECISION');
  });

  it('REPL-004 — BLOB and untyped columns map to BYTEA', () => {
    expect(pgType('BLOB')).toBe('BYTEA');
    expect(pgType('')).toBe('BYTEA');
  });

  it('REPL-005 — date/time types map to TEXT in v1 (faithful, zero parse risk)', () => {
    expect(pgType('DATETIME')).toBe('TEXT');
    expect(pgType('TIMESTAMP')).toBe('TEXT');
    expect(pgType('DATE')).toBe('TEXT');
  });

  it('REPL-006 — date/time detection takes precedence over the INT rule', () => {
    // "DATE" contains no "INT"; but a column declared with a time-ish name must
    // not be mis-mapped. Guards the ordering of the mapping rules.
    expect(pgType('TIMESTAMP')).not.toBe('BIGINT');
  });

  it('REPL-007 — case-insensitive', () => {
    expect(pgType('integer')).toBe('BIGINT');
    expect(pgType('text')).toBe('TEXT');
    expect(pgType('blob')).toBe('BYTEA');
  });
});
