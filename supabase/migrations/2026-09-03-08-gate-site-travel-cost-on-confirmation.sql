-- supabase/migrations/2026-09-03-08-gate-site-travel-cost-on-confirmation.sql
--
-- Follow-up fix from the WHOLE-BRANCH review of the worker check-in/check-out
-- feature (not part of the original 7-task plan in
-- docs/superpowers/plans/2026-09-01-worker-checkin-checkout.md).
--
-- site_travel_cost reads exactly the same worker_assignments rows as
-- labor_cost_by_site, but was never gated when labor_cost_by_site was
-- (2026-09-03-03-gate-labor-cost-on-confirmation.sql). A site day where nobody
-- ever showed up was still billed a full round trip of travel cost -- the same
-- class of bug the labor-cost gate was written to close.
--
-- Unlike labor_cost_by_site there is no `factory` branch to preserve here: this
-- view already counts type='site' rows only (factory work happens at the
-- company's own factory, so there is no travel to pay for), so the gate is a
-- plain AND rather than the `type = 'factory' OR (...)` shape used there.
--
-- Applied AFTER 2026-09-03-06's legacy backfill, so no historical travel cost
-- changed: distinct (site_id, date) pairs for type='site' were 82 before and 82
-- after. The gate only bites from go-live day onward.
CREATE OR REPLACE VIEW site_travel_cost WITH (security_invoker = true) AS
SELECT wa.site_id,
       COUNT(DISTINCT wa.date) AS travel_days,
       s.distance_km,
       ROUND(COUNT(DISTINCT wa.date) * COALESCE(s.distance_km, 0) * 2
             * (SELECT value::numeric FROM app_settings WHERE key = 'travel_rate_per_km'), 2) AS travel_cost
FROM worker_assignments wa
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site' AND wa.confirmed_at IS NOT NULL
GROUP BY wa.site_id, s.distance_km;
