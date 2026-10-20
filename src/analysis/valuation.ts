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
  private readonly league: LeagueSettings;

  private constructor(league: LeagueSettings, proj: Map<string, Projection>, values: Map<string, Map<number, number>>, weeks: number[]) {
    this.league = league;
    this.weeks = weeks;
    this.byWeek = new Map();
    for (const w of weeks) {
      const m = new Map<string, Candidate>();
      for (const [id, perWeek] of values) {
        const p = proj.get(id);
        if (p) m.set(id, { id, positions: eligiblePositions(p, league), value: perWeek.get(w) ?? 0 });
      }
      this.byWeek.set(w, m);
    }
  }

  /** Restante da temporada, semana a semana. */
  static restOfSeason(league: LeagueSettings, proj: Map<string, Projection>, ros: Map<string, RosValue>): RosterValuer {
    const values = new Map([...ros].map(([id, r]) => [id, r.perWeek]));
    const first = ros.values().next().value as RosValue | undefined;
    const weeks = first ? [...first.perWeek.keys()].sort((a, b) => a - b) : [];
    return new RosterValuer(league, proj, values, weeks);
  }

  /** Só a semana projetada em `proj`. */
  static singleWeek(league: LeagueSettings, proj: Map<string, Projection>, week: number): RosterValuer {
    const values = new Map([...proj].map(([id, p]) => [id, new Map([[week, p.mean]])]));
    return new RosterValuer(league, proj, values, [week]);
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
