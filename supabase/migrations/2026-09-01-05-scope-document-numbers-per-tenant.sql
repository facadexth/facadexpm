-- supabase/migrations/2026-09-01-05-scope-document-numbers-per-tenant.sql
-- Every auto-numbering trigger in this app (generate_site_number(),
-- generate_client_number(), etc.) computes its "next number" via
-- SELECT MAX(...) FROM <table> WHERE <table> -- since none of these
-- triggers are SECURITY DEFINER, that MAX() runs under the CALLING
-- user's own RLS, which only ever shows their OWN tenant's rows. So
-- every trigger already (accidentally) computes a per-tenant sequence
-- correctly -- but the UNIQUE constraint backing each number column was
-- GLOBAL across every tenant, not scoped to (tenant_id, number). Result:
-- any tenant whose computed "next number" (e.g. the very first site a
-- brand-new tenant ever creates, always "FX-2026-001") happened to
-- already be claimed by a DIFFERENT tenant got a hard duplicate-key
-- failure creating that record -- confirmed live: FX-2026-001,
-- CL-2026-001, and SP-2026-001 were all already taken, meaning any new
-- tenant signing up today could not create their first site, client, or
-- supplier at all.
--
-- Fix is constraint-only -- the triggers already compute the right
-- per-tenant number, they just need a per-tenant uniqueness constraint
-- to match. Relaxing UNIQUE(col) to UNIQUE(tenant_id, col) can never
-- violate on existing data (a superset of a satisfied constraint is
-- always satisfied), so this is safe to apply directly with no backfill
-- step.
--
-- company_holidays.date gets the same fix for the same underlying
-- reason (not an auto-number, but the same "should be per-tenant,
-- constraint was global" bug) -- only one tenant across the whole
-- platform could ever mark a given date as a holiday.
ALTER TABLE sites DROP CONSTRAINT sites_site_number_key;
ALTER TABLE sites ADD CONSTRAINT sites_tenant_id_site_number_key UNIQUE (tenant_id, site_number);

ALTER TABLE clients DROP CONSTRAINT clients_client_number_key;
ALTER TABLE clients ADD CONSTRAINT clients_tenant_id_client_number_key UNIQUE (tenant_id, client_number);

ALTER TABLE suppliers DROP CONSTRAINT suppliers_supplier_number_key;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_tenant_id_supplier_number_key UNIQUE (tenant_id, supplier_number);

ALTER TABLE labor_subcontractors DROP CONSTRAINT labor_subcontractors_subcontractor_number_key;
ALTER TABLE labor_subcontractors ADD CONSTRAINT labor_subcontractors_tenant_id_subcontractor_number_key UNIQUE (tenant_id, subcontractor_number);

ALTER TABLE labor_payments DROP CONSTRAINT labor_payments_payment_number_key;
ALTER TABLE labor_payments ADD CONSTRAINT labor_payments_tenant_id_payment_number_key UNIQUE (tenant_id, payment_number);

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_po_number_key;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_tenant_id_po_number_key UNIQUE (tenant_id, po_number);

ALTER TABLE quotations DROP CONSTRAINT quotations_quotation_number_key;
ALTER TABLE quotations ADD CONSTRAINT quotations_tenant_id_quotation_number_key UNIQUE (tenant_id, quotation_number);

ALTER TABLE invoices DROP CONSTRAINT invoices_invoice_number_key;
ALTER TABLE invoices ADD CONSTRAINT invoices_tenant_id_invoice_number_key UNIQUE (tenant_id, invoice_number);

ALTER TABLE receipts DROP CONSTRAINT receipts_receipt_number_key;
ALTER TABLE receipts ADD CONSTRAINT receipts_tenant_id_receipt_number_key UNIQUE (tenant_id, receipt_number);

ALTER TABLE receipts DROP CONSTRAINT receipts_tax_invoice_number_key;
ALTER TABLE receipts ADD CONSTRAINT receipts_tenant_id_tax_invoice_number_key UNIQUE (tenant_id, tax_invoice_number);

ALTER TABLE company_holidays DROP CONSTRAINT company_holidays_date_key;
ALTER TABLE company_holidays ADD CONSTRAINT company_holidays_tenant_id_date_key UNIQUE (tenant_id, date);
