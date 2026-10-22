import { describe, expect, it } from 'vitest';
import { evaluateInboxTrade } from '../src/analysis/inbox.js';
import { matchPlayer, nameTokens, resolveTrade, syntheticTrade, type RosteredPlayer } from '../src/analysis/tradeImage.js';
import type { TeamRoster } from '../src/league/settings.js';
import type { ExtractedTrade } from '../src/llm/claude.js';
import { formatInbox } from '../src/notify/inbox.js';
import { messageImage } from '../src/notify/telegram.js';
import { inboxContext, offer } from './fixtures/inbox.js';

const p = (sleeperId: string, name: string, position: string, team: string): RosteredPlayer => ({ sleeperId, name, position, team });
const players = new Map([
  p('1', "Ja'Marr Chase", 'WR', 'CIN'), p('2', 'Bijan Robinson', 'RB', 'ATL'), p('3', 'Marvin Harrison Jr.', 'WR', 'ARI'),
  p('4', 'Josh Allen', 'QB', 'BUF'), p('5', 'Josh Allen', 'LB', 'JAX'), p('6', 'Puka Nacua', 'WR', 'LAR'),
  p('BUF', 'Buffalo Bills', 'DEF', 'BUF'), p('7', 'Jonathan Taylor', 'RB', 'IND'), p('8', 'Justin Tucker', 'K', 'BAL'),
].map(x => [x.sleeperId, x]));
const roster = (rosterId: number, ownerName: string, ids: string[]): TeamRoster => ({ rosterId, ownerId: `u${rosterId}`, ownerName,
  players: ids, starters: [], reserve: [], taxi: [], faabUsed: 0, waiverPosition: rosterId });
const me = roster(1, 'arthur', ['1', '4', 'BUF']);
const rosters = [me, roster(2, 'Rival', ['2', '3', '5']), roster(3, 'Outro', ['6', '7', '8'])];
const pl = (name: string, position: string | null = null, team: string | null = null) => ({ name, position, team });
const side = (owner: string | null, ps: ReturnType<typeof pl>[], extra: Partial<ExtractedTrade['sides'][number]> = {}) =>
  ({ owner, players: ps, picks: [], faab: null, ...extra });
const trade = (...sides: ExtractedTrade['sides']): ExtractedTrade => ({ sides, notes: null });

describe('name normalization', () => {
  it('ignores accents, punctuation and suffixes', () => {
    expect(nameTokens('Marvin Harrison Jr.')).toEqual(['marvin', 'harrison']);
    expect(nameTokens("Ja'Marr Chase")).toEqual(['jamarr', 'chase']);
    expect(nameTokens('José Ñúñez III')).toEqual(['jose', 'nunez']);
  });
  it('accepts first initial abbreviations and D/ST names', () => {
    const pool = [...players.values()];
    expect(matchPlayer(pl('J. Chase'), pool).map(x => x.sleeperId)).toEqual(['1']);
    expect(matchPlayer(pl('Bills D/ST'), pool).map(x => x.sleeperId)).toEqual(['BUF']);
    expect(matchPlayer(pl('Rams', 'DEF', 'LA'), [p('LAR', 'Los Angeles Rams', 'DEF', 'LAR')]).map(x => x.sleeperId)).toEqual(['LAR']);
  });
  it('uses position and team only to break ties', () => {
    const pool = [...players.values()];
    expect(matchPlayer(pl('Josh Allen'), pool)).toHaveLength(2);
    expect(matchPlayer(pl('Josh Allen', 'QB'), pool).map(x => x.sleeperId)).toEqual(['4']);
  });
});

describe('trade resolution', () => {
  it('finds my side and the single partner whose roster has every asset', () => {
    const r = resolveTrade(trade(side('Rival', [pl('Bijan Robinson'), pl('Marvin Harrison')]), side(null, [pl("Ja'Marr Chase")])), rosters, me, players);
    expect(r).toMatchObject({ ok: true, trade: { give: ['1'], get: ['2', '3'] } });
    if (r.ok) expect(r.trade.partner.rosterId).toBe(2);
  });
  it('does not guess when a player is outside the rosters', () => {
    const r = resolveTrade(trade(side(null, [pl('Chase')]), side(null, [pl('Bijan Robinson'), pl('Saquon Barkley')])), rosters, me, players);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain('Saquon Barkley: não encontrado');
  });
  it('rejects names split across teams and multi-team trades', () => {
    expect(resolveTrade(trade(side(null, [pl("Ja'Marr Chase")]), side(null, [pl('Bijan Robinson'), pl('Puka Nacua')])), rosters, me, players).ok).toBe(false);
    expect(resolveTrade(trade(side(null, [pl("Ja'Marr Chase")]), side(null, [pl('Bijan Robinson')]), side(null, [pl('Puka Nacua')])), rosters, me, players).ok).toBe(false);
  });
  it('keeps picks and FAAB, using the shown owner for a picks-only side', () => {
    const r = resolveTrade(trade(side(null, [pl("Ja'Marr Chase")], { faab: 10 }), side('Outro', [], { picks: [{ season: '2027', round: 1 }] })), rosters, me, players);
    expect(r).toMatchObject({ ok: true, trade: { give: ['1'], get: [], faabGive: 10, picksGet: [{ season: '2027', round: 1 }] } });
  });
  it('isolates leagues: the same image matches only where my roster has the assets', () => {
    const other = roster(1, 'arthur', ['6']);
    const r = resolveTrade(trade(side(null, [pl("Ja'Marr Chase")]), side(null, [pl('Bijan Robinson')])), [other, rosters[1]!], other, players);
    expect(r.ok).toBe(false);
  });
});

describe('synthetic trade evaluation', () => {
  it('matches the evaluation of the equivalent Sleeper proposal', () => {
    const ctx = inboxContext();
    const t = syntheticTrade('111', 7, ctx.mine, { partner: ctx.rosters[1]!, give: ['r1'], get: ['r2'], picksGive: [], picksGet: [], faabGive: 0, faabGet: 0 });
    const fromImage = evaluateInboxTrade(ctx, t);
    const fromSleeper = evaluateInboxTrade(ctx, offer());
    expect({ ...fromImage, transactionId: '' }).toEqual({ ...fromSleeper, transactionId: '' });
    const html = formatInbox([fromImage], ctx.weekProj, { title: '🧮 <b>Trade calculator</b>', hideId: true });
    expect(html).toContain('Trade calculator');
    expect(html).not.toContain('<code>');
  });
  it('shows picks without a known season instead of dropping them', () => {
    const ctx = inboxContext();
    const t = syntheticTrade('111', 7, ctx.mine, { partner: ctx.rosters[1]!, give: ['r1'], get: [], picksGive: [], picksGet: [{ season: '?', round: 2 }], faabGive: 0, faabGet: 0 });
    expect(evaluateInboxTrade(ctx, t).picksGet).toHaveLength(1);
  });
});

describe('telegram images', () => {
  const msg = { message_id: 1, chat: { id: 1, type: 'private' } };
  it('picks the largest photo size or an image document', () => {
    expect(messageImage({ ...msg, photo: [{ file_id: 'a', width: 90, height: 90 }, { file_id: 'b', width: 1280, height: 720 }] })?.fileId).toBe('b');
    expect(messageImage({ ...msg, document: { file_id: 'd', mime_type: 'image/png' } })).toMatchObject({ fileId: 'd', mimeType: 'image/png' });
    expect(messageImage({ ...msg, document: { file_id: 'd', mime_type: 'application/pdf' } })).toBeNull();
    expect(messageImage({ ...msg, text: '/lineup' })).toBeNull();
  });
});
