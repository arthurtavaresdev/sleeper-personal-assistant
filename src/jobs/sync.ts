import { selectedLeagueIds } from '../league/selection.js';
import { refreshFeatures, syncNflverse } from '../data/nflverse.js';
import { syncLeague, syncPlayers } from '../data/sleeperSync.js';
import { sleeper } from '../sleeper/client.js';
import type { NflState } from '../sleeper/types.js';

export interface SyncResult {
  state: NflState;
  season: number;
  week: number;
}

/** Sincroniza tudo que as análises precisam. Fontes pesadas respeitam TTL salvo `force`. */
export async function runSync(opts: { force?: boolean; leagueId?: string } = {}): Promise<SyncResult> {
  const leagueIds = await selectedLeagueIds(opts.leagueId);
  const state = await sleeper.state();
  const season = Number(state.season);
  // Fora da temporada regular projeta-se a semana 1
  const week = state.season_type === 'regular' ? Math.max(1, state.week) : 1;

  await syncPlayers(opts.force);
  for (const leagueId of leagueIds) await syncLeague(leagueId, week);
  const changed = await syncNflverse([season - 1, season], opts.force);
  if (changed || opts.force) await refreshFeatures();
  return { state, season, week };
}
