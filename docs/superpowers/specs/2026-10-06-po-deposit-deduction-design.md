# PO deposit deduction (หักมัดจำ) — design

Date: 2026-10-06 · Status: draft for owner review · Written on branch `worktree-supplier-credit-note-peak-export` (docs only; implementation goes in its own worktree, see Sequencing)

## Intent (owner, 2026-10-06)
- Some suppliers (e.g. CAC Pacific, Surin Furniture) are paid by **deposit invoices** before goods arrive. The deposit is already recorded in the app as an expense (own tax invoice, own VAT). Examples read from real documents: CAC `IV6903014` (goods 41,004, "Deduct Down Payment AI6901007" 41,004, invoice total 0.00 / VAT 0.00) and `IV6903055` (goods 9,786, deduct 2,935.80, net 6,850.20, VAT 479.51, total 7,329.71 = the expense already in the app). One deposit invoice is deducted across several delivery invoices.
- Today receiving a PO creates **one expense for the full PO amount** (`PurchaseOrders.jsx` `handleReceive`), so a deposit-paid purchase is counted twice (deposit expense + full expense), and the PO document scan has no notion of a deposit deduction.
- Wanted: the receive step (and the document scan that feeds the PO) can **deduct deposits**, creating an expense only for the remainder; stock always enters in full.
- Deposits are registered **manually** (owner confirmed); no auto-detection from descriptions.

## Non-goals
Credit notes on deposit-paid POs; a PEAK "deduct deposit" document (deposit and remainder export as ordinary expenses); automatic registration of old deposits; changing how stock is valued (it stays at the PO's goods value, ex-VAT, regardless of how it was paid).

## Constraints
- Additive-only migrations; do not add columns to `expenses` (`expenses_view` `e.*` freezes).
- Module/role gate as PO (`has_module_access('purchase_orders')`, `is_admin_or_owner()`), tenant isolation via `tenant_id` + RLS, same as `supplier_credit_notes`.
- Deployment safe in both orders: no existing page may error if code ships before the migration (new queries must degrade; follow the `pickPeakFields` / `useCreditNoteExpenseIds` pattern).
- VAT: deposit and remainder are separate tax invoices; never count the full PO VAT again.

## Data model
- `supplier_deposits` (id, tenant_id, `expense_id` UNIQUE → expenses ON DELETE RESTRICT, `deposit_invoice_no` TEXT NOT NULL, created_by, created_at). One row = "this expense is a deposit". Unique `(tenant_id, deposit_invoice_no)` where the number is not blank.
- `po_deposit_applications` (id, tenant_id, `deposit_id` → supplier_deposits RESTRICT, `po_id` → purchase_orders, `amount_no_vat`, `vat`, created_by, created_at).
- Remaining of a deposit = deposit expense `amount_no_vat` − Σ applications `amount_no_vat` (VAT likewise); computed on read, never stored.
- A deposit expense that has applications cannot be edited in amount or deleted (FK RESTRICT + UI lock, same pattern as credit-note expenses). Client writes to applications only through the RPC below.
- Lock/validation triggers follow the credit-note migration (cross-tenant reference check, no client forging).

## Receive flow
RPC `receive_po_with_deposits(p_po_id, p_applications jsonb)` (SECURITY DEFINER, re-checks tenant + role), atomic:
1. Lock the PO (`status = 'ordered'` else error `not_ordered`).
2. For each application `{deposit_id, amount_no_vat}`: reject if the deposit is not the PO supplier's, if it exceeds the deposit's remaining, or if the sum exceeds the PO's ex-VAT subtotal. VAT of the deduction = `amount_no_vat × deposit.vat / deposit.amount_no_vat` (the deposit invoice's own rate), rounded 2dp.
3. Remainder: `net = subtotal − Σnet`, `vat = poVat − Σdeductionvat`, `total = net + vat` (all ≥ 0). If `net` and `vat` are both 0 → **no expense is created** and `purchase_orders.expense_id` stays null; otherwise insert the remainder expense exactly like today (same fields, `po_id` set) with `amount_no_vat = net`, `vat`, `amount = total`.
4. Insert the application rows, set the PO `received` / `received_date` / `expense_id`.
5. Stock posting stays as today, after the RPC (unchanged `record_stock_movement` loop). Known limitation: stock posting is still a separate step; not made atomic here.
- PO with no deposit selected behaves exactly as today (same RPC with an empty list, so one code path).

