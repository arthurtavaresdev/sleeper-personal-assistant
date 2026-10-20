import { describe, expect, it } from 'vitest';
import type { AnalysisContext } from '../src/analysis/context.js';
import { analyzeTrades, dynastyFactor, positionalTradeFactor, replacementLevels, tradeMarketValue } from '../src/analysis/trades.js';
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
    rosterId: Number(id), ownerId: `u${id}`, ownerName: `Time ${id}`, players: ps, starters: [], reserve: [], taxi: [], faabUsed: 0, waiverPosition: Number(id) }));
  return { league, season: 2026, week: 7, rosters: teams, mine: teams[0]!, rostered: new Set(teams.flatMap((t) => t.players)), weekProj, ros };
}

describe('trade search', () => {
  it('finds the trade that fixes both teams (surplus QB for surplus RB)', async () => {
    const ctx = buildCtx(
      [proj('qbA', 'QB', 20), proj('qbB', 'QB', 18), proj('rbWeak', 'RB', 5), proj('wr1', 'WR', 10),
       proj('qbC', 'QB', 8), proj('rbStrong', 'RB', 15), proj('rb2', 'RB', 14), proj('wr2', 'WR', 10),
       proj('faQB', 'QB', 2), proj('faRB', 'RB', 4), proj('faWR', 'WR', 4)],
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

describe('positional trade value', () => {
  it('values equal replacement surplus as RB > WR > QB in 1QB', () => {
    const ctx = buildCtx([proj('qb', 'QB', 25), proj('rb', 'RB', 15), proj('wr', 'WR', 18),
      proj('faq', 'QB', 20), proj('far', 'RB', 10), proj('faw', 'WR', 13)],
      { 1: ['qb', 'rb', 'wr'] });
    const repl = replacementLevels(ctx, ctx.ros!);
    const value = (id: string) => tradeMarketValue(ctx.weekProj.get(id)!, ctx, repl);
    expect(value('rb')).toBeGreaterThan(value('wr'));
    expect(value('wr')).toBeGreaterThan(value('qb'));
    expect(value('qb')).toBeCloseTo(12);
  });

  it('respects the league market preference RB > WR > TE > QB > K > DEF', () => {
    const league = buildCtx([], { 1: [] }).league;
    const factors = ['RB', 'WR', 'TE', 'QB', 'K', 'DEF'].map(pos => positionalTradeFactor(pos, league));
    for (let i = 1; i < factors.length; i++) expect(factors[i - 1]).toBeGreaterThan(factors[i]!);
  });

  it('does not discount QBs in superflex or 2QB', () => {
    const league = buildCtx([], { 1: [] }).league;
    expect(positionalTradeFactor('QB', league)).toBe(0.8);
    expect(positionalTradeFactor('QB', { ...league, starterSlots: ['QB', 'SUPER_FLEX'] })).toBe(1);
    expect(positionalTradeFactor('QB', { ...league, starterSlots: ['QB', 'QB'] })).toBe(1);
  });

  it('rejects exchanging a replaceable high-scoring QB for a scarce RB', async () => {
    const ctx = buildCtx([proj('q1', 'QB', 30), proj('q2', 'QB', 29), proj('r1', 'RB', 5), proj('w1', 'WR', 10),
      proj('q3', 'QB', 10), proj('r2', 'RB', 18), proj('r3', 'RB', 17), proj('w2', 'WR', 10),
      proj('faq', 'QB', 28), proj('far', 'RB', 4)],
      { 1: ['q1', 'q2', 'r1', 'w1'], 2: ['q3', 'r2', 'r3', 'w2'] });
    const ideas = await analyzeTrades(ctx);
    expect(ideas.some(t => t.give.every(p => p.position === 'QB') && t.get.some(p => p.position === 'RB'))).toBe(false);
  });
});
