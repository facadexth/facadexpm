# Live schema actuals (project yyzbgdmgyvvypfcjuhtr / facadexpm) — 2026-07-02

## worker_assignments
Columns: id (uuid pk), worker_id (uuid NOT NULL), site_id (uuid null), date (date NOT NULL),
type (text default 'site', nullable), ot_hours (numeric default 0), notes (text), created_at (tz).
Constraints:
- PK: worker_assignments_pkey (id)
- FK: worker_assignments_site_id_fkey, worker_assignments_worker_id_fkey
- CHECK: worker_assignments_type_check → type IN ('site','leave','office','holiday','subcontract')
- UNIQUE: worker_assignments_worker_id_date_key → (worker_id, date)
✅ ot_hours EXISTS. No shift column yet.

## sites
Has: location (text), notes (text), client_id, client_name, contract_value, cost_aluminum/equipment/glass/labor/other/rubber, plan_type, status, start_date, end_date, site_number, name.
❌ No distance_km, no map_url yet. (schema.sql was stale: showed `note`/plan_* — real is `notes`/cost_*.)

## labor_cost_by_site (real viewdef)
```sql
SELECT wa.site_id, s.name AS site_name, s.site_number, wa.worker_id,
       w.name AS worker_name, w.nickname,
       count(*) AS days_worked,
       round(w.monthly_salary / 26 * count(*), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s   ON wa.site_id = s.id
WHERE wa.type = 'site'
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;
```
Note: view does NOT expose daily_rate (Assign.jsx references l.daily_rate → currently undefined). Keep output columns identical on rewrite.

## Settings storage
Settings.jsx stores role_permissions in **localStorage** (no DB settings table).
No settings/config table exists → must CREATE app_settings for travel_rate_per_km (DB view needs it).
