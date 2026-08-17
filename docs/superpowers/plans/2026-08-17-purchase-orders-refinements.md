# Purchase Orders — Post-Review Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six gaps found during the first live browser test of Purchase Orders: a per-PO VAT toggle, PDF signature blocks, reference-only file attachments, credit-supplier payment-method defaults (PO receive-flow + manual expense form), an "awaiting_billing" KPI tile on Expenses, and a reconciliation dialog for deleting a PO-linked expense.

**Architecture:** All changes are confined to `src/pages/PurchaseOrders.jsx`, `src/pages/Expenses.jsx`, `src/hooks/useSupabase.js`, plus three new/modified Supabase migrations (one column, one new child table + Storage bucket, no table changes for items 2/4/5/6 beyond what's already there). No new files except the migrations — this keeps the diff reviewable against the six items it maps to.

**Tech Stack:** React 18 (function components, hooks), Supabase Postgres + PostgREST + Storage via `@supabase/supabase-js`, `html2pdf.js` via the existing `downloadPDF()` helper. No automated JS test suite covers UI flows in this repo (Vitest covers pure logic only, per the prior branch) — verification is manual dev-server click-through plus Supabase MCP schema/Storage checks.

## Global Constraints

- Full design context: `docs/superpowers/specs/2026-08-17-purchase-orders-refinements-design.md` — read it before starting if anything below is ambiguous.
- Dev server: run from this worktree with `npm run dev -- --port 5174` (5173 may be occupied by a different worktree — check `lsof -i :5173` first).
- Supabase project id: `yyzbgdmgyvvypfcjuhtr`.
- Apply migrations with `mcp__plugin_supabase_supabase__apply_migration`, then mirror into `supabase/schema.sql` by hand, matching this repo's established convention.
- Migration naming continues this branch's existing sequence — the last one is `2026-08-17-04-expenses-po-id.sql`, so this plan starts at `2026-08-17-05-...`. **Before Task 1, run `ls supabase/migrations/ | sort | tail -3` — if a `-05` already exists (merged from elsewhere), renumber to the next free slot, exactly as this branch's own earlier tasks already had to do twice.**
- `VAT_RATE = 0.07` is a page-local constant already duplicated per-page in this codebase (see `Sites.jsx`) — add a second copy in `PurchaseOrders.jsx` rather than extracting a shared module; that matches existing convention and is out of this plan's scope to change.
- No dedicated Supabase mutation hooks — every write is a direct `supabase.from(...)`/`supabase.storage.from(...)` call inside the component, matching every other page in this codebase.
- `auditLog(tableName, recordId, action, oldValues, newValues)` from `src/lib/audit.js` is called after every insert/update on `purchase_orders`/`expenses` already — keep that pattern for any new write this plan adds to those two tables. Attachment uploads/deletes do not need `auditLog` calls (no other file-storage operation in this codebase logs to `audit_logs`, and the design spec doesn't require it).

---

### Task 1: Migration — `purchase_orders.has_vat` column

**Files:**
- Create: `supabase/migrations/2026-08-17-05-purchase-orders-has-vat.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `purchase_orders.has_vat BOOLEAN NOT NULL DEFAULT true`. Tasks 3 and 6 (VAT UI, receive-flow) read/write this column.

- [ ] **Step 1: Write and apply the migration**

```sql
-- supabase/migrations/2026-08-17-05-purchase-orders-has-vat.sql
-- Per-PO VAT toggle. Mirrors sites.has_vat exactly: line-item prices are
-- always pre-VAT; this only controls whether VAT is added on top of the
-- summed subtotal when computing the PO's grand total and the
-- auto-created expense's amounts.
ALTER TABLE purchase_orders ADD COLUMN has_vat BOOLEAN NOT NULL DEFAULT true;
```

Apply via `mcp__plugin_supabase_supabase__apply_migration`, `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "purchase_orders_has_vat"`.

- [ ] **Step 2: Verify**

```sql
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name = 'purchase_orders' AND column_name = 'has_vat';
```

Expected: `boolean`, default `true`.

- [ ] **Step 3: Update `supabase/schema.sql`**

In the `CREATE TABLE purchase_orders` block, add `has_vat BOOLEAN NOT NULL DEFAULT true,` (placed after `status`, before `notes` — matching the migration's intent of a header-level flag alongside other PO metadata).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-08-17-05-purchase-orders-has-vat.sql supabase/schema.sql
git commit -m "feat: add has_vat column to purchase_orders"
```

---

### Task 2: Migration — `purchase_order_attachments` table + Storage bucket

**Files:**
- Create: `supabase/migrations/2026-08-17-06-purchase-order-attachments.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `purchase_order_attachments` table and a private `po-attachments` Storage bucket with tenant-scoped RLS. Task 5 (attachment UI) reads/writes both.

- [ ] **Step 1: Write and apply the migration**

```sql
-- supabase/migrations/2026-08-17-06-purchase-order-attachments.sql
-- Reference-only file attachments for a PO (supplier quotations, product
-- photos) — never parsed, just stored for viewing/downloading. First use
-- of Supabase Storage in this app: files live in a private bucket under
-- a tenant-prefixed path so bucket RLS can enforce isolation
-- independently of the attachments table's own RLS.

CREATE TABLE purchase_order_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id       UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_po_attachments_po_id ON purchase_order_attachments(po_id);
CREATE INDEX idx_po_attachments_tenant_id ON purchase_order_attachments(tenant_id);

ALTER TABLE purchase_order_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON purchase_order_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

INSERT INTO storage.buckets (id, name, public) VALUES ('po-attachments', 'po-attachments', false)
ON CONFLICT (id) DO NOTHING;

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

Apply via `mcp__plugin_supabase_supabase__apply_migration`, `name: "purchase_order_attachments"`.

- [ ] **Step 2: Verify**

```sql
SELECT table_name FROM information_schema.tables WHERE table_name = 'purchase_order_attachments';
SELECT policyname, tablename, qual FROM pg_policies WHERE tablename = 'purchase_order_attachments' OR (tablename = 'objects' AND policyname = 'po_attachments_tenant_access');
SELECT id, public FROM storage.buckets WHERE id = 'po-attachments';
```

Expected: table exists with RLS; one `admin_full_access` policy on `purchase_order_attachments`; one `po_attachments_tenant_access` policy on `storage.objects`; bucket exists with `public = false`.

Also run `mcp__plugin_supabase_supabase__get_advisors` with `type: "security"` and confirm no new advisory names `po-attachments` or `purchase_order_attachments` (a public bucket or a missing RLS policy would surface here).

- [ ] **Step 3: Update `supabase/schema.sql`**

Add a new `-- PURCHASE_ORDER_ATTACHMENTS` section (same structure as `purchase_order_items`) immediately after the existing `PURCHASE_ORDERS` section. Storage bucket/policy DDL is infrastructure, not part of the table-by-table schema narrative this file otherwise follows — add it as a short trailing comment block noting the bucket name and that its policy lives in the migration (this file doesn't currently document any other Storage bucket, so there's no existing pattern to match beyond keeping it minimal).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-08-17-06-purchase-order-attachments.sql supabase/schema.sql
git commit -m "feat: add purchase order file attachments (table + Storage bucket)"
```

---

### Task 3: VAT toggle — PO form, document, and receive-flow

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Consumes: `purchase_orders.has_vat` (Task 1).
- Produces: `VAT_RATE` constant and `calcPoTotals(items, hasVat)` helper — a small local function returning `{ subtotal, vat, total }`, used by `ItemsEditor`, `PODocumentModal`, the list row, and `handleReceive` so the VAT math is written once in this file even though it's called from four places (per the design spec's DRY note on the existing pre-VAT total duplication).

- [ ] **Step 1: Add `VAT_RATE` and `calcPoTotals`**

In `src/pages/PurchaseOrders.jsx`, immediately after `lineTotal`:

```js
const VAT_RATE = 0.07

function calcPoTotals(items, hasVat) {
  const subtotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : lineTotal(it)), 0)
  const vat = hasVat ? Math.round(subtotal * VAT_RATE * 100) / 100 : 0
  const total = Math.round((subtotal + vat) * 100) / 100
  return { subtotal, vat, total }
}
```

Note: `it.line_total != null ? it.line_total : lineTotal(it)` handles both shapes this function is called with — stored `purchase_order_items` rows (have `line_total`) and the form's live `items` array (strings, needs `lineTotal()`).

- [ ] **Step 2: Add the VAT toggle to `PurchaseOrderForm` and update `EMPTY_FORM`**

Replace:

```js
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', notes: '', items: [{ ...EMPTY_ITEM }] }
```

with:

```js
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', has_vat: true, notes: '', items: [{ ...EMPTY_ITEM }] }
```

In `PurchaseOrderForm`, replace the `<ItemsEditor .../>` line and everything until the notes field:

```jsx
        <ItemsEditor items={form.items} onChange={items => set('items', items)} />
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
```

with:

```jsx
        <ItemsEditor items={form.items} onChange={items => set('items', items)} />
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              รวม VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="po-has-vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          {(() => {
            const { subtotal, vat, total } = calcPoTotals(form.items, form.has_vat)
            return (
              <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมก่อน VAT</span><span className="font-mono">{fmt(subtotal)}</span></div>
                {form.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(vat)}</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมสุทธิ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
              </div>
            )
          })()}
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
```

`fmt` is already imported in this file (from `../lib/supabase.js`).

- [ ] **Step 3: Persist `has_vat` in `handleSave` and `editFormInitial`**

In the `PurchaseOrders` component, replace:

```js
      const poPayload = {
        site_id: form.site_id, supplier_id: form.supplier_id, category_id: form.category_id,
        date: form.date, notes: form.notes || null,
      }
