import { parseLeague, type TeamRoster } from '../../src/league/settings.js';
import type { AnalysisContext } from '../../src/analysis/context.js';
import type { Projection } from '../../src/model/projection.js';
import { TradeTransaction, type TradeTransaction as Trade } from '../../src/sleeper/types.js';
import { HALF_PPR_LEAGUE } from './league.js';
export const offer = (extra: Partial<Trade> = {}): Trade => TradeTransaction.parse({
  transaction_id: '900000000000000001', league_id: '111', type: 'trade', status: 'proposed', leg: 7,
  creator: 'u2', roster_ids: [1, 2], consenter_ids: [2],
  adds: { r1: 2, r2: 1 }, drops: { r1: 1, r2: 2 }, draft_picks: [], waiver_budget: [], ...extra,
});
export function inboxContext(): AnalysisContext {
  const league = parseLeague({ ...HALF_PPR_LEAGUE, league_id: '111', roster_positions: ['QB', 'RB', 'WR', 'BN', 'BN'] });
  const player = (id: string, pos: string, mean: number): Projection => ({
    sleeperId: id, name: id, position: pos, fantasyPositions: [pos], team: 'XX', age: 25,
    opponent: 'YY', injuryStatus: null, mean, sd: 1, p20: mean, p80: mean, stats: {},
  });
  const projections = [player('q1', 'QB', 20), player('q2', 'QB', 20), player('r1', 'RB', 5), player('r2', 'RB', 15),
    player('w1', 'WR', 10), player('w2', 'WR', 10), player('faQ', 'QB', 19), player('faR', 'RB', 4), player('faW', 'WR', 8)];
  const roster = (id: number, players: string[]): TeamRoster => ({ rosterId: id, ownerId: `u${id}`, ownerName: `Time ${id}`,
    players, starters: [], reserve: [], taxi: [], faabUsed: 0, waiverPosition: id });
  const rosters = [roster(1, ['q1', 'r1', 'w1']), roster(2, ['q2', 'r2', 'w2'])];
  return { league, mine: rosters[0]!, rosters, season: 2026, week: 7,
    weekProj: new Map(projections.map(p => [p.sleeperId, p])), rostered: new Set(rosters.flatMap(r => r.players)),
    ros: new Map(projections.map(p => [p.sleeperId, { total: p.mean * 3, weeks: 3, perWeek: new Map([7, 8, 9].map(w => [w, p.mean])) }])) };
}
