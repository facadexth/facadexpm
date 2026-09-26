-- LINE crew-bot deep-link forms: เบิกของ (material request) and ขอลา
-- (leave request), replacing the free-text placeholder that just dropped a
-- message into line_issue_reports. A worker tapping the Rich Menu button
-- now gets a one-time link to a public web form (see field-form Edge
-- Function + src/FieldFormPage.jsx); submitting it writes a real row here,
-- pending ADMIN/OWNER review -- neither table is auto-approved.
--
-- All access goes through the field-form Edge Function using the service
-- role (same pattern as sign-link/PublicSignPage) -- these tables get NO
-- anon RLS policy at all, only admin_full_access for the normal app UI.

CREATE TABLE line_deep_link_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('material_request', 'leave')),
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX line_deep_link_tokens_token_idx ON line_deep_link_tokens (token);

CREATE TABLE material_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  worker_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     NUMERIC,
  unit         TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ
);

CREATE TABLE leave_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id(),
  worker_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  leave_type   TEXT NOT NULL CHECK (leave_type IN ('leave_sick', 'leave_personal')),
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL CHECK (date_to >= date_from),
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ
);

ALTER TABLE line_deep_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;

-- Admin UI (approval queues, and the token list is diagnostic-only --
-- normal app users have no reason to write it, only read for support).
CREATE POLICY admin_full_access ON material_requests FOR ALL
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_full_access ON leave_requests FOR ALL
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_reads ON line_deep_link_tokens FOR SELECT
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
