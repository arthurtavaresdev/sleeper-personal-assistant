import type { Scoring } from '../league/settings.js';
import { probAtLeast } from './stats.js';

export type StatLine = Record<string, number>;

/** Pontos = Σ stat[k] × scoring[k]. Mesma regra de model.fantasy_points() no Postgres. */
export function scoreStatLine(stats: StatLine, scoring: Scoring): number {
  let pts = 0;
  for (const [k, v] of Object.entries(scoring)) {
    const s = stats[k];
    if (s !== undefined) pts += s * v;
  }
  return pts;
}

/**
 * Bônus por marca de jardas como probabilidade de atingir a marca, assumindo
 * jardas ~ Normal(média, sd). Ex.: bonus_rec_yd_100 = P(rec_yd >= 100).
 */
export function yardageBonuses(stats: StatLine): StatLine {
  const sd = (mean: number) => 0.45 * mean + 12;
  const p = (key: string, threshold: number) => {
    const mean = stats[key] ?? 0;
    return mean > 0 ? probAtLeast(threshold, mean, sd(mean)) : 0;
  };
  return {
    bonus_pass_yd_300: p('pass_yd', 300),
    bonus_pass_yd_400: p('pass_yd', 400),
    bonus_rush_yd_100: p('rush_yd', 100),
    bonus_rush_yd_200: p('rush_yd', 200),
    bonus_rec_yd_100: p('rec_yd', 100),
    bonus_rec_yd_200: p('rec_yd', 200),
  };
}
