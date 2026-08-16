-- supabase/migrations/2026-08-16-06-tenants-and-modules-tables.sql
--
-- Foundation tables for multi-tenancy. RLS is intentionally NOT added
-- here — current_tenant_id() (needed by any policy on these tables)
-- can't be created until user_roles.tenant_id exists, which happens
-- in the next migration. RLS for these two tables lands in
-- 2026-08-16-08-tenant-rls-helpers.sql.

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name  TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id),
  plan          TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','active','expired')),
  trial_ends_at TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_modules (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors')),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
