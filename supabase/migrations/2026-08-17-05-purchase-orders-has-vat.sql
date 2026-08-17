-- Per-PO VAT toggle. Mirrors sites.has_vat exactly: line-item prices are
-- always pre-VAT; this only controls whether VAT is added on top of the
-- summed subtotal when computing the PO's grand total and the
-- auto-created expense's amounts.
ALTER TABLE purchase_orders ADD COLUMN has_vat BOOLEAN NOT NULL DEFAULT true;
