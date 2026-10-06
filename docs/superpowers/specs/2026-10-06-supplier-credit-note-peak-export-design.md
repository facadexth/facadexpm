# Supplier credit note + PEAK-format export — design

Date: 2026-10-06 · Status: draft for owner review · Branch: worktree-supplier-credit-note-peak-export

## Intent (agreed with owner)
- Real purchase returns/credit notes appear in supplier documents (e.g. SR6901/31003, SM0008/0000012). The app cannot record them today.
- A credit note must: **reduce stock, reduce expense (incl. VAT), and record what the supplier owes back**.
- Future documents only. No backfill of past returns.
- The accountant prepares statements/VAT filings **from data exported from the app**. No ledger or chart of accounts inside the app.
- The company is leaving PEAK, but tenants may keep using PEAK during the transition, so the app exports **Excel in PEAK's import-template format** (no PEAK API).
- Tax ID / branch of suppliers is **out of scope**: a separate future DBD-lookup feature will fill it. This design only leaves room for it.

## Non-goals
Ledger/journal, full chart of accounts, PEAK Open API, return backfill, tax-ID matching, customer-side credit notes (existing `sale_reversal` covers COGS reversal).

## Constraints
- Additive-only migrations (new tables/columns/constraint values; no drops or renames). Migrations go live the moment they are applied, so apply only after review.
- Module-gated: reuse `has_module_access('purchase_orders')` and a matching `companyHasModule` check in the UI.
- Tenant isolation via `tenant_id` + RLS, same as `expenses`.
- When altering a view, remember `x.*` column lists freeze at creation (re-create views that expose changed tables).

## Phase 1 — Supplier credit note
**Data**
- `supplier_credit_notes`: id, tenant_id, supplier_id, doc_number (supplier's CN number), doc_date, linked `po_id` (nullable), linked `expense_id` (nullable), category_id, amount_no_vat, vat, amount (incl. VAT), settlement_status (`owed` | `offset` | `refunded`), settled_at, notes, status (`draft` | `confirmed` | `void`), created_by, timestamps.
- `supplier_credit_note_items`: credit_note_id, inventory_item_id (nullable for non-stock lines), description, quantity, unit, unit_price, site_id.
- Linking: **optional**. A note normally links to its PO/expense (preferred in the UI), but standalone is allowed for returns whose original purchase predates the app. Document numbers unique per tenant (not global).

**Confirm action** (atomic, one RPC `confirm_supplier_credit_note`)
1. For each stock line, record a movement of new type `purchase_return` at the item's **current weighted-average cost** (not the document price; the difference is not a stock effect). Quantity decreases, WAC unchanged. Must not take stock below zero: reject with a clear error.
2. Insert a negative `expenses` row (amount, amount_no_vat, vat negative) in the note's category, linked to the credit note, so expense totals and VAT reports drop automatically.
3. Set settlement status (default `owed`). The negative expense's `status` follows it: `owed` -> `pending` (reduces the payables forecast), `offset`/`refunded` -> `paid`.
4. `site_id` is required on a credit note (it is both the stock site and the expense site).
- Void reverses all three (stock back at the original movement cost, expense row removed or negated).
- Migration: add `purchase_return` to the `stock_movements.movement_type` CHECK and to the `record_stock_movement` whitelist; extend it to support the decrease path like `transfer_out`.

**UI**: new "ใบลดหนี้ซัพพลายเออร์" list + form under purchase orders (module-gated); button "สร้างใบลดหนี้" from a PO/expense; supplier page shows credit owed. Thai UI.

## Phase 2 — PEAK account-code mapping
- Add nullable `peak_account_code` (6-digit text) to `expense_categories` and to income types; editable in Categories/Settings.
- Credit-note journal uses the note's category account for the credit side (symmetrical with the original purchase) plus code constants 212101 (payable) and 115401 (input VAT). Editing those two constants in Settings is out of scope for now (YAGNI).
- Unmapped categories export with a blank code and a warning count in the export dialog.

## Phase 3 — PEAK-format Excel export
- Templates are in `docs/reference/peak-import-templates/` (expense, purchase, invoice, journal). Start with expense/purchase (credit notes ride the same path as negative expenses — verify against the template before building) then income/invoice.
- Built on `src/lib/exportExcel.js`; one pure builder function per template, unit tested with vitest (a fixture row in → expected cells out).
- **Finding (templates read 2026-10-06):** PEAK's contact column accepts only a PEAK contact number (e.g. C00001) or a 13-digit tax ID (+5-digit branch), never a name; unmatched values import blank. So suppliers get nullable `peak_contact_no`, `tax_id`, `branch_no` columns (filled by hand now, by the DBD feature later); the export uses contact no. first, then tax ID, else blank and counts the row as "no contact".
- **Finding:** PEAK has no credit-note import template (only expense, purchase-inventory, invoice, journal) and the expense template defines no negative rows. Credit notes therefore export through the **journal template** (book รายวันซื้อ): Dr 212101 เจ้าหนี้การค้า (total), Cr the credit note category's PEAK account (net), Cr 115401 ภาษีซื้อ (VAT). Negative expense rows are skipped by the expense export and listed in the export result.
- Date range filter; export result lists skipped rows (negative expenses, unmapped category, no contact).
- Income/invoice export is **not** in this plan; it is a follow-up once expense + credit-note export is proven.

## Testing
- vitest for builders and credit-note math (VAT split, rounding, WAC-cost return).
- Live check on a scratch tenant: confirm → stock, expense, balance move correctly; void restores; negative-stock rejection; RLS cross-tenant.
- Review each migration with a dry-run (`BEGIN … ROLLBACK`) before applying.

## Open items for owner
1. Is the "standalone allowed, link preferred" ruling OK?
2. Check PEAK import credit cost per document before bulk exports (package expires ~2026-10-09).
