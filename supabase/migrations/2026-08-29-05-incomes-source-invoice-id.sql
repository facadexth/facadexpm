-- supabase/migrations/2026-08-29-05-incomes-source-invoice-id.sql
-- Closes the cross-tab mark-paid race flagged in the Invoice module's
-- final review: Invoices.jsx's handleMarkPaid guarded against duplicate
-- income rows with a SELECT-then-INSERT on incomes.invoice_no, but that
-- column has no DB-level uniqueness -- confirmed live, 4 existing
-- invoice_no values are already legitimately shared across unrelated
-- income rows (src/pages/Income.jsx lets users type this field freely,
-- e.g. "IV2608-001" used for two different clients/sites). A UNIQUE
-- constraint on invoice_no itself would break that manual-entry workflow.
--
-- Instead: a new, purely-automated column, matching the exact pattern
-- receipts.invoice_id already uses successfully (a real UNIQUE
-- constraint + SELECT-then-INSERT, self-healing on retry via the alert
-- shown when a genuine race loses the INSERT). Nullable, so every
-- existing/manual income row (NULL here) is unaffected -- Postgres
-- allows unlimited NULLs under a UNIQUE constraint.
ALTER TABLE incomes ADD COLUMN source_invoice_id UUID REFERENCES invoices(id);
ALTER TABLE incomes ADD CONSTRAINT incomes_source_invoice_id_unique UNIQUE (source_invoice_id);

-- Backfill: every already-paid invoice already has an exact, precise link
-- to its income row via invoices.income_id -- reuse that FK directly
-- rather than guessing from invoice_no text.
UPDATE incomes i SET source_invoice_id = inv.id
FROM invoices inv
WHERE inv.income_id = i.id AND i.source_invoice_id IS NULL;
