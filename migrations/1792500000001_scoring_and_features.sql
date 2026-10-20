-- Up Migration

-- Lê uma stat numérica do jsonb (0 quando ausente)
CREATE FUNCTION core.n(s jsonb, k text) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN coalesce((s->>k)::double precision, 0);

-- Converte a stat line semanal do nflverse para as chaves de scoring do Sleeper
CREATE FUNCTION core.to_sleeper_stats(s jsonb, pos text) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN jsonb_build_object(
  'pass_att', core.n(s,'attempts'),
  'pass_cmp', core.n(s,'completions'),
  'pass_inc', core.n(s,'attempts') - core.n(s,'completions'),
  'pass_yd',  core.n(s,'passing_yards'),
  'pass_td',  core.n(s,'passing_tds'),
  'pass_int', core.n(s,'passing_interceptions'),
  'pass_2pt', core.n(s,'passing_2pt_conversions'),
  'pass_sack', core.n(s,'sacks_suffered'),
  'pass_fd',  core.n(s,'passing_first_downs'),
  'rush_att', core.n(s,'carries'),
  'rush_yd',  core.n(s,'rushing_yards'),
  'rush_td',  core.n(s,'rushing_tds'),
  'rush_2pt', core.n(s,'rushing_2pt_conversions'),
  'rush_fd',  core.n(s,'rushing_first_downs'),
  'rec',      core.n(s,'receptions'),
  'rec_tgt',  core.n(s,'targets'),
  'rec_yd',   core.n(s,'receiving_yards'),
  'rec_td',   core.n(s,'receiving_tds'),
  'rec_2pt',  core.n(s,'receiving_2pt_conversions'),
  'rec_fd',   core.n(s,'receiving_first_downs'),
  'fum',      core.n(s,'fumbles_total'),
  'fum_lost', core.n(s,'fumbles_lost_total'),
  'st_td',    core.n(s,'special_teams_tds'),
  'pr_yd',    core.n(s,'punt_return_yards'),
  'kr_yd',    core.n(s,'kickoff_return_yards'),
  'bonus_rec_te', CASE WHEN pos = 'TE' THEN core.n(s,'receptions') ELSE 0 END,
  'bonus_rec_rb', CASE WHEN pos = 'RB' THEN core.n(s,'receptions') ELSE 0 END,
  'bonus_rec_wr', CASE WHEN pos = 'WR' THEN core.n(s,'receptions') ELSE 0 END,
  'bonus_pass_yd_300', (core.n(s,'passing_yards') >= 300)::int,
  'bonus_pass_yd_400', (core.n(s,'passing_yards') >= 400)::int,
  'bonus_rush_yd_100', (core.n(s,'rushing_yards') >= 100)::int,
  'bonus_rush_yd_200', (core.n(s,'rushing_yards') >= 200)::int,
  'bonus_rec_yd_100',  (core.n(s,'receiving_yards') >= 100)::int,
  'bonus_rec_yd_200',  (core.n(s,'receiving_yards') >= 200)::int
) || jsonb_build_object(
  'fgm',      core.n(s,'fg_made'),
  'fga',      core.n(s,'fg_att'),
  'fgmiss',   core.n(s,'fg_missed'),
  'fgm_0_19', core.n(s,'fg_made_0_19'),
  'fgm_20_29', core.n(s,'fg_made_20_29'),
  'fgm_30_39', core.n(s,'fg_made_30_39'),
  'fgm_40_49', core.n(s,'fg_made_40_49'),
  'fgm_50_59', core.n(s,'fg_made_50_59'),
  'fgm_60p',  core.n(s,'fg_made_60_'),
  'fgm_50p',  core.n(s,'fg_made_50_59') + core.n(s,'fg_made_60_'),
  'fgm_yds',  core.n(s,'fg_made_distance'),
  'fgmiss_0_19', core.n(s,'fg_missed_0_19'),
  'fgmiss_20_29', core.n(s,'fg_missed_20_29'),
  'fgmiss_30_39', core.n(s,'fg_missed_30_39'),
  'fgmiss_40_49', core.n(s,'fg_missed_40_49'),
  'fgmiss_50p', core.n(s,'fg_missed_50_59') + core.n(s,'fg_missed_60_'),
  'xpm',      core.n(s,'pat_made'),
  'xpa',      core.n(s,'pat_att'),
  'xpmiss',   core.n(s,'pat_missed')
);

