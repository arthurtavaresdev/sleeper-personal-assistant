-- Up Migration

CREATE SCHEMA raw;    -- dados de origem (staging dos CSVs, controle de fetch)
CREATE SCHEMA core;   -- entidades normalizadas (Sleeper + nflverse)
CREATE SCHEMA model;  -- features e projeções
CREATE SCHEMA app;    -- outbox de notificações, execuções

-- Controle de TTL de cada fonte externa (Sleeper endpoint ou arquivo nflverse)
CREATE TABLE raw.source_fetches (
  source      text PRIMARY KEY,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  row_count   int
);

-- ---------------------------------------------------------------- Sleeper

CREATE TABLE core.players (
  sleeper_id      text PRIMARY KEY,
  data            jsonb NOT NULL,
  full_name       text GENERATED ALWAYS AS (coalesce(data->>'full_name', (data->>'first_name') || ' ' || (data->>'last_name'))) STORED,
  position        text GENERATED ALWAYS AS (data->>'position') STORED,
  team            text GENERATED ALWAYS AS (data->>'team') STORED,
  active          boolean GENERATED ALWAYS AS ((data->>'active')::boolean) STORED,
  injury_status   text GENERATED ALWAYS AS (data->>'injury_status') STORED,
  age             numeric GENERATED ALWAYS AS ((data->>'age')::numeric) STORED,
  depth_order     int GENERATED ALWAYS AS ((data->>'depth_chart_order')::int) STORED,
  search_rank     int GENERATED ALWAYS AS ((data->>'search_rank')::int) STORED,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_pos_team_idx ON core.players (position, team) WHERE active;
CREATE INDEX players_fantasy_pos_idx ON core.players USING gin ((data->'fantasy_positions'));

CREATE TABLE core.leagues (
  league_id        text PRIMARY KEY,
  data             jsonb NOT NULL,
  name             text GENERATED ALWAYS AS (data->>'name') STORED,
  season           int  GENERATED ALWAYS AS ((data->>'season')::int) STORED,
  total_rosters    int  GENERATED ALWAYS AS ((data->>'total_rosters')::int) STORED,
  scoring          jsonb GENERATED ALWAYS AS (data->'scoring_settings') STORED,
  roster_positions jsonb GENERATED ALWAYS AS (data->'roster_positions') STORED,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.league_users (
  league_id    text NOT NULL REFERENCES core.leagues ON DELETE CASCADE,
  user_id      text NOT NULL,
  data         jsonb NOT NULL,
  display_name text GENERATED ALWAYS AS (coalesce(data->'metadata'->>'team_name', data->>'display_name')) STORED,
  PRIMARY KEY (league_id, user_id)
);

CREATE TABLE core.rosters (
  league_id  text NOT NULL REFERENCES core.leagues ON DELETE CASCADE,
  roster_id  int  NOT NULL,
  data       jsonb NOT NULL,
  owner_id   text GENERATED ALWAYS AS (data->>'owner_id') STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, roster_id)
);
CREATE INDEX rosters_players_idx ON core.rosters USING gin ((data->'players'));

CREATE TABLE core.matchups (
  league_id text NOT NULL REFERENCES core.leagues ON DELETE CASCADE,
  week      int  NOT NULL,
  roster_id int  NOT NULL,
  data      jsonb NOT NULL,
  PRIMARY KEY (league_id, week, roster_id)
);

-- ---------------------------------------------------------------- nflverse

-- nflverse usa "LA" para os Rams; Sleeper usa "LAR". IMMUTABLE + CASE para o planner inlinar
-- (a função é chamada centenas de milhares de vezes no refresh das features)
CREATE FUNCTION core.sleeper_team(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE t WHEN 'LA' THEN 'LAR' ELSE t END;

CREATE TABLE core.id_map (
  sleeper_id text PRIMARY KEY,
  gsis_id    text,
  pfr_id     text,
  name       text,
  position   text,
  birthdate  date
);
CREATE UNIQUE INDEX id_map_gsis_idx ON core.id_map (gsis_id) WHERE gsis_id IS NOT NULL;
CREATE INDEX id_map_pfr_idx ON core.id_map (pfr_id);

CREATE TABLE core.games (
  game_id     text PRIMARY KEY,
  season      int  NOT NULL,
  game_type   text NOT NULL,
  week        int  NOT NULL,
  gameday     date,
  gametime    text,
  away_team   text NOT NULL,
  home_team   text NOT NULL,
  away_score  int,
  home_score  int,
  spread_line numeric,   -- positivo = mandante favorito por N pontos
  total_line  numeric,
  roof        text
);
CREATE INDEX games_season_week_idx ON core.games (season, week);

-- Uma linha por jogo de cada time com o total implícito de Vegas
CREATE VIEW core.team_games AS
SELECT g.game_id, g.season, g.week, g.game_type, g.gameday,
       core.sleeper_team(g.home_team) AS team, core.sleeper_team(g.away_team) AS opponent, true AS is_home,
       g.home_score AS points_for, g.away_score AS points_against,
       g.total_line / 2 + g.spread_line / 2 AS implied_points,
       g.spread_line AS expected_margin, g.total_line
FROM core.games g
UNION ALL
SELECT g.game_id, g.season, g.week, g.game_type, g.gameday,
       core.sleeper_team(g.away_team), core.sleeper_team(g.home_team), false,
       g.away_score, g.home_score,
       g.total_line / 2 - g.spread_line / 2,
       -g.spread_line, g.total_line
FROM core.games g;

-- stats: todas as colunas numéricas do CSV do nflverse, como jsonb
CREATE TABLE core.player_weeks (
  gsis_id     text NOT NULL,
  season      int  NOT NULL,
  week        int  NOT NULL,
  season_type text NOT NULL,
  player_name text,
  team        text NOT NULL,
  opponent    text NOT NULL,
  position    text,
  stats       jsonb NOT NULL,
  PRIMARY KEY (gsis_id, season, week)
);
CREATE INDEX player_weeks_team_idx ON core.player_weeks (season, week, team);

CREATE TABLE core.team_weeks (
  team        text NOT NULL,
  season      int  NOT NULL,
  week        int  NOT NULL,
  season_type text NOT NULL,
  opponent    text NOT NULL,
  stats       jsonb NOT NULL,
  PRIMARY KEY (team, season, week)
);

CREATE TABLE core.snaps (
  pfr_id      text NOT NULL,
  season      int  NOT NULL,
  week        int  NOT NULL,
  team        text NOT NULL,
  offense_pct numeric NOT NULL,
  PRIMARY KEY (pfr_id, season, week)
);

-- ---------------------------------------------------------------- model

CREATE TABLE model.projections (
  league_id     text NOT NULL,
  season        int  NOT NULL,
  week          int  NOT NULL,
  sleeper_id    text NOT NULL,
  model_version text NOT NULL,
  mean          numeric NOT NULL,
  sd            numeric NOT NULL,
  p20           numeric NOT NULL,
  p80           numeric NOT NULL,
  stat_line     jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, season, week, sleeper_id, model_version)
);

-- ---------------------------------------------------------------- app

CREATE TABLE app.job_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  error       text
);

-- Outbox: os jobs inserem mensagens; o notificador envia (dedupe pela dedupe_key)
CREATE TABLE app.outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text
);
CREATE INDEX outbox_pending_idx ON app.outbox (id) WHERE sent_at IS NULL;

CREATE FUNCTION app.outbox_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', NEW.id::text);
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_notify AFTER INSERT ON app.outbox
FOR EACH ROW EXECUTE FUNCTION app.outbox_notify();

-- Último status de lesão notificado por jogador (para alertar só quando muda)
CREATE TABLE app.injury_watch (
  sleeper_id    text PRIMARY KEY,
  injury_status text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP SCHEMA app CASCADE;
DROP SCHEMA model CASCADE;
DROP SCHEMA core CASCADE;
DROP SCHEMA raw CASCADE;
