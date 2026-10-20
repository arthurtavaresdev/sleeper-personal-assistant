import { loadContext } from '../analysis/context.js';
import { analyzeLineup } from '../analysis/lineup.js';
import { analyzeTrades, tradeWindowOpen } from '../analysis/trades.js';
import { analyzeWaivers } from '../analysis/waivers.js';
import { sql, withJobLock } from '../db/index.js';
import { syncPlayers } from '../data/sleeperSync.js';
import { log } from '../log.js';
import { activePlayers } from '../league/settings.js';
import { formatInjuryAlert, formatLineup, formatTrades, formatWaivers } from '../notify/format.js';
import { drainOutbox, enqueue } from '../notify/outbox.js';
import { runSync } from './sync.js';

export interface JobOptions {
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

export function runLineupJob(opts: JobOptions = {}): Promise<JobResult> {
  return locked('lineup', async () => {
    const { season, week } = await runSync();
    const ctx = await loadContext(season, opts.week ?? week);
    const report = await analyzeLineup(ctx);
    const html = formatLineup(report, ctx.weekProj, ctx.league.name);
    return deliver('lineup', `${season}-w${ctx.week}`, html, opts);
  });
}

export function runWaiversJob(opts: JobOptions = {}): Promise<JobResult> {
  return locked('waivers', async () => {
    const { season, week } = await runSync();
    const ctx = await loadContext(season, opts.week ?? week, { ros: true });
    const moves = await analyzeWaivers(ctx);
    const html = formatWaivers(moves, ctx.week, ctx.league.faab.enabled);
    return deliver('waivers', `${season}-w${ctx.week}`, html, opts);
  });
}

export function runTradesJob(opts: JobOptions & { partner?: string } = {}): Promise<JobResult> {
  return locked('trades', async () => {
    const { season, week } = await runSync();
    const ctx = await loadContext(season, opts.week ?? week, { ros: true });
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
export function runInjuriesJob(opts: JobOptions = {}): Promise<JobResult> {
  return locked('injuries', async () => {
    await syncPlayers(true);
    const { season, week } = await runSync();
    const ctx = await loadContext(season, week);
    const mine = activePlayers(ctx.mine);
    const prev = new Map(
      (await sql`SELECT sleeper_id, injury_status FROM app.injury_watch WHERE sleeper_id = ANY(${mine})`).map((r) => [
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
        INSERT INTO app.injury_watch (sleeper_id, injury_status) VALUES (${id}, ${status})
        ON CONFLICT (sleeper_id) DO UPDATE SET injury_status = excluded.injury_status, updated_at = now()`;
    }
    if (changes.length === 0) return { text: 'Sem mudanças de status de lesão.', delivered: false };
    const html = formatInjuryAlert(changes, week);
    return deliver('injuries', `${season}-w${week}`, html, opts);
  });
}
