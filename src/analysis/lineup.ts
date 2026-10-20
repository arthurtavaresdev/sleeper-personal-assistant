import { sql } from '../db/index.js';
import { SLOT_ELIGIBILITY } from '../league/settings.js';
import type { Projection } from '../model/projection.js';
import { optimizeWithLocks, type LineupResult } from '../optimizer/lineup.js';
import { activePlayers, type AnalysisContext } from './context.js';
import { toCandidate } from './valuation.js';

export interface LineupChange {
  slot: string;
  out: Projection | null;
  in: Projection;
}

export interface LineupReport {
  week: number;
  optimal: LineupResult;
  currentTotal: number;
  changes: LineupChange[];
  /** Titulares do lineup ótimo com risco (lesão, bye). */
  alerts: Projection[];
  /** Decisões apertadas: titular vs melhor reserva elegível com diferença < 1 pt. */
  closeCalls: { starter: Projection; alt: Projection }[];
  locked: Set<string>;
}

/** Times cujo jogo da semana já começou. */
async function startedTeams(season: number, week: number): Promise<Set<string>> {
  const rows = await sql`
    SELECT team FROM core.team_games
    WHERE season = ${season} AND week = ${week} AND game_type = 'REG' AND kickoff <= now()`;
  return new Set(rows.map((r) => r.team as string));
}

async function currentStarters(ctx: AnalysisContext): Promise<(string | null)[]> {
  const [m] = await sql`
    SELECT data->'starters' AS starters FROM core.matchups
    WHERE league_id = ${ctx.league.id} AND week = ${ctx.week} AND roster_id = ${ctx.mine.rosterId}`;
  const all = ((m?.starters as string[] | undefined) ?? ctx.mine.starters).map((id) => (id && id !== '0' ? id : null));
  return ctx.league.starterSlotIndexes.map((i) => all[i] ?? null);
}

export async function analyzeLineup(ctx: AnalysisContext): Promise<LineupReport> {
  const { league, weekProj } = ctx;
  const started = await startedTeams(ctx.season, ctx.week);
  const isLocked = (id: string) => started.has(weekProj.get(id)?.team ?? '');

  const projections = activePlayers(ctx.mine).flatMap((id) => (weekProj.has(id) ? [weekProj.get(id)!] : []));
  const candidates = projections.map((p) => toCandidate(p, league));
  const starters = await currentStarters(ctx);
  const optimal = optimizeWithLocks(league.starterSlots, candidates, starters, isLocked);

  const currentTotal = starters.reduce((s, id) => s + (id ? weekProj.get(id)?.mean ?? 0 : 0), 0);

  // Mudanças: quem entra no lineup ótimo e não está escalado hoje
  const startersSet = new Set(starters.filter(Boolean));
  const optimalSet = new Set(optimal.slots.map((s) => s.id).filter(Boolean));
  const outs = starters.filter((id): id is string => !!id && !optimalSet.has(id)).map((id) => weekProj.get(id) ?? null);
  const changes: LineupChange[] = [];
  for (const s of optimal.slots) {
    if (!s.id || startersSet.has(s.id)) continue;
    changes.push({ slot: s.slot, in: weekProj.get(s.id)!, out: outs.shift() ?? null });
  }

  const alerts = optimal.slots
    .map((s) => (s.id ? weekProj.get(s.id)! : null))
    .filter((p): p is Projection => !!p && (p.injuryStatus !== null || p.opponent === null));

  const closeCalls: LineupReport['closeCalls'] = [];
  for (const s of optimal.slots) {
    if (!s.id || isLocked(s.id)) continue;
    const starter = weekProj.get(s.id)!;
    const alt = optimal.bench
      .map((id) => weekProj.get(id)!)
      .find((b) => !isLocked(b.sleeperId) && toCandidate(b, league).positions.some((pos) => slotAccepts(s.slot, pos)));
    if (alt && starter.mean - alt.mean < 1) closeCalls.push({ starter, alt });
  }

  return { week: ctx.week, optimal, currentTotal, changes, alerts, closeCalls, locked: new Set(projections.filter((p) => isLocked(p.sleeperId)).map((p) => p.sleeperId)) };
}

const slotAccepts = (slot: string, pos: string) => SLOT_ELIGIBILITY[slot]?.includes(pos) ?? false;
