-- NOT APPLIED. Written for review only; the owner applies it (release order is in
-- docs/superpowers/plans/2026-10-08-company-lookup-ai-handoff.md).
--
-- Budget for the AI company lookup (edge function lookup-company). Every lookup
-- spends real Anthropic money (model tokens + $0.01 per web search), so the
-- budget is RESERVED BEFORE the model call (every attempt counts) and refunded
-- only when the call failed before any successful API response.
-- Modelled on consume_line_push / line_push_caps (2026-10-03-05).
--
-- Two limits, both enforced atomically in consume_company_lookup():
--   1. per-tenant daily cap by plan (company_lookup_caps; trial 5, active 30)
--   2. a global daily ceiling across ALL tenants (row plan='_global', default 300)
-- Both are adjustable any time with a plain UPDATE. "Day" = Bangkok date.
-- Service role only: RLS on with no policies, no grants to app roles.

CREATE TABLE IF NOT EXISTS company_lookup_caps (
  plan      TEXT PRIMARY KEY,
  daily_cap INT  NOT NULL CHECK (daily_cap >= 0)
);
-- '_global' is the all-tenant ceiling, not a plan. Unknown plans fall back to 5.
INSERT INTO company_lookup_caps (plan, daily_cap)
VALUES ('trial', 5), ('active', 30), ('expired', 0), ('_global', 300)
ON CONFLICT (plan) DO NOTHING;

CREATE TABLE IF NOT EXISTS company_lookup_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  count     INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE company_lookup_caps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_lookup_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_lookup_caps, company_lookup_usage FROM PUBLIC, anon, authenticated;

-- Reserves one lookup. Returns jsonb {"status": "ok"|"tenant_cap"|"global_cap"|"unknown_tenant",
-- "day": "YYYY-MM-DD"}: the Bangkok day it counted on, which the caller passes back to
-- refund_company_lookup so a refund after midnight hits the same day.
-- The advisory lock serialises callers so neither limit can be overshot.
DROP FUNCTION IF EXISTS consume_company_lookup(UUID);
CREATE OR REPLACE FUNCTION consume_company_lookup(p_tenant UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cap    INT;
  v_global INT;
  v_day    DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_total  INT;
  v_count  INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('consume_company_lookup'));

  SELECT COALESCE(c.daily_cap, 5) INTO v_cap
  FROM tenants t LEFT JOIN company_lookup_caps c ON c.plan = t.plan
  WHERE t.id = p_tenant;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_tenant', 'day', v_day); END IF;

  SELECT COALESCE((SELECT daily_cap FROM company_lookup_caps WHERE plan = '_global'), 300) INTO v_global;
  SELECT COALESCE(SUM(count), 0) INTO v_total FROM company_lookup_usage WHERE day = v_day;
  IF v_total >= v_global THEN RETURN jsonb_build_object('status', 'global_cap', 'day', v_day); END IF;

  INSERT INTO company_lookup_usage AS u (tenant_id, day, count)
  VALUES (p_tenant, v_day, 1)
  ON CONFLICT (tenant_id, day)
  DO UPDATE SET count = u.count + 1
  WHERE u.count < v_cap
  RETURNING u.count INTO v_count;

  -- first insert with a cap of 0 must not stick
  IF v_count IS NOT NULL AND v_cap <= 0 THEN
    UPDATE company_lookup_usage SET count = GREATEST(count - 1, 0) WHERE tenant_id = p_tenant AND day = v_day;
    RETURN jsonb_build_object('status', 'tenant_cap', 'day', v_day);
  END IF;

  RETURN jsonb_build_object('status', CASE WHEN v_count IS NULL THEN 'tenant_cap' ELSE 'ok' END, 'day', v_day);
END;
$$;

-- Gives back one reserved lookup (floor 0) on the day it was counted. Called only
-- when Anthropic certainly did not bill (see shouldRefund in _shared/company-lookup.ts).
DROP FUNCTION IF EXISTS refund_company_lookup(UUID);
DROP FUNCTION IF EXISTS refund_company_lookup(UUID, DATE);
CREATE OR REPLACE FUNCTION refund_company_lookup(p_tenant UUID, p_day DATE)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE company_lookup_usage
     SET count = GREATEST(count - 1, 0)
   WHERE tenant_id = p_tenant AND day = p_day;
$$;

REVOKE ALL ON FUNCTION consume_company_lookup(UUID)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refund_company_lookup(UUID, DATE)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_company_lookup(UUID)      TO service_role;
GRANT EXECUTE ON FUNCTION refund_company_lookup(UUID, DATE) TO service_role;
