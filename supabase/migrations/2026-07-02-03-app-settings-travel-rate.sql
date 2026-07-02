-- Assign redesign: app-wide settings store + travel rate (baht/km)
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-02

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES ('travel_rate_per_km','20')
ON CONFLICT (key) DO NOTHING;
