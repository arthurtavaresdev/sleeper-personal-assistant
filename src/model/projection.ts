import type { Scoring } from '../league/settings.js';
import type { GameInfo, PlayerForm, PlayerInput, TeamForm, WeekContext } from './inputs.js';
import { scoreStatLine, yardageBonuses, type StatLine } from './scoring.js';
import { clamp, probBetween, shrink } from './stats.js';

export const MODEL_VERSION = 'v1';

export interface Projection {
  sleeperId: string;
  name: string;
  position: string;
  fantasyPositions: string[];
  team: string;
  opponent: string | null;
  injuryStatus: string | null;
  mean: number;
  sd: number;
  p20: number;
  p80: number;
  stats: StatLine;
  /** Motivo de projeção zerada/reduzida, para exibir. */
  note?: string;
}

// ------------------------------------------------------------------ priors por posição

/** Participação esperada pelo papel na depth chart (índice = depth_order - 1). */
const ROLE_PRIOR = {
  targetShare: { WR: [0.22, 0.16, 0.11, 0.05], TE: [0.15, 0.06, 0.03], RB: [0.1, 0.05, 0.02], QB: [0, 0] },
  carryShare: { RB: [0.55, 0.28, 0.1], QB: [0.1, 0.01], WR: [0.02, 0.01, 0.01], TE: [0, 0] },
  passShare: { QB: [0.97, 0.03, 0.01] },
} as const;

/** Eficiência média por posição: [valor, peso do prior em oportunidades]. */
const EFF = {
  catchRate: { WR: 0.64, TE: 0.7, RB: 0.78, QB: 0.5 },
  ydsPerTarget: { WR: 8.3, TE: 7.2, RB: 6.0, QB: 5 },
  recTdPerTarget: { WR: 0.045, TE: 0.048, RB: 0.03, QB: 0 },
  ydsPerCarry: { RB: 4.3, QB: 5.0, WR: 6.5, TE: 4 },
  rushTdPerCarry: { RB: 0.03, QB: 0.04, WR: 0.03, TE: 0.03 },
} as const;
const K = { targets: 60, carries: 50, catch: 30, ypt: 40, recTd: 150, ypc: 80, rushTd: 200, passAtt: 150, ypa: 200, passTd: 300, int: 300 };
const QB_STARTER_MIN_SHARE = 0.95;
const QB_PRIOR = { cmpPct: 0.65, ypa: 7.0, tdPerAtt: 0.045, intPerAtt: 0.023 };
const FUMBLE_PER_TOUCH = 0.006;
/** Alvos do time por tentativa de passe (throwaways, spikes e sacks-anulados não geram alvo). */
const TARGETS_PER_PASS_ATT = 0.92;

/** Coeficiente de variação e piso de desvio por posição (calibrar via backtest). */
const VARIANCE: Record<string, { cv: number; base: number }> = {
  QB: { cv: 0.4, base: 3 },
  RB: { cv: 0.55, base: 2 },
  WR: { cv: 0.6, base: 2 },
  TE: { cv: 0.65, base: 1.5 },
  K: { cv: 0.45, base: 2 },
  DEF: { cv: 0.55, base: 2.5 },
};

/** Multiplicador de disponibilidade pelo status de lesão do Sleeper. */
export function availability(status: string | null): { mult: number; sdBoost: number } {
  switch (status) {
    case 'Out':
    case 'IR':
    case 'PUP':
    case 'Sus':
    case 'NA':
    case 'DNR':
      return { mult: 0, sdBoost: 0 };
    case 'Doubtful':
      return { mult: 0.25, sdBoost: 0.3 };
    case 'Questionable':
      return { mult: 0.88, sdBoost: 0.15 };
    default:
      return { mult: 1, sdBoost: 0 };
  }
}

function rolePrior(table: Partial<Record<string, readonly number[]>>, pos: string, depthOrder: number | null): number {
  const arr = table[pos];
  if (!arr || arr.length === 0) return 0;
  const i = clamp((depthOrder ?? arr.length) - 1, 0, arr.length - 1);
  return arr[i]!;
}

const eff = (table: Partial<Record<string, number>>, pos: string) => table[pos] ?? 0;

// ------------------------------------------------------------------ ambiente do jogo

interface GameEnv {
  teamPoints: number;
  scoreFactor: number;
  teamPassAtt: number;
  teamCarries: number;
}

function shrinkTeam(value: number, games: number, avg: number, k = 3): number {
  return (value * games + avg * k) / (games + k);
}

