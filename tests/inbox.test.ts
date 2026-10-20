import { describe, expect, it } from 'vitest';
import { analyzeInbox, evaluateInboxTrade, tradeAssets, tradeFingerprint } from '../src/analysis/inbox.js';
import { isIncomingTrade } from '../src/sleeper/graphql.js';
import { formatInbox } from '../src/notify/inbox.js';
import { inboxContext, offer } from './fixtures/inbox.js';

describe('incoming trade filtering', () => {
  it('accepts only my own league, roster and unconsented incoming proposals', () => {
    expect(isIncomingTrade(offer(), '111', 1, 'u1')).toBe(true);
    for (const extra of [{ league_id: '222' }, { status: 'complete' }, { status: 'pending' },
      { creator: 'u1' }, { consenter_ids: [1, 2] }, { roster_ids: [2, 3] }]) {
      expect(isIncomingTrade(offer(extra), '111', 1, 'u1')).toBe(false);
    }
  });
  it('filters unrelated offers again during analysis', async () => {
    expect(await analyzeInbox(inboxContext(), [offer({ league_id: '222' })])).toEqual([]);
  });
});
describe('inbox evaluation', () => {
  it('reads transfers from source/destination and computes actual optimal-lineup gain', () => {
    const ctx = inboxContext();
    const r = evaluateInboxTrade(ctx, offer());
    expect(r.give).toEqual(['r1']); expect(r.get).toEqual(['r2']);
    expect(r.weekGain).toBeCloseTo(10);
    expect(r.rosGain).toBeCloseTo(10 * (1 + 0.97 + 0.97 ** 2));
    expect(r.partnerGains[0]!.gain).toBeLessThan(0);
    expect(r.verdict).toBe('favorable');
  });
  it('flags a loss of both production and positional value', () => {
    const ctx = inboxContext();
    ctx.mine.players = ['q1', 'r2', 'w1']; ctx.rosters[1]!.players = ['q2', 'r1', 'w2'];
    const r = evaluateInboxTrade(ctx, offer({ adds: { r2: 2, r1: 1 }, drops: { r2: 1, r1: 2 } }));
    expect(r.verdict).toBe('unfavorable'); expect(r.rosGain).toBeLessThan(0);
  });
  it('shows picks and FAAB without converting them to projected points', () => {
    const ctx = inboxContext();
    const t = offer({ draft_picks: [{ season: '2027', round: 1, roster_id: 2, owner_id: 1, previous_owner_id: 2 }],
      waiver_budget: [{ sender: 1, receiver: 2, amount: 20 }] });
    expect(tradeAssets(t, 1)).toMatchObject({ faabGive: 20, faabGet: 0 });
    const r = evaluateInboxTrade(ctx, t);
    expect(r.picksGet).toHaveLength(1); expect(r.verdict).toBe('review'); expect(r.weekGain).toBe(10);
    expect(formatInbox([r], ctx.weekProj)).toContain('Pick 2027');
  });
  it('requires review for future dynasty value and unknown player projections', () => {
    const ctx = inboxContext(); ctx.league.type = 'dynasty';
    expect(evaluateInboxTrade(ctx, offer()).verdict).toBe('review');
    ctx.league.type = 'redraft'; ctx.weekProj.delete('r2');
    const r = evaluateInboxTrade(ctx, offer());
    expect(r.verdict).toBe('review'); expect(r.reasons.join(' ')).toContain('parcial');
  });
  it('requires review for stale rosters, IR/taxi and overflow', () => {
    const ctx = inboxContext(); ctx.mine.players = ['q1', 'w1'];
    expect(evaluateInboxTrade(ctx, offer()).reasons.join(' ')).toContain('mudou');
    ctx.mine.players.push('r1'); ctx.mine.reserve = ['r1'];
    expect(evaluateInboxTrade(ctx, offer()).reasons.join(' ')).toContain('IR/taxi');
    ctx.mine.reserve = []; ctx.league.rosterSize = 2;
    expect(evaluateInboxTrade(ctx, offer()).reasons.join(' ')).toContain('liberar vaga');
  });
  it('evaluates my part in a multi-team trade without attributing all assets to me', () => {
    const ctx = inboxContext();
    ctx.rosters.push({ ...ctx.rosters[1]!, rosterId: 3, ownerName: 'Third', ownerId: 'u3', players: ['w2'] });
    const t = offer({ roster_ids: [1, 2, 3], consenter_ids: [2, 3],
      adds: { r1: 2, r2: 3, w2: 1 }, drops: { r1: 1, r2: 2, w2: 3 } });
    const r = evaluateInboxTrade(ctx, t);
    expect(r.get).toEqual(['w2']); expect(r.partners).toHaveLength(2); expect(r.partnerGains).toHaveLength(2);
  });
  it('shows empty inbox and escapes external text', () => {
    const ctx = inboxContext(); ctx.rosters[1]!.ownerName = '<bad>&';
    const r = evaluateInboxTrade(ctx, offer());
    expect(formatInbox([], ctx.weekProj)).toContain('Nenhuma proposta');
    expect(formatInbox([r], ctx.weekProj)).toContain('&lt;bad&gt;&amp;');
    expect(formatInbox([r], ctx.weekProj)).not.toContain('<bad>');
  });
  it('fingerprints offer changes independently of JSON key order', () => {
    expect(tradeFingerprint(offer())).toBe(tradeFingerprint(offer({ adds: { r2: 1, r1: 2 } })));
    expect(tradeFingerprint(offer())).not.toBe(tradeFingerprint(offer({ waiver_budget: [{ sender: 1, receiver: 2, amount: 1 }] })));
  });
});
