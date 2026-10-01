-- Supports group-photo auto-filing (LINE crew group -> worker's today's
-- site, falling back to a tenant's designated "default/general" site
-- when no real site assignment exists for today). Explicit flag, not a
-- name match -- now that every tenant shares one platform LINE bot (see
-- docs/superpowers/specs/2026-10-01-shared-line-bot-design.md), a
-- hardcoded site UUID or a hardcoded Thai name ("ส่วนกลาง") would only
-- ever be correct for the one tenant it was written for.

ALTER TABLE sites ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;

-- At most one default site per tenant.
CREATE UNIQUE INDEX idx_sites_one_default_per_tenant ON sites(tenant_id) WHERE is_default = true;

-- FacadeX's own existing "ส่วนกลาง" site (used throughout the Feb-Jul
-- backfill this session as the conventional default) becomes the first
-- real is_default row.
UPDATE sites SET is_default = true WHERE id = 'ca371c71-4869-44be-926c-2d81a188d935';

-- handle_new_user() now also creates a default site for every NEW
-- tenant going forward, named the same "ส่วนกลาง" for consistency with
-- the one real tenant today -- site_number is auto-assigned by the
-- existing generate_site_number() BEFORE INSERT trigger, not set here.
-- Body otherwise identical to the version in
-- 2026-09-09-08-merge-inventory-categories-into-expense-categories.sql
-- (the current authoritative definition) -- only the new INSERT INTO
-- sites block is added, placed right after the app_settings seed.
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

    -- New: every tenant gets one default/"general" site from day one, so
    -- group-photo auto-filing (and anything else that needs a fallback
    -- site) always has somewhere to go, with zero admin setup required.
    INSERT INTO sites (tenant_id, name, is_default)
    VALUES (v_tenant_id, 'ส่วนกลาง', true);

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
