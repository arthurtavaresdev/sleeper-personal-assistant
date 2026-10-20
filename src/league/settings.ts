import { sql } from '../db/index.js';
import type { League } from '../sleeper/types.js';

export type Scoring = Record<string, number>;
export type LeagueType = 'redraft' | 'keeper' | 'dynasty';

/** Posições que cada slot de titular aceita. Slots IDP ficam de fora (sem modelo). */
export const SLOT_ELIGIBILITY: Record<string, readonly string[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);

export const MODELED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;

export interface LeagueSettings {
  id: string;
  name: string;
  season: number;
  type: LeagueType;
  scoring: Scoring;
  /** Slots de titular modelados, na ordem do Sleeper (ex.: QB, RB, RB, WR, WR, TE, FLEX, K, DEF). */
  starterSlots: string[];
  /** Índice de cada slot modelado no array `starters` do Sleeper (que inclui slots IDP). */
  starterSlotIndexes: number[];
  /** Posições que aparecem em algum slot — define quem vale a pena projetar. */
  positions: string[];
  rosterSize: number;
  totalRosters: number;
  faab: { enabled: boolean; budget: number; minBid: number };
  playoffWeekStart: number;
  tradeDeadline: number | null;
}

/** Última semana que conta para o fantasy (final dos playoffs na maioria das ligas). */
export const LAST_FANTASY_WEEK = 17;

export function parseLeague(league: League): LeagueSettings {
  const slots = league.roster_positions;
  const allStarters = slots.filter((s) => !BENCH_SLOTS.has(s));
  const starterSlotIndexes = allStarters.flatMap((s, i) => (s in SLOT_ELIGIBILITY ? [i] : []));
  const starterSlots = starterSlotIndexes.map((i) => allStarters[i]!);
  const positions = [...new Set(starterSlots.flatMap((s) => SLOT_ELIGIBILITY[s]!))];
  const s = league.settings;
  const typeCode = s.type ?? 0;
  return {
    id: league.league_id,
    name: league.name,
    season: Number(league.season),
    type: typeCode === 2 ? 'dynasty' : typeCode === 1 ? 'keeper' : 'redraft',
    scoring: league.scoring_settings,
    starterSlots,
    starterSlotIndexes,
    positions,
    rosterSize: slots.filter((p) => p !== 'IR' && p !== 'TAXI').length,
    totalRosters: league.total_rosters,
    faab: { enabled: s.waiver_type === 2, budget: s.waiver_budget ?? 100, minBid: s.waiver_bid_min ?? 0 },
    playoffWeekStart: s.playoff_week_start ?? 15,
    // Sleeper: trade_deadline é a última semana em que trocas são permitidas (99 = sem prazo)
    tradeDeadline: s.trade_deadline && s.trade_deadline < 99 ? s.trade_deadline : null,
  };
}

export async function loadLeague(leagueId: string): Promise<LeagueSettings> {
  const [row] = await sql`SELECT data FROM core.leagues WHERE league_id = ${leagueId}`;
  if (!row) throw new Error(`Liga ${leagueId} não sincronizada. Rode \`pnpm cli sync\`.`);
  return parseLeague(row.data as League);
}

export interface TeamRoster {
  rosterId: number;
  ownerId: string | null;
  ownerName: string;
  players: string[];
  starters: string[];
  reserve: string[];
  taxi: string[];
  faabUsed: number;
  /** Prioridade de waiver (1 = primeira); desempata lances iguais de FAAB. */
  waiverPosition: number;
}

export async function loadRosters(leagueId: string): Promise<TeamRoster[]> {
  const rows = await sql`
    SELECT r.roster_id, r.owner_id, r.data, coalesce(u.display_name, 'Time ' || r.roster_id) AS owner_name
    FROM core.rosters r
    LEFT JOIN core.league_users u ON u.league_id = r.league_id AND u.user_id = r.owner_id
    WHERE r.league_id = ${leagueId}
    ORDER BY r.roster_id`;
  return rows.map((r) => {
    const d = r.data as { players?: string[]; starters?: string[]; reserve?: string[]; taxi?: string[]; settings?: { waiver_budget_used?: number; waiver_position?: number } };
    return {
      rosterId: r.roster_id as number,
      ownerId: r.owner_id as string | null,
      ownerName: r.owner_name as string,
      players: d.players ?? [],
      starters: d.starters ?? [],
      reserve: d.reserve ?? [],
      taxi: d.taxi ?? [],
      faabUsed: d.settings?.waiver_budget_used ?? 0,
      waiverPosition: d.settings?.waiver_position ?? 99,
    };
  });
}

/** Jogadores do roster que podem ser escalados (fora de IR e taxi squad). */
export function activePlayers(r: TeamRoster): string[] {
  const out = new Set([...r.reserve, ...r.taxi]);
  return r.players.filter((p) => !out.has(p));
}
