import solver from 'javascript-lp-solver';
import { SLOT_ELIGIBILITY } from '../league/settings.js';

export interface Candidate {
  id: string;
  /** Posições elegíveis (fantasy_positions do Sleeper). */
  positions: readonly string[];
  value: number;
}

export interface SlotAssignment {
  slot: string;
  id: string | null;
  value: number;
}

export interface LineupResult {
  total: number;
  slots: SlotAssignment[];
  bench: string[];
}

const eligible = (c: Candidate, slot: string) => c.positions.some((p) => SLOT_ELIGIBILITY[slot]?.includes(p));

/**
 * O guloso é exato quando cada jogador tem uma posição e os flex formam uma cadeia
 * aninhada (REC_FLEX ⊂ FLEX ⊂ SUPER_FLEX; WRRB_FLEX ⊂ FLEX ⊂ SUPER_FLEX), por troca:
 * os n melhores de cada posição sempre podem ocupar os slots dedicados.
 */
export function greedyIsExact(slots: readonly string[], candidates: readonly Candidate[]): boolean {
  const s = new Set(slots);
  if (s.has('REC_FLEX') && s.has('WRRB_FLEX')) return false;
  return candidates.every((c) => c.positions.length === 1);
}

/** Valor ótimo do lineup — rápido, para avaliar milhares de cenários (trocas/waivers). */
export function lineupValue(slots: readonly string[], candidates: readonly Candidate[]): number {
  return greedyIsExact(slots, candidates) ? greedyLineup(slots, candidates).total : ilpLineup(slots, candidates).total;
}

export function optimizeLineup(slots: readonly string[], candidates: readonly Candidate[]): LineupResult {
  return greedyIsExact(slots, candidates) ? greedyLineup(slots, candidates) : ilpLineup(slots, candidates);
}

export function greedyLineup(slots: readonly string[], candidates: readonly Candidate[]): LineupResult {
  const sorted = [...candidates].sort((a, b) => b.value - a.value);
  const used = new Set<string>();
  const result: SlotAssignment[] = slots.map((slot) => ({ slot, id: null, value: 0 }));

  // Slots dedicados primeiro, depois flex do mais restrito ao mais amplo
  const order = slots
    .map((slot, i) => ({ slot, i, width: SLOT_ELIGIBILITY[slot]?.length ?? 0 }))
    .sort((a, b) => a.width - b.width || a.i - b.i);

  for (const { slot, i } of order) {
    const pick = sorted.find((c) => !used.has(c.id) && eligible(c, slot));
    if (!pick) continue;
    used.add(pick.id);
    result[i] = { slot, id: pick.id, value: pick.value };
  }
  return finish(result, candidates, used);
}

export function ilpLineup(slots: readonly string[], candidates: readonly Candidate[]): LineupResult {
  const constraints: Record<string, { max: number }> = {};
  const variables: Record<string, Record<string, number>> = {};
  const ints: Record<string, 1> = {};

  slots.forEach((_, i) => (constraints[`s${i}`] = { max: 1 }));
  candidates.forEach((c, j) => {
    constraints[`p${j}`] = { max: 1 };
    slots.forEach((slot, i) => {
      if (!eligible(c, slot)) return;
      const v = `x_${j}_${i}`;
      // Epsilon garante que slots sejam preenchidos mesmo com jogador de valor 0
      variables[v] = { value: c.value + 1e-6, [`s${i}`]: 1, [`p${j}`]: 1 };
      ints[v] = 1;
    });
  });

  const sol = solver.Solve({ optimize: 'value', opType: 'max', constraints, variables, ints }) as Record<string, number>;
  const result: SlotAssignment[] = slots.map((slot) => ({ slot, id: null, value: 0 }));
  const used = new Set<string>();
  for (const [k, v] of Object.entries(sol)) {
    const m = /^x_(\d+)_(\d+)$/.exec(k);
    if (!m || v < 0.5) continue;
    const c = candidates[Number(m[1])]!;
    const i = Number(m[2]);
    result[i] = { slot: slots[i]!, id: c.id, value: c.value };
    used.add(c.id);
  }
  return finish(result, candidates, used);
}

function finish(slots: SlotAssignment[], candidates: readonly Candidate[], used: Set<string>): LineupResult {
  return {
    total: slots.reduce((s, a) => s + a.value, 0),
    slots,
    bench: candidates.filter((c) => !used.has(c.id)).sort((a, b) => b.value - a.value).map((c) => c.id),
  };
}

/**
 * Lineup ótimo respeitando jogadores travados (jogo já começou): eles mantêm o slot
 * onde estão, e quem já jogou no banco não pode entrar.
 */
export function optimizeWithLocks(
  slots: readonly string[],
  candidates: readonly Candidate[],
  currentStarters: readonly (string | null)[],
  isLocked: (id: string) => boolean,
): LineupResult {
  const lockedSlots = new Map<number, Candidate | null>();
  slots.forEach((_, i) => {
    const id = currentStarters[i];
    if (id && isLocked(id)) lockedSlots.set(i, candidates.find((c) => c.id === id) ?? null);
  });
  const freeIdx = slots.map((_, i) => i).filter((i) => !lockedSlots.has(i));
  const pool = candidates.filter((c) => !isLocked(c.id));
  const sub = optimizeLineup(freeIdx.map((i) => slots[i]!), pool);

  const result: SlotAssignment[] = slots.map((slot) => ({ slot, id: null, value: 0 }));
  freeIdx.forEach((i, k) => (result[i] = sub.slots[k]!));
  for (const [i, c] of lockedSlots) result[i] = { slot: slots[i]!, id: c?.id ?? currentStarters[i]!, value: c?.value ?? 0 };
  const used = new Set(result.map((r) => r.id).filter((x): x is string => x !== null));
  return finish(result, candidates, used);
}
