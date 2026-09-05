-- Fix 1: backfill default inventory_categories for tenants that existed
-- before handle_new_user() started seeding them (2026-09-05-11). Confirmed
-- live: the real production tenant had zero inventory_categories rows.
INSERT INTO inventory_categories (tenant_id, name, sort_order)
SELECT t.id, v.name, v.ord
FROM tenants t
CROSS JOIN (VALUES ('อลูมิเนียม/เหล็ก',1), ('กระจก',2), ('อุปกรณ์',3), ('ซิลิโคน/ยาง',4)) AS v(name, ord)
WHERE NOT EXISTS (SELECT 1 FROM inventory_categories c WHERE c.tenant_id = t.id);

-- Fix 7: inventory_categories had no uniqueness constraint, unlike its
-- sibling expense_categories (UNIQUE(tenant_id, name), schema.sql:65).
-- Run after the backfill above so any pre-existing manual-testing dupes
-- would have blocked this step (dry-run confirmed zero dupes exist).
ALTER TABLE inventory_categories ADD CONSTRAINT inventory_categories_tenant_id_name_key UNIQUE (tenant_id, name);
