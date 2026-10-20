import { analyzeClaims } from '../analysis/claims.js';
import { loadContext } from '../analysis/context.js';
import { analyzeLineup } from '../analysis/lineup.js';
import { analyzeTrades, tradeWindowOpen } from '../analysis/trades.js';
import { analyzeWaivers } from '../analysis/waivers.js';
import { sql, withJobLock } from '../db/index.js';
import { syncPlayers } from '../data/sleeperSync.js';
import { log } from '../log.js';
import { selectedLeagueIds } from '../league/selection.js';
import { escapeHtml } from '../notify/telegram.js';
import { activePlayers, loadLeague } from '../league/settings.js';
import { formatClaims, formatInjuryAlert, formatLineup, formatTrades, formatWaivers } from '../notify/format.js';
import { graphqlConfigured } from '../sleeper/graphql.js';
import { drainOutbox, enqueue } from '../notify/outbox.js';
import { runSync } from './sync.js';

export interface JobOptions {
  leagueId?: string;
  notify?: boolean;
  week?: number;
  /** Envia mesmo que o conteúdo seja igual a uma mensagem já enviada (comandos do bot). */
  force?: boolean;
}

export interface JobResult {
  /** HTML do Telegram. */
  text: string;
  /** true se foi enfileirado para envio. */
  delivered: boolean;
}

async function deliver(kind: string, scope: string, html: string, opts: JobOptions): Promise<JobResult> {
  const league = opts.leagueId ? await loadLeague(opts.leagueId) : null;
  if (league) html = `<b>${escapeHtml(league.name)}</b>\n\n${html}`;
  scope = `${opts.leagueId ?? 'default'}:${scope}`;
  if (!opts.notify) return { text: html, delivered: false };
  const s = opts.force ? `${scope}:${Date.now()}` : scope;
  const queued = await enqueue(kind, s, html);
  if (!queued) log.info({ kind }, 'mensagem idêntica já enviada; ignorando');
  await drainOutbox();
  return { text: html, delivered: true };
}

async function locked<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const result = await withJobLock(job, fn);
  if (result === null) throw new Error(`Job ${job} já está rodando em outro processo`);
  return result;
}

function runLineupSingle(opts: JobOptions = {}): Promise<JobResult> {
  return locked('lineup', async () => {
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, opts.week ?? week, { leagueId: opts.leagueId });
    const report = await analyzeLineup(ctx);
    const html = formatLineup(report, ctx.weekProj, ctx.league.name);
    return deliver('lineup', `${season}-w${ctx.week}`, html, opts);
  });
}

function runWaiversSingle(opts: JobOptions = {}): Promise<JobResult> {
  return locked('waivers', async () => {
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, opts.week ?? week, { ros: true, leagueId: opts.leagueId });
    const moves = await analyzeWaivers(ctx);
    let html = formatWaivers(moves, ctx.week, ctx.league.faab.enabled);
    // Com token, o relatório também avalia as propostas que você já fez
    if (graphqlConfigured() && ctx.league.faab.enabled) {
      try {
        html += '\n\n' + formatClaims(await analyzeClaims(ctx), faabLeft(ctx), { header: false });
      } catch (err) {
        log.warn({ err }, 'não foi possível ler suas propostas pendentes');
      }
    }
    return deliver('waivers', `${season}-w${ctx.week}`, html, opts);
  });
}

const faabLeft = (ctx: { league: { faab: { budget: number } }; mine: { faabUsed: number } }) =>
  Math.max(0, ctx.league.faab.budget - ctx.mine.faabUsed);

function runClaimsSingle(opts: JobOptions = {}): Promise<JobResult> {
  return locked('claims', async () => {
    if (!graphqlConfigured()) {
      return { text: 'Configure SLEEPER_TOKEN no .env para ler suas propostas pendentes.', delivered: false };
    }
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, opts.week ?? week, { ros: true, leagueId: opts.leagueId });
    if (!ctx.league.faab.enabled) return { text: 'A liga não usa FAAB.', delivered: false };
    const html = formatClaims(await analyzeClaims(ctx), faabLeft(ctx));
    return deliver('claims', `${season}-w${ctx.week}`, html, opts);
  });
}

