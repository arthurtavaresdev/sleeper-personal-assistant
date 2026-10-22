import type { TeamRoster } from '../league/settings.js';
import type { ExtractedTrade } from '../llm/claude.js';
import { TradeTransaction } from '../sleeper/types.js';

export interface RosteredPlayer {
  sleeperId: string;
  name: string;
  position: string | null;
  team: string | null;
}

export type ExtractedSide = ExtractedTrade['sides'][number];

export interface ResolvedTrade {
  partner: TeamRoster;
  give: string[];
  get: string[];
  picksGive: { season: string; round: number }[];
  picksGet: { season: string; round: number }[];
  faabGive: number;
  faabGet: number;
}

export type Resolution = { ok: true; trade: ResolvedTrade } | { ok: false; problems: string[] };

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const DEF_WORDS = new Set(['dst', 'def', 'defense', 'defence']);

/** Tokens comparáveis: sem acento, pontuação (D/ST vira dst) e sufixos (Jr., III). */
export function nameTokens(name: string): string[] {
  const tokens = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.'’/]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens.at(-1)!)) tokens.pop();
  return tokens;
}

/** nflverse e prints podem usar LA para os Rams; o Sleeper usa LAR. */
export const normalizeTeam = (team: string | null) => {
  const t = team?.trim().toUpperCase() || null;
  return t === 'LA' ? 'LAR' : t;
};

/** Nome completo igual, ou inicial + sobrenome ("J. Chase") quando o app abrevia. */
function nameMatches(query: string[], candidate: string[]): boolean {
  if (!query.length || !candidate.length) return false;
  if (query.join('') === candidate.join('')) return true;
  return query.length >= 2 && query[0]!.length === 1 && candidate[0]![0] === query[0]
    && query.slice(1).join('') === candidate.slice(1).join('');
}

function defenseMatches(q: ExtractedSide['players'][number], p: RosteredPlayer): boolean {
  if (p.position !== 'DEF') return false;
  const team = normalizeTeam(q.team);
  if (team) return team === p.sleeperId;
  const query = nameTokens(q.name).filter((t) => !DEF_WORDS.has(t));
  const candidate = nameTokens(p.name);
  // "Bills D/ST" ou "Buffalo Bills": o apelido do time é o último token no Sleeper
  return query.length > 0 && (query.join('') === candidate.join('') || query.at(-1) === candidate.at(-1));
}

/** Candidatos de um nome extraído entre jogadores de um roster; posição e time desempatam. */
export function matchPlayer(q: ExtractedSide['players'][number], pool: RosteredPlayer[]): RosteredPlayer[] {
  const isDef = q.position?.toUpperCase() === 'DEF' || nameTokens(q.name).some((t) => DEF_WORDS.has(t));
  const query = nameTokens(q.name);
  let found = pool.filter((p) => (isDef ? defenseMatches(q, p) : nameMatches(query, nameTokens(p.name))));
  const pos = q.position?.toUpperCase();
  if (found.length > 1 && pos) found = found.filter((p) => p.position === pos);
  const team = normalizeTeam(q.team);
  if (found.length > 1 && team) found = found.filter((p) => normalizeTeam(p.team) === team);
  return found;
}

interface SideOwner { roster: TeamRoster; ids: string[] }

/** Roster que contém todos os jogadores do lado, com um único ID por nome. */
function sideOwners(side: ExtractedSide, rosters: TeamRoster[], players: Map<string, RosteredPlayer>): SideOwner[] {
  const out: SideOwner[] = [];
  for (const roster of rosters) {
    const pool = roster.players.flatMap((id) => players.get(id) ?? []);
    const ids = side.players.map((q) => matchPlayer(q, pool));
    if (ids.every((m) => m.length === 1)) out.push({ roster, ids: ids.map((m) => m[0]!.sleeperId) });
  }
  if (!side.players.length) {
    // Lado só com picks/FAAB: o dono vem do nome exibido no print
    const owner = nameTokens(side.owner ?? '').join('');
    return owner ? rosters.filter((r) => nameTokens(r.ownerName).join('') === owner).map((roster) => ({ roster, ids: [] })) : [];
  }
  if (out.length > 1 && side.owner) {
    const owner = nameTokens(side.owner).join('');
    const named = out.filter((o) => nameTokens(o.roster.ownerName).join('') === owner);
    if (named.length) return named;
  }
  return out;
}

function describe(side: ExtractedSide): string {
  const assets = [...side.players.map((p) => p.name), ...side.picks.map((p) => `pick ${p.season ?? '?'} R${p.round}`),
    ...(side.faab ? [`$${side.faab} FAAB`] : [])];
  return `${side.owner ?? 'lado sem nome'} (${assets.join(', ') || 'nada'})`;
}

