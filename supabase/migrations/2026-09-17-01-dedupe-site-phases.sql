-- Fixes a pre-existing double-seed bug: 14 of 136 sites ended up with
-- duplicate site_phases rows (same site_id + name), most likely from the
-- seed trigger firing twice on some site-creation path. Keeps the
-- earliest-created row per (site_id, name) group, deletes the rest.
-- Verified against production 2026-09-17: 966 total rows, 136 distinct
-- sites, 14 sites with duplicate phase names before this runs.

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY site_id, name ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM site_phases
)
DELETE FROM site_phases WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
