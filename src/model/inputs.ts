import { num, sql } from '../db/index.js';

export interface PlayerForm {
  games: number;
  gamesThisSeason: number;
  lastTeam: string;
  wSum: number;
  wTargets: number;
  wTeamTargets: number;
  wCarries: number;
  wTeamCarries: number;
  wPassAtt: number;
  wTeamPassAtt: number;
  wPassCmp: number;
  wPassYd: number;
  wPassTd: number;
  wPassInt: number;
  wRushYd: number;
  wRushTd: number;
  wRec: number;
  wRecYd: number;
  wRecTd: number;
  wFumLost: number;
  wFgAtt: number;
  wFgMade039: number;
  wFgMade4049: number;
  wFgMade50p: number;
  wPatMade: number;
  wPatAtt: number;
  pprEwma: number;
  snapEwma: number | null;
  snapLast2: number | null;
}

export interface PlayerInput {
  sleeperId: string;
  name: string;
  position: string;
  fantasyPositions: string[];
  team: string;
  injuryStatus: string | null;
  depthOrder: number | null;
  age: number | null;
  form: PlayerForm | null;
}

export interface TeamForm {
  games: number;
  passAtt: number;
  carries: number;
  sacksTaken: number;
  giveaways: number;
  pointsFor: number;
  pointsAgainst: number;
  defSack: number;
  defInt: number;
  defFumRec: number;
  defTd: number;
  stTd: number;
  defSafe: number;
  defBlk: number;
  yardsAllowed: number;
}

export interface GameInfo {
  opponent: string;
  isHome: boolean;
  impliedPoints: number | null;
  expectedMargin: number | null;
  kickoff: Date | null;
}

export interface WeekContext {
  season: number;
  week: number;
  games: Map<string, GameInfo>;
  teamForm: Map<string, TeamForm>;
  dvp: Map<string, number>;
  leagueAvg: TeamForm;
  /** Média dos totais implícitos de Vegas na semana (null se não há linhas). */
  avgImplied: number | null;
}

const n = num;
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Jogadores a projetar: todos os ativos com time nas posições modeladas,
 * mais quem estiver em algum roster da liga (mesmo sem time, para mostrar 0).
 * `formWeek` permite reaproveitar a forma atual ao projetar semanas futuras.
 */
export async function loadPlayers(
  leagueId: string,
  positions: string[],
  season: number,
  formWeek: number,
): Promise<PlayerInput[]> {
  const rows = await sql`
    WITH rostered AS (
      SELECT DISTINCT jsonb_array_elements_text(data->'players') AS sleeper_id
      FROM core.rosters WHERE league_id = ${leagueId}
    )
    -- f.* primeiro: colunas homônimas da MV (ex.: position) não podem sobrescrever as do jogador
    SELECT f.*, p.sleeper_id, p.full_name, p.position, p.team, p.injury_status, p.depth_order, p.age,
           coalesce(p.data->'fantasy_positions', jsonb_build_array(p.position)) AS fantasy_positions
    FROM core.players p
    LEFT JOIN core.id_map m ON m.sleeper_id = p.sleeper_id
    LEFT JOIN model.player_form_mv f ON f.gsis_id = m.gsis_id AND f.season = ${season} AND f.week = ${formWeek}
    WHERE p.position = ANY(${positions})
      AND ((p.active AND p.team IS NOT NULL) OR p.sleeper_id IN (SELECT sleeper_id FROM rostered))`;

  return rows.map((r) => ({
    sleeperId: r.sleeper_id,
    name: r.full_name ?? r.sleeper_id,
    position: r.position,
    fantasyPositions: r.fantasy_positions as string[],
    team: r.team ?? '',
    injuryStatus: r.injury_status,
    depthOrder: r.depth_order,
    age: nOrNull(r.age),
    form:
      r.games === null
        ? null
        : {
            games: n(r.games),
            gamesThisSeason: n(r.games_this_season),
            lastTeam: r.last_team,
            wSum: n(r.w_sum),
            wTargets: n(r.w_targets),
            wTeamTargets: n(r.w_team_targets),
            wCarries: n(r.w_carries),
            wTeamCarries: n(r.w_team_carries),
            wPassAtt: n(r.w_pass_att),
            wTeamPassAtt: n(r.w_team_pass_att),
            wPassCmp: n(r.w_pass_cmp),
            wPassYd: n(r.w_pass_yd),
            wPassTd: n(r.w_pass_td),
            wPassInt: n(r.w_pass_int),
            wRushYd: n(r.w_rush_yd),
            wRushTd: n(r.w_rush_td),
            wRec: n(r.w_rec),
            wRecYd: n(r.w_rec_yd),
            wRecTd: n(r.w_rec_td),
            wFumLost: n(r.w_fum_lost),
            wFgAtt: n(r.w_fg_att),
            wFgMade039: n(r.w_fg_made_0_39),
            wFgMade4049: n(r.w_fg_made_40_49),
            wFgMade50p: n(r.w_fg_made_50p),
            wPatMade: n(r.w_pat_made),
            wPatAtt: n(r.w_pat_att),
            pprEwma: n(r.ppr_ewma),
            snapEwma: nOrNull(r.snap_ewma),
            snapLast2: nOrNull(r.snap_last2),
          },
  }));
}

