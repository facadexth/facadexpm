-- LINE crew-bot deep-link forms: เบิกของ (material request) and ขอลา
-- (leave request), replacing the free-text placeholder that just dropped a
-- message into line_issue_reports. A worker tapping the Rich Menu button
-- now gets a one-time link to a public web form (see field-form Edge
-- Function + src/FieldFormPage.jsx).
--
-- เบิกของ creates a REAL purchase_orders row directly (status 'draft' --
-- see migration 2026-09-27-02) instead of landing in a separate staging
-- table only ADMIN/OWNER would ever see; ขอลา still lands here pending
-- review -- leave_requests is not auto-approved, approving it in HR.jsx
-- is what creates the real worker_assignments day(s).
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
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;

-- Admin UI (approval queue, and the token list is diagnostic-only --
-- normal app users have no reason to write it, only read for support).
CREATE POLICY admin_full_access ON leave_requests FOR ALL
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_reads ON line_deep_link_tokens FOR SELECT
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
