-- supabase/migrations/2026-09-29-03-checkin-locations.sql
-- Check-in Locations & Attendance (spec: docs/superpowers/specs/2026-09-29-checkin-locations-design.md)

CREATE TABLE checkin_locations (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  lat        NUMERIC NOT NULL,
  lng        NUMERIC NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_checkin_locations_tenant_id ON checkin_locations(tenant_id);
ALTER TABLE checkin_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON checkin_locations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- Everyone at the tenant can READ (WORKER included) -- the no-assignment
-- check-in flow and MySchedule.jsx's own location card need this; only
-- ADMIN/OWNER can write, per admin_full_access above.
CREATE POLICY tenant_read_access ON checkin_locations FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- Seed one row per tenant that currently has a factory_site_id set, from
-- that site's own name/lat/lng, then repoint the app_setting at it. Wrapped
-- so a tenant with no factory_site_id set (or an already-blank one) is a
-- no-op.
DO $$
DECLARE
  r RECORD;
  v_new_id UUID;
BEGIN
  FOR r IN
    SELECT a.tenant_id, a.value AS old_site_id, s.name, s.lat, s.lng
    FROM app_settings a
    JOIN sites s ON s.id = nullif(a.value, '')::uuid AND s.tenant_id = a.tenant_id
    WHERE a.key = 'factory_site_id' AND nullif(a.value, '') IS NOT NULL
  LOOP
    INSERT INTO checkin_locations (tenant_id, name, lat, lng)
    VALUES (r.tenant_id, 'โรงงาน (' || r.name || ')', r.lat, r.lng)
    RETURNING id INTO v_new_id;

    UPDATE app_settings SET value = v_new_id::text
    WHERE tenant_id = r.tenant_id AND key = 'factory_site_id';
  END LOOP;
END $$;

-- worker_assignments: which checkin_locations row a type='factory'
-- assignment resolves to, once more than one location exists. Nullable --
-- an existing/new factory assignment with this unset still falls back to
-- app_settings.factory_site_id (see Task 2), so this migration doesn't
-- require backfilling every historical row.
ALTER TABLE worker_assignments ADD COLUMN checkin_location_id UUID REFERENCES checkin_locations(id);

-- user_roles: the owner-assigned fixed location for an ADMIN/OWNER
-- account's no-assignment check-in. NULL = this account has no assigned
-- location and cannot use the no-assignment path.
ALTER TABLE user_roles ADD COLUMN assigned_checkin_location_id UUID REFERENCES checkin_locations(id);

-- worker_checkins: add the second reference, make site_id nullable, swap
-- the old single UNIQUE for two partial ones.
ALTER TABLE worker_checkins ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE worker_checkins ADD COLUMN checkin_location_id UUID REFERENCES checkin_locations(id);
ALTER TABLE worker_checkins ADD CONSTRAINT worker_checkins_exactly_one_target
  CHECK ((site_id IS NOT NULL) <> (checkin_location_id IS NOT NULL));

ALTER TABLE worker_checkins DROP CONSTRAINT worker_checkins_worker_id_site_id_date_key;
CREATE UNIQUE INDEX worker_checkins_site_unique
  ON worker_checkins(worker_id, site_id, date) WHERE site_id IS NOT NULL;
CREATE UNIQUE INDEX worker_checkins_location_unique
  ON worker_checkins(worker_id, checkin_location_id, date) WHERE checkin_location_id IS NOT NULL;
