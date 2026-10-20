import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/league/selection.js', () => ({ selectedLeagueIds: vi.fn(async () => ['111', '222']) }));
vi.mock('../src/jobs/sync.js', () => ({ runSync: vi.fn(async () => ({ season: 2026, week: 7 })) }));
vi.mock('../src/analysis/context.js', () => ({ loadContext: vi.fn(async (_s, _w, opts) => ({ league: { id: opts.leagueId, name: `League ${opts.leagueId}` }, week: 7, weekProj: new Map() })) }));
vi.mock('../src/analysis/lineup.js', () => ({ analyzeLineup: vi.fn(async () => ({})) }));
vi.mock('../src/notify/format.js', () => ({ formatLineup: vi.fn((_r, _p, name) => name) }));
vi.mock('../src/league/settings.js', () => ({ loadLeague: vi.fn(async id => ({ name: `League ${id}` })), activePlayers: vi.fn() }));
vi.mock('../src/db/index.js', () => ({ withJobLock: vi.fn(async (_name, fn) => fn()), sql: vi.fn() }));
import { runLineupJob } from '../src/jobs/analysis.js';
import { runSync } from '../src/jobs/sync.js';
import { loadContext } from '../src/analysis/context.js';
afterEach(() => vi.clearAllMocks());
describe('multi-league analysis', () => {
  it('passes each league explicitly through sync and context and labels both reports', async () => {
    const result = await runLineupJob();
    expect(runSync).toHaveBeenCalledWith({ leagueId: '111' });
    expect(runSync).toHaveBeenCalledWith({ leagueId: '222' });
    expect(loadContext).toHaveBeenCalledWith(2026, 7, { leagueId: '222' });
    expect(result.text).toContain('League 111');
    expect(result.text).toContain('League 222');
    expect(result.delivered).toBe(false);
  });
  it('continues with the second league if the first fails', async () => {
    vi.mocked(runSync).mockRejectedValueOnce(new Error('source unavailable'));
    const result = await runLineupJob();
    expect(result.text).toContain('source unavailable');
    expect(result.text).toContain('League 222');
  });
});