export function gameEnvironment(tf: TeamForm | undefined, game: GameInfo, avg: TeamForm, avgImplied: number | null): GameEnv {
  const games = tf?.games ?? 0;
  const formPoints = shrinkTeam(tf?.pointsFor ?? avg.pointsFor, games, avg.pointsFor);
  // Linha de Vegas quando existe (semana atual); senão, forma do time.
  // O fator relativo compara cada fonte com a própria média (Vegas tende a ficar abaixo do realizado).
  const useVegas = game.impliedPoints !== null && avgImplied !== null;
  const teamPoints = useVegas ? game.impliedPoints! : formPoints;
  const baseline = useVegas ? avgImplied! : avg.pointsFor;
  const margin = game.expectedMargin ?? 0;
  const scoreFactor = clamp(teamPoints / baseline, 0.6, 1.5);
  const paceFactor = 0.85 + 0.15 * scoreFactor;
  // Favorito corre mais e passa menos (game script)
  const teamPassAtt = shrinkTeam(tf?.passAtt ?? avg.passAtt, games, avg.passAtt) * clamp(1 - 0.008 * margin, 0.85, 1.15) * paceFactor;
  const teamCarries = shrinkTeam(tf?.carries ?? avg.carries, games, avg.carries) * clamp(1 + 0.012 * margin, 0.8, 1.2) * paceFactor;
  return { teamPoints, scoreFactor, teamPassAtt, teamCarries };
}

// ------------------------------------------------------------------ jogadores de linha

function skillStatLine(p: PlayerInput, env: GameEnv, matchup: number): StatLine {
  const f: PlayerForm | null = p.form;
  const pos = p.position;
  const changedTeam = f !== null && f.lastTeam !== p.team;
  const kMult = changedTeam ? 3 : 1;

  // Mudança recente de papel: snaps das últimas 2 semanas vs média
  let roleTrend = 1;
  if (f?.snapEwma && f.snapLast2 && f.snapEwma > 0.05) {
    roleTrend = 1 + 0.5 * (clamp(f.snapLast2 / f.snapEwma, 0.8, 1.25) - 1);
  }

  const targetShare = shrink(f?.wTargets ?? 0, f?.wTeamTargets ?? 0, rolePrior(ROLE_PRIOR.targetShare, pos, p.depthOrder), K.targets * kMult) * roleTrend;
  const carryShare = shrink(f?.wCarries ?? 0, f?.wTeamCarries ?? 0, rolePrior(ROLE_PRIOR.carryShare, pos, p.depthOrder), K.carries * kMult) * roleTrend;

  const targets = targetShare * env.teamPassAtt * TARGETS_PER_PASS_ATT;
  const carries = carryShare * env.teamCarries;

  const catchRate = shrink(f?.wRec ?? 0, f?.wTargets ?? 0, eff(EFF.catchRate, pos), K.catch);
  const ypt = shrink(f?.wRecYd ?? 0, f?.wTargets ?? 0, eff(EFF.ydsPerTarget, pos), K.ypt);
  const recTdRate = shrink(f?.wRecTd ?? 0, f?.wTargets ?? 0, eff(EFF.recTdPerTarget, pos), K.recTd);
  const ypc = shrink(f?.wRushYd ?? 0, f?.wCarries ?? 0, eff(EFF.ydsPerCarry, pos), K.ypc);
  const rushTdRate = shrink(f?.wRushTd ?? 0, f?.wCarries ?? 0, eff(EFF.rushTdPerCarry, pos), K.rushTd);

  const rec = targets * catchRate;
  const stats: StatLine = {
    rec_tgt: targets,
    rec,
    rec_yd: targets * ypt * matchup,
    rec_td: targets * recTdRate * env.scoreFactor * matchup,
    rush_att: carries,
    rush_yd: carries * ypc * matchup,
    rush_td: carries * rushTdRate * env.scoreFactor * matchup,
    fum_lost: (rec + carries) * FUMBLE_PER_TOUCH,
  };

  if (pos === 'QB') {
    let passShare = shrink(f?.wPassAtt ?? 0, f?.wTeamPassAtt ?? 0, rolePrior(ROLE_PRIOR.passShare, pos, p.depthOrder), K.passAtt * kMult);
    // Titular atual: o histórico pode ter jogos como reserva ou interrompidos por lesão
    if (p.depthOrder === 1) passShare = Math.max(passShare, QB_STARTER_MIN_SHARE);
    const att = passShare * env.teamPassAtt;
    const cmpPct = shrink(f?.wPassCmp ?? 0, f?.wPassAtt ?? 0, QB_PRIOR.cmpPct, K.passAtt);
    const ypa = shrink(f?.wPassYd ?? 0, f?.wPassAtt ?? 0, QB_PRIOR.ypa, K.ypa);
    const tdRate = shrink(f?.wPassTd ?? 0, f?.wPassAtt ?? 0, QB_PRIOR.tdPerAtt, K.passTd);
    const intRate = shrink(f?.wPassInt ?? 0, f?.wPassAtt ?? 0, QB_PRIOR.intPerAtt, K.int);
    Object.assign(stats, {
      pass_att: att,
      pass_cmp: att * cmpPct,
      pass_inc: att * (1 - cmpPct),
      pass_yd: att * ypa * matchup,
      pass_td: att * tdRate * env.scoreFactor * matchup,
      pass_int: att * intRate,
      pass_fd: (att * ypa) / 18,
      pass_sack: att * 0.065,
    });
    stats.fum_lost = (stats.fum_lost ?? 0) + att * 0.004;
  }

  // Aproximações para ligas que pontuam first downs
  stats.rec_fd = (stats.rec_yd ?? 0) / 17;
  stats.rush_fd = (stats.rush_yd ?? 0) / 14;
  if (pos === 'TE') stats.bonus_rec_te = rec;
  if (pos === 'RB') stats.bonus_rec_rb = rec;
  if (pos === 'WR') stats.bonus_rec_wr = rec;
  Object.assign(stats, yardageBonuses(stats));
  return stats;
}

