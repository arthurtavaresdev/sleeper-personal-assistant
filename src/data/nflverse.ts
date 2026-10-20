import { copyCsvToStaging, isFresh, markFetched, sql } from '../db/index.js';
import { log } from '../log.js';

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';
const IDS_URL = 'https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv';

// Casa números como "12", "-3.5", "1.2e-05"; o resto das colunas (nomes, ids, listas) fica de fora do jsonb
const NUMERIC_RE = '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$';

async function fetchCsv(url: string): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`nflverse ${url}: HTTP ${res.status}`);
  return res.body;
}

async function loadSource(
  source: string,
  url: string,
  staging: string,
  upsert: () => Promise<unknown>,
  opts: { ttlHours: number; force: boolean; nullToken?: string },
): Promise<boolean> {
  if (!opts.force && (await isFresh(source, opts.ttlHours))) {
    log.debug({ source }, 'fonte em cache');
    return false;
  }
  const rows = await copyCsvToStaging(staging, await fetchCsv(url), { nullToken: opts.nullToken });
  await upsert();
  await sql.unsafe(`DROP TABLE ${staging}`);
  await markFetched(source, rows);
  log.info({ source, rows }, 'fonte carregada');
  return true;
}

function upsertPlayerWeeks() {
  return sql.unsafe(`
    INSERT INTO core.player_weeks (gsis_id, season, week, season_type, player_name, team, opponent, position, stats)
    SELECT s.player_id, s.season::int, s.week::int, s.season_type, s.player_display_name, s.team, s.opponent_team, s.position,
           (SELECT coalesce(jsonb_object_agg(key, value::numeric), '{}')
              FROM jsonb_each_text(to_jsonb(s))
             WHERE value ~ '${NUMERIC_RE}' AND key NOT IN ('season', 'week'))
    FROM raw.nfl_player_weeks s
    WHERE s.player_id IS NOT NULL AND s.team IS NOT NULL
    ON CONFLICT (gsis_id, season, week) DO UPDATE
      SET season_type = excluded.season_type, player_name = excluded.player_name, team = excluded.team,
          opponent = excluded.opponent, position = excluded.position, stats = excluded.stats`);
}

function upsertTeamWeeks() {
  return sql.unsafe(`
    INSERT INTO core.team_weeks (team, season, week, season_type, opponent, stats)
    SELECT s.team, s.season::int, s.week::int, s.season_type, s.opponent_team,
           (SELECT coalesce(jsonb_object_agg(key, value::numeric), '{}')
              FROM jsonb_each_text(to_jsonb(s))
             WHERE value ~ '${NUMERIC_RE}' AND key NOT IN ('season', 'week'))
    FROM raw.nfl_team_weeks s
    ON CONFLICT (team, season, week) DO UPDATE
      SET season_type = excluded.season_type, opponent = excluded.opponent, stats = excluded.stats`);
}

function upsertGames(minSeason: number) {
  return sql.unsafe(`
    INSERT INTO core.games (game_id, season, game_type, week, gameday, gametime, away_team, home_team,
                            away_score, home_score, spread_line, total_line, roof)
    SELECT game_id, season::int, game_type, week::int, gameday::date, gametime, away_team, home_team,
           away_score::int, home_score::int, spread_line::numeric, total_line::numeric, roof
    FROM raw.nfl_games
    WHERE season::int >= ${minSeason}
    ON CONFLICT (game_id) DO UPDATE
      SET gameday = excluded.gameday, gametime = excluded.gametime,
          away_score = excluded.away_score, home_score = excluded.home_score,
          spread_line = excluded.spread_line, total_line = excluded.total_line, roof = excluded.roof`);
}

function upsertSnaps() {
  return sql.unsafe(`
    INSERT INTO core.snaps (pfr_id, season, week, team, offense_pct)
    SELECT pfr_player_id, season::int, week::int, team, offense_pct::numeric
    FROM raw.nfl_snaps
    WHERE game_type = 'REG' AND pfr_player_id IS NOT NULL AND offense_snaps::numeric > 0
    ON CONFLICT (pfr_id, season, week) DO UPDATE
      SET team = excluded.team, offense_pct = excluded.offense_pct`);
}

/**
 * Mapa sleeper_id → gsis_id/pfr_id. Ordem de preferência:
 * 1. tabela da DynastyProcess; 2. gsis_id que o próprio Sleeper expõe;
 * 3. nome normalizado + posição contra jogadores com stats no nflverse.
 */
async function upsertIdMap() {
  await sql.unsafe(`
    INSERT INTO core.id_map (sleeper_id, gsis_id, pfr_id, name, position, birthdate)
    SELECT DISTINCT ON (sleeper_id) sleeper_id, gsis_id, pfr_id, name, position,
           CASE WHEN birthdate ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN birthdate::date END
    FROM raw.dp_ids
    WHERE sleeper_id IS NOT NULL
    ORDER BY sleeper_id, db_season DESC NULLS LAST
    ON CONFLICT (sleeper_id) DO UPDATE
      SET gsis_id = excluded.gsis_id, pfr_id = excluded.pfr_id, name = excluded.name,
          position = excluded.position, birthdate = excluded.birthdate`);
  // gsis duplicado viola o índice único parcial: mantém só a linha de maior sleeper_id
  await sql`
    UPDATE core.id_map m SET gsis_id = NULL
    WHERE gsis_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM core.id_map o WHERE o.gsis_id = m.gsis_id AND o.sleeper_id > m.sleeper_id)`;
}

