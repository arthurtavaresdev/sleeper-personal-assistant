import { parseLeague, type LeagueSettings } from '../../src/league/settings.js';
import type { League } from '../../src/sleeper/types.js';

/** Liga half-PPR padrão de 12 times, pontuação típica do Sleeper. */
export const HALF_PPR_LEAGUE: League = {
  league_id: 'fixture',
  name: 'Fixture League',
  season: '2026',
  status: 'in_season',
  total_rosters: 12,
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'IR'],
  scoring_settings: {
    pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
    rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
    rec: 0.5, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
    fum_lost: -2,
    fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, xpm: 1, fgmiss: -1, xpmiss: -1,
    sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2, def_st_td: 6,
    pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
    pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
  },
  settings: { type: 0, waiver_type: 2, waiver_budget: 100, playoff_week_start: 15 },
};

export const halfPpr = (): LeagueSettings => parseLeague(HALF_PPR_LEAGUE);
