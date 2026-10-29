import { analyzeInbox, evaluateInboxTrade, findCounter, tradeFingerprint } from '../analysis/inbox.js';
import { describeExtraction, resolveTrade, syntheticTrade, type Resolution, type RosteredPlayer } from '../analysis/tradeImage.js';
import { extractTradeFromImage, IMAGE_MEDIA_TYPES, llmConfigured, tradeCommentary, type ImageMediaType } from '../llm/claude.js';
import { formatInbox } from '../notify/inbox.js';
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
import { activePlayers, loadLeague, loadRosters, type LeagueSettings } from '../league/settings.js';
import { findMyRoster } from '../analysis/context.js';
import { formatClaims, formatInjuryAlert, formatLineup, formatTrades, formatWaivers } from '../notify/format.js';
import { graphqlConfigured, myTradeInbox } from '../sleeper/graphql.js';
import { drainOutbox, enqueue } from '../notify/outbox.js';
import { runSync } from './sync.js';

export interface JobOptions {
  leagueId?: string;
  /** Inbox agendado: notifica somente propostas novas ou alteradas. */
  newOnly?: boolean;
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

async function deliver(kind: string, scope: string, html: string, opts: JobOptions, dedupeByScope = false): Promise<JobResult> {
  const league = opts.leagueId ? await loadLeague(opts.leagueId) : null;
  if (league) html = `<b>${escapeHtml(league.name)}</b>\n\n${html}`;
  scope = `${opts.leagueId ?? 'default'}:${scope}`;
  if (!opts.notify) return { text: html, delivered: false };
  const s = opts.force ? `${scope}:${Date.now()}` : scope;
  const queued = await enqueue(kind, s, html, { dedupeByScope });
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

function runInboxSingle(opts: JobOptions = {}): Promise<JobResult> {
  return locked(`inbox:${opts.leagueId}`, async () => {
    if (!graphqlConfigured()) return { text: 'Configure SLEEPER_TOKEN no .env para consultar suas propostas de trade.', delivered: false };
    const { season, week } = await runSync({ leagueId: opts.leagueId });
    const ctx = await loadContext(season, week, { ros: true, leagueId: opts.leagueId });
    if (!ctx.mine.ownerId) throw new Error('Seu roster não tem proprietário identificado.');
    const trades = await myTradeInbox(ctx.league.id, ctx.mine.rosterId, ctx.mine.ownerId);
    const reports = await analyzeInbox(ctx, trades);
    if (opts.newOnly && opts.notify) {
      for (const report of reports) {
        const trade = trades.find(t => t.transaction_id === report.transactionId)!;
        await deliver('inbox', `${trade.transaction_id}:${tradeFingerprint(trade)}`,
          formatInbox([report], ctx.weekProj), opts, true);
      }
      return { text: '', delivered: true };
    }
    return deliver('inbox', `${season}-w${week}`, formatInbox(reports, ctx.weekProj), opts);
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
        // O mesmo erro na mesma liga é avisado uma vez por dia, não a cada execução do timer
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        await enqueue('error', `${leagueId}:${day}`, text);
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

export const runInboxJob = (opts: JobOptions = {}) => forLeagues(opts, runInboxSingle);

/** Tipo da imagem pelos bytes iniciais; o nome ou MIME informado serve só de fallback. */
export function imageMediaType(data: Buffer, hint?: string): ImageMediaType | null {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return IMAGE_MEDIA_TYPES.find((t) => t === hint) ?? null;
}

async function rosteredPlayers(ids: string[]): Promise<Map<string, RosteredPlayer>> {
  const rows = await sql`SELECT sleeper_id, full_name, position, team FROM core.players WHERE sleeper_id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.sleeper_id as string, {
    sleeperId: r.sleeper_id as string, name: (r.full_name as string | null) ?? (r.sleeper_id as string),
    position: r.position as string | null, team: r.team as string | null,
  }]));
}

const comparable = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface TradeImageOptions extends JobOptions {
  image: Buffer;
  mediaType?: string;
  /** Legenda da foto: se citar o nome de uma liga, restringe a busca a ela. */
  caption?: string;
}

/**
 * Trade calculator: o Claude lê o print, a liga é a única cujos rosters casam com
 * os dois lados, e a avaliação reaproveita o modelo do inbox.
 */
export async function runTradeImageJob(opts: TradeImageOptions): Promise<JobResult> {
  if (!llmConfigured()) return { text: 'Configure ANTHROPIC_API_KEY no .env para avaliar trocas por imagem.', delivered: false };
  const mediaType = imageMediaType(opts.image, opts.mediaType);
  if (!mediaType) return { text: 'Formato de imagem não suportado. Envie JPEG, PNG, GIF ou WebP.', delivered: false };
  const extracted = await extractTradeFromImage(opts.image, mediaType, opts.caption);
  const reading = ['📷 <b>Leitura da imagem</b>', ...describeExtraction(extracted).map(escapeHtml)];

  const leagues: { league: LeagueSettings; resolution: Resolution; mine: Awaited<ReturnType<typeof findMyRoster>> }[] = [];
  for (const leagueId of await selectedLeagueIds(opts.leagueId)) {
    try {
      const league = await loadLeague(leagueId);
      const rosters = await loadRosters(leagueId);
      const mine = await findMyRoster(rosters);
      const players = await rosteredPlayers(rosters.flatMap((r) => r.players));
      leagues.push({ league, mine, resolution: resolveTrade(extracted, rosters, mine, players) });
    } catch (err) {
      log.warn({ err, leagueId }, 'liga ignorada no trade calculator');
    }
  }
  const caption = comparable(opts.caption ?? '');
  const named = leagues.filter((l) => caption && caption.includes(comparable(l.league.name)));
  const candidates = named.length ? named : leagues;
  const matches = candidates.filter((l) => l.resolution.ok);

  if (matches.length !== 1) {
    const lines = [...reading, ''];
    if (matches.length > 1) {
      lines.push('⚠️ A troca casa com mais de uma liga. Reenvie com o nome da liga na legenda:',
        ...matches.map((l) => `• ${escapeHtml(l.league.name)}`));
    } else {
      lines.push('⚠️ Não consegui casar a troca com os rosters de nenhuma liga; nada foi avaliado.');
      for (const l of candidates) {
        if (!l.resolution.ok) lines.push(`<b>${escapeHtml(l.league.name)}</b>`, ...l.resolution.problems.map((p) => `• ${escapeHtml(p)}`));
      }
    }
    return { text: lines.join('\n'), delivered: false };
  }

  const { league, resolution } = matches[0]!;
  if (!resolution.ok) throw new Error('resolução inconsistente');
  return locked(`trade-image:${league.id}`, async () => {
    const { season, week } = await runSync({ leagueId: league.id });
    const ctx = await loadContext(season, week, { ros: true, leagueId: league.id });
    if (!tradeWindowOpen(ctx.league, ctx.week)) reading.push('', '⚠️ O prazo de trocas da liga já passou; a avaliação é só informativa.');
    // Rosters recarregados após o sync: o parceiro é o mesmo roster_id resolvido na leitura
    const report = evaluateInboxTrade(ctx, syntheticTrade(ctx.league.id, ctx.week, ctx.mine, resolution.trade));
    report.counter = await findCounter(ctx, report);
    const evaluation = formatInbox([report], ctx.weekProj, { title: '🧮 <b>Trade calculator</b>', hideId: true });
    const parts = [evaluation, '', ...reading];
    try {
      const comment = await tradeCommentary(evaluation.replace(/<[^>]+>/g, ''));
      if (comment) parts.splice(1, 0, '', `💬 <b>Comentário</b>\n${escapeHtml(comment)}`);
    } catch (err) {
      log.warn({ err }, 'comentário do trade calculator indisponível');
    }
    return deliver('trade-image', `${Date.now()}`, parts.join('\n'), { ...opts, leagueId: league.id });
  });
}