/**
 * Casa a troca lida na imagem com os rosters de uma liga. Nomes só são procurados
 * dentro dos rosters; sem casamento único, a troca não é avaliada.
 */
export function resolveTrade(extracted: ExtractedTrade, rosters: TeamRoster[], mine: TeamRoster, players: Map<string, RosteredPlayer>): Resolution {
  const sides = extracted.sides.filter((s) => s.players.length || s.picks.length || s.faab);
  if (sides.length !== 2) return { ok: false, problems: [`Foram lidos ${sides.length} lados com ativos; o calculator avalia trocas entre dois times.`] };
  const owners = sides.map((s) => sideOwners(s, rosters, players));
  const problems: string[] = [];
  const mineIdx = [0, 1].filter((i) => owners[i]!.some((o) => o.roster.rosterId === mine.rosterId));
  if (mineIdx.length !== 1) {
    problems.push(mineIdx.length ? 'Os dois lados casam com o seu roster; não dá para saber o que você entrega.'
      : 'Nenhum lado casa inteiramente com o seu roster.');
  }
  const myIdx = mineIdx[0] ?? 0;
  const theirIdx = 1 - myIdx;
  const myOwner = owners[myIdx]!.find((o) => o.roster.rosterId === mine.rosterId);
  const theirOwners = owners[theirIdx]!.filter((o) => o.roster.rosterId !== mine.rosterId);
  if (mineIdx.length === 1 && theirOwners.length !== 1) {
    problems.push(theirOwners.length ? `Mais de um time poderia entregar ${describe(sides[theirIdx]!)}.`
      : `Nenhum time da liga tem todos os ativos de ${describe(sides[theirIdx]!)}.`);
  }
  for (const [i, side] of sides.entries()) {
    const roster = i === myIdx ? mine : theirOwners[0]?.roster;
    const pool = roster ? roster.players.flatMap((id) => players.get(id) ?? []) : [...players.values()];
    for (const q of side.players) {
      const n = matchPlayer(q, pool).length;
      if (n !== 1) problems.push(`${q.name}: ${n ? 'nome ambíguo' : 'não encontrado'}${roster ? ` no roster de ${roster.ownerName}` : ' na liga'}.`);
    }
  }
  if (problems.length || !myOwner) return { ok: false, problems: [...new Set(problems)] };
  const theirs = theirOwners[0]!;
  const picks = (s: ExtractedSide) => s.picks.map((p) => ({ season: p.season ?? '?', round: p.round }));
  return {
    ok: true,
    trade: {
      partner: theirs.roster, give: myOwner.ids, get: theirs.ids,
      picksGive: picks(sides[myIdx]!), picksGet: picks(sides[theirIdx]!),
      faabGive: sides[myIdx]!.faab ?? 0, faabGet: sides[theirIdx]!.faab ?? 0,
    },
  };
}

/** Proposta no formato do Sleeper para reaproveitar a avaliação do inbox. */
export function syntheticTrade(leagueId: string, week: number, mine: TeamRoster, t: ResolvedTrade): TradeTransaction {
  const me = mine.rosterId, them = t.partner.rosterId;
  const season = (s: string) => (/^\d{4}$/.test(s) ? s : 'sem ano');
  return TradeTransaction.parse({
    transaction_id: 'imagem', league_id: leagueId, type: 'trade', status: 'proposed', leg: week,
    creator: '', roster_ids: [me, them], consenter_ids: [],
    adds: Object.fromEntries([...t.get.map((id) => [id, me]), ...t.give.map((id) => [id, them])]),
    drops: Object.fromEntries([...t.give.map((id) => [id, me]), ...t.get.map((id) => [id, them])]),
    draft_picks: [
      ...t.picksGive.map((p) => ({ season: season(p.season), round: p.round, roster_id: me, owner_id: them, previous_owner_id: me })),
      ...t.picksGet.map((p) => ({ season: season(p.season), round: p.round, roster_id: them, owner_id: me, previous_owner_id: them })),
    ],
    waiver_budget: [
      ...(t.faabGive ? [{ sender: me, receiver: them, amount: t.faabGive }] : []),
      ...(t.faabGet ? [{ sender: them, receiver: me, amount: t.faabGet }] : []),
    ],
  });
}

/** Resumo da leitura para o usuário conferir o que o modelo viu. */
export function describeExtraction(extracted: ExtractedTrade): string[] {
  return [...extracted.sides.map((s) => `• ${describe(s)}`), ...(extracted.notes ? [`• Observação: ${extracted.notes}`] : [])];
}
