-- Up Migration

-- Kickoff absoluto (gametime do nflverse está no horário de Nova York); colunas novas vão ao final
CREATE OR REPLACE VIEW core.team_games AS
SELECT g.game_id, g.season, g.week, g.game_type, g.gameday,
       core.sleeper_team(g.home_team) AS team, core.sleeper_team(g.away_team) AS opponent, true AS is_home,
       g.home_score AS points_for, g.away_score AS points_against,
       g.total_line / 2 + g.spread_line / 2 AS implied_points,
       g.spread_line AS expected_margin, g.total_line,
       (g.gameday + nullif(g.gametime, '')::time) AT TIME ZONE 'America/New_York' AS kickoff
FROM core.games g
UNION ALL
SELECT g.game_id, g.season, g.week, g.game_type, g.gameday,
       core.sleeper_team(g.away_team), core.sleeper_team(g.home_team), false,
       g.away_score, g.home_score,
       g.total_line / 2 - g.spread_line / 2,
       -g.spread_line, g.total_line,
       (g.gameday + nullif(g.gametime, '')::time) AT TIME ZONE 'America/New_York'
FROM core.games g;

-- Down Migration

CREATE OR REPLACE VIEW core.team_games AS
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
