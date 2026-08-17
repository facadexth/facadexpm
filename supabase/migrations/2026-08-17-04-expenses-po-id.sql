-- supabase/migrations/2026-08-17-04-expenses-po-id.sql
-- Link an expense back to the purchase order it was auto-created from
-- (Phase 1 receive flow). Nullable — only ever set by that flow;
-- manually-created expenses leave it null.
--
-- Also recreates expenses_view via e.* so po_id (and any other expenses
-- columns) are exposed through it, self-contained regardless of whether
-- a separate branch's expenses_view fix (for billing_date/due_date/
-- amount_no_vat/vat/tenant_id) has already merged — this is a harmless,
-- idempotent no-op recreation if it has. CREATE OR REPLACE VIEW can't be
-- used here since Postgres only allows appending columns at the view's
-- current end via REPLACE, and e.* now emits table columns in table
-- storage order, not necessarily at the view's current last position —
-- DROP+CREATE is the only reliable option. No other views depend on
-- expenses_view (verify via pg_depend before running in Step 2 below).

ALTER TABLE expenses ADD COLUMN po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX idx_expenses_po_id ON expenses(po_id);

DROP VIEW IF EXISTS expenses_view;

CREATE VIEW expenses_view WITH (security_invoker = true) AS
SELECT
  e.*,
  s.name              AS site_name,
  s.site_number,
  s.status            AS site_status,
  ec.name             AS category_name,
  ec.color            AS category_color,
  sup.name            AS supplier_name,
  sup.supplier_number,
  sup.category        AS supplier_category
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id;
