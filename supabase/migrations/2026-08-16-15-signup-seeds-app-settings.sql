-- supabase/migrations/2026-08-16-15-signup-seeds-app-settings.sql
--
-- app_settings (travel_rate_per_km, holiday_pay_multiplier) became a
-- per-tenant table (composite PK (tenant_id, key)) in
-- 2026-08-16-07-tenant-id-backfill.sql, but handle_new_user()
-- (2026-08-16-11-signup-trigger.sql) was never updated to seed it for a
-- newly created tenant. A brand-new trial tenant can use the payroll
-- module immediately (trial unlocks everything), so travel-cost and
-- holiday-pay calculations would silently read missing rows instead of
-- failing loudly.
--
-- Only the NEWLY CREATED tenant branch seeds app_settings — an invited
-- teammate joins an existing tenant that should already have its own
-- settings, so seeding there would be wrong (and could clobber nothing
-- since ON CONFLICT DO NOTHING, but is simply unnecessary work on a
-- tenant that isn't being created here).
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_tenant_id UUID;
  v_invited_tenant_id UUID;
BEGIN
  v_invited_tenant_id := (new.raw_user_meta_data->>'invited_tenant_id')::UUID;

  IF v_invited_tenant_id IS NOT NULL THEN
    v_tenant_id := v_invited_tenant_id;
  ELSE
    INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'company_name', new.email),
      new.id, 'trial', now() + interval '14 days'
    )
    RETURNING id INTO v_tenant_id;

    -- Default settings for the new tenant, matching schema.sql's global
    -- app_settings seed values exactly.
    INSERT INTO app_settings (tenant_id, key, value) VALUES
      (v_tenant_id, 'travel_rate_per_km', '20'),
      (v_tenant_id, 'holiday_pay_multiplier', '1.5')
    ON CONFLICT (tenant_id, key) DO NOTHING;
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