// ------------------------------------------------------------------ kicker

function kickerStatLine(p: PlayerInput, env: GameEnv): StatLine {
  const f = p.form;
  const games = f?.wSum ?? 0;
  const fgAttPg = shrink(f?.wFgAtt ?? 0, games, 1.8, 3) * Math.pow(env.scoreFactor, 0.6);
  const made = shrink((f?.wFgMade039 ?? 0) + (f?.wFgMade4049 ?? 0) + (f?.wFgMade50p ?? 0), f?.wFgAtt ?? 0, 0.85, 15);
  const fgm = fgAttPg * made;
  // Distribuição por distância: histórico do kicker puxado para a média da liga
  const totalMade = (f?.wFgMade039 ?? 0) + (f?.wFgMade4049 ?? 0) + (f?.wFgMade50p ?? 0);
  const share = (x: number, prior: number) => shrink(x, totalMade, prior, 8);
  const s039 = share(f?.wFgMade039 ?? 0, 0.55);
  const s4049 = share(f?.wFgMade4049 ?? 0, 0.27);
  const s50 = share(f?.wFgMade50p ?? 0, 0.18);
  const tot = s039 + s4049 + s50;
  const tds = env.teamPoints * 0.105;
  const xpa = tds * 0.93;
  const xpPct = shrink(f?.wPatMade ?? 0, f?.wPatAtt ?? 0, 0.95, 20);
  return {
    fga: fgAttPg,
    fgm,
    fgmiss: fgAttPg - fgm,
    fgm_0_19: (fgm * s039 * 0.05) / tot,
    fgm_20_29: (fgm * s039 * 0.45) / tot,
    fgm_30_39: (fgm * s039 * 0.5) / tot,
    fgm_40_49: (fgm * s4049) / tot,
    fgm_50_59: (fgm * s50 * 0.95) / tot,
    fgm_60p: (fgm * s50 * 0.05) / tot,
    fgm_50p: (fgm * s50) / tot,
    fgm_yds: fgm * 38,
    xpa,
    xpm: xpa * xpPct,
    xpmiss: xpa * (1 - xpPct),
  };
}

// ------------------------------------------------------------------ defesa

const PTS_BUCKETS: [string, number, number][] = [
  ['pts_allow_0', -100, 0.5],
  ['pts_allow_1_6', 0.5, 6.5],
  ['pts_allow_7_13', 6.5, 13.5],
  ['pts_allow_14_20', 13.5, 20.5],
  ['pts_allow_21_27', 20.5, 27.5],
  ['pts_allow_28_34', 27.5, 34.5],
  ['pts_allow_35p', 34.5, 200],
];
const YDS_BUCKETS: [string, number, number][] = [
  ['yds_allow_0_100', -1000, 100],
  ['yds_allow_100_199', 100, 200],
  ['yds_allow_200_299', 200, 300],
  ['yds_allow_300_349', 300, 350],
  ['yds_allow_350_399', 350, 400],
  ['yds_allow_400_449', 400, 450],
  ['yds_allow_450_499', 450, 500],
  ['yds_allow_500_549', 500, 550],
  ['yds_allow_550p', 550, 2000],
];

