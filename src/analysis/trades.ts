import type { LeagueSettings, TeamRoster } from '../league/settings.js';
import type { Projection } from '../model/projection.js';
import type { RosValue } from '../model/service.js';
import { activePlayers, type AnalysisContext } from './context.js';
import { RosterValuer } from './valuation.js';

export interface TradeIdea {
  partner: TeamRoster;
  give: Projection[];
  get: Projection[];
  /** Ganho do meu lineup ótimo no restante da temporada (pontos). */
  myGain: number;
  /** Ganho do lineup ótimo do outro time (≥ 0 = troca boa para ele também). */
  theirGain: number;
  /** Valor de mercado (VORP) que dou e recebo — checagem de realismo. */
  vorpGive: number;
  vorpGet: number;
}

const TRADEABLE = new Set(['QB', 'RB', 'WR', 'TE']);
/** Quanto o outro lado pode perder (pts ROS) e ainda assim provavelmente aceitar. */
const ACCEPT_TOLERANCE = 2;
/** Limita a diferença de valor de mercado a 20% para qualquer lado. */
const MAX_VORP_PREMIUM = 1.2;
/** Para trocas 2x1 só os N mais valiosos de cada lado entram na combinação. */
const PAIR_POOL = 10;

/** Nível de reposição por posição = melhor free agent disponível (ROS). */
export function replacementLevels(ctx: AnalysisContext, ros: Map<string, RosValue>): Map<string, number> {
  const levels = new Map<string, number>();
  for (const p of ctx.weekProj.values()) {
    if (ctx.rostered.has(p.sleeperId) || !p.team) continue;
    const v = ros.get(p.sleeperId)?.total ?? 0;
    if (v > (levels.get(p.position) ?? 0)) levels.set(p.position, v);
  }
  return levels;
}

/** Preferência de mercado da liga, aplicada ao excedente sobre os waivers.
 * Heurística: não altera pontos projetados nem o lineup. Em 2QB/superflex,
 * a demanda por QBs muda e o desconto de formato 1QB não se aplica.
 */
export function positionalTradeFactor(position: string, league: LeagueSettings): number {
  if (position === 'RB') return 1.25;
  if (position === 'WR') return 1.1;
  if (position === 'K') return 0.5;
  if (position === 'DEF') return 0.4;
  if (position === 'QB') {
    const multiQb = league.starterSlots.includes('SUPER_FLEX') || league.starterSlots.filter((s) => s === 'QB').length > 1;
    return multiQb ? 1 : 0.8;
  }
  return 1;
}

/** Valor para negociação: excedente sobre reposição × preferência posicional × idade. */
export function tradeMarketValue(p: Projection, ctx: AnalysisContext, replacement: Map<string, number>): number {
  const surplus = Math.max(0, (ctx.ros?.get(p.sleeperId)?.total ?? 0) - (replacement.get(p.position) ?? 0));
  const ageFactor = ctx.league.type === 'dynasty' ? dynastyFactor(p.position, p.age) : 1;
  return surplus * positionalTradeFactor(p.position, ctx.league) * ageFactor;
}

/** Fator de valor futuro para ligas dynasty (curva de idade simplificada por posição). */
export function dynastyFactor(position: string, age: number | null): number {
  if (age === null) return 1;
  const peakEnd: Record<string, number> = { RB: 26, WR: 28, TE: 29, QB: 32 };
  const end = peakEnd[position] ?? 28;
  // Jovens valem até +40%; a partir do fim do pico, −12% por ano
  if (age <= end) return 1 + Math.min(0.4, (end - age) * 0.08);
  return Math.max(0.3, 1 - (age - end) * 0.12);
}

function combos<T>(arr: T[], k: 1 | 2): T[][] {
  if (k === 1) return arr.map((x) => [x]);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i]!, arr[j]!]);
  return out;
}

