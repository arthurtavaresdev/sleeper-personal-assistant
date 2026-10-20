import { z } from 'zod';

export const NflState = z.object({
  week: z.number(),
  display_week: z.number().optional(),
  season: z.string(),
  season_type: z.string(),
});
export type NflState = z.infer<typeof NflState>;

export const User = z.object({
  user_id: z.string(),
  username: z.string().nullish(),
  display_name: z.string().nullish(),
});

export const LeagueUser = z
  .object({
    user_id: z.string(),
    display_name: z.string().nullish(),
    metadata: z.object({ team_name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export const League = z
  .object({
    league_id: z.string(),
    name: z.string(),
    season: z.string(),
    status: z.string(),
    total_rosters: z.number(),
    roster_positions: z.array(z.string()),
    scoring_settings: z.record(z.string(), z.number()),
    settings: z
      .object({
        type: z.number().optional(), // 0 redraft, 1 keeper, 2 dynasty
        waiver_type: z.number().optional(), // 2 = FAAB
        waiver_budget: z.number().optional(),
        waiver_bid_min: z.number().optional(),
        playoff_week_start: z.number().optional(),
        playoff_teams: z.number().optional(),
        trade_deadline: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type League = z.infer<typeof League>;

export const Roster = z
  .object({
    roster_id: z.number(),
    owner_id: z.string().nullish(),
    players: z.array(z.string()).nullish(),
    starters: z.array(z.string()).nullish(),
    reserve: z.array(z.string()).nullish(),
    taxi: z.array(z.string()).nullish(),
    settings: z
      .object({
        wins: z.number().optional(),
        losses: z.number().optional(),
        waiver_budget_used: z.number().optional(),
        waiver_position: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type Roster = z.infer<typeof Roster>;

export const Matchup = z
  .object({
    roster_id: z.number(),
    matchup_id: z.number().nullish(),
    starters: z.array(z.string()).nullish(),
    players: z.array(z.string()).nullish(),
    points: z.number().nullish(),
  })
  .passthrough();

export const Trending = z.array(z.object({ player_id: z.string(), count: z.number() }));

export const Transaction = z
  .object({
    transaction_id: z.string(),
    type: z.string(),
    status: z.string(),
    leg: z.number(),
    roster_ids: z.array(z.number()),
    adds: z.record(z.string(), z.number()).nullish(),
    drops: z.record(z.string(), z.number()).nullish(),
    settings: z.object({ waiver_bid: z.number().optional(), seq: z.number().optional() }).passthrough().nullish(),
    metadata: z.object({ notes: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();
export type Transaction = z.infer<typeof Transaction>;

/** Ativos de uma proposta: owner_id é o destino; previous_owner_id é a origem. */
export const TradePick = z.object({
  season: z.union([z.string(), z.number()]).transform(String),
  round: z.number().int().positive(),
  roster_id: z.number().int(),
  owner_id: z.number().int(),
  previous_owner_id: z.number().int(),
}).passthrough();
export const TradeBudget = z.object({
  sender: z.number().int(), receiver: z.number().int(), amount: z.number().nonnegative(),
}).passthrough();
export const TradeTransaction = Transaction.extend({
  type: z.literal('trade'),
  league_id: z.string(),
  creator: z.string(),
  consenter_ids: z.array(z.number().int()),
  draft_picks: z.array(TradePick).nullish(),
  waiver_budget: z.array(TradeBudget).nullish(),
});
export type TradeTransaction = z.infer<typeof TradeTransaction>;
