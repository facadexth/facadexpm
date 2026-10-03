-- Per-tenant daily budget for LINE push messages, plus de-dupe for leave decisions.
--
-- All tenants share ONE LINE bot, so its monthly push quota is shared. Replies
-- are free; pushes are not. Before this, nothing bounded how many pushes one
-- tenant could cause (e.g. a trial OWNER re-sending leave decisions in a loop),
-- so a single abuser could use up every tenant's quota. Edge Functions now call
-- consume_line_push() before each push and skip the push when it returns false.

CREATE TABLE IF NOT EXISTS line_push_caps (
  plan      TEXT PRIMARY KEY,
  daily_cap INT  NOT NULL CHECK (daily_cap >= 0)
);

-- Adjustable at any time with a plain UPDATE; unknown plans fall back to 40.
INSERT INTO line_push_caps (plan, daily_cap) VALUES ('trial', 40), ('active', 400)
ON CONFLICT (plan) DO NOTHING;

CREATE TABLE IF NOT EXISTS line_push_log (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  count     INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Service role only: RLS on with no policies, and no grants to app roles.
ALTER TABLE line_push_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_push_log  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON line_push_caps, line_push_log FROM anon, authenticated;

-- Atomically spends p_n pushes from today's (Bangkok date) budget.
-- Returns true when allowed, false when it would exceed the cap or the tenant
-- is unknown. The cap check sits inside the upsert so concurrent callers can
-- never overshoot it.
CREATE OR REPLACE FUNCTION consume_line_push(p_tenant UUID, p_n INT DEFAULT 1)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap   INT;
  v_day   DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_count INT;
BEGIN
  IF p_n IS NULL OR p_n < 1 THEN RETURN false; END IF;

  SELECT COALESCE(c.daily_cap, 40) INTO v_cap
  FROM tenants t LEFT JOIN line_push_caps c ON c.plan = t.plan
  WHERE t.id = p_tenant;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_n > v_cap THEN RETURN false; END IF;

  INSERT INTO line_push_log AS l (tenant_id, day, count)
  VALUES (p_tenant, v_day, p_n)
  ON CONFLICT (tenant_id, day)
  DO UPDATE SET count = l.count + p_n
  WHERE l.count + p_n <= v_cap
  RETURNING l.count INTO v_count;

  RETURN v_count IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION consume_line_push(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_line_push(UUID, INT) TO service_role;

-- The decision ('approved'/'rejected') last announced to the worker on LINE.
-- leave-notify only sends when this differs from the decision being sent, so
-- repeating the same call can no longer message the worker again.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS decision_notified TEXT;
