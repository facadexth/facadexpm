-- supabase/migrations/2026-08-17-07-contractor-type-templates.sql
--
-- Shared reference data for contractor-type starter templates (see
-- docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md).
-- Not tenant-scoped — every tenant reads the same rows once, at signup.

CREATE TABLE contractor_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  label_th    TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE contractor_type_categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_type_id  UUID NOT NULL REFERENCES contractor_types(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL DEFAULT '#6c63ff',
  sort_order          INT NOT NULL DEFAULT 0
);

-- Kept as its own table (rather than a supplier_name column on
-- contractor_type_categories) so a category can carry more than one
-- candidate supplier later without a schema change — v1 only ever
-- inserts one row per material category, and zero rows for a labor
-- category (that absence is what marks it as labor — no separate flag).
CREATE TABLE contractor_type_category_suppliers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_template_id  UUID NOT NULL REFERENCES contractor_type_categories(id) ON DELETE CASCADE,
  supplier_name          TEXT NOT NULL,
  sort_order             INT NOT NULL DEFAULT 0
);

ALTER TABLE tenants ADD COLUMN contractor_type_id UUID REFERENCES contractor_types(id);

-- Shared reference data: any authenticated user can read it (needed by
-- the signup form's dropdown, before the caller even has a tenant_id
-- yet — so this must NOT be tenant_can_write()/current_tenant_id()
-- gated). No write policy for authenticated — content is maintained
-- directly via SQL.
ALTER TABLE contractor_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_types ON contractor_types FOR SELECT TO authenticated USING (true);

ALTER TABLE contractor_type_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_categories ON contractor_type_categories FOR SELECT TO authenticated USING (true);

ALTER TABLE contractor_type_category_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_category_suppliers ON contractor_type_category_suppliers FOR SELECT TO authenticated USING (true);
