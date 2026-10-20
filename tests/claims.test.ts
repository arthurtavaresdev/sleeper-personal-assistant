import { describe, expect, it } from 'vitest';
import { decide, faabCeiling } from '../src/analysis/claims.js';

const base = { currentBid: 5, suggestion: 4, ceiling: 8, minBid: 1 };

describe('claim decisions', () => {
  it('cancels claims that do not improve the team', () => {
    expect(decide({ ...base, rosGain: 0.3, topRival: null }).action).toBe('cancel');
  });
  it('lets go when beating the likely rival costs more than the ceiling', () => {
    const d = decide({ ...base, rosGain: 7, topRival: { bid: 18, beatsMeOnTie: true } });
    expect(d).toMatchObject({ action: 'let_go', neededBid: 19, suggestedBid: 4 });
  });
  it('raises to the bid needed when it fits under the ceiling', () => {
    expect(decide({ ...base, rosGain: 7, topRival: { bid: 6, beatsMeOnTie: true } })).toMatchObject({ action: 'raise', suggestedBid: 7 });
  });
  it('does not add $1 when I win the tie-break', () => {
    expect(decide({ ...base, rosGain: 7, topRival: { bid: 6, beatsMeOnTie: false } }).suggestedBid).toBe(6);
  });
  it('keeps a bid already above what is needed and below the ceiling', () => {
    expect(decide({ ...base, currentBid: 8, rosGain: 7, topRival: { bid: 5, beatsMeOnTie: true } }).action).toBe('keep');
  });
  it('caps the ceiling by remaining budget', () => {
    expect(faabCeiling(1000, 30, 10)).toBe(18);
    expect(faabCeiling(10, 0, 10)).toBe(0);
  });
});