## UI
- **Expenses page**: on a supplier expense row, "ลงทะเบียนเป็นมัดจำ" asks for the deposit invoice number (e.g. `AI6901007`). Registered deposit rows show "ใช้ไปแล้ว X · เหลือ Y" and are locked once applied.
- **PO receive dialog**: optional "หักมัดจำ" block listing the supplier's deposits with a remaining balance; tick + amount ex-VAT (default = min(remaining, subtotal still uncovered)). A live preview shows "รายจ่ายใหม่: ก่อน VAT X · VAT Y" or "ไม่สร้างรายจ่าย (หักครบ)". Errors map to Thai messages (over-remaining, over-PO, wrong supplier).
- **PO list/detail**: a PO that used deposits shows the applied deposit numbers and amounts.

## Document scan (PO from photo)
- Extend the extraction output with `deposit_deductions: [{ref, amount}]` (a "Deduct Down Payment / หักดาวน์เพย์เมนต์ …" line: invoice number of the deposit and the ex-VAT amount deducted). Update the prompt (`supabase/functions/_shared/po-extract-prompt.ts`), the validator (`src/lib/poDocumentExtraction.js`, never throws; absent/garbled → empty list) and the scan eval (`scripts/eval-po-extract.mjs`) with the two CAC documents above as fixtures.
- The PO create form pre-fills the deposit block: exact normalized match of `ref` against `supplier_deposits.deposit_invoice_no` of that supplier → preselected with the read amount; no match → visible warning and manual choice. Nothing is ever deducted silently.
- A document whose goods subtotal is fully deducted (invoice total 0) is read as a deposit-paid purchase, not as a free one: line prices stay as printed.

## Error handling / edge cases
- Deposit expense amount edited down below what is applied: blocked (lock).
- PO cancelled before receiving: no applications exist yet. PO already received cannot be un-received today; if that feature exists later it must release applications (open item, not in this scope).
- Deposit invoices that cover several POs, or several deposits covering one PO: supported (many applications).
- Rounding: VAT split per application rounded 2dp; remainder VAT computed from totals so `net + vat = total` always holds; sums verified in tests against the two real documents.

## Testing
- vitest (pure `depositMath.js`): remaining balance, VAT split, remainder, preview, over-limit cases; fixtures `IV6903014` (full deduction → no expense) and `IV6903055` (net 6,850.20 / VAT 479.51 / total 7,329.71).
- vitest for the extraction validator (`deposit_deductions` valid, malformed, missing) and prompt text.
- SQL test script (BEGIN … ROLLBACK, house style of `supabase/tests/supplier_credit_notes_test.sql`): over-remaining rejected with nothing written, wrong-supplier deposit rejected, full deduction creates no expense, partial creates the right remainder, double receive rejected, deposit with applications cannot be deleted, cross-tenant.
- Live verification by the owner after applying the migration: register the real deposit, receive a test PO, check expense totals; PEAK export of both expenses.

## Sequencing
- Branch off `worktree-supplier-credit-note-peak-export` (both change `PurchaseOrders.jsx`, reuse the expense-lock pattern); that branch must merge first, or this one is rebased onto main afterwards.
- The unbuilt PO-extract upgrade (`docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md`, branch `feat/po-scan-tiered`) also changes `po-extract-prompt.ts` and the validator: decide the order before building to avoid a merge conflict (open item).

## Open items for the owner
1. Register the existing CAC "Down Payment 30 %" expense (and `AI6901007`) by hand after the feature ships; the number on the old expense (`IV68071902`) is not the `AI…` number, so the deposit invoice number is typed at registration.
2. Whether the PO-extract upgrade or this feature goes first.
