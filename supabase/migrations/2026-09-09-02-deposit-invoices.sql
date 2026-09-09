-- supabase/migrations/2026-09-09-02-deposit-invoices.sql
-- Adds a "deposit invoice" flavor to the existing invoices table rather
-- than a new table/number series -- explicit user decision: a deposit
-- invoice must share the exact same IN-prefixed numbering sequence as a
-- normal progress invoice, just flagged as a deposit.
--
-- deposit_pct is captured at CREATE time (the % of contract value the
-- user typed) so handleMarkPaid can later replay Income.jsx's existing
-- "saving a มัดจำ row sets sites.default_deposit_pct" behavior without
-- having to re-derive the percentage from the invoice amount.
ALTER TABLE invoices ADD COLUMN is_deposit BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN deposit_pct NUMERIC;
