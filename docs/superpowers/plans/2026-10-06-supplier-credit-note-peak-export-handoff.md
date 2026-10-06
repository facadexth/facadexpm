# Supplier credit note + PEAK export — owner handoff (2026-10-06)

Branch `worktree-supplier-credit-note-peak-export` (19 commits after `7ea1f30`). Nothing is merged, pushed or applied. Last checks run by reviewers: `npx vitest run` 607/607, `npm run build` OK.

## Apply order (migrations go live the moment they are applied)
1. `supabase/migrations/2026-10-06-01-supplier-credit-notes.sql`
2. `supabase/migrations/2026-10-06-02-credit-note-rpcs.sql`
3. Only then deploy the code. (Code before migrations does not break existing pages — the credit-note page, the PO menu item and the PEAK modal's credit-note part just error — but migrations first is the safe order.)

Dry run each file first (no change is kept):
```
printf 'BEGIN;\n' > /tmp/dry.sql; cat supabase/migrations/2026-10-06-01-supplier-credit-notes.sql >> /tmp/dry.sql; printf '\nROLLBACK;\n' >> /tmp/dry.sql
npx supabase db query --linked -f /tmp/dry.sql
```
File 02 depends on 01, so dry-run it inside the same transaction as 01 (concatenate both between BEGIN and ROLLBACK).

## Run after applying
`supabase/tests/supplier_credit_notes_test.sql` (BEGIN … ROLLBACK, 8 checks: over-quantity confirm rejected with nothing written, double confirm, no-items confirm, void restores stock and removes the expense, client status UPDATE locked, draft delete with items, voided number reusable, expense delete blocked). It has never been run; its fixture columns/tenant setup may need small edits on first run.

## Verified vs not
- Verified by tests/build: calculation helpers, PEAK builders (headers compared with the real templates), stock-report handling of returns, PO base-unit conversion, payload rules.
- Verified read-only against the live schema: `expenses` columns/status values, no CHECK against negative amounts, existing `record_stock_movement` matched migration 2026-09-05-15, tenant_id on the referenced tables.
- **Not verified:** that either migration applies (e.g. constraint name `stock_movements_movement_type_check` on CHANG, default grants), the RPCs/triggers under the real `authenticated` role, every UI flow (create/edit/confirm/void/settle, draft delete, Expenses lock, PEAK modal, PO prefill) in a browser, and **importing the produced files into PEAK** (price-type codes, tax-rate values, journal layout, contact matching).

## Resolved after the final review
- Nav entry for the credit-note page now has `permKey: 'purchase_orders'` (src/App.jsx:74), so it inherits the purchase-orders page permission.

## Deliberately left out
Income/invoice PEAK export, DBD tax-ID lookup (suppliers have empty `tax_id`/`branch_no`/`peak_contact_no` to fill by hand until then), editable PEAK constants 212101/115401, backfilling past returns, "create from expense" entry point (only from a received PO).

## Known limits
- PEAK expense export treats expenses without `amount_no_vat` as no-VAT gross; the modal counts them as "ไม่ทราบ VAT".
- Expense export skips negative (credit-note) expenses; credit notes go out as journal entries (Dr 212101 total, Cr category account net, Cr 115401 VAT). Charts/category totals may show negative amounts for credit-note expenses.
- Deferred minors: float comparison in the stock shortfall check, extra indexes, trigger functions without `SET search_path`, `insufficient_stock` message has no item name, a few UI labels.
