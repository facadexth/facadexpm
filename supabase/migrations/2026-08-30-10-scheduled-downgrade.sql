-- supabase/migrations/2026-08-30-10-scheduled-downgrade.sql
-- Scheduled (no-charge) downgrades: an active paying tenant can pick a
-- cheaper tier without a proration reimbursement, but the switch itself
-- doesn't happen until the current paid cycle actually ends -- they keep
-- their current tier's access until plan_expires_at, then the cheaper
-- tier applies automatically. omise-create-charge (Edge Function, not
-- SQL) is separately updated to reject any downgrade-or-equal package
-- selection -- that endpoint is for price INCREASES only.
ALTER TABLE tenants ADD COLUMN pending_package_id UUID REFERENCES packages(id) ON DELETE SET NULL;

-- Admin/owner picks a cheaper (or equal-priced) package to switch to once
-- the current cycle ends. No payment, no proration credit -- just an
-- intent flag. Only valid while the tenant is actively mid-cycle on a
-- paid plan; if there's no time left to "wait out", they should just buy
-- the tier directly (the normal fresh-subscription flow already handles
-- that at full price).
CREATE OR REPLACE FUNCTION tenant_schedule_downgrade(p_package_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_current_package_id UUID;
  v_current_price NUMERIC;
  v_target_price NUMERIC;
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  SELECT package_id INTO v_current_package_id
  FROM tenants
  WHERE id = v_tenant_id AND plan = 'active' AND plan_expires_at IS NOT NULL AND plan_expires_at > now();

  IF v_current_package_id IS NULL THEN
    RAISE EXCEPTION 'no active paid plan with time remaining to schedule a downgrade against';
  END IF;

  SELECT price_monthly INTO v_current_price FROM packages WHERE id = v_current_package_id;
  SELECT price_monthly INTO v_target_price FROM packages WHERE id = p_package_id;

  IF v_target_price IS NULL THEN
    RAISE EXCEPTION 'target package has no payable monthly price (Custom/Enterprise) -- contact us directly';
  END IF;
  IF v_target_price > v_current_price THEN
    RAISE EXCEPTION 'this is a higher-priced package -- use the upgrade flow instead';
  END IF;
  IF p_package_id = v_current_package_id THEN
    RAISE EXCEPTION 'already on this package';
  END IF;

  UPDATE tenants SET pending_package_id = p_package_id WHERE id = v_tenant_id;
END;
$$;

-- Admin/owner changes their mind before the scheduled downgrade applies.
CREATE OR REPLACE FUNCTION tenant_cancel_pending_downgrade()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  UPDATE tenants SET pending_package_id = NULL WHERE id = current_tenant_id();
END;
$$;

-- Applies a due scheduled downgrade. Called opportunistically by
-- useTenant.js on load (this app has no cron/scheduled-job
-- infrastructure -- trial_ends_at is already handled the same
-- lazy/on-load way, see trialJustEnded in App.jsx). A no-op unless a
-- downgrade is actually pending AND the paid-through date has passed, so
-- it's safe to call unconditionally/frequently and open to any tenant
-- member (not gated to admin/owner) -- it only ever executes a change an
-- admin/owner already approved when scheduling it.
CREATE OR REPLACE FUNCTION tenant_apply_pending_downgrade()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_pending_package_id UUID;
  v_plan_expires_at TIMESTAMPTZ;
  v_target_price NUMERIC;
  v_new_plan_expires_at TIMESTAMPTZ;
BEGIN
  SELECT pending_package_id, plan_expires_at INTO v_pending_package_id, v_plan_expires_at
  FROM tenants WHERE id = v_tenant_id;

  IF v_pending_package_id IS NULL OR v_plan_expires_at IS NULL OR v_plan_expires_at > now() THEN
    RETURN;
  END IF;

  SELECT price_monthly INTO v_target_price FROM packages WHERE id = v_pending_package_id;
  -- Free is free forever (matches tenant_downgrade_to_free()'s semantics);
  -- a still-paid cheaper tier keeps the already-passed plan_expires_at as
  -- is -- no new cycle is fabricated since no new payment was made, so
  -- the tenant lands in the same "needs to pick/pay for a plan" state as
  -- any other lapsed-active tenant, just now defaulted onto the cheaper
  -- tier.
  v_new_plan_expires_at := CASE WHEN v_target_price = 0 THEN NULL ELSE v_plan_expires_at END;

  UPDATE tenants
  SET package_id = v_pending_package_id, pending_package_id = NULL, plan_expires_at = v_new_plan_expires_at
  WHERE id = v_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = v_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = v_pending_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT v_tenant_id, module_key FROM package_modules WHERE package_id = v_pending_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (v_tenant_id, 'active', v_new_plan_expires_at, 'scheduled-downgrade (auto-applied)');
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_schedule_downgrade(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION tenant_cancel_pending_downgrade() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION tenant_apply_pending_downgrade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_schedule_downgrade(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_cancel_pending_downgrade() TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_apply_pending_downgrade() TO authenticated;
