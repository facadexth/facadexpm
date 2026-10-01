-- Gives line_bot, estimation, and offline_mode a real tier home for the
-- first time. All three were widened into tenant_modules_module_key_check
-- as they shipped (2026-09-10-05, 2026-09-13-01, 2026-09-27-03) but
-- deliberately kept OUT of package_modules_module_key_check -- allowlist-
-- only via direct tenant_modules grants, while each feature was still new.
-- That soft-launch period is over for line_bot specifically (see the
-- platform-readiness review, 2026-10-01): it now needs a real tier so
-- paying customers (not just the one allowlisted tenant) can get it.
--
-- Tier assignment per that review's proposal:
--   Pro Team : line_bot (free-reply LINE features only -- queries,
--              check-in/out, leave/material-request submission; no
--              scheduled push -- the LINE backend itself doesn't yet
--              distinguish free-vs-push usage per tier, that's a
--              follow-up, this migration only grants the module)
--   Business : + line_bot, estimation (scheduled reminder pushes land
--              here too once that distinction exists)
--   Enterprise: + line_bot, estimation, offline_mode
-- Free/Solo unchanged -- no line_bot until a self-serve tier is deemed
-- safe (today's LINE backend module-check, just shipped, is the
-- prerequisite that makes this safe at all).
ALTER TABLE package_modules DROP CONSTRAINT package_modules_module_key_check;
ALTER TABLE package_modules ADD CONSTRAINT package_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation','offline_mode','line_bot'));

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'line_bot' FROM packages WHERE name IN ('Pro Team', 'Business', 'Enterprise');

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'estimation' FROM packages WHERE name IN ('Business', 'Enterprise');

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'offline_mode' FROM packages WHERE name = 'Enterprise';
