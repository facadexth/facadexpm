-- ============================================================
-- Merge inventory_categories into expense_categories.
-- Requested by the tenant: the two category lists ("หมวดหมู่ค่าใช้จ่าย"
-- and the material categories used for cost estimates/stock deduction)
-- were two separate tables the user didn't realize were different --
-- for their own tenant, 3 of the 4 material categories (กระจก,
-- ซิลิโคน/ยาง, อุปกรณ์) already existed as identically-named rows in
-- both tables. Unifying them means one shared "หมวดหมู่" list serves
-- expense tagging, PO categorization, inventory item tagging, and (via
-- the new use_for_cost_deduction flag) site cost estimates + stock
-- deduction, all from the same Settings > หมวดหมู่ page.
-- ============================================================

-- 1. The flag itself, now on expense_categories. Defaults to false so
--    pre-existing plain expense categories don't suddenly start
--    counting toward cost estimates/stock deduction.
ALTER TABLE expense_categories ADD COLUMN use_for_cost_deduction BOOLEAN NOT NULL DEFAULT false;

-- 1b. FacadeX's own tenant special case: the seeded default material
--     category "อลูมิเนียม/เหล็ก" was wrong for them -- their real books
--     already split this into two separate expense categories, "อลูมิเนียม"
--     and "เหล็ก". Nothing referenced the combined inventory_categories row
--     (0 inventory_items, 0 site_cost_estimates), so it was already deleted
--     directly rather than name-matched -- flag both real categories here
--     instead of relying on the generic name-join below.
UPDATE expense_categories SET use_for_cost_deduction = true
WHERE id IN ('49ce5d97-8f6d-4fb9-881a-0a00a400a71f', 'd4b6cbfd-5f08-4373-82d5-21fac9c6ab3d');

-- 2. Drop the old FK constraints FIRST -- they still point at
--    inventory_categories, so writing an expense_categories id into
--    these columns (step 3 below) would violate them otherwise.
ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_category_id_fkey;
ALTER TABLE site_cost_estimates DROP CONSTRAINT site_cost_estimates_inventory_category_id_fkey;

-- 3. Where a tenant already has an expense_categories row with the exact
--    same name as an inventory_categories row, repoint every FK value
--    that pointed at the old inventory_categories row onto that match,
--    mark the match as usable for cost/deduction, then drop the
--    superseded inventory_categories row.
UPDATE inventory_items ii
SET category_id = ec.id
FROM inventory_categories ic
JOIN expense_categories ec ON ec.tenant_id = ic.tenant_id AND ec.name = ic.name
WHERE ii.category_id = ic.id;

UPDATE site_cost_estimates sce
SET inventory_category_id = ec.id
FROM inventory_categories ic
JOIN expense_categories ec ON ec.tenant_id = ic.tenant_id AND ec.name = ic.name
WHERE sce.inventory_category_id = ic.id;

UPDATE expense_categories ec
SET use_for_cost_deduction = true
FROM inventory_categories ic
WHERE ec.tenant_id = ic.tenant_id AND ec.name = ic.name;

DELETE FROM inventory_categories ic
WHERE EXISTS (
  SELECT 1 FROM expense_categories ec WHERE ec.tenant_id = ic.tenant_id AND ec.name = ic.name
);

-- 4. Every remaining inventory_categories row (no name match) copies
--    straight into expense_categories, reusing the same id -- so the FK
--    values on inventory_items/site_cost_estimates that still point at
--    these ids keep resolving once the FK constraints below are
--    re-added, with zero data-value changes needed.
INSERT INTO expense_categories (id, tenant_id, name, sort_order, use_for_cost_deduction, created_at)
SELECT id, tenant_id, name, sort_order, true, created_at
FROM inventory_categories;

-- 5. Re-add the FK constraints, now pointing at expense_categories.
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;

ALTER TABLE site_cost_estimates ADD CONSTRAINT site_cost_estimates_inventory_category_id_fkey
  FOREIGN KEY (inventory_category_id) REFERENCES expense_categories(id) ON DELETE CASCADE;

-- 6. inventory_categories is now fully superseded.
DROP TABLE inventory_categories;

-- 7. handle_new_user() seeded 4 default rows into inventory_categories
--    for every new signup -- reseed the same 4 names into
--    expense_categories instead, flagged for cost/deduction. Uses
--    ON CONFLICT because the contractor-type template seeded further
--    below in the same function can independently insert a category
--    with one of these exact names (this already happens in production
--    -- see the "กระจก" name-collision this migration just resolved).
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID;
  v_invited_tenant_id UUID;
  v_contractor_type_id UUID;
BEGIN
  v_invited_tenant_id := (new.raw_user_meta_data->>'invited_tenant_id')::UUID;

  IF v_invited_tenant_id IS NOT NULL THEN
    v_tenant_id := v_invited_tenant_id;
  ELSE
    v_contractor_type_id := (new.raw_user_meta_data->>'contractor_type_id')::UUID;

    INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at, contractor_type_id)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'company_name', new.email),
      new.id, 'trial', now() + interval '14 days', v_contractor_type_id
    )
    RETURNING id INTO v_tenant_id;

    INSERT INTO app_settings (tenant_id, key, value) VALUES
      (v_tenant_id, 'travel_rate_per_km', '20'),
      (v_tenant_id, 'holiday_pay_multiplier', '1.5')
    ON CONFLICT (tenant_id, key) DO NOTHING;

    -- Every new tenant gets these 4 default categories pre-ticked for
    -- cost estimates/stock deduction, matching sites' old cost-breakdown
    -- labels. Lives in expense_categories now (merged from the former
    -- inventory_categories table) -- see this migration file.
    INSERT INTO expense_categories (tenant_id, name, sort_order, use_for_cost_deduction) VALUES
      (v_tenant_id, 'อลูมิเนียม/เหล็ก', 1, true),
      (v_tenant_id, 'กระจก', 2, true),
      (v_tenant_id, 'อุปกรณ์', 3, true),
      (v_tenant_id, 'ซิลิโคน/ยาง', 4, true)
    ON CONFLICT (tenant_id, name) DO UPDATE SET use_for_cost_deduction = true;

    -- Seed expense_categories + suppliers from the chosen contractor
    -- type's shared template rows (contractor_type_categories /
    -- contractor_type_category_suppliers). Only the newly-created tenant
    -- branch seeds -- same reasoning as the app_settings seed above.
    -- Skipped entirely when contractor_type_id is absent/NULL (old
    -- client code or Task 4's dropdown not yet shipped): the tenant
    -- starts blank, exactly as it did before this change.
    IF v_contractor_type_id IS NOT NULL THEN
      INSERT INTO expense_categories (name, color, sort_order, tenant_id)
      SELECT name, color, sort_order, v_tenant_id
      FROM contractor_type_categories
      WHERE contractor_type_id = v_contractor_type_id
      ON CONFLICT (tenant_id, name) DO NOTHING;

      INSERT INTO suppliers (name, tenant_id)
      SELECT s.supplier_name, v_tenant_id
      FROM contractor_type_category_suppliers s
      JOIN contractor_type_categories c ON c.id = s.category_template_id
      WHERE c.contractor_type_id = v_contractor_type_id;
    END IF;
  END IF;

  INSERT INTO public.user_roles (user_email, role, status, tenant_id)
  VALUES (
    new.email,
    CASE WHEN v_invited_tenant_id IS NULL THEN 'OWNER' ELSE 'WORKER' END,
    'approved',
    v_tenant_id
  )
  ON CONFLICT (user_email) DO NOTHING;

  RETURN new;
END;
$function$;
