-- Support overnight OT (e.g. 22:00 start, 03:30 end next day). Explicit
-- opt-in flag rather than inferring "crossed midnight" from end<start, so a
-- genuine data-entry typo (end time before start on the same day) still
-- gets rejected instead of being silently reinterpreted as an overnight
-- shift. end_time is understood to fall on date+1 when is_overnight=true.
ALTER TABLE worker_ot ADD COLUMN is_overnight BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE worker_ot DROP CONSTRAINT worker_ot_check;
ALTER TABLE worker_ot ADD CONSTRAINT worker_ot_check
  CHECK (is_overnight OR end_time > start_time);
