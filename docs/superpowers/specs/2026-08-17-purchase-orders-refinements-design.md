# Purchase Orders — Post-Review Refinements — Design

## Problem

The Phase 1 Purchase Orders feature (see `docs/superpowers/specs/2026-08-17-purchase-orders-design.md` and its implementation, branch `worktree-purchase-orders`) was built and passed code-level review, but had never been exercised in a live browser until now. After a manual click-through, six gaps surfaced:

1. No way to say whether a PO's total is VAT-inclusive.
2. The printable PO document has no signature space.
3. No way to attach a supplier's own quotation/reference file to a PO.
4. Selecting a credit-terms supplier doesn't change the payment-method default away from "โอน" (transfer), in either the PO receive-flow or the manual expense form.
5. The Expenses summary doesn't surface how much money is sitting in `awaiting_billing` status.
6. Deleting an expense that was auto-created from a received PO leaves the PO's `expense_id` pointing at nothing, with no prompt to reconcile.

This spec covers all six as one refinement pass on the already-shipped feature, rather than a new feature.

## Background / decisions already made

- **VAT is a per-PO choice, not per-item.** Line-item `unit_price`/`line_total` always mean pre-VAT; the toggle only controls whether VAT is added on top of the summed subtotal when computing the PO's grand total and the auto-created expense's amounts. Mirrors the exact pattern already used by `sites.has_vat`/`contract_value_no_vat` in `Sites.jsx` — same `VAT_RATE = 0.07` constant, same rounding (`Math.round(x * VAT_RATE * 100) / 100`), reused rather than reinvented.
- **Attachments are reference-only.** Uploaded files (supplier quotations, product photos) are stored for viewing/downloading — never parsed, never used to populate PO fields. This is explicitly narrower than "import a PO from a file," which was considered and rejected as unnecessary scope.
- **Attachments are a child table, not a JSON/array column** — matches this codebase's existing 1-to-many convention (`purchase_order_items`, `site_phases`, etc.), each row carrying its own `tenant_id` per the established pattern rather than relying solely on a parent join.
- **Credit-default fix applies in two places**, both because they were both raised as the same underlying complaint: the PO receive-flow (Item 4a) and the manual "+เพิ่มรายจ่าย" form on the Expenses page (Item 4b). Both already correctly *restrict* the payment-method dropdown when a supplier has no credit (shipped in the prior branch) — neither currently *upgrades* the default when a supplier does have credit, which is the gap.
- **Delete-then-reconcile, not block-until-resolved.** Deleting a PO-linked expense proceeds immediately (unchanged from current behavior); a follow-up dialog then asks how to reconcile the now-dangling PO reference. This was chosen over blocking the delete because the delete itself is not the risky part — leaving the PO's state stale afterward is.

## 1. VAT Toggle

**Data model** — add one column to the existing `purchase_orders` table:

```sql
ALTER TABLE purchase_orders ADD COLUMN has_vat BOOLEAN NOT NULL DEFAULT true;
```

No new column needed on `purchase_order_items` — VAT is computed once, at the header level, over the summed subtotal.

