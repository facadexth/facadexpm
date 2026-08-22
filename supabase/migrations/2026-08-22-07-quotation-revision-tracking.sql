-- Revision counter for quotations — every save on an existing quotation
-- (not the first insert) bumps this by 1, so the printed document can show
-- "แก้ไขครั้งที่ N". This is a counter, not full version history (no old
-- snapshots stored) — see the design spec's Non-Goals for why full history
-- was deliberately deferred; this is the smaller "track how many times
-- revised" ask, not that.
ALTER TABLE quotations
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
