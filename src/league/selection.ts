import { config } from '../config.js';
import { sleeper } from '../sleeper/client.js';

export function parseLeagueIds(value: string): string[] {
  const ids = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error('LEAGUE_IDS deve conter IDs separados por vírgula ou auto.');
  return ids;
}

/** auto acompanha todas as ligas NFL da temporada atual do usuário. */
export async function selectedLeagueIds(leagueId?: string): Promise<string[]> {
  if (leagueId) return parseLeagueIds(leagueId);
  if (config.LEAGUE_IDS === 'auto') {
    if (!config.SLEEPER_USERNAME) throw new Error('Configure SLEEPER_USERNAME para descobrir as ligas.');
    const [user, state] = await Promise.all([sleeper.user(config.SLEEPER_USERNAME), sleeper.state()]);
    const leagues = await sleeper.userLeagues(user.user_id, state.season);
    if (!leagues.length) throw new Error('Nenhuma liga NFL encontrada nesta temporada.');
    return [...new Set(leagues.map(l => l.league_id))];
  }
  const ids = parseLeagueIds(config.LEAGUE_IDS || config.LEAGUE_ID);
  if (!ids.length) throw new Error('Configure LEAGUE_IDS ou rode setup.');
  return ids;
}
