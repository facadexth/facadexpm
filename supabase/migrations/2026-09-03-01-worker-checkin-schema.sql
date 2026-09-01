-- supabase/migrations/2026-09-03-01-worker-checkin-schema.sql
-- Location-based worker check-in/check-out (see
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- sites gains coordinates; worker_assignments gains a confirmation gate
-- (set by a successful check-in or an admin override, see Task 2/6);
-- worker_checkins is the actual attendance event log, kept separate from
-- the plan. No RLS write policy is granted here for the worker's own
-- rows -- the only write path is the SECURITY DEFINER functions in
-- 2026-09-03-02, which independently re-validate distance server-side.

ALTER TABLE sites ADD COLUMN lat NUMERIC(9,6);
ALTER TABLE sites ADD COLUMN lng NUMERIC(9,6);

ALTER TABLE worker_assignments ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE worker_assignments ADD COLUMN confirmed_by TEXT;

CREATE TABLE worker_checkins (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  checkin_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkin_lat         NUMERIC(9,6) NOT NULL,
  checkin_lng         NUMERIC(9,6) NOT NULL,
  checkin_distance_m  NUMERIC NOT NULL,
  checkout_at         TIMESTAMPTZ,
  checkout_lat        NUMERIC(9,6),
  checkout_lng        NUMERIC(9,6),
  checkout_distance_m NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, site_id, date)
);

CREATE INDEX idx_worker_checkins_tenant_id ON worker_checkins(tenant_id);
CREATE INDEX idx_worker_checkins_worker_date ON worker_checkins(worker_id, date);

ALTER TABLE worker_checkins ENABLE ROW LEVEL SECURITY;
-- Reads: same shape as worker_ot/salary_records -- admin sees everything,
-- a worker sees only their own rows. Writes are NOT granted here at all --
-- the only write path is the SECURITY DEFINER functions in Task 2, which
-- bypass RLS. This keeps direct table access (e.g. a stray client-side
-- .insert() call) impossible even for a WORKER's own rows -- they must go
-- through the distance-validating function.
CREATE POLICY admin_full_access ON worker_checkins FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY worker_reads_own ON worker_checkins FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND worker_id IN (SELECT id FROM workers WHERE email = auth.email()));
