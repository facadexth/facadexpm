-- supabase/migrations/2026-10-13-01-worker-teams.sql
-- Teams for the Assign wizard. 1 worker = 1 team (PK on worker_id).
-- Assignments are still written per worker, so payroll/cost are unaffected.
CREATE TABLE worker_teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE worker_team_members (
  worker_id UUID PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  team_id   UUID NOT NULL REFERENCES worker_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_worker_team_members_team ON worker_team_members(team_id);

ALTER TABLE worker_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_reads ON worker_teams FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
CREATE POLICY owner_writes ON worker_teams FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY tenant_reads ON worker_team_members FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
-- team_id and worker_id must both belong to the caller's tenant (a member row
-- cannot point at another tenant's team or worker).
CREATE POLICY owner_writes ON worker_team_members FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND EXISTS (SELECT 1 FROM worker_teams t WHERE t.id = worker_team_members.team_id AND t.tenant_id = current_tenant_id())
    AND EXISTS (SELECT 1 FROM workers w WHERE w.id = worker_team_members.worker_id AND w.tenant_id = current_tenant_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_teams, worker_team_members TO authenticated;
REVOKE ALL ON worker_teams, worker_team_members FROM anon;
