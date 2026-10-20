-- Up Migration
ALTER TABLE app.injury_watch ADD COLUMN league_id text NOT NULL DEFAULT '';
ALTER TABLE app.injury_watch DROP CONSTRAINT injury_watch_pkey;
ALTER TABLE app.injury_watch ADD PRIMARY KEY (league_id, sleeper_id);
-- Down Migration
DELETE FROM app.injury_watch a USING app.injury_watch b
WHERE a.sleeper_id = b.sleeper_id AND a.league_id < b.league_id;
ALTER TABLE app.injury_watch DROP CONSTRAINT injury_watch_pkey;
ALTER TABLE app.injury_watch DROP COLUMN league_id;
ALTER TABLE app.injury_watch ADD PRIMARY KEY (sleeper_id);
