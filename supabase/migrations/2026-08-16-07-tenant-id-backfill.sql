-- supabase/migrations/2026-08-16-07-tenant-id-backfill.sql
--
-- Adds tenant_id to every company-scoped table. Existing FacadeX
-- production data is backfilled into one bootstrap tenant owned by
-- its current OWNER user, with plan='active' (not 'trial' — this is
-- an existing paying customer being migrated, not a new signup).
--
-- Order matters: tenant_id must exist on user_roles BEFORE
-- current_tenant_id() can be created (it selects from user_roles),
-- and current_tenant_id() must exist BEFORE it can be used as a
-- column DEFAULT on the other 18 tables. Hence three passes below.

-- ── Pass 1: bootstrap tenant for existing FacadeX data ──
INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
SELECT 'Facade X', au.id, 'active', now() - interval '1 day'
FROM auth.users au
JOIN user_roles ur ON ur.user_email = au.email
WHERE ur.role = 'OWNER'
ORDER BY ur.created_at ASC
LIMIT 1;

-- ── Pass 2: add tenant_id (nullable), backfill, lock down, index ──
DO $$
DECLARE
  t TEXT;
  bootstrap_tenant_id UUID;
BEGIN
  SELECT id INTO bootstrap_tenant_id FROM tenants WHERE company_name = 'Facade X';

  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings',
                            'company_holidays','workers','worker_assignments','worker_ot',
                            'clients','suppliers','labor_subcontractors','labor_contracts',
                            'labor_payments','calendar_sync','site_phases','audit_logs',
                            'salary_records','user_roles']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id UUID', t);
    EXECUTE format('UPDATE %I SET tenant_id = $1', t) USING bootstrap_tenant_id;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      t, t || '_tenant_id_fkey');
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id)', 'idx_' || t || '_tenant_id', t);
  END LOOP;
END $$;

-- ── app_settings needs a composite PK now (was a global singleton
-- keyed only by `key`; each tenant needs its own travel_rate_per_km
-- etc.) ──
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);

-- ── Pass 3: current_tenant_id(), now that user_roles.tenant_id
-- exists, then set it as DEFAULT on the 18 tables where a new row's
-- tenant should always be the inserting user's own tenant. user_roles
-- itself is excluded: a brand-new signup has no user_roles row yet,
-- so current_tenant_id() would resolve to NULL at exactly the moment
-- the signup trigger needs to create that first row — it must set
-- tenant_id explicitly instead (see Task 6). ──
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT tenant_id FROM user_roles WHERE user_email = auth.email();
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings',
                            'company_holidays','workers','worker_assignments','worker_ot',
                            'clients','suppliers','labor_subcontractors','labor_contracts',
                            'labor_payments','calendar_sync','site_phases','audit_logs',
                            'salary_records']
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()', t);
  END LOOP;
END $$;
