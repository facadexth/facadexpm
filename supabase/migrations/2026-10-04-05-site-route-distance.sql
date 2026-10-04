-- Driving distance/time from the company's base to each site (OpenRouteService).
-- sites.distance_km already exists (one way, drives travel pay); this adds the drive time.
-- The routing key is ONE shared secret (ORS_API_KEY), so each company gets a daily cap.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS travel_minutes INT;

CREATE TABLE IF NOT EXISTS route_call_log (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  calls     INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE route_call_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON route_call_log FROM anon, authenticated;

-- true = this call may go ahead (and is counted). Bangkok date. Service role only.
CREATE OR REPLACE FUNCTION consume_route_call(p_tenant UUID, p_cap INT DEFAULT 150) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_calls INT;
BEGIN
  INSERT INTO route_call_log (tenant_id, day, calls)
  VALUES (p_tenant, (now() AT TIME ZONE 'Asia/Bangkok')::date, 1)
  ON CONFLICT (tenant_id, day) DO UPDATE SET calls = route_call_log.calls + 1
  RETURNING calls INTO v_calls;
  RETURN v_calls <= p_cap;
END $$;
REVOKE ALL ON FUNCTION consume_route_call(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_route_call(UUID, INT) TO service_role;
