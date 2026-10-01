-- Adds shift granularity to leave_requests (เต็มวัน/เช้า/บ่าย). Previously
-- every leave request implicitly covered the whole day, and HR.jsx's
-- approval handler hardcoded worker_assignments.shift = 'morning' when
-- blocking the worker's calendar -- meaning even a "full day" leave never
-- blocked the afternoon slot, so a worker on approved leave could still get
-- double-booked for an afternoon site assignment. Existing rows default to
-- 'full_day', matching how they were already being treated end to end.
ALTER TABLE leave_requests ADD COLUMN shift TEXT NOT NULL DEFAULT 'full_day'
  CHECK (shift IN ('full_day', 'morning', 'evening'));
