# PO-centric deposits and partial receipts — design

Status: draft for owner review (2026-10-07). Supersedes the "register an existing expense as a deposit, deduct once at receive" flow shipped on 2026-10-07 (kept working for old data).

## 1. What the owner asked for (his words, condensed)

The whole money flow hangs off the PO:

1. Open a PO.
2. Create a deposit for that PO: a **percentage** or an **amount**. After creating it, it becomes the **first expense** of the PO.
3. Goods arrive: **receive everything or only some lines**.
4. Pay for the goods (everything or part).
5. Deduct the deposit at receipt time: a **percentage** or a **value**, with the **remaining deposit** always visible.
6. Pay the remainder; deposit balance ends at 0.

Real reference case (ไทย-เยอรมัน, PO2610-038): PO total 221,201.10 incl. VAT (206,730.00 + 14,471.10); deposit 110,600.55 = exactly 50%, paid 24 Jul; goods received 100% at once; remainder 110,600.55 paid in a second payment; deposit balance 0. "Same process, this case just skips partial receipt and partial payment."

UI wishes: on the PO list, replace the buttons *receive / edit / delete* with a **3-dot menu** that also contains **create deposit**. The *receive* action opens a **PO popup** with a choice **receive all / receive some lines**; **view PO** shows the lines and the **remaining deposit**. The receive dialog also asks for the **received date**. The expense keeps the supplier-invoice / PO date; the received date is used for stock (owner ruling "ข").

## 2. Scope

