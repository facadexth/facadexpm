-- supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql

-- ── workers (payroll module) ──
DROP POLICY IF EXISTS worker_reads_own_profile ON workers;
CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR email = auth.email())
  );

DROP POLICY IF EXISTS admin_writes_workers ON workers;
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_updates_workers ON workers;
CREATE POLICY admin_updates_workers ON workers FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_deletes_workers ON workers;
CREATE POLICY admin_deletes_workers ON workers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ── worker_assignments, worker_ot (payroll module) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['worker_assignments','worker_ot']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS worker_reads_own ON %I', t);
    EXECUTE format($p$CREATE POLICY worker_reads_own ON %I FOR SELECT TO authenticated
      USING (
        tenant_id = current_tenant_id() AND has_module_access('payroll')
        AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
      )$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_inserts ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_inserts ON %I FOR INSERT TO authenticated
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_updates ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_updates ON %I FOR UPDATE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_deletes ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_deletes ON %I FOR DELETE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
  END LOOP;
END $$;

-- ── salary_records (payroll module) ──
DROP POLICY IF EXISTS worker_reads_own ON salary_records;
CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
  );

DROP POLICY IF EXISTS admin_writes ON salary_records;
CREATE POLICY admin_writes ON salary_records FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_updates ON salary_records;
CREATE POLICY admin_updates ON salary_records FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_deletes ON salary_records;
CREATE POLICY admin_deletes ON salary_records FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ── labor_subcontractors, labor_contracts, labor_payments (labor_subcontractors module) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['labor_subcontractors','labor_contracts','labor_payments']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_full_access ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))$p$, t);
  END LOOP;
END $$;
