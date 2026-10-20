import { z } from 'zod';
import { config } from '../config.js';
import { Transaction, TradeTransaction } from './types.js';

/**
 * API GraphQL interna do sleeper.com, autenticada com o token da SUA sessão.
 * Sem contrato público: pode mudar a qualquer momento, por isso é opcional.
 * Usada só para ler as suas próprias propostas pendentes (as dos outros são privadas).
 */
const ENDPOINT = 'https://sleeper.com/graphql';

export const graphqlConfigured = () => Boolean(config.SLEEPER_TOKEN);

async function query<T extends z.ZodType>(op: string, gql: string, schema: T): Promise<z.infer<T>> {
  if (!config.SLEEPER_TOKEN) throw new Error('SLEEPER_TOKEN não configurado');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: config.SLEEPER_TOKEN, 'x-sleeper-graphql-op': op },
    body: JSON.stringify({ operationName: op, variables: {}, query: gql }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('SLEEPER_TOKEN inválido ou expirado');
  if (!res.ok) throw new Error(`Sleeper GraphQL ${op}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Sleeper GraphQL ${op}: ${body.errors[0]!.message}`);
  return schema.parse(body.data?.[op]);
}

/** Propostas de waiver pendentes do meu roster (qualquer semana). */
export async function myPendingClaims(leagueId: string, myRosterId: number): Promise<Transaction[]> {
  // Os ids vêm do banco, mas validamos o formato antes de interpolar na query
  if (!/^\d+$/.test(leagueId) || !Number.isInteger(myRosterId)) throw new Error('league/roster inválidos');
  const gql = `query league_transactions_filtered {
    league_transactions_filtered(league_id: "${leagueId}", roster_id_filters: [${myRosterId}],
      type_filters: ["waiver"], leg_filters: [], status_filters: ["pending"]) {
      transaction_id type status leg roster_ids adds drops settings metadata
    }
  }`;
  const claims = await query('league_transactions_filtered', gql, z.array(Transaction));
  return claims.filter((c) => c.roster_ids.includes(myRosterId));
}

/** Somente propostas recebidas pelo próprio roster, ainda sem o seu aceite. */
export function isIncomingTrade(t: TradeTransaction, leagueId: string, rosterId: number, userId: string): boolean {
  return t.league_id === leagueId && t.type === 'trade' && t.status === 'proposed'
    && t.roster_ids.includes(rosterId) && !t.consenter_ids.includes(rosterId) && t.creator !== userId;
}

export async function myTradeInbox(leagueId: string, rosterId: number, userId: string): Promise<TradeTransaction[]> {
  if (!/^\d+$/.test(leagueId) || !Number.isInteger(rosterId) || rosterId <= 0) throw new Error('league/roster inválidos');
  const gql = `query league_transactions_filtered {
    league_transactions_filtered(league_id: "${leagueId}", roster_id_filters: [${rosterId}],
      type_filters: ["trade"], status_filters: ["proposed"], limit: 200) {
      transaction_id league_id type status leg roster_ids creator consenter_ids
      adds drops draft_picks waiver_budget settings metadata
    }
  }`;
  const trades = await query('league_transactions_filtered', gql, z.array(TradeTransaction));
  if (trades.length >= 200) throw new Error('A consulta atingiu o limite de 200 propostas; inbox pode estar incompleto.');
  return trades.filter(t => isIncomingTrade(t, leagueId, rosterId, userId));
}
