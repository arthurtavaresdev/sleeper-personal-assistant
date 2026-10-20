import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/db/index.js', () => ({ sql: vi.fn(async () => [{ id: 1 }]) }));
import { sql } from '../src/db/index.js';
import { enqueue } from '../src/notify/outbox.js';
afterEach(() => vi.clearAllMocks());
const keys = () => vi.mocked(sql).mock.calls.map(call => (call as unknown[])[2]);
describe('outbox deduplication', () => {
  it('uses stable scope for event alerts even when projections change the text', async () => {
    await enqueue('inbox', 'league:offer:version', 'first evaluation', { dedupeByScope: true });
    await enqueue('inbox', 'league:offer:version', 'changed evaluation', { dedupeByScope: true });
    expect(keys()).toEqual(['inbox:league:offer:version', 'inbox:league:offer:version']);
  });
  it('preserves content hashing for existing reports', async () => {
    await enqueue('waivers', 'week', 'first'); await enqueue('waivers', 'week', 'second');
    expect(keys()[0]).not.toEqual(keys()[1]);
  });
});
