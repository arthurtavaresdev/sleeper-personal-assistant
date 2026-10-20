import { createHash } from 'node:crypto';
import type { AnalysisContext } from './context.js';
import { activePlayers } from './context.js';
import { replacementLevels, tradeMarketValue, analyzeTrades, type TradeIdea } from './trades.js';
import { RosterValuer } from './valuation.js';
import type { TradeTransaction } from '../sleeper/types.js';
import type { TeamRoster } from '../league/settings.js';
import { isIncomingTrade } from '../sleeper/graphql.js';

export interface InboxAssets {
  give: string[];
  get: string[];
  picksGive: NonNullable<TradeTransaction['draft_picks']>;
  picksGet: NonNullable<TradeTransaction['draft_picks']>;
  faabGive: number;
  faabGet: number;
}
export interface InboxVerdict extends InboxAssets {
  transactionId: string;
  partners: TeamRoster[];
  weekGain: number;
  rosGain: number;
  marketGive: number;
  marketGet: number;
  partnerGains: { name: string; gain: number }[];
  verdict: 'favorable' | 'negotiate' | 'unfavorable' | 'review';
  reasons: string[];
  counter?: TradeIdea;
}

export function tradeAssets(t: TradeTransaction, rosterId: number): InboxAssets {
  return {
    give: Object.entries(t.drops ?? {}).filter(([, id]) => id === rosterId).map(([id]) => id),
    get: Object.entries(t.adds ?? {}).filter(([, id]) => id === rosterId).map(([id]) => id),
    picksGive: (t.draft_picks ?? []).filter(p => p.previous_owner_id === rosterId && p.owner_id !== rosterId),
    picksGet: (t.draft_picks ?? []).filter(p => p.owner_id === rosterId && p.previous_owner_id !== rosterId),
    faabGive: (t.waiver_budget ?? []).filter(b => b.sender === rosterId).reduce((s, b) => s + b.amount, 0),
    faabGet: (t.waiver_budget ?? []).filter(b => b.receiver === rosterId).reduce((s, b) => s + b.amount, 0),
  };
}

