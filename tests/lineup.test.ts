import { describe, expect, it } from 'vitest';
import { greedyLineup, ilpLineup, lineupValue, optimizeWithLocks, type Candidate } from '../src/optimizer/lineup.js';

const STD = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const SF = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'SUPER_FLEX'];

const c = (id: string, pos: string, value: number): Candidate => ({ id, positions: [pos], value });

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function randomRoster(r: () => number, size: number): Candidate[] {
  const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'];
  return Array.from({ length: size }, (_, i) => c(`p${i}`, positions[Math.floor(r() * positions.length)]!, Math.round(r() * 250) / 10));
}

describe('lineup optimizer', () => {
  it('fills dedicated slots with the best player of each position and flex with the best remaining', () => {
    const roster = [
      c('qb1', 'QB', 20), c('qb2', 'QB', 18),
      c('rb1', 'RB', 15), c('rb2', 'RB', 12), c('rb3', 'RB', 11),
      c('wr1', 'WR', 14), c('wr2', 'WR', 10), c('wr3', 'WR', 9),
      c('te1', 'TE', 8), c('k', 'K', 7), c('d', 'DEF', 6),
    ];
    const r = greedyLineup(STD, roster);
    expect(r.slots.map((s) => s.id)).toEqual(['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3', 'k', 'd']);
    expect(r.bench).toEqual(['qb2', 'wr3']);
  });

  it('puts a QB in SUPER_FLEX when it is the best remaining option', () => {
    const roster = [c('qb1', 'QB', 22), c('qb2', 'QB', 19), c('rb1', 'RB', 10), c('rb2', 'RB', 9), c('rb3', 'RB', 5),
      c('wr1', 'WR', 12), c('wr2', 'WR', 11), c('wr3', 'WR', 10), c('wr4', 'WR', 6), c('te', 'TE', 7), c('wr5', 'WR', 4)];
    const r = greedyLineup(SF, roster);
    expect(r.slots.find((s) => s.slot === 'SUPER_FLEX')!.id).toBe('qb2');
  });

  it('greedy matches ILP on random rosters (nested flex structures)', () => {
    const r = rng(42);
    for (let t = 0; t < 200; t++) {
      const roster = randomRoster(r, 8 + Math.floor(r() * 12));
      for (const slots of [STD, SF, ['QB', 'RB', 'WR', 'TE', 'REC_FLEX', 'FLEX']]) {
        expect(greedyLineup(slots, roster).total).toBeCloseTo(ilpLineup(slots, roster).total, 6);
      }
    }
  });

  it('uses ILP for multi-position players', () => {
    // Jogador RB/WR deve ir para onde libera mais pontos
    const roster = [c('rb1', 'RB', 10), { id: 'x', positions: ['RB', 'WR'], value: 9 }, c('wr1', 'WR', 3), c('wr2', 'WR', 2)];
    expect(lineupValue(['RB', 'RB', 'WR'], roster)).toBeCloseTo(22, 6);
  });

  it('leaves slots empty when there are not enough eligible players', () => {
    const r = ilpLineup(['QB', 'TE'], [c('qb', 'QB', 10)]);
    expect(r.slots[1]!.id).toBeNull();
    expect(r.total).toBe(10);
  });

  it('keeps locked starters in place and never starts a benched player whose game started', () => {
    const roster = [c('rb1', 'RB', 15), c('rb2', 'RB', 5), c('rb3', 'RB', 12), c('rb4', 'RB', 20)];
    // rb2 travado como titular; rb4 já jogou no banco
    const locked = new Set(['rb2', 'rb4']);
    const r = optimizeWithLocks(['RB', 'RB'], roster, ['rb2', 'rb3'], (id) => locked.has(id));
    expect(r.slots.map((s) => s.id)).toEqual(['rb2', 'rb1']);
  });
});
