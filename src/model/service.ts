import { sql } from '../db/index.js';
import { LAST_FANTASY_WEEK, MODELED_POSITIONS, type LeagueSettings } from '../league/settings.js';
import { loadPlayers, loadWeekContext, type PlayerInput } from './inputs.js';
import { MODEL_VERSION, projectAll, type Projection } from './projection.js';

const positionsFor = (league: LeagueSettings) =>
  MODELED_POSITIONS.filter((p) => league.positions.includes(p));

/**
 * Projeta uma semana. `currentWeek` limita a forma usada: semanas futuras
 * usam a forma atual (é o que se sabe hoje) e a tabela da NFL daquela semana.
 */
export async function projectWeek(
  league: LeagueSettings,
  season: number,
  week: number,
  currentWeek = week,
  players?: PlayerInput[],
): Promise<Map<string, Projection>> {
  const formWeek = Math.min(week, currentWeek);
  const [ctx, ps] = await Promise.all([
    loadWeekContext(season, week, formWeek),
    players ?? loadPlayers(league.id, positionsFor(league), season, formWeek),
  ]);
  return projectAll(ps, ctx, league.scoring);
}

export async function saveProjections(league: LeagueSettings, season: number, week: number, projections: Map<string, Projection>) {
  const rows = [...projections.values()].map((p) => ({
    league_id: league.id,
    season,
    week,
    sleeper_id: p.sleeperId,
    model_version: MODEL_VERSION,
    mean: p.mean,
    sd: p.sd,
    p20: p.p20,
    p80: p.p80,
    stat_line: p.stats,
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await sql`
      INSERT INTO model.projections ${sql(chunk)}
      ON CONFLICT (league_id, season, week, sleeper_id, model_version) DO UPDATE
        SET mean = excluded.mean, sd = excluded.sd, p20 = excluded.p20, p80 = excluded.p80,
            stat_line = excluded.stat_line, created_at = now()`;
  }
}

export interface RosValue {
  total: number;
  weeks: number;
  perWeek: Map<number, number>;
}

/** Soma das projeções de `fromWeek` até a última semana do fantasy. */
export async function projectRestOfSeason(
  league: LeagueSettings,
  season: number,
  fromWeek: number,
): Promise<Map<string, RosValue>> {
  const lastWeek = LAST_FANTASY_WEEK;
  const players = await loadPlayers(league.id, positionsFor(league), season, fromWeek);
  const ros = new Map<string, RosValue>();
  for (let w = fromWeek; w <= lastWeek; w++) {
    const proj = await projectWeek(league, season, w, fromWeek, players);
    for (const [id, p] of proj) {
      const v = ros.get(id) ?? { total: 0, weeks: lastWeek - fromWeek + 1, perWeek: new Map() };
      v.total += p.mean;
      v.perWeek.set(w, p.mean);
      ros.set(id, v);
    }
  }
  return ros;
}