-- Stat line de DEF/ST no formato do Sleeper (faixas de pontos/jardas cedidos como 0/1)
CREATE FUNCTION core.to_sleeper_def_stats(s jsonb, pts_allowed double precision, yds_allowed double precision) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN jsonb_build_object(
  'sack',     core.n(s,'def_sacks'),
  'int',      core.n(s,'def_interceptions'),
  'fum_rec',  core.n(s,'fumble_recovery_opp'),
  'ff',       core.n(s,'def_fumbles_forced'),
  'def_td',   core.n(s,'def_tds') + core.n(s,'fumble_recovery_tds'),
  'safe',     core.n(s,'def_safeties'),
  'blk_kick', core.n(s,'def_punt_blocks') + core.n(s,'def_fg_blocks') + core.n(s,'def_pat_blocks'),
  'def_st_td', core.n(s,'special_teams_tds'),
  'tkl_loss', core.n(s,'def_tackles_for_loss'),
  'qb_hit',   core.n(s,'def_qb_hits'),
  'pts_allow', pts_allowed,
  'pts_allow_0',     (pts_allowed = 0)::int,
  'pts_allow_1_6',   (pts_allowed BETWEEN 1 AND 6)::int,
  'pts_allow_7_13',  (pts_allowed BETWEEN 7 AND 13)::int,
  'pts_allow_14_20', (pts_allowed BETWEEN 14 AND 20)::int,
  'pts_allow_21_27', (pts_allowed BETWEEN 21 AND 27)::int,
  'pts_allow_28_34', (pts_allowed BETWEEN 28 AND 34)::int,
  'pts_allow_35p',   (pts_allowed >= 35)::int,
  'yds_allow', yds_allowed,
  'yds_allow_0_100',   (yds_allowed < 100)::int,
  'yds_allow_100_199', (yds_allowed >= 100 AND yds_allowed < 200)::int,
  'yds_allow_200_299', (yds_allowed >= 200 AND yds_allowed < 300)::int,
  'yds_allow_300_349', (yds_allowed >= 300 AND yds_allowed < 350)::int,
  'yds_allow_350_399', (yds_allowed >= 350 AND yds_allowed < 400)::int,
  'yds_allow_400_449', (yds_allowed >= 400 AND yds_allowed < 450)::int,
  'yds_allow_450_499', (yds_allowed >= 450 AND yds_allowed < 500)::int,
  'yds_allow_500_549', (yds_allowed >= 500 AND yds_allowed < 550)::int,
  'yds_allow_550p',    (yds_allowed >= 550)::int
);

