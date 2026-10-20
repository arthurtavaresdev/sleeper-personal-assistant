import { num, sql } from '../db/index.js';
import type { TeamRoster } from '../league/settings.js';
import type { Projection } from '../model/projection.js';
import { clamp } from '../model/stats.js';
import { myPendingClaims } from '../sleeper/graphql.js';
import { activePlayers, type AnalysisContext } from './context.js';
import { RosterValuer } from './valuation.js';
import { suggestFaab } from './waivers.js';

export interface BidderProfile {
  bids: number;
  medianBid: number | null;
  maxBid: number | null;
  /** Mediana e máximo só nesta posição. */
  posMedianBid: number | null;
  posMaxBid: number | null;
}

export interface Rival {
  roster: TeamRoster;
  /** Ganho ROS do lineup ótimo dele com o jogador (largando o pior encaixe). */
  gain: number;
  faabLeft: number;
  profile: BidderProfile;
  predictedBid: number;
}

export type ClaimAction = 'cancel' | 'raise' | 'keep' | 'lower' | 'let_go';

export interface ClaimVerdict {
  add: Projection;
  drop: Projection | null;
  currentBid: number;
  rosGain: number;
  weekGain: number;
  /** O máximo que o jogador vale para mim. */
  myCeiling: number;
  rivals: Rival[];
  /** Lance estimado para vencer o concorrente mais provável. */
  neededBid: number | null;
  action: ClaimAction;
  suggestedBid: number;
}

/** Teto de lance: o dobro da agressividade do lance sugerido, limitado a 60% do saldo. */
export function faabCeiling(rosGain: number, remaining: number, weeks: number): number {
  if (remaining <= 0 || rosGain <= 0) return 0;
  const pct = clamp((rosGain / Math.max(1, weeks)) * 0.12, 0.01, 0.6);
  return Math.max(1, Math.min(remaining, Math.round(remaining * pct)));
}

/**
 * Lance previsto de um rival: o lance "racional" pelo ganho dele, escalado pela
 * agressividade histórica (mediana dele, na posição se houver, vs mediana da liga).
 */
export function predictRivalBid(gain: number, faabLeft: number, weeks: number, profile: BidderProfile, leagueMedian: number): number {
  if (faabLeft <= 0) return 0;
  const base = suggestFaab({ rosGain: gain, trendingAdds: 0 }, faabLeft, weeks);
  const median = profile.posMedianBid ?? profile.medianBid;
  const aggr = median === null || profile.bids < 2 ? 1 : clamp(median / Math.max(1, leagueMedian), 0.5, 3);
  return Math.min(faabLeft, Math.max(1, Math.round(base * aggr)));
}

/** Decide o que fazer com uma proposta. Puro, para teste. */
export function decide(input: {
  rosGain: number;
  currentBid: number;
  suggestion: number;
  ceiling: number;
  minBid: number;
  /** Maior lance previsto entre rivais e se eu perco o desempate para esse rival. */
  topRival: { bid: number; beatsMeOnTie: boolean } | null;
}): { action: ClaimAction; suggestedBid: number; neededBid: number | null } {
  const { rosGain, currentBid, suggestion, ceiling, minBid, topRival } = input;
  if (rosGain <= 0.5) return { action: 'cancel', suggestedBid: 0, neededBid: null };

  const neededBid = topRival ? topRival.bid + (topRival.beatsMeOnTie ? 1 : 0) : null;
  if (neededBid !== null && neededBid > ceiling) {
    // Não vale disputar; um lance barato só como aposta
    return { action: 'let_go', suggestedBid: Math.max(minBid, Math.min(currentBid, suggestion)), neededBid };
  }
  const target = Math.max(minBid, neededBid ?? 0, Math.min(suggestion, ceiling));
  if (currentBid < target) return { action: 'raise', suggestedBid: target, neededBid };
  if (currentBid > ceiling) return { action: 'lower', suggestedBid: target, neededBid };
  return { action: 'keep', suggestedBid: currentBid, neededBid };
}