```

with:

```js
      const poPayload = {
        site_id: form.site_id, supplier_id: form.supplier_id, category_id: form.category_id,
        date: form.date, has_vat: form.has_vat, notes: form.notes || null,
      }
```

Replace:

```js
    return {
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, notes: editRow.notes || '',
```

with:

```js
    return {
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, has_vat: editRow.has_vat, notes: editRow.notes || '',
```

- [ ] **Step 4: Show VAT-aware totals in the document view and the list row**

In `PODocumentModal`, replace:

```jsx
function PODocumentModal({ po, onClose }) {
  const items = po.purchase_order_items || []
  const total = items.reduce((s, it) => s + (it.line_total || 0), 0)
```

with:

```jsx
function PODocumentModal({ po, onClose }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat)
```

Replace the `<tfoot>` block:

```jsx
            <tfoot>
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '2px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '2px solid #111' }}>{fmt(total)} บาท</td>
              </tr>
            </tfoot>
```

with:

```jsx
            <tfoot>
              <tr>
                <td colSpan={3} style={{ padding: '6px 4px', borderTop: '2px solid #111' }}>รวมก่อน VAT</td>
                <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: '2px solid #111' }}>{fmt(subtotal)}</td>
              </tr>
              {po.has_vat && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px' }}>VAT (7%)</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(vat)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(total)} บาท</td>
              </tr>
            </tfoot>
```

In the main component's table row rendering, replace:

```jsx
              {(pos || []).map(po => {
                const total = (po.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
                return (
```

with:

```jsx
              {(pos || []).map(po => {
                const { total } = calcPoTotals(po.purchase_order_items, po.has_vat)
                return (
```

- [ ] **Step 5: Use VAT-aware totals in the receive flow**

Replace:

```js
  const handleReceive = async () => {
    if (!receiveRow || receiving) return
    setReceiving(true)
    const total = (receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
    try {
      const expensePayload = {
        date: new Date().toISOString().slice(0, 10),
        description: `จากใบสั่งซื้อ ${receiveRow.po_number}`,
        site_id: receiveRow.site_id,
        category_id: receiveRow.category_id,
        supplier_id: receiveRow.supplier_id,
        supplier: receiveRow.suppliers?.name || null,
        amount: total,
```

with:

```js
  const handleReceive = async () => {
    if (!receiveRow || receiving) return
    setReceiving(true)
    const { subtotal, vat, total } = calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat)
    try {
      const expensePayload = {
        date: new Date().toISOString().slice(0, 10),
        description: `จากใบสั่งซื้อ ${receiveRow.po_number}`,
        site_id: receiveRow.site_id,
        category_id: receiveRow.category_id,
        supplier_id: receiveRow.supplier_id,
        supplier: receiveRow.suppliers?.name || null,
        amount_no_vat: subtotal,
        vat: vat,
        amount: total,
```

Also update the receive `ConfirmDialog`'s message, which independently recomputes the total today. Replace:

```jsx
          message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt((receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0))} บาท?`}
```

with:

```jsx
          message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt(calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat).total)} บาท?`}
```

- [ ] **Step 6: Manual verification**

Run the dev server. Create a PO with 2+ items, toggle VAT on/off, confirm the subtotal/VAT/total breakdown updates live in the form. Save with VAT on, confirm the list row and document view show the VAT-inclusive total, and the document's totals table shows the subtotal/VAT/grand-total breakdown. Receive it, confirm the created expense's `amount_no_vat`/`vat`/`amount` match the PO's breakdown (check via the Expenses page or `execute_sql`). Repeat for a PO with VAT off and confirm no VAT line appears anywhere and `vat = 0`.

- [ ] **Step 7: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "feat: add per-PO VAT toggle to form, document, and receive flow"
```

---

### Task 4: PDF signature blocks

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:** none — self-contained UI addition to `PODocumentModal`.

- [ ] **Step 1: Add the signature block**

In `PODocumentModal`, immediately before the closing `</div>` of the `id={`po-doc-${po.id}`}` element (right after the `</table>` from the items, now followed by the `<tfoot>` totals from Task 3 — the signature block goes after the whole `<table>` closes):

```jsx
          <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, textAlign: 'center', fontSize: 12 }}>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้จัดทำ</div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้อนุมัติ</div>
          </div>
```

- [ ] **Step 2: Manual verification**

Open a PO's document view, confirm the two signature lines appear below the totals, download the PDF and confirm they render in the exported file too.

- [ ] **Step 3: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "feat: add signature blocks to PO PDF document"
```

---

### Task 5: File attachments — upload/list/download/remove UI

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Consumes: `purchase_order_attachments` table and `po-attachments` bucket (Task 2).
- Produces: `AttachmentsSection` component, rendered inside the Add/Edit modal only when editing an existing PO (`editRow` is set) — matches the design spec's decision that uploads need a `po_id` to exist first.

- [ ] **Step 1: Add the `AttachmentsSection` component**

Insert after `PurchaseOrderForm`, before `PODocumentModal`:

```jsx
function AttachmentsSection({ poId, tenantId }) {
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('purchase_order_attachments').select('*').eq('po_id', poId).order('uploaded_at')
    setAttachments(data || [])
  }
  useEffect(() => { load() }, [poId])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const filePath = `${tenantId}/${poId}/${Date.now()}-${file.name}`
      const { error: upErr } = await supabase.storage.from('po-attachments').upload(filePath, file)
      if (upErr) throw upErr
      const { error: dbErr } = await supabase.from('purchase_order_attachments').insert({ po_id: poId, file_path: filePath, file_name: file.name })
      if (dbErr) throw dbErr
      await load()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDownload = async (att) => {
    const { data, error } = await supabase.storage.from('po-attachments').createSignedUrl(att.file_path, 60)
    if (error) { alert('Error: ' + error.message); return }
    window.open(data.signedUrl, '_blank')
  }

  const handleRemove = async (att) => {
    await supabase.storage.from('po-attachments').remove([att.file_path])
    await supabase.from('purchase_order_attachments').delete().eq('id', att.id)
    await load()
  }

  return (
    <div>
      <label className="label">ไฟล์แนบ</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {attachments.map(att => (
          <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleDownload(att)}>📎 {att.file_name}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleRemove(att)}>✕</button>
          </div>
        ))}
      </div>
      <input type="file" onChange={handleUpload} disabled={uploading} accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png" />
    </div>
  )
}
```

Add `useEffect` to this file's React import (currently `import { useState, useMemo } from 'react'` — needs `useEffect` added).

- [ ] **Step 2: Wire tenant id and render the section conditionally**

`AttachmentsSection` needs the current tenant id for the storage path. Check how other pages in this codebase obtain it — `src/hooks/useTenant.js` exposes it via `useTenant()`. In the `PurchaseOrders` component, add:

```js
import { useTenant } from '../hooks/useTenant.js'
```

and inside the component:

```js
const { tenant } = useTenant()
```

In the Add/Edit `Modal`, replace:

```jsx
      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบสั่งซื้อ' : 'เพิ่มใบสั่งซื้อ'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <PurchaseOrderForm
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
        </Modal>
      )}
```

with:

```jsx
      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบสั่งซื้อ' : 'เพิ่มใบสั่งซื้อ'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <PurchaseOrderForm
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
          {editRow && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection poId={editRow.id} tenantId={tenant.id} />
            </div>
          )}
          {!editRow && (
            <div className="modal-body" style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              บันทึกใบสั่งซื้อก่อน จึงจะแนบไฟล์ได้
            </div>
          )}
        </Modal>
      )}
```

- [ ] **Step 3: Manual verification**

Create a new PO, confirm the "บันทึกใบสั่งซื้อก่อน..." hint shows (no uploader) while creating. Save it, reopen it for edit, confirm the uploader now appears. Upload a PDF and an image, confirm both list with correct filenames. Click a filename to download, confirm it opens/downloads the correct file. Remove one, confirm it disappears from the list and (via `execute_sql` or the Supabase dashboard) confirm the Storage object is also gone, not just the DB row.

Also confirm cross-tenant isolation holds: this can't be fully tested without a second tenant, so instead confirm the uploaded file's path starts with the current `tenant.id` (visible in the DB row's `file_path`) and re-read the `po_attachments_tenant_access` policy from Task 2 to confirm the path-prefix check is correct.

- [ ] **Step 4: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "feat: add file attachment upload/download to purchase orders"
```

---

### Task 6: Credit-supplier payment-method defaults

**Files:**
- Modify: `src/hooks/useSupabase.js` (`usePurchaseOrders`'s supplier select)
- Modify: `src/pages/PurchaseOrders.jsx` (`handleReceive`)
- Modify: `src/pages/Expenses.jsx` (`ExpenseForm`'s Supplier `onChange`)

**Interfaces:**
- Consumes: `suppliers.credit_days`, already used elsewhere in `Expenses.jsx` via `src/lib/supplierCredit.js`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `credit_days` to `usePurchaseOrders`'s select**

In `src/hooks/useSupabase.js`, replace:

```js
      .select('*, sites(name, site_number), suppliers(name, supplier_number), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total)')
```

with:

```js
      .select('*, sites(name, site_number), suppliers(name, supplier_number, credit_days), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total)')
```

- [ ] **Step 2: Use it in `handleReceive`**

In `src/pages/PurchaseOrders.jsx`, replace:

```js
        payment_method: 'transfer',
        status: 'pending',
```

with:

```js
        payment_method: receiveRow.suppliers?.credit_days != null ? 'check' : 'transfer',
        status: receiveRow.suppliers?.credit_days != null ? 'awaiting_billing' : 'pending',
```

- [ ] **Step 3: Add the upgrade case to `Expenses.jsx`'s Supplier `onChange`**

Replace:

```jsx
              onChange={id => {
                const sup = suppliers.find(s => s.id === id)
                const hasCredit = !sup || sup.credit_days != null
                setForm(f => ({
                  ...f,
                  supplier_id: id,
                  supplier: sup ? sup.name : (id ? f.supplier : ''),
                  payment_method: resolvePaymentMethodOnSupplierChange(f.payment_method, hasCredit),
                }))
              }}
```

with:

```jsx
              onChange={id => {
                const sup = suppliers.find(s => s.id === id)
                const hasCredit = !sup || sup.credit_days != null
                setForm(f => {
                  const downgraded = resolvePaymentMethodOnSupplierChange(f.payment_method, hasCredit)
                  const upgraded = (hasCredit && sup && f.payment_method === 'transfer') ? 'check' : downgraded
                  return {
                    ...f,
                    supplier_id: id,
                    supplier: sup ? sup.name : (id ? f.supplier : ''),
                    payment_method: upgraded,
                  }
                })
              }}
```

`resolvePaymentMethodOnSupplierChange` (from `src/lib/supplierCredit.js`, already imported in this file) still handles the downgrade case unchanged; this wraps it with the new upgrade case, which only fires when the form's `payment_method` is still at its untouched default (`'transfer'`) — matching `EMPTY_FORM.payment_method`. If the user already picked something else (including `'cash'`), this leaves it alone.

- [ ] **Step 4: Manual verification**

In PurchaseOrders: create and save a PO with a supplier that has `credit_days` set (edit a real supplier via the Suppliers tab first if none currently qualify — revert after testing), receive it, confirm the created expense has `payment_method = 'check'` and `status = 'awaiting_billing'`. Repeat with a cash-only supplier, confirm `transfer`/`pending` as before.

In Expenses: open "+ เพิ่มรายจ่าย" (payment_method starts at its default `'transfer'`), pick a credit-terms supplier, confirm the payment-method dropdown jumps to "เช็ค". Reset the form, this time manually pick "เงินสด" first, then pick the same credit supplier — confirm the payment method stays "เงินสด" (not overridden).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/PurchaseOrders.jsx src/pages/Expenses.jsx
git commit -m "feat: default payment method to check/awaiting_billing for credit-terms suppliers"
```

---

### Task 7: "รอวางบิล" KPI tile on Expenses

**Files:**
- Modify: `src/pages/Expenses.jsx`

**Interfaces:** none — self-contained addition to the existing KPI row.

- [ ] **Step 1: Add the computed total**

In `src/pages/Expenses.jsx`, immediately after `totalPending`:

```js
  const totalAwaitingBilling = useMemo(() => (expenses || []).filter(e => e.status === 'awaiting_billing').reduce((s, e) => s + (e.amount || 0), 0), [expenses])
```

- [ ] **Step 2: Add the KPI tile**

Replace:

```jsx
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">ค้างจ่าย</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalPending)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนรายการ</div><div className="kpi-value">{(expenses||[]).length} รายการ</div></div>
```

with:

```jsx
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">ค้างจ่าย</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalPending)}</div></div>
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">รอวางบิล</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalAwaitingBilling)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนรายการ</div><div className="kpi-value">{(expenses||[]).length} รายการ</div></div>
```

- [ ] **Step 3: Manual verification**

On the Expenses page, set at least one expense's status to "🧾 รอวางบิล" (via the existing toggle-status dialog), confirm the new "รอวางบิล" tile shows a non-zero total matching that row's (or rows') summed amount, and confirm `totalPending`'s tile is unaffected (doesn't double-count it).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "feat: add awaiting_billing KPI tile to expenses summary"
```

---

### Task 8: Delete-reconciliation dialog for PO-linked expenses

**Files:**
- Modify: `src/pages/Expenses.jsx`

**Interfaces:** none — self-contained addition to the existing delete flow.

- [ ] **Step 1: Track the deleted row and add reconciliation state**

Replace:

```js
  const [deleteId, setDeleteId] = useState(null)
```

with:

```js
  const [deleteId, setDeleteId] = useState(null)
  const [reconcilePoId, setReconcilePoId] = useState(null)
```

- [ ] **Step 2: Update `handleDelete` to trigger reconciliation**

Replace:

```js
  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('expenses').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch(); showToast('ลบแล้ว') }
    else alert('Error: ' + error.message)
  }
```

with:

```js
  const handleDelete = async () => {
    if (!deleteId) return
    const row = (expenses || []).find(e => e.id === deleteId)
    const { error } = await supabase.from('expenses').delete().eq('id', deleteId)
    if (error) { alert('Error: ' + error.message); return }
    setDeleteId(null); refetch(); showToast('ลบแล้ว')
    if (row?.po_id) setReconcilePoId(row.po_id)
  }
```

- [ ] **Step 3: Add the reconciliation dialog**

After the existing `{/* ── Delete Confirm ── */}` block, add:

```jsx
      {/* ── PO Reconciliation Dialog ── */}
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

- [ ] **Step 4: Manual verification**

Receive a PO (creating a linked expense per the existing flow), go to Expenses, delete that expense, confirm the reconciliation dialog appears immediately after the delete succeeds. Choose "กลับไปเป็นยังไม่รับของ", confirm on the Purchase Orders page that PO's status is back to "📦 สั่งแล้ว" with its receive/edit/cancel buttons available again. Repeat the whole flow (receive → delete → dialog), this time choosing "ยกเลิกใบสั่งซื้อ", confirm the PO shows "✕ ยกเลิก". Also delete a regular expense with no `po_id` and confirm the reconciliation dialog does NOT appear.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "feat: prompt to reconcile the linked PO when deleting its auto-created expense"
```

---

## Self-Review Notes

- **Spec coverage:** Item 1 (VAT) → Task 3 (+ Task 1's migration); Item 2 (signatures) → Task 4; Item 3 (attachments) → Task 5 (+ Task 2's migration); Item 4 (credit defaults) → Task 6; Item 5 (KPI tile) → Task 7; Item 6 (delete-reconciliation) → Task 8. All six spec items covered; Out of Scope items (parsing attachments, editing `has_vat` post-receive, a revert for the reconciliation choice) are untouched by this plan.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type/name consistency:** `calcPoTotals(items, hasVat)` returns `{ subtotal, vat, total }` and is called with that exact shape in all four call sites (form, document, list row, receive flow). `has_vat` (snake_case, matching the DB column and `sites.has_vat` precedent) is used consistently in form state, payloads, and reads — not mixed with a camelCase `hasVat` anywhere in state/payloads (only as a local destructured variable name inside `calcPoTotals`, which is fine since it's a function parameter, not a persisted field name).
