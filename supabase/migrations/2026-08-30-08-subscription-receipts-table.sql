-- supabase/migrations/2026-08-30-08-subscription-receipts-table.sql
-- Platform billing receipt (FacadeX -> tenant), distinct from the app's
-- own client-facing Invoice/Receipt module (a tenant's receipts to THEIR
-- clients). Issued automatically by omise-webhook on a confirmed
-- successful subscription payment; emailed via Resend.
CREATE TABLE subscription_receipts (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number    TEXT NOT NULL UNIQUE DEFAULT '',
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  package_name      TEXT NOT NULL, -- snapshot at time of issue
  amount            NUMERIC NOT NULL, -- VAT-inclusive baht, matches payment_intents.amount
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_to          TEXT,
  email_sent_at     TIMESTAMPTZ,
  email_error       TEXT
);

CREATE INDEX idx_subscription_receipts_tenant_id ON subscription_receipts(tenant_id);

-- Same MAX(existing)+1 pattern as generate_site_number()/generate_po_number()
-- -- never COUNT(*)+1 (breaks on delete).
CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RCT-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM subscription_receipts
  WHERE receipt_number LIKE 'RCT-' || year_part || '-%';
  NEW.receipt_number := 'RCT-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receipt_number
  BEFORE INSERT ON subscription_receipts
  FOR EACH ROW
  WHEN (NEW.receipt_number IS NULL OR NEW.receipt_number = '')
  EXECUTE FUNCTION generate_receipt_number();

ALTER TABLE subscription_receipts ENABLE ROW LEVEL SECURITY;

-- Tenant members can see their own subscription receipts (billing history).
CREATE POLICY member_reads_own ON subscription_receipts FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
-- No INSERT/UPDATE policy for `authenticated` -- only the webhook
-- (service_role) ever creates these.
