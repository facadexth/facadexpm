-- supabase/migrations/2026-09-03-12-bank-accounts.sql
-- Multiple bank accounts per tenant, each categorized as VAT or
-- non-VAT income, with one default per category. quotations/invoices
-- each record which account was selected (not just live-computed at
-- print time), defaulted per document's own has_vat and freely
-- switchable among same-category accounts.
--
-- Backfills the old single tenants.bank_name/bank_account_name/
-- bank_account_no fields into one bank_accounts row per tenant that
-- had one set, defaulted to the 'vat' category (the more common case)
-- and marked default. Those tenants columns are left in place (not
-- dropped -- live production data) but are no longer read/written by
-- the app going forward.
CREATE TABLE bank_accounts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  bank_name     TEXT NOT NULL,
  account_name  TEXT NOT NULL,
  account_no    TEXT NOT NULL,
  vat_category  TEXT NOT NULL CHECK (vat_category IN ('vat','non_vat')),
  is_default    BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_accounts_tenant_id ON bank_accounts(tenant_id);
-- At most one default account per (tenant, vat_category).
CREATE UNIQUE INDEX idx_bank_accounts_one_default_per_category
  ON bank_accounts(tenant_id, vat_category) WHERE is_default = true;

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bank_accounts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

ALTER TABLE quotations ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

INSERT INTO bank_accounts (tenant_id, bank_name, account_name, account_no, vat_category, is_default)
SELECT id, bank_name, COALESCE(bank_account_name, ''), COALESCE(bank_account_no, ''), 'vat', true
FROM tenants
WHERE bank_name IS NOT NULL AND bank_name != '';