export async function loadWeekContext(season: number, week: number, formWeek: number): Promise<WeekContext> {
  const [games, teams, dvp] = await Promise.all([
    sql`SELECT team, opponent, is_home, implied_points, expected_margin, kickoff
        FROM core.team_games WHERE season = ${season} AND week = ${week} AND game_type = 'REG'`,
    sql`SELECT * FROM model.team_form_mv WHERE season = ${season} AND week = ${formWeek}`,
    sql`SELECT defense, position, factor FROM model.defense_vs_pos_mv WHERE season = ${season} AND week = ${formWeek}`,
  ]);

  const teamForm = new Map<string, TeamForm>(
    teams.map((t) => [
      t.team as string,
      {
        games: n(t.games),
        passAtt: n(t.pass_att),
        carries: n(t.carries),
        sacksTaken: n(t.sacks_taken),
        giveaways: n(t.giveaways),
        pointsFor: n(t.points_for),
        pointsAgainst: n(t.points_against),
        defSack: n(t.def_sack),
        defInt: n(t.def_int),
        defFumRec: n(t.def_fum_rec),
        defTd: n(t.def_td),
        stTd: n(t.st_td),
        defSafe: n(t.def_safe),
        defBlk: n(t.def_blk),
        yardsAllowed: n(t.yds_allowed),
      },
    ]),
  );

  const implied = games.map((g) => nOrNull(g.implied_points)).filter((x): x is number => x !== null);
  return {
    season,
    week,
    avgImplied: implied.length ? implied.reduce((a, b) => a + b, 0) / implied.length : null,
    games: new Map(
      games.map((g) => [
        g.team as string,
        {
          opponent: g.opponent,
          isHome: g.is_home,
          impliedPoints: nOrNull(g.implied_points),
          expectedMargin: nOrNull(g.expected_margin),
          kickoff: g.kickoff,
        },
      ]),
    ),
    teamForm,
    dvp: new Map(dvp.map((d) => [`${d.defense}:${d.position}`, n(d.factor)])),
    leagueAvg: averageTeamForm([...teamForm.values()]),
  };
}

/** Médias típicas da NFL por time/jogo — usadas como prior e quando ainda não há jogos. */
export const NFL_TEAM_DEFAULTS: TeamForm = {
  games: 0,
  passAtt: 34,
  carries: 26,
  sacksTaken: 2.4,
  giveaways: 1.3,
  pointsFor: 22.5,
  pointsAgainst: 22.5,
  defSack: 2.4,
  defInt: 0.8,
  defFumRec: 0.55,
  defTd: 0.15,
  stTd: 0.04,
  defSafe: 0.02,
  defBlk: 0.05,
  yardsAllowed: 330,
};

export function averageTeamForm(forms: TeamForm[]): TeamForm {
  if (forms.length === 0) return { ...NFL_TEAM_DEFAULTS };
  const keys = Object.keys(NFL_TEAM_DEFAULTS) as (keyof TeamForm)[];
  const avg = {} as TeamForm;
  for (const k of keys) avg[k] = forms.reduce((s, f) => s + f[k], 0) / forms.length;
  return avg;
}
