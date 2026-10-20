-- supabase/migrations/2026-10-20-14-contribution-opening.sql
-- เงินสมทบยกมา (contribution opening balance, one per worker as of a date) and
-- เงินสมทบสะสม (running total) for the payslip and the HR payroll grid.
--
-- Rule (owner, 2026-10-20): balance for period P = opening.amount + the sum of the
-- worker's 'contribution' (system_key) line amounts in periods AFTER the as-of
-- month, up to and including P. Only closed periods count, except P itself,
-- which counts in any status so the slip being viewed is consistent.
-- No opening row = 0 opening and the sum runs over all of the worker's periods.
--
-- RLS copies the payroll pattern (2026-10-19-01): admin/owner read and write in
-- their tenant with the payroll module (writes also need tenant_can_write());
-- a worker reads only their own row. No anon access. No row-removal grant for
-- authenticated: the form stores 0 instead; rows go with the worker (FK cascade).
-- The balance functions are SECURITY INVOKER, so RLS on salary_records /
-- salary_record_lines / contribution_openings decides what each caller sees
-- (a PM sees nothing; a worker sees only their own confirmed/closed months).
-- The service role (field-form LINE payslip) bypasses RLS and passes the worker id.

CREATE TABLE public.contribution_openings (
  tenant_id  uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON DELETE CASCADE,
  worker_id  uuid NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  amount     numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  as_of      date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text DEFAULT auth.email(),
  PRIMARY KEY (tenant_id, worker_id)
);
CREATE INDEX contribution_openings_worker ON public.contribution_openings (worker_id);

-- stamp who/when on every write (the client never sends these)
CREATE OR REPLACE FUNCTION public.contribution_openings_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.email();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.contribution_openings_stamp() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER contribution_openings_stamp BEFORE INSERT OR UPDATE ON public.contribution_openings
  FOR EACH ROW EXECUTE FUNCTION public.contribution_openings_stamp();

ALTER TABLE public.contribution_openings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.contribution_openings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.contribution_openings TO authenticated;
GRANT ALL ON public.contribution_openings TO service_role;

CREATE POLICY read_openings ON public.contribution_openings FOR SELECT TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll')) AND (
    (SELECT is_admin_or_owner()) OR worker_id IN (SELECT id FROM workers WHERE email = (SELECT auth.email()))));
CREATE POLICY admin_insert ON public.contribution_openings FOR INSERT TO authenticated
  WITH CHECK (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
    AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write())
    AND worker_id IN (SELECT id FROM workers WHERE tenant_id = (SELECT current_tenant_id())));
CREATE POLICY admin_update ON public.contribution_openings FOR UPDATE TO authenticated
  USING (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
    AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write()))
  WITH CHECK (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
    AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write())
    AND worker_id IN (SELECT id FROM workers WHERE tenant_id = (SELECT current_tenant_id())));

-- Balances for period (p_year, p_month): one row per worker who has a salary record
-- in that month or an opening row (all visible to the caller under RLS).
-- p_worker narrows to one worker.
CREATE OR REPLACE FUNCTION public.contribution_balances(p_year int, p_month int, p_worker uuid DEFAULT NULL)
RETURNS TABLE (worker_id uuid, opening numeric, as_of date, balance numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH ws AS (
    SELECT r.tenant_id, r.worker_id FROM salary_records r
     WHERE r.year = p_year AND r.month = p_month AND (p_worker IS NULL OR r.worker_id = p_worker)
    UNION
    SELECT o.tenant_id, o.worker_id FROM contribution_openings o
     WHERE p_worker IS NULL OR o.worker_id = p_worker
  )
  SELECT ws.worker_id,
         COALESCE(o.amount, 0),
         o.as_of,
         COALESCE(o.amount, 0) + COALESCE((
           SELECT sum(l.amount)
             FROM salary_record_lines l
             JOIN salary_records r  ON r.id = l.salary_record_id
             JOIN payroll_periods p ON p.id = r.period_id
             JOIN pay_items pi      ON pi.id = l.pay_item_id
            WHERE r.worker_id = ws.worker_id AND r.tenant_id = ws.tenant_id
              AND pi.system_key = 'contribution'
              AND r.year * 12 + r.month <= p_year * 12 + p_month
              AND (o.as_of IS NULL
                   OR r.year * 12 + r.month > extract(year FROM o.as_of)::int * 12 + extract(month FROM o.as_of)::int)
              AND (p.status = 'closed' OR (r.year = p_year AND r.month = p_month))
         ), 0)
    FROM ws
    LEFT JOIN contribution_openings o ON o.tenant_id = ws.tenant_id AND o.worker_id = ws.worker_id;
$$;

-- One worker's balance for a slip; NULL when nothing is visible for that worker/month.
CREATE OR REPLACE FUNCTION public.contribution_balance(p_worker uuid, p_year int, p_month int)
RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT b.balance FROM public.contribution_balances(p_year, p_month, p_worker) b LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.contribution_balances(int, int, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contribution_balance(uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contribution_balances(int, int, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contribution_balance(uuid, int, int) TO authenticated, service_role;
