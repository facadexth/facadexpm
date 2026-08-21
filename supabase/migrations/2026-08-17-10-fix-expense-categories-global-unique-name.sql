-- expense_categories.name has always had a GLOBAL UNIQUE(name) constraint
-- (no tenant_id), a pre-existing multi-tenancy bug that predates this
-- migration. It stayed dormant because tenants historically chose their
-- own category names by hand, so cross-tenant collisions were unlikely
-- by chance. The contractor-type starter-template seed (see
-- 2026-08-17-09-signup-trigger-contractor-seed.sql) makes the collision
-- guaranteed instead of unlikely: every tenant that picks the same
-- contractor type at signup gets IDENTICAL category names inserted, so
-- the second tenant of any given trade would fail signup outright with
-- a unique-violation on this constraint.
--
-- Verified before this migration: tenant_id is NOT NULL on every existing
-- row, and no existing (tenant_id, name) pair is duplicated, so this
-- swap is safe to apply directly with no data cleanup required.
ALTER TABLE expense_categories DROP CONSTRAINT expense_categories_name_key;
ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_tenant_id_name_key UNIQUE (tenant_id, name);
