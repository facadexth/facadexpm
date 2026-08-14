-- Split 'leave' into leave_sick (paid, no quota) and leave_personal
-- (deducts pay, deducts workers.annual_leave_days quota). Old 'leave'
-- value is kept for historical rows — not migrated, not removed.
-- See docs/superpowers/specs/2026-08-14-leave-type-quota-design.md
ALTER TABLE worker_assignments DROP CONSTRAINT worker_assignments_type_check;
ALTER TABLE worker_assignments ADD CONSTRAINT worker_assignments_type_check
  CHECK (type IN ('site','leave','office','holiday','subcontract','factory','leave_sick','leave_personal'));
