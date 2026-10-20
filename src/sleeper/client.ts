import { z } from 'zod';
import { League, LeagueUser, Matchup, NflState, Roster, Transaction, Trending, User } from './types.js';

const BASE = 'https://api.sleeper.app/v1';

async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(BASE + path);
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`Sleeper ${path}: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Sleeper ${path}: HTTP ${res.status}`);
    const body = await res.json();
    if (body === null) throw new Error(`Sleeper ${path}: não encontrado`);
    return schema.parse(body);
  }
}

export const sleeper = {
  state: () => get('/state/nfl', NflState),
  user: (username: string) => get(`/user/${encodeURIComponent(username)}`, User),
  userLeagues: (userId: string, season: string) => get(`/user/${userId}/leagues/nfl/${season}`, z.array(League)),
  league: (id: string) => get(`/league/${id}`, League),
  rosters: (id: string) => get(`/league/${id}/rosters`, z.array(Roster)),
  users: (id: string) => get(`/league/${id}/users`, z.array(LeagueUser)),
  matchups: (id: string, week: number) => get(`/league/${id}/matchups/${week}`, z.array(Matchup)),
  transactions: (id: string, leg: number) => get(`/league/${id}/transactions/${leg}`, z.array(Transaction)),
  trendingAdds: (hours = 48, limit = 50) =>
    get(`/players/nfl/trending/add?lookback_hours=${hours}&limit=${limit}`, Trending),
  /** ~15 MB; mantido cru (record id → objeto) e validado só o essencial. */
  players: () => get('/players/nfl', z.record(z.string(), z.object({ player_id: z.string() }).passthrough())),
};
