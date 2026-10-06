# Supplier tax invoice matching (many POs ↔ one invoice, stock from the invoice) — design

Date: 2026-10-06 · Status: draft for owner review · Written on branch `worktree-supplier-credit-note-peak-export` (docs only)

## Intent (owner, 2026-10-06)
- A supplier (e.g. ช.เจริญกลาส) delivers against POs/delivery notes during the month, then issues **one consolidated tax invoice** whose **items do not match the POs' items**.
- After matching: **the expenses stay as they are** (site/category cost, amounts unchanged); **stock enters when the tax invoice is keyed**, from the invoice's own lines.
- Chosen approach (owner, option "ข"): the stock already posted when the POs were received is **reversed**, then the invoice lines are posted. It must be **error-free** (atomic, no half state).
- The supplier has been asked to issue invoices in the month the goods were ordered; the design uses the month to propose and cross-check POs.

## What exists today (verified in code, 2026-10-06)
- `SwapTaxInvoiceModal` (PurchaseOrders.jsx): one PO only; compares the scanned invoice total (ex-VAT) with that PO's expense within 1% / 5 baht; writes only `expenses.invoice_no` and `notes`; never touches stock; items are not matched. Receiving a PO posts `purchase_in` movements from the PO's own items (`reference_type='purchase_order'`, `reference_id=<po id>`).
- So the existing swap cannot do: several POs per invoice, item mismatch handling, or stock from the invoice.

## Scope
New document **ใบกำกับภาษีผู้ขาย** (supplier tax invoice): header + its own lines + a set of linked POs. Posting it (a) checks the match, (b) reverses the stock of the linked POs, (c) posts the invoice lines as stock, (d) stamps the invoice number on the linked POs' expenses. Void undoes all of it.
Non-goals: item-by-item PO matching; changing expense amounts/sites; PEAK export of this document (expenses export as today); credit notes against it (use the credit-note feature).

## Data model (additive, no columns on `expenses`)
- `supplier_tax_invoices` (id, tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total, match_diff, match_note, status `draft|posted|void`, created_by, created_at, posted_at). Unique `(tenant_id, supplier_id, invoice_no)` where status ≠ void.
- `supplier_tax_invoice_items` (invoice_id, description, qty, unit, unit_price, amount, `inventory_item_id` (null = not stock), `site_id`, `base_qty`, `base_unit_cost`) — base qty/cost computed client-side with the same conversion used when receiving a PO (`computePoItemBaseQty`), validated > 0 by the RPC.
- `supplier_tax_invoice_pos` (invoice_id, po_id UNIQUE) — a PO belongs to at most one non-void invoice.
- `supplier_tax_invoice_reversals` (invoice_id, po_id, inventory_item_id, site_id, quantity, unit_cost) — exactly what was reversed, so a void can restore it.
- RLS/lock/validation triggers, grants and tenant checks follow the credit-note migrations (client may only create drafts; posting/void only through RPCs).

## Match rule
- Compare the invoice **net before VAT** with Σ **PO goods value (ex-VAT subtotal)** of the linked POs (not the expense amounts, so deposit-paid POs still compare correctly).
- Difference ≤ max(1%, 5 baht): pass. Larger: allowed only with a typed `match_note` (reason) and shown in red; stored as `match_diff`. (Tolerance values are an open item.)
- The picker proposes the supplier's received POs of the invoice month that are not linked yet; POs outside the month can be added with a warning; a list "POs of this supplier this month not linked" is shown so nothing is silently left out.

## Posting RPC `post_supplier_tax_invoice(p_id)` — atomic, definer, tenant/role checked
1. Lock the invoice (`draft` else `not_draft`); require ≥1 line and ≥1 PO.
2. Each linked PO must be the same supplier, `received`, not linked elsewhere, and not already reversed (`po_already_reversed`).
3. Match check as above (`match_note` required beyond tolerance).
4. **Order matters to avoid errors:** first post the invoice lines (`purchase_in`, dated the invoice date, `reference_type='supplier_tax_invoice'`), then reverse each linked PO's receipt movements with a new movement type `receipt_reversal` that removes the original quantity at the original cost with the exact weighted-average inverse `new_wac = (q·wac − r·cost)/(q − r)` (wac unchanged when the balance reaches 0). A reversal may take a balance below zero when stock was already consumed by COGS deductions; this is **allowed, never an exception**, and flagged in the preview and the result. Because lines are posted first, the common case (invoice quantity ≥ PO quantity) never goes negative.
5. Record the reversed rows in `supplier_tax_invoice_reversals`; stamp the invoice no. on each linked PO's expense (`invoice_no`, previous value appended to `notes`; amounts untouched); mark the invoice `posted`.
- Preview RPC `preview_supplier_tax_invoice(p_id)` (read-only) returns, per stock item: balance before, + invoice qty, − reversed PO qty, balance after, and warnings (negative result, PO without receipt movements, PO already reversed). The UI shows it before the confirm warning dialog.
- Void `void_supplier_tax_invoice(p_id)`: reverse the invoice's movements (exact inverse, same rules), re-post the reversed PO movements from `supplier_tax_invoice_reversals`, restore the expenses' invoice_no from the note trail, mark `void`.

## UI
New page under รายจ่าย (module-gated like POs): choose supplier → invoice header (or scan the invoice with the existing extraction to prefill lines) → pick POs (month-filtered, multi-select, running Σ vs invoice net) → map each invoice line to a stock item (picker with inline-create, or "ไม่ใช่สต็อก") → preview table → post with a warning dialog (states: stock added, stock reversed from N POs, any negative balance, expenses unchanged but stamped with the invoice number, undo = void only).
PO list/detail shows "ใบกำกับ <no>" on linked POs; the old single-PO swap stays for the simple case.

## Testing
- vitest (pure): match tolerance, month proposal, exact WAC inverse (incl. balance → 0), base-qty mapping, preview math with negative-balance cases.
- SQL test script (BEGIN … ROLLBACK, house style): post with 2 POs and different items; invoice posted before reversal so no error when stock suffices; reversal below zero allowed and reported; PO linked twice rejected; second post `not_draft`; void restores balances/WAC and expenses; expense amounts never change; cross-tenant; client cannot forge posted state.
- Live verification by the owner on one real monthly invoice (ช.เจริญกลาส) before relying on it.

## Open items for the owner
1. Match tolerance (default 1% / 5 baht, same as the current swap) and whether a bigger difference needs a reason only or a block.
2. Negative stock after reversal: allow with warning (proposed) or block.
3. Whether POs of this kind should be flagged at creation as "stock from invoice" so receiving them does not post stock at all in future (would remove the reversal step for new POs; not needed for the history).
4. Sequencing against the PO deposit feature (both touch `PurchaseOrders.jsx` and the receive flow).