async function loadProfiles(leagueId: string, position: string): Promise<{ profiles: Map<number, BidderProfile>; leagueMedian: number }> {
  const rows = await sql`
    SELECT roster_id, overall, bids, median_bid, max_bid
    FROM model.bidder_profiles
    WHERE league_id = ${leagueId} AND (overall OR position = ${position})`;
  const profiles = new Map<number, BidderProfile>();
  for (const r of rows) {
    const p = profiles.get(r.roster_id) ?? { bids: 0, medianBid: null, maxBid: null, posMedianBid: null, posMaxBid: null };
    if (r.overall) Object.assign(p, { bids: num(r.bids), medianBid: num(r.median_bid), maxBid: num(r.max_bid) });
    else Object.assign(p, { posMedianBid: num(r.median_bid), posMaxBid: num(r.max_bid) });
    profiles.set(r.roster_id, p);
  }
  const [m] = await sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bid) AS median FROM model.waiver_bids WHERE league_id = ${leagueId}`;
  return { profiles, leagueMedian: num(m?.median) || 1 };
}

export async function analyzeClaims(ctx: AnalysisContext): Promise<ClaimVerdict[]> {
  if (!ctx.ros) throw new Error('analyzeClaims precisa de projeções ROS');
  const { league, weekProj, ros } = ctx;
  const claims = await myPendingClaims(league.id, ctx.mine.rosterId);
  const valuer = RosterValuer.restOfSeason(league, weekProj, ros);
  const weekValuer = RosterValuer.singleWeek(league, weekProj, ctx.week);
  const mine = activePlayers(ctx.mine);
  const remaining = Math.max(0, league.faab.budget - ctx.mine.faabUsed);
  const weeks = valuer.remainingWeeks;

  const verdicts: ClaimVerdict[] = [];
  for (const c of claims) {
    const addId = Object.keys(c.adds ?? {})[0];
    const add = addId ? weekProj.get(addId) : undefined;
    if (!add) continue;
    const dropId = Object.keys(c.drops ?? {})[0];
    const after = [...mine.filter((x) => x !== dropId), add.sleeperId];
    const rosGain = valuer.value(after) - valuer.value(mine);
    const weekGain = weekValuer.value(after) - weekValuer.value(mine);

    const { profiles, leagueMedian } = await loadProfiles(league.id, add.position);
    const rivals: Rival[] = ctx.rosters
      .filter((r) => r.rosterId !== ctx.mine.rosterId)
      .map((r) => {
        const ps = activePlayers(r);
        const base = valuer.value(ps);
        const gain = Math.max(0, ...ps.map((d) => valuer.value([...ps.filter((x) => x !== d), add.sleeperId]) - base));
        const faabLeft = Math.max(0, league.faab.budget - r.faabUsed);
        const profile = profiles.get(r.rosterId) ?? { bids: 0, medianBid: null, maxBid: null, posMedianBid: null, posMaxBid: null };
        return { roster: r, gain, faabLeft, profile, predictedBid: gain > 1 ? predictRivalBid(gain, faabLeft, weeks, profile, leagueMedian) : 0 };
      })
      .filter((r) => r.predictedBid > 0)
      .sort((a, b) => b.predictedBid - a.predictedBid);

    const top = rivals[0];
    const currentBid = c.settings?.waiver_bid ?? 0;
    const ceiling = faabCeiling(rosGain, remaining, weeks);
    const decision = decide({
      rosGain,
      currentBid,
      suggestion: suggestFaab({ rosGain, trendingAdds: 0 }, remaining, weeks),
      ceiling,
      minBid: league.faab.minBid,
      // Empate de FAAB vai para quem tem prioridade de waiver menor (melhor)
      topRival: top ? { bid: top.predictedBid, beatsMeOnTie: top.roster.waiverPosition < ctx.mine.waiverPosition } : null,
    });

    verdicts.push({
      add,
      drop: dropId ? weekProj.get(dropId) ?? null : null,
      currentBid,
      rosGain,
      weekGain,
      myCeiling: ceiling,
      rivals: rivals.slice(0, 3),
      ...decision,
    });
  }
  return verdicts;
}