function runTradesSingle(opts: JobOptions & { partner?: string } = {}): Promise<JobResult> {
  return locked('trades', async () => {
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, opts.week ?? week, { ros: true, leagueId: opts.leagueId });
    if (!tradeWindowOpen(ctx.league, ctx.week)) return { text: 'Prazo de trocas da liga já passou.', delivered: false };
    const ideas = await analyzeTrades(ctx, { partner: opts.partner });
    const html = formatTrades(ideas, ctx.week);
    return deliver('trades', `${season}-w${ctx.week}`, html, opts);
  });
}

/**
 * Compara o status de lesão atual dos meus jogadores com o último visto
 * (app.injury_watch) e alerta só o que mudou para pior ou melhor.
 */
function runInjuriesSingle(opts: JobOptions = {}): Promise<JobResult> {
  return locked('injuries', async () => {
    await syncPlayers(true);
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, week, { leagueId: opts.leagueId });
    const mine = activePlayers(ctx.mine);
    const prev = new Map(
      (await sql`SELECT sleeper_id, injury_status FROM app.injury_watch WHERE league_id = ${ctx.league.id} AND sleeper_id = ANY(${mine})`).map((r) => [
        r.sleeper_id as string,
        r.injury_status as string | null,
      ]),
    );
    const changes = mine
      .map((id) => ctx.weekProj.get(id))
      .filter((p) => !!p)
      .filter((p) => (prev.has(p.sleeperId) ? prev.get(p.sleeperId) !== p.injuryStatus : p.injuryStatus !== null))
      .map((p) => ({ p, from: prev.get(p.sleeperId) ?? null }));

    for (const id of mine) {
      const status = ctx.weekProj.get(id)?.injuryStatus ?? null;
      await sql`
        INSERT INTO app.injury_watch (league_id, sleeper_id, injury_status) VALUES (${ctx.league.id}, ${id}, ${status})
        ON CONFLICT (league_id, sleeper_id) DO UPDATE SET injury_status = excluded.injury_status, updated_at = now()`;
    }
    if (changes.length === 0) return { text: 'Sem mudanças de status de lesão.', delivered: false };
    const html = formatInjuryAlert(changes, week);
    return deliver('injuries', `${season}-w${week}`, html, opts);
  });
}

/** Uma falha não impede as demais ligas de serem analisadas. */
async function forLeagues<T extends JobOptions>(opts: T, job: (o: T) => Promise<JobResult>): Promise<JobResult> {
  const results: JobResult[] = [];
  for (const leagueId of await selectedLeagueIds(opts.leagueId)) {
    try {
      const result = await job({ ...opts, leagueId });
      if (!result.delivered && opts.notify && result.text === 'Sem mudanças de status de lesão.' && !opts.force) {
        results.push({ text: '', delivered: true });
      } else if (!result.delivered && opts.notify) {
        results.push(await deliver('status', `${Date.now()}`, result.text, { ...opts, leagueId }));
      } else {
        if (!result.delivered && !opts.notify && !result.text.includes('<b>')) {
          const league = await loadLeague(leagueId);
          result.text = `<b>${escapeHtml(league.name)}</b>\n${result.text}`;
        }
        results.push(result);
      }
    } catch (err) {
      log.error({ err, leagueId }, 'falha na análise da liga');
      const text = `Liga ${leagueId}: ${escapeHtml(err instanceof Error ? err.message : String(err))}`;
      if (opts.notify) {
        await enqueue('error', `${leagueId}:${Date.now()}`, text);
        await drainOutbox();
      }
      results.push({ text, delivered: Boolean(opts.notify) });
    }
  }
  return { text: results.map(r => r.text).join('\n\n'), delivered: results.every(r => r.delivered) };
}

export const runLineupJob = (opts: JobOptions = {}) => forLeagues(opts, runLineupSingle);
export const runWaiversJob = (opts: JobOptions = {}) => forLeagues(opts, runWaiversSingle);
export const runClaimsJob = (opts: JobOptions = {}) => forLeagues(opts, runClaimsSingle);
export const runTradesJob = (opts: JobOptions & { partner?: string } = {}) => forLeagues(opts, runTradesSingle);
export const runInjuriesJob = (opts: JobOptions = {}) => forLeagues(opts, runInjuriesSingle);