-- Pontos = Σ stat[k] × scoring[k] (mesma regra de model/scoring.ts)
CREATE FUNCTION model.fantasy_points(stats jsonb, scoring jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (
  SELECT coalesce(sum((stats->>sc.key)::numeric * (sc.value #>> '{}')::numeric), 0)
  FROM jsonb_each(scoring) sc
  WHERE jsonb_typeof(sc.value) = 'number' AND stats ? sc.key
);

-- Índice temporal contínuo entre temporadas
CREATE FUNCTION model.t(season int, week int) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (season - 2000) * 20 + week;

-- ---------------------------------------------------------------- uso por jogo

-- Materializada: extrai as stats do jsonb uma única vez (as MVs de forma leem daqui)
CREATE MATERIALIZED VIEW model.player_usage AS
SELECT pw.gsis_id, pw.season, pw.week, model.t(pw.season, pw.week) AS t,
       core.sleeper_team(pw.team) AS team, core.sleeper_team(pw.opponent) AS opponent, pw.position,
       core.n(pw.stats,'targets')               AS targets,
       core.n(tw.stats,'targets')               AS team_targets,
       core.n(pw.stats,'carries')               AS carries,
       core.n(tw.stats,'carries')               AS team_carries,
       core.n(pw.stats,'attempts')              AS pass_att,
       core.n(tw.stats,'attempts')              AS team_pass_att,
       core.n(pw.stats,'completions')           AS pass_cmp,
       core.n(pw.stats,'passing_yards')         AS pass_yd,
       core.n(pw.stats,'passing_tds')           AS pass_td,
       core.n(pw.stats,'passing_interceptions') AS pass_int,
       core.n(pw.stats,'rushing_yards')         AS rush_yd,
       core.n(pw.stats,'rushing_tds')           AS rush_td,
       core.n(pw.stats,'receptions')            AS rec,
       core.n(pw.stats,'receiving_yards')       AS rec_yd,
       core.n(pw.stats,'receiving_tds')         AS rec_td,
       core.n(pw.stats,'receiving_air_yards')   AS air_yd,
       core.n(tw.stats,'passing_air_yards')     AS team_air_yd,
       core.n(pw.stats,'fumbles_lost_total')    AS fum_lost,
       core.n(pw.stats,'fg_att')                AS fg_att,
       core.n(pw.stats,'fg_made')               AS fg_made,
       core.n(pw.stats,'fg_made_0_19') + core.n(pw.stats,'fg_made_20_29') + core.n(pw.stats,'fg_made_30_39') AS fg_made_0_39,
       core.n(pw.stats,'fg_made_40_49')         AS fg_made_40_49,
       core.n(pw.stats,'fg_made_50_59') + core.n(pw.stats,'fg_made_60_') AS fg_made_50p,
       core.n(pw.stats,'pat_made')              AS pat_made,
       core.n(pw.stats,'pat_att')               AS pat_att,
       core.n(pw.stats,'fantasy_points_ppr')    AS ppr,
       sn.offense_pct::float8                   AS snap_pct
FROM core.player_weeks pw
JOIN core.team_weeks tw ON tw.team = pw.team AND tw.season = pw.season AND tw.week = pw.week
LEFT JOIN core.id_map im ON im.gsis_id = pw.gsis_id
LEFT JOIN core.snaps sn ON sn.pfr_id = im.pfr_id AND sn.season = pw.season AND sn.week = pw.week
WHERE pw.season_type = 'REG';

CREATE UNIQUE INDEX player_usage_pk ON model.player_usage (gsis_id, season, week);

-- Semanas-alvo de projeção: todas as semanas REG da temporada mais recente
CREATE VIEW model.target_weeks AS
SELECT DISTINCT season, week, model.t(season, week) AS t
FROM core.games
WHERE game_type = 'REG' AND season = (SELECT max(season) FROM core.games WHERE game_type = 'REG');

-- ---------------------------------------------------------------- forma do jogador
-- Para cada semana-alvo, EWMA dos últimos 12 jogos ANTERIORES a ela (sem vazamento).
-- Peso 0.8^(jogos atrás); jogos da temporada anterior valem 60%.
-- Guarda somas ponderadas cruas para o TypeScript aplicar shrinkage.

CREATE MATERIALIZED VIEW model.player_form_mv AS
WITH ranked AS (
  SELECT tg.season AS tseason, tg.week AS tweek, u.*,
         row_number() OVER (PARTITION BY u.gsis_id, tg.t ORDER BY u.t DESC) AS k
  FROM model.target_weeks tg
  JOIN model.player_usage u ON u.t < tg.t AND u.t >= tg.t - 40
), w AS (
  SELECT *, power(0.8::float8, k - 1) * CASE WHEN season < tseason THEN 0.6 ELSE 1 END AS wt
  FROM ranked WHERE k <= 12
)
SELECT gsis_id, tseason AS season, tweek AS week,
       (array_agg(team ORDER BY t DESC))[1]     AS last_team,
       (array_agg(position ORDER BY t DESC))[1] AS position,
       count(*)                                  AS games,
       count(*) FILTER (WHERE season = tseason)  AS games_this_season,
       sum(wt)                                   AS w_sum,
       sum(wt * targets)                         AS w_targets,
       sum(wt * team_targets)                    AS w_team_targets,
       sum(wt * carries)                         AS w_carries,
       sum(wt * team_carries)                    AS w_team_carries,
       sum(wt * pass_att)                        AS w_pass_att,
       sum(wt * team_pass_att)                   AS w_team_pass_att,
       sum(wt * pass_cmp)                        AS w_pass_cmp,
       sum(wt * pass_yd)                         AS w_pass_yd,
       sum(wt * pass_td)                         AS w_pass_td,
       sum(wt * pass_int)                        AS w_pass_int,
       sum(wt * rush_yd)                         AS w_rush_yd,
       sum(wt * rush_td)                         AS w_rush_td,
       sum(wt * rec)                             AS w_rec,
       sum(wt * rec_yd)                          AS w_rec_yd,
       sum(wt * rec_td)                          AS w_rec_td,
       sum(wt * air_yd)                          AS w_air_yd,
       sum(wt * team_air_yd)                     AS w_team_air_yd,
       sum(wt * fum_lost)                        AS w_fum_lost,
       sum(wt * fg_att)                          AS w_fg_att,
       sum(wt * fg_made_0_39)                    AS w_fg_made_0_39,
       sum(wt * fg_made_40_49)                   AS w_fg_made_40_49,
       sum(wt * fg_made_50p)                     AS w_fg_made_50p,
       sum(wt * pat_made)                        AS w_pat_made,
       sum(wt * pat_att)                         AS w_pat_att,
       sum(wt * ppr) / sum(wt)                   AS ppr_ewma,
       sum(wt * snap_pct) FILTER (WHERE snap_pct IS NOT NULL)
         / nullif(sum(wt) FILTER (WHERE snap_pct IS NOT NULL), 0) AS snap_ewma,
       avg(snap_pct) FILTER (WHERE k <= 2)       AS snap_last2
FROM w
GROUP BY gsis_id, tseason, tweek;

CREATE UNIQUE INDEX player_form_mv_pk ON model.player_form_mv (gsis_id, season, week);

-- ---------------------------------------------------------------- forma do time (ataque e defesa)

CREATE MATERIALIZED VIEW model.team_usage AS
SELECT core.sleeper_team(tw.team) AS team, tw.season, tw.week, model.t(tw.season, tw.week) AS t,
       core.n(tw.stats,'attempts')  AS pass_att,
       core.n(tw.stats,'carries')   AS carries,
       core.n(tw.stats,'sacks_suffered') AS sacks_taken,
       core.n(tw.stats,'passing_interceptions') + core.n(tw.stats,'fumbles_lost_total') AS giveaways,
       tg.points_for, tg.points_against,
       core.n(tw.stats,'def_sacks') AS def_sack,
       core.n(tw.stats,'def_interceptions') AS def_int,
       core.n(tw.stats,'fumble_recovery_opp') AS def_fum_rec,
       core.n(tw.stats,'def_tds') + core.n(tw.stats,'fumble_recovery_tds') AS def_td,
       core.n(tw.stats,'special_teams_tds') AS st_td,
       core.n(tw.stats,'def_safeties') AS def_safe,
       core.n(tw.stats,'def_punt_blocks') + core.n(tw.stats,'def_fg_blocks') + core.n(tw.stats,'def_pat_blocks') AS def_blk,
       core.n(ow.stats,'passing_yards') + core.n(ow.stats,'rushing_yards') AS yds_allowed
FROM core.team_weeks tw
JOIN core.team_weeks ow ON ow.team = tw.opponent AND ow.season = tw.season AND ow.week = tw.week
JOIN core.team_games tg ON tg.season = tw.season AND tg.week = tw.week AND tg.team = core.sleeper_team(tw.team)
WHERE tw.season_type = 'REG';

CREATE UNIQUE INDEX team_usage_pk ON model.team_usage (team, season, week);

CREATE MATERIALIZED VIEW model.team_form_mv AS
WITH ranked AS (
  SELECT tg.season AS tseason, tg.week AS tweek, u.*,
         row_number() OVER (PARTITION BY u.team, tg.t ORDER BY u.t DESC) AS k
  FROM model.target_weeks tg
  JOIN model.team_usage u ON u.t < tg.t AND u.t >= tg.t - 40
), w AS (
  SELECT *, power(0.8::float8, k - 1) * CASE WHEN season < tseason THEN 0.6 ELSE 1 END AS wt
  FROM ranked WHERE k <= 12
)
SELECT team, tseason AS season, tweek AS week, count(*) AS games,
       sum(wt * pass_att) / sum(wt)       AS pass_att,
       sum(wt * carries) / sum(wt)        AS carries,
       sum(wt * sacks_taken) / sum(wt)    AS sacks_taken,
       sum(wt * giveaways) / sum(wt)      AS giveaways,
       sum(wt * points_for) / sum(wt)     AS points_for,
       sum(wt * points_against) / sum(wt) AS points_against,
       sum(wt * def_sack) / sum(wt)       AS def_sack,
       sum(wt * def_int) / sum(wt)        AS def_int,
       sum(wt * def_fum_rec) / sum(wt)    AS def_fum_rec,
       sum(wt * def_td) / sum(wt)         AS def_td,
       sum(wt * st_td) / sum(wt)          AS st_td,
       sum(wt * def_safe) / sum(wt)       AS def_safe,
       sum(wt * def_blk) / sum(wt)        AS def_blk,
       sum(wt * yds_allowed) / sum(wt)    AS yds_allowed
FROM w
GROUP BY team, tseason, tweek;

CREATE UNIQUE INDEX team_form_mv_pk ON model.team_form_mv (team, season, week);

-- ---------------------------------------------------------------- defesa vs posição
-- Razão entre pontos PPR cedidos a cada posição e o que esses jogadores costumam fazer
-- (forma pré-jogo), com prior de 30 pts puxando para 1.0. Últimos 8 jogos da defesa.

CREATE MATERIALIZED VIEW model.defense_vs_pos_mv AS
WITH games AS (
  SELECT u.opponent AS defense, u.position, u.season, u.week, u.t,
         sum(u.ppr) AS actual, sum(f.ppr_ewma) AS expected
  FROM model.player_usage u
  JOIN model.player_form_mv f ON f.gsis_id = u.gsis_id AND f.season = u.season AND f.week = u.week
  WHERE u.position IN ('QB','RB','WR','TE') AND f.games >= 2
  GROUP BY u.opponent, u.position, u.season, u.week, u.t
), ranked AS (
  SELECT tg.season AS tseason, tg.week AS tweek, g.*,
         row_number() OVER (PARTITION BY g.defense, g.position, tg.t ORDER BY g.t DESC) AS k
  FROM model.target_weeks tg
  JOIN games g ON g.t < tg.t
)
SELECT defense, position, tseason AS season, tweek AS week, count(*) AS games,
       (sum(actual) + 30) / (sum(expected) + 30) AS factor
FROM ranked WHERE k <= 8
GROUP BY defense, position, tseason, tweek;

CREATE UNIQUE INDEX defense_vs_pos_mv_pk ON model.defense_vs_pos_mv (defense, position, season, week);

-- ---------------------------------------------------------------- pontos realizados (backtest)

CREATE FUNCTION model.actual_points(p_scoring jsonb, p_season int, p_week int)
RETURNS TABLE (sleeper_id text, points numeric)
LANGUAGE sql STABLE AS $$
  SELECT im.sleeper_id, model.fantasy_points(core.to_sleeper_stats(pw.stats, pw.position), p_scoring)
  FROM core.player_weeks pw
  JOIN core.id_map im ON im.gsis_id = pw.gsis_id
  WHERE pw.season = p_season AND pw.week = p_week
  UNION ALL
  SELECT tu.team, model.fantasy_points(
           core.to_sleeper_def_stats(tw.stats, tu.points_against::float8, tu.yds_allowed), p_scoring)
  FROM model.team_usage tu
  JOIN core.team_weeks tw ON core.sleeper_team(tw.team) = tu.team AND tw.season = tu.season AND tw.week = tu.week
  WHERE tu.season = p_season AND tu.week = p_week
$$;

-- Down Migration

DROP FUNCTION model.actual_points;
DROP MATERIALIZED VIEW model.defense_vs_pos_mv;
DROP MATERIALIZED VIEW model.team_form_mv;
DROP MATERIALIZED VIEW model.team_usage;
DROP MATERIALIZED VIEW model.player_form_mv;
DROP VIEW model.target_weeks;
DROP MATERIALIZED VIEW model.player_usage;
DROP FUNCTION model.t;
DROP FUNCTION model.fantasy_points;
DROP FUNCTION core.to_sleeper_def_stats;
DROP FUNCTION core.to_sleeper_stats;
DROP FUNCTION core.n;
