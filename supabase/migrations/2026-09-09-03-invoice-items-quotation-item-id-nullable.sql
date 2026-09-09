-- supabase/migrations/2026-09-09-03-invoice-items-quotation-item-id-nullable.sql
-- A deposit invoice_items row (see CreateDepositInvoiceModal, Invoices.jsx)
-- isn't a draw against any specific quotation line item -- it's a flat %
-- of the whole quotation's contract value -- so quotation_item_id must be
-- nullable to represent it. Every existing row (all real progress-invoice
-- draws) already has a non-null value, so relaxing the constraint can't
-- violate any existing data.
ALTER TABLE invoice_items ALTER COLUMN quotation_item_id DROP NOT NULL;
