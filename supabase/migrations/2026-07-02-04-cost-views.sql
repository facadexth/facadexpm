-- Assign redesign: half-day labor view (incl. factory) + per-site travel cost
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-02
-- days_worked changes bigint->numeric, so DROP+CREATE (CREATE OR REPLACE can't retype)

DROP VIEW IF EXISTS labor_cost_by_site;
CREATE VIEW labor_cost_by_site AS
SELECT wa.site_id, s.name AS site_name, s.site_number, wa.worker_id,
       w.name AS worker_name, w.nickname,
       count(*) * 0.5 AS days_worked,
       round(w.monthly_salary / 26 * (count(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s   ON wa.site_id = s.id
WHERE wa.type IN ('site','factory')
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;

-- one round trip per distinct date that has a 'site' assignment; factory excluded
CREATE OR REPLACE VIEW site_travel_cost AS
SELECT wa.site_id,
       count(DISTINCT wa.date) AS travel_days,
       s.distance_km,
       round(count(DISTINCT wa.date) * COALESCE(s.distance_km,0) * 2
             * (SELECT value::numeric FROM app_settings WHERE key='travel_rate_per_km'), 2) AS travel_cost
FROM worker_assignments wa
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site'
GROUP BY wa.site_id, s.distance_km;