export async function analyzeTrades(ctx: AnalysisContext, opts: { limit?: number; partner?: string } = {}): Promise<TradeIdea[]> {
  if (!ctx.ros) throw new Error('analyzeTrades precisa de projeções ROS');
  const { league, weekProj, ros } = ctx;
  const valuer = RosterValuer.restOfSeason(league, weekProj, ros);
  const repl = replacementLevels(ctx, ros);
  const vorp = (p: Projection) => tradeMarketValue(p, ctx, repl);

  // Melhores free agents para ocupar vagas liberadas em trocas 2x1
  const freeAgents = [...weekProj.values()]
    .filter((p) => !ctx.rostered.has(p.sleeperId) && p.team && league.positions.includes(p.position))
    .sort((a, b) => (ros.get(b.sleeperId)?.total ?? 0) - (ros.get(a.sleeperId)?.total ?? 0))
    .slice(0, 2)
    .map((p) => p.sleeperId);

  const mine = activePlayers(ctx.mine);
  const myBase = valuer.value(mine);
  const tradeable = (ids: string[]) =>
    ids
      .map((id) => weekProj.get(id))
      .filter((p): p is Projection => !!p && TRADEABLE.has(p.position))
      .sort((a, b) => vorp(b) - vorp(a));
  const myPool = tradeable(mine);

  const ideas: TradeIdea[] = [];
  const partners = ctx.rosters.filter(
    (r) => r.rosterId !== ctx.mine.rosterId && (!opts.partner || r.ownerName.toLowerCase().includes(opts.partner.toLowerCase())),
  );

  for (const partner of partners) {
    const theirs = activePlayers(partner);
    const theirBase = valuer.value(theirs);
    const theirPool = tradeable(theirs);

    const shapes: [1 | 2, 1 | 2][] = [[1, 1], [2, 1], [1, 2]];
    for (const [nGive, nGet] of shapes) {
      const gives = combos(nGive === 2 ? myPool.slice(0, PAIR_POOL) : myPool, nGive);
      const gets = combos(nGet === 2 ? theirPool.slice(0, PAIR_POOL) : theirPool, nGet);
      for (const give of gives) {
        const vGive = give.reduce((s, p) => s + vorp(p), 0);
        if (vGive <= 0) continue;
        for (const get of gets) {
          const vGet = get.reduce((s, p) => s + vorp(p), 0);
          if (vGet <= 0 || vGet > vGive * MAX_VORP_PREMIUM || vGive > vGet * MAX_VORP_PREMIUM) continue;

          const giveIds = new Set(give.map((p) => p.sleeperId));
          const getIds = get.map((p) => p.sleeperId);
          const myAfter = [...mine.filter((id) => !giveIds.has(id)), ...getIds];
          // Quem recebe menos jogadores ganha vaga para o melhor free agent
          const myFill = freeAgents.slice(0, Math.max(0, give.length - get.length));
          const myGain = valuer.value([...myAfter, ...myFill]) - myBase;
          if (myGain <= 1) continue;

          const getSet = new Set(getIds);
          const theirAfter = [...theirs.filter((id) => !getSet.has(id)), ...giveIds];
          const theirFill = freeAgents.slice(0, Math.max(0, get.length - give.length));
          const theirGain = valuer.value([...theirAfter, ...theirFill]) - theirBase;
          if (theirGain < -ACCEPT_TOLERANCE) continue;

          ideas.push({ partner, give, get, myGain, theirGain, vorpGive: vGive, vorpGet: vGet });
        }
      }
    }
  }

  // Prioriza o meu ganho; empate desfeito pelo ganho do parceiro (mais chance de aceitar)
  ideas.sort((a, b) => b.myGain - a.myGain || b.theirGain - a.theirGain);
  const perPartner = new Map<number, number>();
  const usedGets = new Set<string>();
  const out: TradeIdea[] = [];
  for (const idea of ideas) {
    const count = perPartner.get(idea.partner.rosterId) ?? 0;
    const key = idea.get.map((p) => p.sleeperId).sort().join('+');
    if (count >= 2 || usedGets.has(key)) continue;
    perPartner.set(idea.partner.rosterId, count + 1);
    usedGets.add(key);
    out.push(idea);
    if (out.length >= (opts.limit ?? 5)) break;
  }
  return out;
}

export function tradeWindowOpen(league: LeagueSettings, week: number): boolean {
  return league.tradeDeadline === null || week <= league.tradeDeadline;
}