/** Avaliação sem efeitos externos: só jogadores modelados entram nos números. */
export function evaluateInboxTrade(ctx: AnalysisContext, t: TradeTransaction): InboxVerdict {
  if (!ctx.ros) throw new Error('Inbox precisa de projeções ROS');
  const assets = tradeAssets(t, ctx.mine.rosterId);
  const partners = ctx.rosters.filter(r => t.roster_ids.includes(r.rosterId) && r.rosterId !== ctx.mine.rosterId);
  const rosValuer = RosterValuer.restOfSeason(ctx.league, ctx.weekProj, ctx.ros);
  const weekValuer = RosterValuer.singleWeek(ctx.league, ctx.weekProj, ctx.week);
  const repl = replacementLevels(ctx, ctx.ros);
  const market = (ids: string[]) => ids.reduce((sum, id) => {
    const p = ctx.weekProj.get(id);
    return sum + (p ? tradeMarketValue(p, ctx, repl) : 0);
  }, 0);
  const after = (roster: TeamRoster) => {
    const a = tradeAssets(t, roster.rosterId);
    return [...new Set([...activePlayers(roster).filter(id => !a.give.includes(id)), ...a.get])];
  };
  const reasons: string[] = [];
  const participants = [ctx.mine, ...partners];
  for (const r of participants) {
    const a = tradeAssets(t, r.rosterId);
    if (a.give.some(id => !r.players.includes(id))) reasons.push(`Roster de ${r.ownerName} mudou: há jogador oferecido que não está mais no time.`);
    if ([...a.give, ...a.get].some(id => !ctx.weekProj.has(id) || !ctx.ros!.has(id))) reasons.push(`Há jogador sem projeção em ${r.ownerName}; avaliação de pontos é parcial.`);
    if (a.give.some(id => r.reserve.includes(id) || r.taxi.includes(id))) reasons.push(`Há ativo em IR/taxi de ${r.ownerName}; disponibilidade futura precisa de revisão.`);
    if (after(r).length > ctx.league.rosterSize) reasons.push(`${r.ownerName} precisará liberar vaga; o custo do descarte não está incluído.`);
  }
  for (const id of new Set([...Object.keys(t.adds ?? {}), ...Object.keys(t.drops ?? {})])) {
    const from = t.drops?.[id];
    const to = t.adds?.[id];
    if (from === undefined || to === undefined || from === to || !t.roster_ids.includes(from) || !t.roster_ids.includes(to)) {
      reasons.push('Transferência de jogador incompleta ou inconsistente; revise a proposta no Sleeper.');
    }
  }
  if (partners.length !== t.roster_ids.length - 1) reasons.push('Um participante não foi encontrado nos rosters sincronizados.');
  if (assets.picksGive.length || assets.picksGet.length) reasons.push('Picks não têm valuation próprio ainda; não estão convertidas em pontos ou valor de negociação.');
  if (assets.faabGive || assets.faabGet) reasons.push('FAAB é exibido separadamente; não há conversão de orçamento em pontos.');
  if (!assets.give.length && !assets.get.length && !assets.picksGive.length && !assets.picksGet.length && !assets.faabGive && !assets.faabGet) reasons.push('Nenhum ativo transferido para seu time foi identificado.');
  if (ctx.league.type === 'dynasty') reasons.push('O modelo dynasty usa idade e projeções até o fim desta temporada; não projeta carreiras futuras.');

  const before = activePlayers(ctx.mine);
  const rosGain = rosValuer.value(after(ctx.mine)) - rosValuer.value(before);
  const weekGain = weekValuer.value(after(ctx.mine)) - weekValuer.value(before);
  const marketGive = market(assets.give), marketGet = market(assets.get);
  // Em dynasty a avaliação é informativa, sem transformar um modelo ROS em recomendação definitiva.
  let verdict: InboxVerdict['verdict'] = 'review';
  if (!reasons.length) {
    if (rosGain > 1 && marketGet >= marketGive * 0.9) verdict = 'favorable';
    else if (rosGain < -1 && marketGet < marketGive * 0.8) verdict = 'unfavorable';
    else verdict = 'negotiate';
  }
  if (rosGain < -1) reasons.push('Seu lineup perde pontos no restante da temporada.');
  if (marketGive > marketGet * 1.2) reasons.push('Você entrega mais valor posicional do que recebe (diferença acima de 20%).');
  if (assets.give.length > assets.get.length) reasons.push('A vaga liberada pode ser preenchida por waiver; esse benefício adicional não foi presumido.');
  return {
    ...assets, transactionId: t.transaction_id, partners, weekGain, rosGain, marketGive, marketGet, verdict,
    partnerGains: partners.map(r => ({ name: r.ownerName, gain: rosValuer.value(after(r)) - rosValuer.value(activePlayers(r)) })),
    reasons: [...new Set(reasons)],
  };
}

export async function analyzeInbox(ctx: AnalysisContext, trades: TradeTransaction[]): Promise<InboxVerdict[]> {
  const incoming = trades.filter(t => isIncomingTrade(t, ctx.league.id, ctx.mine.rosterId, ctx.mine.ownerId ?? ''));
  const reports: InboxVerdict[] = [];
  for (const t of incoming) {
    const report = evaluateInboxTrade(ctx, t);
    if (report.verdict !== 'review' && report.verdict !== 'favorable' && report.partners.length === 1) {
      const ideas = await analyzeTrades(ctx, { partner: report.partners[0]!.ownerName, limit: 20 });
      report.counter = ideas.find(idea => idea.partner.rosterId === report.partners[0]!.rosterId
        && idea.get.some(p => report.get.includes(p.sleeperId))
        && !(idea.give.length === report.give.length && idea.get.length === report.get.length
          && idea.give.every(p => report.give.includes(p.sleeperId)) && idea.get.every(p => report.get.includes(p.sleeperId))));
    }
    reports.push(report);
  }
  return reports;
}

/** Identifica alterações da oferta, independentemente de mudanças nas projeções. */
export function tradeFingerprint(t: TradeTransaction): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical({
    adds: t.adds, drops: t.drops, draft_picks: t.draft_picks, waiver_budget: t.waiver_budget,
    settings: t.settings, creator: t.creator, roster_ids: t.roster_ids, consenter_ids: t.consenter_ids,
  }))).digest('hex').slice(0, 24);
}
