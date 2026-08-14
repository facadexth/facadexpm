-- worker_ot: OT decoupled from the morning/evening shift structure in
-- worker_assignments. Tied to a site (for per-site cost attribution) and a
-- time range, capped at one entry per worker per day.
-- See docs/superpowers/specs/2026-08-14-ot-decouple-design.md
CREATE TABLE worker_ot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  ot_hours    NUMERIC NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, date),
  CHECK (end_time > start_time)
);

CREATE INDEX idx_worker_ot_site ON worker_ot(site_id);
CREATE INDEX idx_worker_ot_date ON worker_ot(date);

-- ต้นทุน OT ต่อไซท์ (all-time) — mirrors labor_cost_by_site's shape/grouping
CREATE VIEW ot_cost_by_site AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * (w.monthly_salary / 26 / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;
