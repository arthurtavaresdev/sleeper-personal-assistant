import type { Projection } from '../model/projection.js';
import { sleeper } from '../sleeper/client.js';
import { clamp } from '../model/stats.js';
import { activePlayers, type AnalysisContext } from './context.js';
import { RosterValuer } from './valuation.js';

export interface WaiverMove {
  add: Projection;
  drop: Projection | null;
  /** Ganho no lineup ótimo somado no restante da temporada (pontos). */
  rosGain: number;
  weekGain: number;
  trendingAdds: number;
  faabBid: number | null;
}

const FA_PER_POSITION = 25;

/**
 * Para cada free agent promissor, testa trocá-lo por cada jogador do meu roster e
 * guarda o melhor par (adicionar, largar) pelo ganho no lineup ótimo semana a semana.
 */
export async function analyzeWaivers(ctx: AnalysisContext, limit = 5): Promise<WaiverMove[]> {
  if (!ctx.ros) throw new Error('analyzeWaivers precisa de projeções ROS');
  const { league, weekProj, ros } = ctx;
  const valuer = RosterValuer.restOfSeason(league, weekProj, ros);
  const weekValuer = RosterValuer.singleWeek(league, weekProj, ctx.week);

  const trending = new Map((await sleeper.trendingAdds(48, 100).catch(() => [])).map((t) => [t.player_id, t.count]));

  // Free agents: projetados, não rostados; os melhores por posição em ROS
  const free = [...weekProj.values()].filter((p) => !ctx.rostered.has(p.sleeperId) && p.team);
  const fas = league.positions.flatMap((pos) =>
    free
      .filter((p) => p.position === pos)
      .sort((a, b) => (ros.get(b.sleeperId)?.total ?? 0) - (ros.get(a.sleeperId)?.total ?? 0))
      .slice(0, FA_PER_POSITION),
  );

  const mine = activePlayers(ctx.mine);
  const rosterFull = ctx.mine.players.length - ctx.mine.reserve.length - ctx.mine.taxi.length >= league.rosterSize;
  const base = valuer.value(mine);
  const baseWeek = weekValuer.value(mine);

  const moves: WaiverMove[] = [];
  for (const fa of fas) {
    let best: { drop: string | null; gain: number } = { drop: null, gain: -Infinity };
    // Com vaga livre, adicionar sem largar é opção
    if (!rosterFull) best = { drop: null, gain: valuer.value([...mine, fa.sleeperId]) - base };
    for (const d of mine) {
      const gain = valuer.value([...mine.filter((x) => x !== d), fa.sleeperId]) - base;
      if (gain > best.gain) best = { drop: d, gain };
    }
    if (best.gain <= 0.5) continue;
    const after = best.drop ? mine.filter((x) => x !== best.drop) : mine;
    moves.push({
      add: fa,
      drop: best.drop ? weekProj.get(best.drop) ?? null : null,
      rosGain: best.gain,
      weekGain: weekValuer.value([...after, fa.sleeperId]) - baseWeek,
      trendingAdds: trending.get(fa.sleeperId) ?? 0,
      faabBid: null,
    });
  }

  moves.sort((a, b) => b.rosGain - a.rosGain);
  // Um mesmo drop não deve ser sugerido para vários adds
  const usedDrops = new Set<string>();
  const top = moves.filter((m) => {
    const key = m.drop?.sleeperId;
    if (key && usedDrops.has(key)) return false;
    if (key) usedDrops.add(key);
    return true;
  }).slice(0, limit);

  if (league.faab.enabled) {
    const remaining = Math.max(0, league.faab.budget - ctx.mine.faabUsed);
    for (const m of top) m.faabBid = suggestFaab(m, remaining, valuer.remainingWeeks);
  }
  return top;
}

/** Lance FAAB proporcional ao ganho por semana; jogador em alta no mercado sobe 25%. */
export function suggestFaab(m: Pick<WaiverMove, 'rosGain' | 'trendingAdds'>, remaining: number, weeks: number): number {
  if (remaining <= 0) return 0;
  const perWeek = m.rosGain / Math.max(1, weeks);
  let pct = clamp(perWeek * 0.06, 0.01, 0.4);
  if (m.trendingAdds > 20000) pct *= 1.25;
  return Math.max(1, Math.min(remaining, Math.round(remaining * pct)));
}
