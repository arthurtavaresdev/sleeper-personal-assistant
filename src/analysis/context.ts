import { config, requireLeagueId } from '../config.js';
import { activePlayers, loadLeague, loadRosters, type LeagueSettings, type TeamRoster } from '../league/settings.js';
import type { Projection } from '../model/projection.js';
import { projectRestOfSeason, projectWeek, saveProjections, type RosValue } from '../model/service.js';
import { sleeper } from '../sleeper/client.js';

export interface AnalysisContext {
  league: LeagueSettings;
  season: number;
  week: number;
  rosters: TeamRoster[];
  mine: TeamRoster;
  rostered: Set<string>;
  weekProj: Map<string, Projection>;
  ros: Map<string, RosValue> | null;
}

export async function findMyRoster(rosters: TeamRoster[]): Promise<TeamRoster> {
  if (!config.SLEEPER_USERNAME) throw new Error('SLEEPER_USERNAME não configurado');
  const user = await sleeper.user(config.SLEEPER_USERNAME);
  const mine = rosters.find((r) => r.ownerId === user.user_id);
  if (!mine) throw new Error(`Usuário ${config.SLEEPER_USERNAME} não tem time nesta liga`);
  return mine;
}

export async function loadContext(season: number, week: number, opts: { ros?: boolean } = {}): Promise<AnalysisContext> {
  const league = await loadLeague(requireLeagueId());
  const rosters = await loadRosters(league.id);
  const mine = await findMyRoster(rosters);
  const weekProj = await projectWeek(league, season, week);
  await saveProjections(league, season, week, weekProj);
  const ros = opts.ros ? await projectRestOfSeason(league, season, week) : null;
  return {
    league,
    season,
    week,
    rosters,
    mine,
    rostered: new Set(rosters.flatMap((r) => r.players)),
    weekProj,
    ros,
  };
}

export { activePlayers };