export function defenseStatLine(def: TeamForm | undefined, opp: TeamForm | undefined, oppEnv: GameEnv, avg: TeamForm): StatLine {
  const g = def?.games ?? 0;
  const og = opp?.games ?? 0;
  const blend = (d: number | undefined, o: number | undefined, a: number, oppScale = 1) =>
    0.5 * shrinkTeam(d ?? a, g, a) + 0.5 * shrinkTeam((o ?? a) * oppScale, og, a);

  const ptsMean = oppEnv.teamPoints;
  const ydsMean = blend(def?.yardsAllowed, undefined, avg.yardsAllowed) * (0.7 + 0.3 * oppEnv.scoreFactor);
  const sack = blend(def?.defSack, opp?.sacksTaken, avg.defSack);
  // Turnovers: ~60% das giveaways do adversário são INT
  const int = blend(def?.defInt, opp ? opp.giveaways * 0.6 : undefined, avg.defInt);
  const fumRec = blend(def?.defFumRec, opp ? opp.giveaways * 0.4 : undefined, avg.defFumRec);

  const stats: StatLine = {
    sack,
    int,
    fum_rec: fumRec,
    ff: fumRec * 1.6,
    def_td: (int + fumRec) * 0.11,
    def_st_td: shrinkTeam(def?.stTd ?? avg.stTd, g, avg.stTd, 8),
    safe: avg.defSafe,
    blk_kick: avg.defBlk,
    pts_allow: ptsMean,
    yds_allow: ydsMean,
  };
  for (const [k, lo, hi] of PTS_BUCKETS) stats[k] = probBetween(lo, hi, ptsMean, 9.5);
  for (const [k, lo, hi] of YDS_BUCKETS) stats[k] = probBetween(lo, hi, ydsMean, 70);
  return stats;
}

// ------------------------------------------------------------------ montagem

function finalize(p: PlayerInput, opponent: string | null, stats: StatLine, scoring: Scoring, note?: string): Projection {
  const { mult, sdBoost } = availability(p.injuryStatus);
  const raw = scoreStatLine(stats, scoring);
  const mean = Math.max(0, raw * mult);
  const v = VARIANCE[p.position] ?? { cv: 0.6, base: 2 };
  const sd = mean === 0 ? 0 : mean * (v.cv + sdBoost) + v.base;
  const scaled: StatLine = {};
  for (const [k, val] of Object.entries(stats)) scaled[k] = val * mult;
  return {
    sleeperId: p.sleeperId,
    name: p.name,
    position: p.position,
    fantasyPositions: p.fantasyPositions,
    team: p.team,
    opponent,
    injuryStatus: p.injuryStatus,
    mean,
    sd,
    p20: Math.max(0, mean - 0.84 * sd),
    p80: mean + 0.84 * sd,
    stats: scaled,
    note: note ?? (mult === 0 ? p.injuryStatus ?? undefined : undefined),
  };
}

export function projectPlayer(p: PlayerInput, ctx: WeekContext, scoring: Scoring): Projection {
  const team = p.team;
  const game = team ? ctx.games.get(team) : undefined;
  if (!game) return finalize(p, null, {}, scoring, team ? 'BYE' : 'sem time');

  const avg = ctx.leagueAvg;
  const env = gameEnvironment(ctx.teamForm.get(team), game, avg, ctx.avgImplied);

  if (p.position === 'DEF') {
    const oppGame = ctx.games.get(game.opponent)!;
    const oppEnv = gameEnvironment(ctx.teamForm.get(game.opponent), oppGame, avg, ctx.avgImplied);
    const stats = defenseStatLine(ctx.teamForm.get(team), ctx.teamForm.get(game.opponent), oppEnv, avg);
    return finalize(p, game.opponent, stats, scoring);
  }
  if (p.position === 'K') return finalize(p, game.opponent, kickerStatLine(p, env), scoring);

  const dvp = ctx.dvp.get(`${game.opponent}:${p.position}`) ?? 1;
  const matchup = clamp(1 + 0.6 * (dvp - 1), 0.85, 1.15);
  return finalize(p, game.opponent, skillStatLine(p, env, matchup), scoring);
}

export function projectAll(players: PlayerInput[], ctx: WeekContext, scoring: Scoring): Map<string, Projection> {
  return new Map(players.map((p) => [p.sleeperId, projectPlayer(p, ctx, scoring)]));
}