async function fillIdMapFallbacks() {
  await sql`
    INSERT INTO core.id_map (sleeper_id, gsis_id, name, position)
    SELECT DISTINCT ON (trim(p.data->>'gsis_id')) p.sleeper_id, trim(p.data->>'gsis_id'), p.full_name, p.position
    FROM core.players p
    WHERE nullif(trim(p.data->>'gsis_id'), '') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM core.id_map m WHERE m.gsis_id = trim(p.data->>'gsis_id'))
    ORDER BY trim(p.data->>'gsis_id'), p.active DESC NULLS LAST, p.search_rank NULLS LAST
    ON CONFLICT (sleeper_id) DO UPDATE SET gsis_id = excluded.gsis_id
      WHERE core.id_map.gsis_id IS NULL`;

  // Nome normalizado: minúsculo, sem sufixos (Jr., III…) e sem pontuação
  await sql`
    WITH cand AS (
      SELECT p.sleeper_id, p.position, p.team,
             regexp_replace(lower(regexp_replace(p.full_name, '\s+(jr|sr|ii|iii|iv|v)\.?$', '', 'i')), '[^a-z]', '', 'g') AS key
      FROM core.players p
      WHERE p.active AND p.position IN ('QB','RB','WR','TE','K')
        AND NOT EXISTS (SELECT 1 FROM core.id_map m WHERE m.sleeper_id = p.sleeper_id AND m.gsis_id IS NOT NULL)
    ), nfl AS (
      SELECT DISTINCT ON (pw.gsis_id) pw.gsis_id, pw.position, core.sleeper_team(pw.team) AS team,
             regexp_replace(lower(regexp_replace(pw.player_name, '\s+(jr|sr|ii|iii|iv|v)\.?$', '', 'i')), '[^a-z]', '', 'g') AS key
      FROM core.player_weeks pw
      WHERE pw.player_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM core.id_map m WHERE m.gsis_id = pw.gsis_id)
      ORDER BY pw.gsis_id, pw.season DESC, pw.week DESC
    ), pairs AS (
      SELECT c.sleeper_id, n.gsis_id,
             count(*) OVER (PARTITION BY c.sleeper_id) AS n_for_sleeper,
             count(*) OVER (PARTITION BY n.gsis_id) AS n_for_gsis
      FROM cand c JOIN nfl n ON n.key = c.key AND n.position = c.position
    )
    INSERT INTO core.id_map (sleeper_id, gsis_id)
    SELECT sleeper_id, gsis_id FROM pairs WHERE n_for_sleeper = 1 AND n_for_gsis = 1
    ON CONFLICT (sleeper_id) DO UPDATE SET gsis_id = excluded.gsis_id
      WHERE core.id_map.gsis_id IS NULL`;
}

export async function syncNflverse(seasons: number[], force = false): Promise<boolean> {
  let changed = false;
  const ttl = { ttlHours: 12, force };
  for (const season of seasons) {
    changed = (await loadSource(`nflverse:player_week:${season}`,
      `${RELEASES}/stats_player/stats_player_week_${season}.csv`, 'raw.nfl_player_weeks', upsertPlayerWeeks, ttl)) || changed;
    changed = (await loadSource(`nflverse:team_week:${season}`,
      `${RELEASES}/stats_team/stats_team_week_${season}.csv`, 'raw.nfl_team_weeks', upsertTeamWeeks, ttl)) || changed;
    changed = (await loadSource(`nflverse:snaps:${season}`,
      `${RELEASES}/snap_counts/snap_counts_${season}.csv`, 'raw.nfl_snaps', upsertSnaps, ttl)) || changed;
  }
  const minSeason = Math.min(...seasons);
  changed = (await loadSource('nflverse:games', `${RELEASES}/schedules/games.csv`, 'raw.nfl_games',
    () => upsertGames(minSeason), { ttlHours: 6, force })) || changed;
  changed = (await loadSource('dynastyprocess:ids', IDS_URL, 'raw.dp_ids', upsertIdMap,
    { ttlHours: 72, force, nullToken: 'NA' })) || changed;
  await fillIdMapFallbacks();
  return changed;
}

export async function refreshFeatures(): Promise<void> {
  // Ordem importa: usage → form → defesa vs posição (que depende de player_form_mv)
  for (const mv of ['model.player_usage', 'model.team_usage', 'model.player_form_mv', 'model.team_form_mv', 'model.defense_vs_pos_mv']) {
    await sql.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
  }
  log.info('features atualizadas');
}
