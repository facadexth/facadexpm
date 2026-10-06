-- NOT APPLIED. Written for review only; the owner applies it (release order is in
-- docs/superpowers/plans/2026-10-08-company-lookup-ai-handoff.md).
--
-- Per-tenant daily counter for the AI company lookup (edge function lookup-company).
-- Counts SUCCESSFUL lookups per Bangkok day; the cap itself (30) is a constant in
-- supabase/functions/_shared/company-lookup.ts. Same shape as line_push_log
-- (2026-10-03-05): RLS on, no policies, no grants to app roles, service role only.

CREATE TABLE IF NOT EXISTS company_lookup_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  count     INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE company_lookup_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_lookup_usage FROM PUBLIC, anon, authenticated;

-- Today's count (Bangkok date) for a tenant; 0 when none yet.
CREATE OR REPLACE FUNCTION company_lookup_count_today(p_tenant UUID)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT count FROM company_lookup_usage
      WHERE tenant_id = p_tenant AND day = (now() AT TIME ZONE 'Asia/Bangkok')::date),
    0);
$$;

-- Records one successful lookup; returns the new count for today.
CREATE OR REPLACE FUNCTION company_lookup_record(p_tenant UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day   DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_count INT;
BEGIN
  INSERT INTO company_lookup_usage AS u (tenant_id, day, count)
  VALUES (p_tenant, v_day, 1)
  ON CONFLICT (tenant_id, day) DO UPDATE SET count = u.count + 1
  RETURNING u.count INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION company_lookup_count_today(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION company_lookup_record(UUID)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION company_lookup_count_today(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION company_lookup_record(UUID)      TO service_role;
