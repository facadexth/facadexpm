-- supabase/migrations/2026-08-17-09-signup-trigger-contractor-seed.sql
--
-- Extends handle_new_user()'s new-tenant branch: sets the tenant's
-- contractor_type_id from signup metadata, then seeds expense_categories
-- and suppliers from that type's template rows. Only the NEWLY CREATED
-- tenant branch seeds anything here — an invited teammate joins an
-- existing tenant that should already have its own categories/suppliers,
-- so seeding there would be wrong, same reasoning as the app_settings
-- seed this migration sits alongside.
--
-- If contractor_type_id is absent or NULL in the metadata (shouldn't
-- happen once Task 4 makes the signup dropdown required, but the
-- trigger must not error on it), seeding is skipped entirely and the
-- tenant starts blank, exactly as it does today — a safety fallback,
-- not a supported path.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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

    -- Default settings for the new tenant, matching schema.sql's global
    -- app_settings seed values exactly.
    INSERT INTO app_settings (tenant_id, key, value) VALUES
      (v_tenant_id, 'travel_rate_per_km', '20'),
      (v_tenant_id, 'holiday_pay_multiplier', '1.5')
    ON CONFLICT (tenant_id, key) DO NOTHING;

    IF v_contractor_type_id IS NOT NULL THEN
      INSERT INTO expense_categories (name, color, sort_order, tenant_id)
      SELECT name, color, sort_order, v_tenant_id
      FROM contractor_type_categories
      WHERE contractor_type_id = v_contractor_type_id;

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
$$;
