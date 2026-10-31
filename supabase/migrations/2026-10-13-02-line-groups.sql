-- supabase/migrations/2026-10-13-02-line-groups.sql
-- Several LINE groups per tenant, capped per package tier. Replaces the single
-- line_settings.crew_group_id (column kept, unused, for rollback).
CREATE TABLE line_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL UNIQUE,            -- a LINE group belongs to ONE tenant
  label      TEXT,
  is_notify  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX line_groups_one_notify_per_tenant ON line_groups(tenant_id) WHERE is_notify;
CREATE INDEX line_groups_tenant ON line_groups(tenant_id);

ALTER TABLE line_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_groups FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- Owner may rename / change notify group / unlink. Inserts come only from the
-- webhook (service role), which enforces the tier cap.
CREATE POLICY owner_updates ON line_groups FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY owner_deletes ON line_groups FOR DELETE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
-- Column-level UPDATE only: the owner may change label/is_notify, never tenant_id or
-- group_id. REVOKE first because default privileges give authenticated table-wide UPDATE.
GRANT SELECT, DELETE ON line_groups TO authenticated;
REVOKE UPDATE ON line_groups FROM authenticated;
GRANT UPDATE (label, is_notify) ON line_groups TO authenticated;
REVOKE ALL ON line_groups FROM anon;

-- Tier caps (NULL = unlimited). Same pattern as 2026-08-29-14-package-seat-limits.sql.
-- (Tenants can already SELECT packages via 2026-08-30-03 authenticated_read, so the
-- UI reads max_line_groups directly; no my_line_group_limit() helper needed.)
ALTER TABLE packages ADD COLUMN max_line_groups INT;
UPDATE packages SET max_line_groups = 1    WHERE name = 'Free';
UPDATE packages SET max_line_groups = 1    WHERE name = 'Solo';
UPDATE packages SET max_line_groups = 5    WHERE name = 'Pro Team';
UPDATE packages SET max_line_groups = 10   WHERE name = 'Business';
UPDATE packages SET max_line_groups = NULL WHERE name = 'Enterprise';

-- Existing linked groups become the notify group, so nothing changes for them.
INSERT INTO line_groups (tenant_id, group_id, is_notify)
SELECT tenant_id, crew_group_id, true FROM line_settings WHERE crew_group_id IS NOT NULL AND crew_group_id <> ''
ON CONFLICT (group_id) DO NOTHING;

-- Server-side check for the webhook (no user JWT there).
CREATE OR REPLACE FUNCTION can_add_line_group(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.max_line_groups IS NULL
            OR (SELECT count(*) FROM line_groups g WHERE g.tenant_id = p_tenant) < p.max_line_groups
     FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
     WHERE t.id = p_tenant),
    true)
$$;
REVOKE ALL ON FUNCTION can_add_line_group(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION can_add_line_group(UUID) TO service_role;
