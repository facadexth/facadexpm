-- Per-package daily LINE push cap, editable in the tenant-management quota card.
--
-- NULL = "use the plan default" (line_push_caps: trial 40, active 400), NOT
-- unlimited: all tenants share one LINE bot, so an unbounded cap would let one
-- tenant spend everyone's monthly push quota. Existing behaviour is unchanged
-- until an admin sets a number. Trial tenants always keep the trial cap.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_line_push_per_day INT
  CHECK (max_line_push_per_day IS NULL OR max_line_push_per_day >= 0);

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

  SELECT CASE WHEN t.plan = 'trial' THEN COALESCE(c.daily_cap, 40)
              ELSE COALESCE(p.max_line_push_per_day, c.daily_cap, 40) END
    INTO v_cap
  FROM tenants t
  LEFT JOIN line_push_caps c ON c.plan = t.plan
  LEFT JOIN packages p ON p.id = t.package_id
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
