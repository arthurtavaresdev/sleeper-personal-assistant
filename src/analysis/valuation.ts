import type { LeagueSettings } from '../league/settings.js';
import type { Projection } from '../model/projection.js';
import type { RosValue } from '../model/service.js';
import { lineupValue, type Candidate } from '../optimizer/lineup.js';

/** Peso de cada semana futura (incerteza cresce com o horizonte). */
const WEEK_DISCOUNT = 0.97;

/**
 * Valor de um conjunto de jogadores no restante da temporada: soma, semana a semana,
 * do lineup ótimo. Captura byes e profundidade melhor que somar projeções individuais.
 */
export class RosterValuer {
  private readonly weeks: number[];
  private readonly byWeek: Map<number, Map<string, Candidate>>;

  constructor(
    private readonly league: LeagueSettings,
    proj: Map<string, Projection>,
    ros: Map<string, RosValue>,
  ) {
    const anyRos = ros.values().next().value as RosValue | undefined;
    this.weeks = anyRos ? [...anyRos.perWeek.keys()].sort((a, b) => a - b) : [];
    this.byWeek = new Map();
    for (const w of this.weeks) {
      const m = new Map<string, Candidate>();
      for (const [id, r] of ros) {
        const p = proj.get(id);
        if (!p) continue;
        m.set(id, { id, positions: eligiblePositions(p, league), value: r.perWeek.get(w) ?? 0 });
      }
      this.byWeek.set(w, m);
    }
  }

  get remainingWeeks(): number {
    return this.weeks.length;
  }

  value(playerIds: Iterable<string>): number {
    const ids = [...playerIds];
    let total = 0;
    this.weeks.forEach((w, k) => {
      const m = this.byWeek.get(w)!;
      const cands = ids.flatMap((id) => (m.has(id) ? [m.get(id)!] : []));
      total += Math.pow(WEEK_DISCOUNT, k) * lineupValue(this.league.starterSlots, cands);
    });
    return total;
  }
}

export function eligiblePositions(p: Projection, league: LeagueSettings): string[] {
  const pos = p.fantasyPositions.filter((x) => league.positions.includes(x));
  return pos.length ? pos : [p.position];
}

export function toCandidate(p: Projection, league: LeagueSettings): Candidate {
  return { id: p.sleeperId, positions: eligiblePositions(p, league), value: p.mean };
}
