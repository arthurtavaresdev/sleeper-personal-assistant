import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/league/selection.js', () => ({ selectedLeagueIds: vi.fn(async () => ['111', '222']) }));
vi.mock('../src/jobs/sync.js', () => ({ runSync: vi.fn(async () => ({ season: 2026, week: 7 })) }));
vi.mock('../src/analysis/context.js', () => ({ loadContext: vi.fn(async (_s, _w, opts) => ({ league: { id: opts.leagueId, name: opts.leagueId }, mine: { rosterId: 1, ownerId: 'u1' }, weekProj: new Map() })) }));
vi.mock('../src/sleeper/graphql.js', () => ({ graphqlConfigured: () => true, myTradeInbox: vi.fn(async (id) => [{ transaction_id: 'same-id', league_id: id }]) }));
vi.mock('../src/analysis/inbox.js', () => ({ analyzeInbox: vi.fn(async (_ctx, trades) => trades.map((t: { transaction_id: string }) => ({ transactionId: t.transaction_id }))), tradeFingerprint: () => 'fingerprint' }));
vi.mock('../src/notify/inbox.js', () => ({ formatInbox: () => 'report' }));
vi.mock('../src/notify/outbox.js', () => ({ enqueue: vi.fn(async () => true), drainOutbox: vi.fn(async () => 1) }));
vi.mock('../src/league/settings.js', () => ({ loadLeague: vi.fn(async id => ({ name: id })), activePlayers: vi.fn() }));
vi.mock('../src/db/index.js', () => ({ withJobLock: vi.fn(async (_name, fn) => fn()), sql: vi.fn() }));
import { runInboxJob } from '../src/jobs/analysis.js';
import { myTradeInbox } from '../src/sleeper/graphql.js';
import { enqueue } from '../src/notify/outbox.js';
afterEach(() => { vi.clearAllMocks(); });
describe('inbox jobs', () => {
  it('deduplicates automatic alerts by league and offer fingerprint, not report text', async () => {
    await runInboxJob({ notify: true, newOnly: true });
    expect(enqueue).toHaveBeenCalledWith('inbox', '111:same-id:fingerprint', expect.stringContaining('report'), { dedupeByScope: true });
    expect(enqueue).toHaveBeenCalledWith('inbox', '222:same-id:fingerprint', expect.stringContaining('report'), { dedupeByScope: true });
  });
  it('is silent on a scheduled check with no incoming offers', async () => {
    vi.mocked(myTradeInbox).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await runInboxJob({ notify: true, newOnly: true });
    expect(result.delivered).toBe(true); expect(enqueue).not.toHaveBeenCalled();
  });
  it('keeps the other league available when one inbox fails', async () => {
    vi.mocked(myTradeInbox).mockRejectedValueOnce(new Error('token expired'));
    const result = await runInboxJob();
    expect(result.text).toContain('token expired'); expect(result.text).toContain('report');
  });
});
