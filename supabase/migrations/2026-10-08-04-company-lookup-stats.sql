-- NOT APPLIED. Written for review only; the owner applies it AFTER 2026-10-08-03
-- (release order is in docs/superpowers/plans/2026-10-08-company-lookup-ai-handoff.md).
--
-- One row per paid AI company lookup attempt (edge function lookup-company), so the
-- owner can see usage, estimated cost, which sites answer, and the found / not-found rate.
-- Privacy: NO company names, tax IDs or addresses are stored. `domains` holds only the
-- allowlisted hostnames of the kept citations.
-- Written only by the edge function with the service role: RLS on, no policies, no grants
-- to app roles (including the identity sequence).

CREATE TABLE IF NOT EXISTS company_lookup_stats (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  day                 DATE NOT NULL,  -- Bangkok date
  outcome             TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'incomplete', 'error')),
  candidates_kept     INT,
  web_search_requests INT,
  input_tokens        INT,
  output_tokens       INT,
  est_cost_usd        NUMERIC(10,5),
  domains             TEXT[],
  multi_source        BOOLEAN
);

CREATE INDEX IF NOT EXISTS company_lookup_stats_day_idx ON company_lookup_stats (day);

ALTER TABLE company_lookup_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_lookup_stats FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE company_lookup_stats_id_seq FROM PUBLIC, anon, authenticated;
GRANT INSERT ON company_lookup_stats TO service_role;
GRANT SELECT ON company_lookup_stats TO service_role;
GRANT USAGE ON SEQUENCE company_lookup_stats_id_seq TO service_role;
