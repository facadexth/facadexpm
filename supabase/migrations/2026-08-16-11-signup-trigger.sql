-- supabase/migrations/2026-08-16-11-signup-trigger.sql
--
-- Two signup paths now share this trigger:
--   1. Self-serve company signup (Login.jsx signup mode, Task 8) —
--      raw_user_meta_data has NO invited_tenant_id → create a new
--      tenant with a 14-day trial, caller becomes its OWNER.
--   2. Admin-invited teammate (UserManagement.jsx) — passes
--      invited_tenant_id in auth.signUp's options.data → joins that
--      existing tenant as WORKER (UserManagement.jsx's own follow-up
--      upsert then sets the actually-chosen role, same as today).
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
