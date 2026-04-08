-- Migration: 002_rundown_share_token
-- Adds share_token column to manual_rundown_plans for public countdown timer links.
-- Share tokens are short alphanumeric strings used in /rundown/timer/:token URLs
-- so speakers/presenters can see how much time they have left on the current cue.
--
-- The column is also added programmatically in ManualRundownStore._init() via
-- ALTER TABLE ... ADD COLUMN with a try/catch, so this migration is safe to
-- run on databases that already have the column.

ALTER TABLE manual_rundown_plans ADD COLUMN IF NOT EXISTS share_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mrp_share_token
  ON manual_rundown_plans(share_token)
  WHERE share_token IS NOT NULL;
