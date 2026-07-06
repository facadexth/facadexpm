-- site_phases: per-site process-step schedule (Gantt) + billing weight (S-curve plan line)
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-06

CREATE TABLE site_phases (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  start_date          DATE,
  end_date            DATE,
  status              TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (status IN ('not_started','in_progress','done')),
  billing_weight_pct  NUMERIC NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_site_phases_site_id ON site_phases(site_id);

-- Auto-seed the 7-step template whenever a new site is created (covers the
-- add-site form and Excel import — any insert path into `sites`).
CREATE OR REPLACE FUNCTION seed_site_phases() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct) VALUES
    (NEW.id, 'ทำแบบเพื่อขออนุมัติ', 1, 5),
    (NEW.id, 'สั่งวัสดุ', 2, 15),
    (NEW.id, 'วัดหน้างานเพื่อผลิต', 3, 5),
    (NEW.id, 'ผลิต', 4, 30),
    (NEW.id, 'ติดตั้ง', 5, 30),
    (NEW.id, 'เก็บงานรอบสุดท้าย', 6, 10),
    (NEW.id, 'ส่งมอบงาน', 7, 5);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_seed_site_phases
  AFTER INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION seed_site_phases();

-- Backfill: sites created before this migration have no phases yet.
INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct)
SELECT s.id, p.name, p.sort_order, p.billing_weight_pct
FROM sites s
CROSS JOIN (VALUES
  ('ทำแบบเพื่อขออนุมัติ', 1, 5),
  ('สั่งวัสดุ', 2, 15),
  ('วัดหน้างานเพื่อผลิต', 3, 5),
  ('ผลิต', 4, 30),
  ('ติดตั้ง', 5, 30),
  ('เก็บงานรอบสุดท้าย', 6, 10),
  ('ส่งมอบงาน', 7, 5)
) AS p(name, sort_order, billing_weight_pct)
WHERE NOT EXISTS (SELECT 1 FROM site_phases sp WHERE sp.site_id = s.id);
