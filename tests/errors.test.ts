import { describe, expect, it } from 'vitest';
import { describeError } from '../src/errors.js';

const refused = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}:5433`), { code: 'ECONNREFUSED', address, port: 5433 });

describe('describeError', () => {
  it('describes AggregateError with empty message and hints at the database', () => {
    const err = Object.assign(new AggregateError([refused('::1'), refused('127.0.0.1')], ''), { code: 'ECONNREFUSED' });
    const msg = describeError(err);
    expect(msg).toContain('connect ECONNREFUSED ::1:5433; connect ECONNREFUSED 127.0.0.1:5433');
    expect(msg).toContain('pnpm db:up');
  });

  it('keeps regular messages and non-errors', () => {
    expect(describeError(new Error('Semanas inválidas'))).toBe('Semanas inválidas');
    expect(describeError('falhou')).toBe('falhou');
  });
});
