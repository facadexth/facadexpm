-- supabase/migrations/2026-10-02-04-line-admin-chat.sql
-- LINE hybrid privacy mode (docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
-- Additive only: three new tables + one private bucket, no change to
-- existing tables. Readable/writable by platform_admins only; the
-- webhook and cron use the service role, which bypasses RLS.

CREATE TABLE line_chat_sessions (
  line_user_id     text PRIMARY KEY,
  tenant_id        uuid,  -- informational, resolved from the worker/user link; no content
  mode             text NOT NULL DEFAULT 'secure_bot' CHECK (mode IN ('secure_bot', 'chat_with_admin')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_admin_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id   text NOT NULL REFERENCES line_chat_sessions(line_user_id) ON DELETE CASCADE,
  direction      text NOT NULL CHECK (direction IN ('user', 'admin')),
  body           text,
  storage_path   text,
  line_event_id  text UNIQUE,  -- LINE message id; a redelivered event cannot insert twice
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR storage_path IS NOT NULL)
);
CREATE INDEX line_admin_messages_user_created_idx ON line_admin_messages (line_user_id, created_at);

CREATE TABLE line_admin_chat_config (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row table
  idle_hours integer NOT NULL DEFAULT 24 CHECK (idle_hours BETWEEN 1 AND 720)
);
INSERT INTO line_admin_chat_config (id) VALUES (true);

ALTER TABLE line_chat_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_admin_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_admin_chat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_all ON line_chat_sessions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_all ON line_admin_messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_all ON line_admin_chat_config FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
-- No policy for anon or for tenant users: RLS denies them by default.

INSERT INTO storage.buckets (id, name, public) VALUES ('line-admin-chat', 'line-admin-chat', false)
  ON CONFLICT (id) DO NOTHING;
CREATE POLICY line_admin_chat_platform_admin_all ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'line-admin-chat' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (bucket_id = 'line-admin-chat' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
