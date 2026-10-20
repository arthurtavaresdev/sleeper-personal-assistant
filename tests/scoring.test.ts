import { describe, expect, it } from 'vitest';
import { scoreStatLine, yardageBonuses } from '../src/model/scoring.js';
import { availability } from '../src/model/projection.js';
import { probBetween } from '../src/model/stats.js';
import { HALF_PPR_LEAGUE } from './fixtures/league.js';

describe('scoring', () => {
  it('computes half-PPR points from a stat line', () => {
    const pts = scoreStatLine({ rec: 6, rec_yd: 85, rec_td: 1, fum_lost: 1 }, HALF_PPR_LEAGUE.scoring_settings);
    expect(pts).toBeCloseTo(3 + 8.5 + 6 - 2, 6);
  });

  it('ignores stats the league does not score', () => {
    expect(scoreStatLine({ rec_tgt: 10 }, HALF_PPR_LEAGUE.scoring_settings)).toBe(0);
  });

  it('turns yardage bonuses into probabilities', () => {
    const b = yardageBonuses({ rec_yd: 100 });
    expect(b.bonus_rec_yd_100).toBeCloseTo(0.5, 2);
    expect(b.bonus_rec_yd_200).toBeLessThan(0.05);
    expect(yardageBonuses({}).bonus_pass_yd_300).toBe(0);
  });

  it('defense points-allowed buckets sum to 1', () => {
    const edges = [-100, 0.5, 6.5, 13.5, 20.5, 27.5, 34.5, 200];
    let sum = 0;
    for (let i = 0; i < edges.length - 1; i++) sum += probBetween(edges[i]!, edges[i + 1]!, 21, 9.5);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('zeroes out players ruled out', () => {
    expect(availability('Out').mult).toBe(0);
    expect(availability('IR').mult).toBe(0);
    expect(availability('Questionable').mult).toBeGreaterThan(0.8);
    expect(availability(null).mult).toBe(1);
  });
});
