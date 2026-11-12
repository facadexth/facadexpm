-- Errors that crash a page in a user's browser (owner 2026-11-12: "กดปุ่มเอกสารแล้วขึ้นหน้าขาวล้วน" on IN2611-002 /
-- IN2611-005 for some users, nothing reproducible here and nothing recorded). PageErrorBoundary inserts one row per
-- crash; nobody reads them in the app (the developer reads them with SQL). Additive: a new table only.
CREATE TABLE client_errors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_email  TEXT NOT NULL DEFAULT (auth.jwt() ->> 'email'),
  tenant_id   UUID,
  page        TEXT CHECK (length(page) <= 100),
  message     TEXT CHECK (length(message) <= 2000),
  stack       TEXT CHECK (length(stack) <= 8000),
  url         TEXT CHECK (length(url) <= 500),
  user_agent  TEXT CHECK (length(user_agent) <= 500),
  app_version TEXT CHECK (length(app_version) <= 50),
  viewport    TEXT CHECK (length(viewport) <= 50)
);
ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;
-- insert only, as yourself; no select / update / delete policy
CREATE POLICY client_errors_insert_own ON client_errors FOR INSERT TO authenticated
  WITH CHECK (user_email = (SELECT auth.jwt() ->> 'email'));
REVOKE ALL ON client_errors FROM anon, authenticated;
GRANT INSERT ON client_errors TO authenticated;
