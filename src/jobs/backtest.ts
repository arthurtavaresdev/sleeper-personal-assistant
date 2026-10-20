import { num, sql } from '../db/index.js';
import { MODELED_POSITIONS, type LeagueSettings } from '../league/settings.js';
import { loadPlayers } from '../model/inputs.js';
import { projectWeek } from '../model/service.js';

export interface BacktestRow {
  position: string;
  n: number;
  modelMae: number;
  baselineMae: number;
  modelBias: number;
}

/**
 * Para cada semana, projeta com a forma pré-jogo e compara com os pontos reais
 * (pontuação da liga). Baseline: média dos pontos do jogador na temporada até ali.
 * Só entram jogadores que jogaram a semana e têm ao menos 1 jogo anterior.
 */
export async function runBacktest(league: LeagueSettings, season: number, weeks: number[]): Promise<BacktestRow[]> {
  const actualByWeek = new Map<number, Map<string, number>>();
  const maxWeek = Math.max(...weeks);
  for (let w = 1; w <= maxWeek; w++) {
    const rows = await sql`SELECT sleeper_id, points FROM model.actual_points(${sql.json(league.scoring)}, ${season}, ${w})`;
    actualByWeek.set(w, new Map(rows.map((r) => [r.sleeper_id as string, num(r.points)])));
  }

  const positions = MODELED_POSITIONS.filter((p) => league.positions.includes(p));
  const acc = new Map<string, { n: number; model: number; base: number; bias: number }>();

  for (const week of weeks) {
    const players = await loadPlayers(league.id, positions, season, week);
    // O status de lesão atual vazaria informação: no backtest todos estão disponíveis
    for (const p of players) p.injuryStatus = null;
    const proj = await projectWeek(league, season, week, week, players);
    const actual = actualByWeek.get(week)!;

    for (const [id, pts] of actual) {
      const p = proj.get(id);
      if (!p) continue;
      const prior: number[] = [];
      for (let w = 1; w < week; w++) {
        const v = actualByWeek.get(w)?.get(id);
        if (v !== undefined) prior.push(v);
      }
      if (prior.length === 0) continue;
      const baseline = prior.reduce((a, b) => a + b, 0) / prior.length;
      const a = acc.get(p.position) ?? { n: 0, model: 0, base: 0, bias: 0 };
      a.n++;
      a.model += Math.abs(p.mean - pts);
      a.base += Math.abs(baseline - pts);
      a.bias += p.mean - pts;
      acc.set(p.position, a);
    }
  }

  return [...acc.entries()]
    .map(([position, a]) => ({
      position,
      n: a.n,
      modelMae: a.model / a.n,
      baselineMae: a.base / a.n,
      modelBias: a.bias / a.n,
    }))
    .sort((x, y) => positions.indexOf(x.position as never) - positions.indexOf(y.position as never));
}
