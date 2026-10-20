import { isFresh, markFetched, sql } from '../db/index.js';
import { log } from '../log.js';
import { sleeper } from '../sleeper/client.js';

export async function syncPlayers(force = false): Promise<void> {
  if (!force && (await isFresh('sleeper:players', 24))) return;
  const players = await sleeper.players();
  await sql`
    INSERT INTO core.players (sleeper_id, data, updated_at)
    SELECT key, value, now() FROM jsonb_each(${sql.json(players as never)}::jsonb)
    ON CONFLICT (sleeper_id) DO UPDATE SET data = excluded.data, updated_at = now()
    WHERE core.players.data IS DISTINCT FROM excluded.data`;
  await markFetched('sleeper:players', Object.keys(players).length);
  log.info({ players: Object.keys(players).length }, 'jogadores do Sleeper atualizados');
}

/** Liga, times, rosters e matchups da semana — sempre ao vivo (são poucas requisições). */
export async function syncLeague(leagueId: string, week: number): Promise<void> {
  const [league, users, rosters, matchups] = await Promise.all([
    sleeper.league(leagueId),
    sleeper.users(leagueId),
    sleeper.rosters(leagueId),
    sleeper.matchups(leagueId, week),
  ]);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO core.leagues (league_id, data, updated_at) VALUES (${leagueId}, ${tx.json(league as never)}, now())
      ON CONFLICT (league_id) DO UPDATE SET data = excluded.data, updated_at = now()`;
    await tx`DELETE FROM core.league_users WHERE league_id = ${leagueId}`;
    for (const u of users) {
      await tx`INSERT INTO core.league_users (league_id, user_id, data) VALUES (${leagueId}, ${u.user_id}, ${tx.json(u as never)})`;
    }
    await tx`DELETE FROM core.rosters WHERE league_id = ${leagueId}`;
    for (const r of rosters) {
      await tx`INSERT INTO core.rosters (league_id, roster_id, data) VALUES (${leagueId}, ${r.roster_id}, ${tx.json(r as never)})`;
    }
    for (const m of matchups) {
      await tx`
        INSERT INTO core.matchups (league_id, week, roster_id, data) VALUES (${leagueId}, ${week}, ${m.roster_id}, ${tx.json(m as never)})
        ON CONFLICT (league_id, week, roster_id) DO UPDATE SET data = excluded.data`;
    }
  });
  log.info({ league: league.name, rosters: rosters.length }, 'liga sincronizada');
}
