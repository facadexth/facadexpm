-- supabase/migrations/2026-08-30-06-payment-intents-table.sql
-- Tracks each attempted Omise payment (Phase B self-service billing).
-- The webhook Edge Function (omise-webhook) uses omise_charge_id to know
-- which tenant/package to activate on a confirmed successful charge.
CREATE TABLE payment_intents (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  package_id       UUID NOT NULL REFERENCES packages(id),
  amount           NUMERIC NOT NULL, -- baht, not satang -- converted when calling Omise
  omise_source_id  TEXT,
  omise_charge_id  TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','expired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ
);

CREATE INDEX idx_payment_intents_tenant_id ON payment_intents(tenant_id);
CREATE INDEX idx_payment_intents_omise_charge_id ON payment_intents(omise_charge_id);

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;

-- Tenant members can see their own tenant's payment attempts.
CREATE POLICY member_reads_own ON payment_intents FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- Starting a payment is an admin/owner-level action (billing).
CREATE POLICY admin_inserts ON payment_intents FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- No UPDATE policy for `authenticated` -- only the webhook (service_role,
-- which bypasses RLS entirely) ever transitions status away from 'pending'.
