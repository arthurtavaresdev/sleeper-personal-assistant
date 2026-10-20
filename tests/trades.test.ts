import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from '../src/analysis/context.js';
import { analyzeTrades, dynastyFactor } from '../src/analysis/trades.js';
import { suggestFaab } from '../src/analysis/waivers.js';
import { parseLeague, type TeamRoster } from '../src/league/settings.js';
import type { Projection } from '../src/model/projection.js';
import type { RosValue } from '../src/model/service.js';
import { HALF_PPR_LEAGUE } from './fixtures/league.js';

const WEEKS = [7, 8, 9];

function proj(id: string, position: string, mean: number): Projection {
  return { sleeperId: id, name: id, position, fantasyPositions: [position], team: 'XX', age: 25, opponent: 'YY',
    injuryStatus: null, mean, sd: 1, p20: mean, p80: mean, stats: {} };
}

function buildCtx(players: Projection[], rosters: Record<number, string[]>): AnalysisContext {
  const league = parseLeague({ ...HALF_PPR_LEAGUE, roster_positions: ['QB', 'RB', 'WR', 'BN', 'BN'] });
  const weekProj = new Map(players.map((p) => [p.sleeperId, p]));
  const ros = new Map<string, RosValue>(players.map((p) => [p.sleeperId,
    { total: p.mean * WEEKS.length, weeks: WEEKS.length, perWeek: new Map(WEEKS.map((w) => [w, p.mean])) }]));
  const teams: TeamRoster[] = Object.entries(rosters).map(([id, ps]) => ({
    rosterId: Number(id), ownerId: `u${id}`, ownerName: `Time ${id}`, players: ps, starters: [], reserve: [], taxi: [], faabUsed: 0 }));
  return { league, season: 2026, week: 7, rosters: teams, mine: teams[0]!, rostered: new Set(teams.flatMap((t) => t.players)), weekProj, ros };
}

describe('trade search', () => {
  it('finds the trade that fixes both teams (surplus QB for surplus RB)', async () => {
    const ctx = buildCtx(
      [proj('qbA', 'QB', 20), proj('qbB', 'QB', 18), proj('rbWeak', 'RB', 5), proj('wr1', 'WR', 10),
       proj('qbC', 'QB', 8), proj('rbStrong', 'RB', 15), proj('rb2', 'RB', 14), proj('wr2', 'WR', 10),
       proj('faQB', 'QB', 6), proj('faRB', 'RB', 4), proj('faWR', 'WR', 4)],
      { 1: ['qbA', 'qbB', 'rbWeak', 'wr1'], 2: ['qbC', 'rbStrong', 'rb2', 'wr2'] },
    );
    const [best] = await analyzeTrades(ctx);
    expect(best!.give.map((p) => p.sleeperId)).toEqual(['qbB']);
    expect(best!.get.map((p) => p.sleeperId)).toEqual(['rbStrong']);
    expect(best!.myGain).toBeGreaterThan(0);
    expect(best!.theirGain).toBeGreaterThan(0);
  });

  it('does not suggest trades that only help me at the partner expense', async () => {
    const ctx = buildCtx(
      [proj('qbA', 'QB', 20), proj('rbA', 'RB', 5), proj('wrA', 'WR', 10),
       proj('qbB', 'QB', 8), proj('rbB', 'RB', 15), proj('wrB', 'WR', 10), proj('faRB', 'RB', 2)],
      { 1: ['qbA', 'rbA', 'wrA'], 2: ['qbB', 'rbB', 'wrB'] },
    );
    const ideas = await analyzeTrades(ctx);
    for (const t of ideas) expect(t.theirGain).toBeGreaterThanOrEqual(-2);
  });
});

describe('valuation helpers', () => {
  it('values young players higher in dynasty and decays after the age peak', () => {
    expect(dynastyFactor('RB', 22)).toBeGreaterThan(1);
    expect(dynastyFactor('RB', 30)).toBeLessThan(1);
    expect(dynastyFactor('QB', 30)).toBeGreaterThan(dynastyFactor('RB', 30));
    expect(dynastyFactor('WR', null)).toBe(1);
  });

  it('scales FAAB bids with weekly gain and caps them', () => {
    expect(suggestFaab({ rosGain: 10, trendingAdds: 0 }, 100, 10)).toBe(6);
    expect(suggestFaab({ rosGain: 1000, trendingAdds: 0 }, 100, 10)).toBe(40);
    expect(suggestFaab({ rosGain: 10, trendingAdds: 50000 }, 100, 10)).toBe(8);
    expect(suggestFaab({ rosGain: 10, trendingAdds: 0 }, 0, 10)).toBe(0);
  });
});
