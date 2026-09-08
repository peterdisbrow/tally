-- Display vs operator share tokens. Legacy rows default to operator so
-- existing Sunday control links keep working until they are regenerated.
ALTER TABLE rundown_shares ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator';
