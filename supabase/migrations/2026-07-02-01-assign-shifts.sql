-- Assign redesign: morning/evening half-day shifts + factory type
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-02

ALTER TABLE worker_assignments
  ADD COLUMN IF NOT EXISTS shift TEXT NOT NULL DEFAULT 'morning'
  CHECK (shift IN ('morning','evening'));

ALTER TABLE worker_assignments DROP CONSTRAINT IF EXISTS worker_assignments_type_check;
ALTER TABLE worker_assignments
  ADD CONSTRAINT worker_assignments_type_check
  CHECK (type IN ('site','leave','office','holiday','subcontract','factory'));

-- drop old unique BEFORE splitting (evening copies share worker_id,date)
ALTER TABLE worker_assignments DROP CONSTRAINT IF EXISTS worker_assignments_worker_id_date_key;

-- split each existing (full-day) row into an evening half; ot kept on morning only
INSERT INTO worker_assignments (worker_id, site_id, date, type, ot_hours, notes, shift)
SELECT worker_id, site_id, date, type, 0, notes, 'evening'
FROM worker_assignments
WHERE shift = 'morning'
ON CONFLICT DO NOTHING;

ALTER TABLE worker_assignments
  ADD CONSTRAINT worker_assignments_worker_id_date_shift_key
  UNIQUE (worker_id, date, shift);