In v1:
- 3-dot row menu on the PO list (receive, view, edit, create deposit, cancel/delete as today, permission rules unchanged).
- Create deposit from a PO (percent of the PO total incl. VAT, or an amount incl. VAT; VAT split follows the PO's VAT mode; supplier invoice/receipt number and payment method fields).
- Receive dialog: receive all / receive selected lines (line granularity, full line quantity), received date, deposit deduction (percent or value, VAT-inclusive input, default proportional to the receipt's share), preview of the bill that will be created.
- Each receipt creates one **bill** (expense) for the value of the lines received, net of the deposit deduction, and posts stock for the lines received dated the received date.
- PO status gains `partially_received`; the PO detail popup shows lines (ordered / received / outstanding), receipts, deposits, deposit balance.
- Partial payment of a bill by **splitting** (ruling below).

Out of v1 (explicit): partial quantity inside one line (only whole lines), a payments table, supplier returns against receipts (credit notes already exist), several deposits per PO (one deposit per PO in v1; the old "register an existing expense" path still allows several).

## 3. Rulings (made by me; the owner can overturn)

- R1 Receipt granularity = whole PO lines. A line is either not received or received in full. Reason: the owner said "รับบางรายการ"; keeps stock and money maths exact.
- R2 Expense date = PO/invoice date as today; `received_date` on the receipt = stock date. Owner chose "ข".
- R3 Partial payment = **split**: "pay part now" turns a pending bill into a `paid` expense for the amount paid plus a `pending` expense for the rest (same invoice number and PO link, notes mention the split); the pending part can be split again. No payments table in v1. Existing payables reports and the PEAK export keep working unchanged. (Alternative "payments table" costs a refactor of every payables screen; deferred.)
- R4 Deposit deduction default: `deposit_pct_of_po × receipt value` rounded to satang, capped by the remaining deposit and by the receipt value; the last receipt (all lines received) defaults to "the whole remaining deposit". Editable as percent or value.
- R5 VAT of a deduction follows the existing proportional rule of the live deposit feature (net × deposit.vat / deposit.net, exact remainder when the deposit is used up).
- R6 One deposit per PO in v1 created from the PO; deposits registered the old way remain valid and are selectable in the receive dialog as today.
- R7 A fully received PO behaves exactly as today for everything downstream (tax-invoice matching, credit notes). A partially received PO is **not eligible** for tax-invoice linking until fully received (the eligibility check already requires status `received`).

## 4. Data model (all additive; nothing existing is dropped)

- `purchase_orders.status` CHECK gains `partially_received`. `purchase_orders.expense_id` stays as the link to the *first* bill for legacy and display; the real link is `expenses.po_id` (already exists) — a PO may now have many bills.
- New `po_receipts` (id, tenant_id, po_id, received_date date, received_by text, notes, created_at) and `po_receipt_items` (id, tenant_id, receipt_id, po_item_id, UNIQUE(po_item_id) so a line can be received once; quantity = the line quantity at receipt time, line_total snapshot, base quantity posted to stock). RLS tenant-scoped like the deposit tables; clients read, only SECURITY DEFINER RPCs write.
- `supplier_deposits` gains optional `po_id` (the PO the deposit was created for) and `pct_of_po numeric` (NULL for deposits registered the old way). The existing guard that rejects registering a PO-generated expense stays; deposits created from a PO are created by the new RPC which inserts the expense (not flagged `po_generated`) and the deposit row together.
- `po_deposit_applications` gains `receipt_id` (nullable for old rows) so a deduction is tied to the receipt that used it.
- Stock movements keep `reference_type='purchase_order'`, `reference_id = PO id` (so the tax-invoice reversal logic keeps reading the PO's real receipt movements) and are inserted with `created_at` = received date at 12:00 Bangkok; `notes` carry the receipt number.

## 5. Server functions

- `create_po_deposit(p_po_id, p_mode 'percent'|'amount', p_value, p_invoice_no, p_date, p_payment_method)` — validates tenant/role/`tenant_can_write()`, locks the PO, one deposit per PO, deposit ≤ PO total, computes the VAT split from the PO's VAT mode, inserts the expense (paid or as chosen) + `supplier_deposits` row atomically; returns ids.
- `receive_po_lines(p_po_id, p_line_ids uuid[], p_received_date date, p_deduction jsonb, p_expected_subtotal numeric, p_expected_vat numeric)` — locks the PO and deposit rows in a fixed order; rejects already received lines; computes the receipt value from the stored lines; applies the deduction (percent or value → satang, VAT proportional); inserts the receipt + items, the bill expense (net of deduction; none when fully covered, as today), the deposit application, the stock movements (through the same helper used today), sets PO status `received` when all lines are received else `partially_received`, `received_date` = latest receipt date. Replaces `receive_po_with_deposits` for the new client; the old function stays until the old client is gone.
- `split_payment(p_expense_id, p_amount, p_paid_date, p_method)` — only for a `pending` bill; creates the split described in R3 atomically, refuses amounts ≤ 0 or ≥ the bill, keeps VAT split proportional, and refuses on expenses that are credit-note rows or locked deposit rows.
- All three: SECURITY DEFINER, `SET search_path`, REVOKE FROM PUBLIC/anon, GRANT to authenticated, tenant from `current_tenant_id()`, role gate like `receive_po_with_deposits`, error codes mapped to Thai text, SQL tests in one rolled-back transaction ending in `RAISE EXCEPTION 'RESULT …'`.

## 6. UI

- PO list row: primary action stays visible per status where the screen has room, everything else in a 3-dot menu: *รับของ*, *ดู PO*, *สร้างใบจ่ายมัดจำ*, *แก้ไข*, *ยกเลิก/ลบ* (same permission gating and the same locks as today: deposit-locked, tax-invoice-locked, received POs).
- *ดู PO* popup: lines with ordered / received / outstanding, receipts with dates, deposit (amount, % of PO, used, **remaining**), bills (paid/pending), totals.
- *รับของ* popup: the PO header, radio **รับทั้งหมด / รับบางรายการ** (the second shows a checkbox per outstanding line with its value), **วันที่รับสินค้า** (default today Bangkok), the deduction block (percent | value, remaining deposit shown, preview "บิลที่จะสร้าง: ก่อน VAT x · VAT y · ยอดชำระ z" or "ไม่สร้างบิล (หักครบ)"), confirm disabled while loading and while busy (same guards as the shipped dialog).
- Bill row on Expenses: *จ่ายบางส่วน* action (split) for pending bills.
- Manual: the full manual and quick-start get a section after release (not part of v1 code).

## 7. Error handling and safety

- Everything above runs in one transaction per action; a failure leaves no partial state; double clicks serialise on the PO row lock.
- Totals guard as in the shipped RPC: client sends the expected subtotal/VAT; mismatch → `totals_mismatch`.
- Edit/cancel of a PO with receipts or a deposit is refused server-side by trigger (extend the existing deposit/tax-invoice triggers) because the PO edit path is non-atomic.
- Negative stock is not created by receipts (they add stock); tax-invoice matching later reverses only real receipt movements.

## 8. Migration of existing data

- Existing received POs get no `po_receipts` rows (nothing to backfill; the detail popup shows legacy receipts from `purchase_orders.received_date`).
- **ไทย-เยอรมัน correction** (PO2610-038): a one-off SQL, owner-approved separately: register deposit 2602543 for that PO, record the application (103,365.00 + 7,235.55), set bill 2603202 to 110,600.55 (103,365.00 + 7,235.55).

## 9. Testing

Pure JS (vitest): deduction split (percent/value/default proportional/last-receipt remainder), receipt value from lines, split-payment maths (VAT proportional, satang), line selection. SQL: rolled-back test transaction covering create deposit, receive all, receive some then rest, deduction caps, deposit used up (exact VAT), double click, tenant isolation, role denial, tax-invoice and credit-note interplay, split payment, locks. UI: render harness with real CSS (3-dot menu, popups, mobile width). Whole-branch review by the strongest model before the owner applies migrations; dry run in one transaction first, apply per file with `BEGIN; SET LOCAL lock_timeout`.

## 10. Open items for the owner

1. Confirm R3 (split = partial payment) or ask for a payments table.
2. Confirm R4 default deduction (proportional to the receipt's share of the PO, whole remainder on the last receipt).
3. Confirm "one deposit per PO from the PO" for v1.
