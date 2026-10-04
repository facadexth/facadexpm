-- Web Push: the browser/phone devices an OWNER or ADMIN has turned notifications on for.
--
-- Free and outside the LINE message quota. The app registers a device through the
-- RPCs below; Edge Functions read this table with the service role to send.
-- Writes go only through the SECURITY DEFINER RPCs so a user can never attach a
-- device to someone else or to another company, and a device that changes hands on
-- the same browser (new login) is moved to the new user.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_email    TEXT NOT NULL,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh_key    TEXT NOT NULL,
  auth_key      TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at    TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant ON push_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_email);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_subscriptions FROM anon, authenticated;
GRANT SELECT ON push_subscriptions TO authenticated;

-- A signed-in user can see (never change directly) their own devices.
DROP POLICY IF EXISTS own_subscriptions_read ON push_subscriptions;
CREATE POLICY own_subscriptions_read ON push_subscriptions FOR SELECT TO authenticated
  USING (user_email = (auth.jwt() ->> 'email') AND tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION register_push_subscription(
  p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT, p_user_agent TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email  TEXT := auth.jwt() ->> 'email';
  v_tenant UUID := current_tenant_id();
  v_known  BOOLEAN;
BEGIN
  IF v_email IS NULL OR v_tenant IS NULL OR NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR length(p_endpoint) > 1000
     OR coalesce(p_p256dh, '') = '' OR coalesce(p_auth, '') = '' THEN
    RAISE EXCEPTION 'invalid subscription' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = p_endpoint) INTO v_known;
  -- Keep one person from filling the table with junk devices.
  IF NOT v_known AND (SELECT count(*) FROM push_subscriptions WHERE user_email = v_email) >= 20 THEN
    RAISE EXCEPTION 'too many devices' USING ERRCODE = '54000';
  END IF;

  INSERT INTO push_subscriptions (tenant_id, user_email, endpoint, p256dh_key, auth_key, user_agent)
  VALUES (v_tenant, v_email, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, user_email = EXCLUDED.user_email,
        p256dh_key = EXCLUDED.p256dh_key, auth_key = EXCLUDED.auth_key,
        user_agent = EXCLUDED.user_agent, failure_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION unregister_push_subscription(p_endpoint TEXT) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM push_subscriptions
  WHERE endpoint = p_endpoint
    AND user_email = (auth.jwt() ->> 'email')
    AND tenant_id = current_tenant_id();
END;
$$;

-- Explicit grants: signed-in users only, never anon (a restore once lost these).
REVOKE ALL ON FUNCTION register_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION unregister_push_subscription(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION register_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION unregister_push_subscription(TEXT) TO authenticated, service_role;