**Form (`PurchaseOrderForm` in `PurchaseOrders.jsx`)** — a toggle (checkbox or radio, matching `Sites.jsx`'s existing `has_vat` control style) near the item editor. Below the running total, show:

```
รวมก่อน VAT      6,450.00
VAT (7%)           451.50   ← shown only when has_vat
รวมสุทธิ          6,901.50   ← subtotal, or subtotal+vat if has_vat
```

using the same `VAT_RATE = 0.07` constant and rounding already defined in `Sites.jsx` (import/duplicate the constant into `PurchaseOrders.jsx`, matching how each page in this codebase currently keeps its own copy of small page-local constants rather than sharing a `lib/` module for a single float).

**Document view (`PODocumentModal`)** — same three-line breakdown appended below the items table, before the signature block (see Item 2).

**Receive flow (`handleReceive`)** — replaces the current single `amount: total` field with:

```js
const subtotal = (receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
const vatAmount = receiveRow.has_vat ? Math.round(subtotal * VAT_RATE * 100) / 100 : 0
const amount = Math.round((subtotal + vatAmount) * 100) / 100
// expensePayload: amount_no_vat: subtotal, vat: vatAmount, amount
```

`expenses.amount_no_vat`/`expenses.vat` already exist (added in earlier work, nullable) — no expense-table migration needed for this item.

## 2. Signature Blocks on PDF

Add to `PODocumentModal`, immediately after the totals block and before the closing `</div>`:

```jsx
<div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, textAlign: 'center', fontSize: 12 }}>
  <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้จัดทำ</div>
  <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้อนุมัติ</div>
</div>
```

Identical structure to `LaborContractors.jsx`'s `PaymentModal` PDF signature block — copied, not reinvented.

## 3. File Attachments

**Data model:**

```sql
CREATE TABLE purchase_order_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id       UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,      -- path within the Storage bucket
  file_name   TEXT NOT NULL,      -- original filename, for display
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_po_attachments_po_id ON purchase_order_attachments(po_id);
CREATE INDEX idx_po_attachments_tenant_id ON purchase_order_attachments(tenant_id);

ALTER TABLE purchase_order_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON purchase_order_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
```

Same RLS shape as every other `purchase_orders`-module table.

**Storage** — new private bucket `po-attachments` (this app's first use of Supabase Storage). Files are stored under a tenant-prefixed path (`{tenant_id}/{po_id}/{filename}`) so bucket-level RLS can enforce tenant isolation independently of the `purchase_order_attachments` table's own RLS — belt-and-suspenders, since a Storage bucket's access policy is a separate security boundary from table RLS:

```sql
CREATE POLICY po_attachments_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'po-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  )
  WITH CHECK (
    bucket_id = 'po-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  );
```

**UI** — in the PO Add/Edit modal, below the notes field: a file input (accepts PDF/Excel/images — no strict MIME allowlist beyond what the browser's `accept` attribute suggests, since this is reference storage, not a parsed import), uploading immediately on selection (not deferred to form save, since the PO may not have an `id` yet on create — upload is only enabled once editing an existing PO, i.e. after the first save; on create, the file section shows a "บันทึกใบสั่งซื้อก่อน จึงจะแนบไฟล์ได้" hint instead of the uploader). Uploaded files list as name + download link + a remove (✕) button, matching the visual density of `ItemsEditor`'s rows.

## 4. Credit-Supplier Payment-Method Default

**4a. PO receive-flow (`handleReceive` in `PurchaseOrders.jsx`):**

`usePurchaseOrders`'s supplier select needs `credit_days` added: `suppliers(name, supplier_number, credit_days)`.

```js
const supplierHasCredit = receiveRow.suppliers?.credit_days != null
const payment_method = supplierHasCredit ? 'check' : 'transfer'
const status = supplierHasCredit ? 'awaiting_billing' : 'pending'
```

replacing the current hardcoded `payment_method: 'transfer', status: 'pending'`.

**4b. Manual expense form (`ExpenseForm` in `Expenses.jsx`):** in the Supplier field's `onChange` (already modified once in the prior branch to *downgrade* `payment_method` away from `check`/`credit` when the new supplier has no credit terms), add the mirror case — upgrade the default when the new supplier does have credit and the form is still at its untouched default:

```js
onChange={id => {
  const sup = suppliers.find(s => s.id === id)
  const hasCredit = !sup || sup.credit_days != null
  setForm(f => ({
    ...f,
    supplier_id: id,
    supplier: sup ? sup.name : (id ? f.supplier : ''),
    payment_method: !hasCredit && (f.payment_method === 'check' || f.payment_method === 'credit')
      ? 'transfer'
      : (hasCredit && sup && f.payment_method === 'transfer') ? 'check' : f.payment_method,
  }))
}}
```

"Untouched default" is operationalized as `f.payment_method === 'transfer'` — `'transfer'` is `EMPTY_FORM`'s initial value, so this only fires on a field the user hasn't deliberately changed away from the default. If the user picks `'cash'` explicitly, selecting a credit supplier afterward leaves `'cash'` alone (not `'transfer'`, so the upgrade condition doesn't match) — correct, since `'cash'` was a deliberate choice, not the untouched default.

## 5. "รอวางบิล" KPI Tile

In `Expenses.jsx`, alongside the existing `totalPaid`/`totalPending` computations:

```js
const totalAwaitingBilling = useMemo(
  () => (expenses || []).filter(e => e.status === 'awaiting_billing').reduce((s, e) => s + (e.amount || 0), 0),
  [expenses]
)
```

New KPI card in the existing KPI row, same `kpi-card kpi-sm` styling as the other four, using the `.badge-awaiting_billing` yellow tint already defined:

```jsx
<div className="kpi-card kpi-sm yellow"><div className="kpi-label">รอวางบิล</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalAwaitingBilling)}</div></div>
```

`totalPending`'s existing filter (`status === 'pending' || status === 'check_issued'`) is unchanged — `awaiting_billing` stays a distinct, separately-visible number rather than being folded in.

## 6. Delete-Reconciliation for PO-Linked Expenses

In `Expenses.jsx`'s `handleDelete`:

```js
const handleDelete = async () => {
  if (!deleteId) return
  const row = expenses.find(e => e.id === deleteId)
  const { error } = await supabase.from('expenses').delete().eq('id', deleteId)
  if (error) { alert('Error: ' + error.message); return }
  setDeleteId(null); refetch(); showToast('ลบแล้ว')
  if (row?.po_id) setReconcilePoId(row.po_id)   // triggers the follow-up dialog
}
```

New state `reconcilePoId`, and a follow-up modal (not `ConfirmDialog` — needs two named action buttons, not one confirm/one cancel):

```jsx
{reconcilePoId && (
  <Modal title="ใบสั่งซื้ออ้างอิงยังอยู่" onClose={() => setReconcilePoId(null)} maxWidth={420}>
    <div className="modal-body">
      <p style={{ color: 'var(--text2)' }}>รายจ่ายที่ลบไปมาจากใบสั่งซื้อนี้ — ต้องการปรับสถานะใบสั่งซื้ออย่างไร?</p>
    </div>
    <div className="modal-footer">
      <button className="btn btn-ghost" onClick={async () => {
        await supabase.from('purchase_orders').update({ status: 'ordered', received_date: null, expense_id: null }).eq('id', reconcilePoId)
        setReconcilePoId(null)
      }}>กลับไปเป็นยังไม่รับของ</button>
      <button className="btn btn-danger" onClick={async () => {
        await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', reconcilePoId)
        setReconcilePoId(null)
      }}>ยกเลิกใบสั่งซื้อ</button>
    </div>
  </Modal>
)}
```

`purchase_orders.expense_id` already has `ON DELETE SET NULL` (set in Task 1's migration), so deleting the expense doesn't fail and auto-nulls the PO's `expense_id` reference — no dangling FK. What it does *not* fix is the PO's `status`, which stays `'received'` even though the expense that justified that status is gone. This dialog's job is purely to correct `status` (and `received_date`, for the revert path) — the FK cleanup already happens for free.

## Out of Scope

- Parsing uploaded attachment files (Item 3) — reference-only, confirmed explicitly.
- A "revert" for the reconciliation choice in Item 6 (once you pick cancel-or-revert, that's final — no undo).
- Editing `has_vat` after a PO has been received (once an expense exists from it, VAT is baked into that expense's own `amount_no_vat`/`vat`; changing the PO's `has_vat` afterward wouldn't retroactively update the expense).
- A default `has_vat` sourced from the supplier or site — always defaults to `true` (Thai business norm), user unchecks per-PO when not applicable, same UX as `Sites.jsx`.

## Testing

Same verification approach as the rest of this session: schema/RLS checks via `execute_sql`/`get_advisors`, code-level tracing, plus this time an actual manual click-through in the browser (the gap that surfaced all six of these items in the first place) — create a PO with VAT on and off, attach and remove a file, receive a PO from a credit supplier and confirm `check`/`awaiting_billing` defaults, check the new KPI tile total matches a manually-summed `awaiting_billing` row set, delete a PO-linked expense and confirm both reconciliation paths update the PO correctly.
