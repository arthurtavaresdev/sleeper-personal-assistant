import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config.js';
import { sleeper } from '../src/sleeper/client.js';
import { parseLeagueIds, selectedLeagueIds } from '../src/league/selection.js';
const original = { ...config };
afterEach(() => { Object.assign(config, original); vi.restoreAllMocks(); });
describe('league selection', () => {
  it('trims and deduplicates IDs without converting big integers', () => {
    expect(parseLeagueIds('1389707052531601408, 1336841924551675904,1389707052531601408')).toEqual(['1389707052531601408', '1336841924551675904']);
    expect(() => parseLeagueIds('123,garbage')).toThrow();
  });
  it('uses both configured leagues and allows selecting only one', async () => {
    config.LEAGUE_IDS = '111,222';
    expect(await selectedLeagueIds()).toEqual(['111','222']);
    expect(await selectedLeagueIds('222')).toEqual(['222']);
  });
  it('keeps legacy single-league configuration working', async () => {
    config.LEAGUE_IDS = ''; config.LEAGUE_ID = '111';
    expect(await selectedLeagueIds()).toEqual(['111']);
  });
  it('discovers all current leagues when auto is explicit', async () => {
    config.LEAGUE_IDS = 'auto'; config.SLEEPER_USERNAME = 'test';
    vi.spyOn(sleeper, 'user').mockResolvedValue({ user_id: '1' });
    vi.spyOn(sleeper, 'state').mockResolvedValue({ season: '2026', week: 7, season_type: 'regular' });
    vi.spyOn(sleeper, 'userLeagues').mockResolvedValue([{ league_id: '111' }, { league_id: '222' }] as never);
    expect(await selectedLeagueIds()).toEqual(['111', '222']);
  });
});
