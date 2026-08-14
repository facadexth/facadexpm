-- company_holidays: company-wide holiday calendar. Does NOT touch
-- worker_assignments — no auto-marking of workers as on-holiday. Used
-- only to (a) mark the date visually in the Assign grid, and (b) pay a
-- premium to whoever has a site/factory shift on that date.
-- See docs/superpowers/specs/2026-08-14-company-holidays-design.md
CREATE TABLE company_holidays (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_company_holidays_date ON company_holidays(date);

-- Default holiday-pay multiplier (1.5x), editable from the HR tab.
-- Reuses the existing app_settings key/value mechanism (same one
-- travel_rate_per_km already uses).
INSERT INTO app_settings (key, value)
VALUES ('holiday_pay_multiplier', '1.5')
ON CONFLICT (key) DO NOTHING;
