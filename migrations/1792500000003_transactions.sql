-- Up Migration

-- Transações processadas da liga (API pública). Waivers perdidas também aparecem, com o lance.
CREATE TABLE core.transactions (
  league_id      text NOT NULL REFERENCES core.leagues ON DELETE CASCADE,
  transaction_id text NOT NULL,
  data           jsonb NOT NULL,
  type           text GENERATED ALWAYS AS (data->>'type') STORED,
  status         text GENERATED ALWAYS AS (data->>'status') STORED,
  leg            int  GENERATED ALWAYS AS ((data->>'leg')::int) STORED,
  roster_id      int  GENERATED ALWAYS AS ((data->'roster_ids'->>0)::int) STORED,
  bid            int  GENERATED ALWAYS AS ((data->'settings'->>'waiver_bid')::int) STORED,
  PRIMARY KEY (league_id, transaction_id)
);
CREATE INDEX transactions_waiver_idx ON core.transactions (league_id, roster_id) WHERE type = 'waiver';

-- Lances de FAAB por jogador disputado (um jogador por proposta)
CREATE VIEW model.waiver_bids AS
SELECT t.league_id, t.roster_id, t.leg, t.status, t.bid, a.key AS sleeper_id, p.position
FROM core.transactions t
CROSS JOIN LATERAL jsonb_each(t.data->'adds') a
LEFT JOIN core.players p ON p.sleeper_id = a.key
WHERE t.type = 'waiver' AND t.bid IS NOT NULL
  -- falha por roster cheio não é disputa de lance
  AND coalesce(t.data->'metadata'->>'notes', '') NOT ILIKE '%too many players%';

-- Perfil de cada manager: quanto costuma oferecer, no geral e por posição
CREATE VIEW model.bidder_profiles AS
SELECT league_id, roster_id, position,
       GROUPING(position) = 1                            AS overall,
       count(*)                                          AS bids,
       count(*) FILTER (WHERE status = 'complete')       AS wins,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY bid)  AS median_bid,
       max(bid)                                          AS max_bid
FROM model.waiver_bids
GROUP BY GROUPING SETS ((league_id, roster_id), (league_id, roster_id, position));

-- Down Migration

DROP VIEW model.bidder_profiles;
DROP VIEW model.waiver_bids;
DROP TABLE core.transactions;
