# Purchase Orders (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a module-gated "ใบสั่งซื้อ" (Purchase Orders) feature: itemized orders tied to a site/supplier/category, a printable document, and a receive flow that auto-creates the corresponding expense.

**Architecture:** Two new tables (`purchase_orders`, `purchase_order_items`) with tenant-scoped, module-gated RLS matching the existing `labor_subcontractors` family of tables exactly. One new page (`src/pages/PurchaseOrders.jsx`) following the structural pattern of `src/pages/LaborContractors.jsx` (module-gated CRUD page with a PDF-export sub-flow) and `src/pages/Expenses.jsx` (list+filter+modal-form shape, plain `supabase.from()` calls, no dedicated mutation hooks). No new global state, no backend business logic beyond auto-numbering and RLS — all writes happen from the client, matching how every existing page in this app already works.

**Tech Stack:** React 18 (function components, hooks), Supabase Postgres + PostgREST via `@supabase/supabase-js`, `html2pdf.js` via the existing `downloadPDF()` helper. No automated JS test suite in this repo — verification is manual dev-server click-through plus Supabase MCP `execute_sql` schema checks, matching every other feature already built here.

## Global Constraints

- Full design context: `docs/superpowers/specs/2026-08-17-purchase-orders-design.md` (and its module-gating amendment) — read it before starting if anything below is ambiguous.
- Dev server: run from `/Users/plfx/code/FacadeXPM/facadex-app` with `npm run dev -- --port 5173`.
- Supabase project id for all migration/`execute_sql` calls: `yyzbgdmgyvvypfcjuhtr`.
- Apply migrations with `mcp__plugin_supabase_supabase__apply_migration` (tracked), then mirror the resulting schema into `supabase/schema.sql` by hand — this repo keeps `schema.sql` as a manually-synced reference, not a generated file.
- Migration file naming: `supabase/migrations/YYYY-MM-DD-NN-description.sql`. This plan is written against `main`'s current migration sequence, which ends at `2026-08-16-15-signup-seeds-app-settings.sql` — this feature's migrations start at `2026-08-17-01-...`. **Before running Task 1, check `ls supabase/migrations/ | sort | tail -5` and `git log --oneline -3` — if a different branch's `2026-08-17-*` migrations have merged into `main` since this plan was written, renumber this plan's migration files to continue after them instead of colliding.**
- **Purchase Orders is a gated SaaS module (`module_key = 'purchase_orders'`), not a core feature.** Every RLS policy on the two new tables must include `has_module_access('purchase_orders')`, matching the exact pattern already used by `labor_subcontractors`/`labor_contracts`/`labor_payments` (a single `admin_full_access` policy per table: `FOR ALL TO authenticated USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')) WITH CHECK (same)`).
- `tenant_modules.module_key` currently has `CHECK (module_key IN ('payroll','labor_subcontractors'))` and must be widened before `'purchase_orders'` can be seeded into it.
- The existing FacadeX bootstrap tenant (`plan='active'`, expired trial) needs an explicit `tenant_modules` row for `'purchase_orders'` or it will be locked out of this feature on deploy — this happened before for `payroll`/`labor_subcontractors` (see `supabase/migrations/2026-08-16-14-seed-bootstrap-tenant-modules.sql`) and must not happen again here.
- Auto-numbering (`po_number`) follows the exact existing trigger-function pattern (see `generate_site_number()`/`generate_supplier_number()` in `supabase/schema.sql`) — **including that pattern's pre-existing lack of tenant-scoping** (the `MAX(...)` computation is not filtered by `tenant_id`, same as every other numbering function in this codebase today). This is a known, consistent, existing quirk across the whole app — do not "fix" it only for this new trigger; that would make `purchase_orders` inconsistent with `sites`/`clients`/`suppliers`/etc. If it needs fixing, that's a separate cross-cutting change outside this plan's scope.
- No dedicated Supabase mutation hooks — every existing page (`Expenses.jsx`, `Sites.jsx`, `LaborContractors.jsx`) calls `supabase.from(...).insert()/.update()/.delete()` directly inside its own handlers. Follow this exactly; do not introduce a new data-access abstraction.
- Financial/module-gated pages in this codebase (`HR.jsx`, `LaborContractors.jsx`) call `auditLog(tableName, recordId, action, oldValues, newValues)` from `src/lib/audit.js` after successful mutations. `Expenses.jsx`/`Sites.jsx` predate this convention and don't call it, but as a new module-gated financial entity, `purchase_orders` should follow the newer convention — call `auditLog` after every insert/update.

---

### Task 1: Migration — `purchase_orders` + `purchase_order_items` tables, numbering, RLS

**Files:**
- Create: `supabase/migrations/2026-08-17-01-purchase-orders-tables.sql`
- Modify: `supabase/schema.sql` (append new section, matching the existing table-by-table structure — insert after the `suppliers` section since POs reference sites/suppliers/categories, before the `labor_subcontractors` section)

**Interfaces:**
- Produces: `purchase_orders` table (`id, po_number, site_id, supplier_id, category_id, date, status, notes, received_date, expense_id, created_at, updated_at, tenant_id`) and `purchase_order_items` table (`id, po_id, description, quantity, unit, unit_price, line_total, sort_order, tenant_id`). Later tasks (2, 3) reference these table/column names exactly.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-08-17-01-purchase-orders-tables.sql
-- Purchase Orders (Phase 1): itemized orders tied to a site/supplier/
-- category, with a status lifecycle (ordered/received/cancelled) and a
-- reference back to the expense created on receipt. See
-- docs/superpowers/specs/2026-08-17-purchase-orders-design.md.

CREATE TABLE purchase_orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number       TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: PO-2026-001
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  category_id     UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  date            DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','received','cancelled')),
  notes           TEXT,
  received_date   DATE,
  expense_id      UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE TABLE purchase_order_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit            TEXT,
  unit_price      NUMERIC NOT NULL DEFAULT 0,
  line_total      NUMERIC NOT NULL DEFAULT 0,
  sort_order      INT NOT NULL DEFAULT 0,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_purchase_orders_site_id ON purchase_orders(site_id);
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_tenant_id ON purchase_orders(tenant_id);
CREATE INDEX idx_purchase_order_items_po_id ON purchase_order_items(po_id);
CREATE INDEX idx_purchase_order_items_tenant_id ON purchase_order_items(tenant_id);

-- Auto-numbering, same pattern as generate_site_number()/generate_supplier_number()
-- (MAX(existing suffix)+1, not COUNT(*)+1 — see the comment above
-- generate_site_number() in schema.sql for why COUNT(*)+1 breaks when a
-- row is deleted). Matches those functions' lack of tenant_id scoping —
-- an existing, consistent quirk across every numbering trigger in this
-- app, not something to fix only here.
CREATE OR REPLACE FUNCTION generate_po_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(po_number FROM 'PO-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM purchase_orders
  WHERE po_number LIKE 'PO-' || year_part || '-%';
  NEW.po_number := 'PO-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_po_number
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.po_number IS NULL OR NEW.po_number = '')
  EXECUTE FUNCTION generate_po_number();

-- purchase_orders-module RLS: single ADMIN+-only full-access policy,
-- tenant-scoped AND gated on has_module_access('purchase_orders') for
-- both reads and writes — same shape as labor_subcontractors.
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_orders FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_order_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "purchase_orders_tables"`, and the SQL body from Step 1.

- [ ] **Step 3: Verify via `execute_sql`**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('purchase_orders','purchase_order_items');

SELECT polname, qual, with_check FROM pg_policies
WHERE tablename IN ('purchase_orders','purchase_order_items');
```

Expected: both tables exist; both have exactly one policy each (`admin_full_access`), with `qual`/`with_check` containing `has_module_access('purchase_orders'::text)`.

Then confirm numbering works — this INSERT will fail with a foreign-key error (no real site/supplier/category exist to reference yet), which is fine; you only need to confirm it fails on the FK, not on `po_number` or RLS, proving the trigger ran:

```sql
INSERT INTO purchase_orders (site_id, supplier_id, category_id, date)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), CURRENT_DATE);
```

Expected: `ERROR: insert or update on table "purchase_orders" violates foreign key constraint` (not a `po_number` null-violation or RLS-denial error) — confirms the trigger populated `po_number` before the FK check ran.

- [ ] **Step 4: Update `supabase/schema.sql`**

Append the same `CREATE TABLE`/index/trigger/RLS block from Step 1 into `supabase/schema.sql`, positioned after the `suppliers` section (before `-- LABOR_SUBCONTRACTORS`), formatted to match the surrounding file's style (aligned column definitions, section header comment `-- ----...--\n-- PURCHASE_ORDERS — ใบสั่งซื้อ\n-- ----...--`).

- [ ] **Step 5: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app
git add supabase/migrations/2026-08-17-01-purchase-orders-tables.sql supabase/schema.sql
git commit -m "feat: add purchase_orders and purchase_order_items tables"
```

---

### Task 2: Migration — widen `tenant_modules.module_key`, seed FacadeX bootstrap tenant

**Files:**
- Create: `supabase/migrations/2026-08-17-02-purchase-orders-module-key.sql`
- Modify: `supabase/schema.sql` (the `tenant_modules` CHECK constraint, plus append the seed as a documented, replayable statement matching how `2026-08-16-14`'s seed is documented there — see the comment above `has_module_access()` in `schema.sql`)

**Interfaces:**
- Produces: `tenant_modules.module_key` now accepts `'purchase_orders'`; the FacadeX tenant has a `tenant_modules` row for it. No later task depends on new interfaces here — this is a standalone data/constraint fix.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-08-17-02-purchase-orders-module-key.sql
-- Widen tenant_modules.module_key to allow 'purchase_orders', and seed
-- the existing FacadeX bootstrap tenant with it. Without this seed, the
-- real company is immediately locked out of this feature on deploy —
-- plan='active' alone does not grant module access (modules are paid
-- add-ons on top of the base plan), and FacadeX's trial already expired.
-- Same bug/fix shape as 2026-08-16-14-seed-bootstrap-tenant-modules.sql.

ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders'));

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'purchase_orders' FROM tenants WHERE company_name = 'Facade X'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "purchase_orders_module_key"`, and the SQL body from Step 1.

- [ ] **Step 3: Verify via `execute_sql`**

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'tenant_modules'::regclass AND conname = 'tenant_modules_module_key_check';

SELECT t.company_name, tm.module_key FROM tenant_modules tm
JOIN tenants t ON t.id = tm.tenant_id
WHERE t.company_name = 'Facade X';
```

Expected: the constraint definition's `ARRAY[...]` includes `'purchase_orders'::text`; the second query returns a row with `module_key = 'purchase_orders'` for `Facade X` (alongside the pre-existing `payroll`/`labor_subcontractors` rows from the earlier seed).

- [ ] **Step 4: Update `supabase/schema.sql`**

Find:

```sql
CREATE TABLE tenant_modules (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors')),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
```

Replace the `CHECK` line with:

```sql
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders')),
```

Then find the bootstrap-seed comment block immediately below it (starts `-- Bootstrap seed (supabase/migrations/2026-08-16-14-seed-bootstrap-tenant-modules.sql):`) and append, after its existing `INSERT INTO tenant_modules ... ON CONFLICT (tenant_id, module_key) DO NOTHING;` block:

```sql
--
-- purchase_orders bootstrap seed (supabase/migrations/2026-08-17-02-purchase-orders-module-key.sql):
-- same reasoning, same tenant, new module.
--   INSERT INTO tenant_modules (tenant_id, module_key)
--   SELECT id, 'purchase_orders' FROM tenants WHERE company_name = 'Facade X'
--   ON CONFLICT (tenant_id, module_key) DO NOTHING;
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-17-02-purchase-orders-module-key.sql supabase/schema.sql
git commit -m "feat: gate purchase orders as a tenant module, seed FacadeX bootstrap tenant"
```

---

### Task 3: Migration — link expenses to their originating PO

**Files:**
- Create: `supabase/migrations/2026-08-17-03-expenses-po-id.sql`
- Modify: `supabase/schema.sql` (the `expenses` table definition, and the `expenses_view` definition)

**Interfaces:**
- Produces: `expenses.po_id` (nullable FK to `purchase_orders`). Task 7 relies on this column and on `expenses_view` exposing it.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-08-17-03-expenses-po-id.sql
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
```

- [ ] **Step 2: Check for view dependents before applying**

Run via `execute_sql` first:

```sql
SELECT dependent_view.relname AS dependent_view
FROM pg_depend
JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
JOIN pg_class AS dependent_view ON pg_rewrite.ev_class = dependent_view.oid
JOIN pg_class AS source_table ON pg_depend.refobjid = source_table.oid
WHERE source_table.relname = 'expenses_view' AND dependent_view.relname != 'expenses_view';
```

Expected: no rows. If this returns any dependent view, STOP and report BLOCKED — dropping `expenses_view` would break it, and this plan does not cover fixing an unexpected dependent.

- [ ] **Step 3: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "expenses_po_id"`, and the SQL body from Step 1.

- [ ] **Step 4: Verify via `execute_sql`**

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'expenses_view' AND column_name = 'po_id';
```

Expected: one row. Also re-run `mcp__plugin_supabase_supabase__get_advisors` with `type: "security"` and confirm no new advisory appears that names `expenses_view` (pre-existing unrelated advisories, e.g. about `sites_progress` or auth settings, are expected and not caused by this change).

- [ ] **Step 5: Update `supabase/schema.sql`**

In the `expenses` table definition, add `po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,` as a new column (placed near `supplier_id`, with a comment `-- FK to purchase_orders — set only by the PO receive flow`), and add `CREATE INDEX idx_expenses_po_id ON expenses(po_id);` alongside the other `expenses` indexes.

Find the existing `expenses_view` definition (`CREATE OR REPLACE VIEW expenses_view WITH (security_invoker = true) AS SELECT e.*, ...`) — it should already read `e.*` (schema.sql already declares the correct target shape; this task's migration is what makes the *live* view match it). No change needed to `schema.sql` here beyond the `expenses` table edit above, unless a prior read shows `schema.sql`'s `expenses_view` is *not* yet `e.*`-based, in which case apply the same `e.*` correction there too.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-17-03-expenses-po-id.sql supabase/schema.sql
git commit -m "feat: link expenses to their originating purchase order"
```

---

### Task 4: `PurchaseOrders.jsx` — data hook, list page, Add/Edit with line items

**Files:**
- Modify: `src/hooks/useSupabase.js` (add `usePurchaseOrders`)
- Create: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Produces: `usePurchaseOrders(filters)` hook (same shape as `useExpenses`) — queries `purchase_orders` directly with an embedded PostgREST select pulling site/supplier names, matching how `useAssignments` embeds `workers(...)`/`sites(...)` via `.select('*, workers(...), sites(...)')` rather than needing a dedicated view. `PurchaseOrders` default export (page component) — consumed by `App.jsx` (Task 5). `PO_STATUSES`/`PO_STATUS_LABELS` and the Add/Edit modal are internal to this file; Tasks 6/7 add to this same file, not new files. This task does not wire the page into `App.jsx` yet — it's a self-contained component you can sanity-check by temporarily importing it anywhere, but the real integration and manual verification of it actually appearing/working happens in Task 5, once it's routed.

- [ ] **Step 1: Add `usePurchaseOrders` to `useSupabase.js`**

In `src/hooks/useSupabase.js`, immediately after the `useExpenses` function (before `usePaymentForecast`), add:

```js
export function usePurchaseOrders(filters = {}) {
  return useQuery(async () => {
    let q = supabase
      .from('purchase_orders')
      .select('*, sites(name, site_number), suppliers(name, supplier_number), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total)')
      .order('date', { ascending: false })

    if (filters.siteId)     q = q.eq('site_id', filters.siteId)
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status)     q = q.eq('status', filters.status)
    if (filters.from)       q = q.gte('date', filters.from)
    if (filters.to)         q = q.lte('date', filters.to)

    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}
```

- [ ] **Step 2: Create `src/pages/PurchaseOrders.jsx` — imports, constants, and the line-item editor**

```jsx
// ============================================================
// PurchaseOrders — ใบสั่งซื้อ
// ✅ Itemized PO tied to site/supplier/category
// ✅ Auto-number PO-YYYY-NNN
// ✅ Status: ordered -> received (auto-creates expense) | cancelled
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { usePurchaseOrders, useSites, useSuppliers, useCategories } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const catOpts = (categories) => (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))
const supplierOpts = (suppliers) => (suppliers || []).map(s => ({
  value: s.id, label: `${s.supplier_number} · ${s.name}`, keywords: `${s.supplier_number} ${s.name}`,
}))

const PO_STATUSES = ['ordered', 'received', 'cancelled']
const PO_STATUS_LABELS = { ordered: '📦 สั่งแล้ว', received: '✅ รับของแล้ว', cancelled: '✕ ยกเลิก' }

const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '' }
const EMPTY_FORM = { site_id: '', supplier_id: '', category_id: '', date: '', notes: '', items: [{ ...EMPTY_ITEM }] }

function lineTotal(item) {
  return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
}

function ItemsEditor({ items, onChange }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการสินค้า ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" placeholder="รายละเอียดสินค้า" required
              value={it.description} onChange={e => set(i, 'description', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
              value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
            <input className="input input-sm" placeholder="หน่วย"
              value={it.unit} onChange={e => set(i, 'unit', e.target.value)} />
            <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
              value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={add}>+ เพิ่มรายการ</button>
      <div style={{ marginTop: 10, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(grandTotal)}</span> บาท
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add the `PurchaseOrderForm` component**

Append to `src/pages/PurchaseOrders.jsx`:

```jsx
function PurchaseOrderForm({ initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">หมวดค่าใช้จ่าย ★</label>
            <SearchableSelect required value={form.category_id} onChange={id => set('category_id', id)}
              placeholder="— เลือกหมวด —" options={catOpts(categories)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ไซท์งาน ★</label>
            <SearchableSelect required value={form.site_id} onChange={id => set('site_id', id)}
              placeholder="— เลือกไซท์ —" options={siteOpts(sites)} />
          </div>
          <div>
            <label className="label">Supplier ★</label>
            <SearchableSelect required value={form.supplier_id} onChange={id => set('supplier_id', id)}
              placeholder="— เลือก Supplier —" options={supplierOpts(suppliers)} />
          </div>
        </div>
        <ItemsEditor items={form.items} onChange={items => set('items', items)} />
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึกใบสั่งซื้อ'}
        </button>
      </div>
    </form>
  )
}
```

- [ ] **Step 4: Add the main `PurchaseOrders` page component (list + CRUD wiring, no receive/PDF yet)**

Append to `src/pages/PurchaseOrders.jsx`:

```jsx
export default function PurchaseOrders({ navigateTo, navState }) {
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,     setSiteId]     = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [status,      setStatus]    = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editRow, setEditRow] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, supplierId, status }
  const { data: pos, refetch } = usePurchaseOrders(filters)
  const { data: sites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers }  = useSuppliers()

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const poPayload = {
        site_id: form.site_id, supplier_id: form.supplier_id, category_id: form.category_id,
        date: form.date, notes: form.notes || null,
      }
      let poId = editRow?.id
      if (editRow) {
        const { error } = await supabase.from('purchase_orders').update(poPayload).eq('id', editRow.id)
        if (error) throw error
        await supabase.from('purchase_order_items').delete().eq('po_id', editRow.id)
        await auditLog('purchase_orders', editRow.id, 'UPDATE', editRow, poPayload)
      } else {
        const { data, error } = await supabase.from('purchase_orders').insert(poPayload).select().single()
        if (error) throw error
        poId = data.id
        await auditLog('purchase_orders', poId, 'INSERT', null, poPayload)
      }

      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          po_id: poId, description: it.description,
          quantity: parseFloat(it.quantity) || 0, unit: it.unit || null,
          unit_price: parseFloat(it.unit_price) || 0, line_total: lineTotal(it), sort_order: i,
        }))
      if (itemsPayload.length) {
        const { error } = await supabase.from('purchase_order_items').insert(itemsPayload)
        if (error) throw error
      }

      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', deleteId)
    if (!error) { await auditLog('purchase_orders', deleteId, 'UPDATE', null, { status: 'cancelled' }); setDeleteId(null); refetch(); showToast('ยกเลิกแล้ว') }
    else alert('Error: ' + error.message)
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      site_id: editRow.site_id, supplier_id: editRow.supplier_id, category_id: editRow.category_id,
      date: editRow.date, notes: editRow.notes || '',
      items: (editRow.purchase_order_items?.length ? editRow.purchase_order_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price) })),
    }
  }, [editRow])

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มใบสั่งซื้อ</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {PO_STATUSES.map(s => <option key={s} value={s}>{PO_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ไซท์งาน</th><th>Supplier</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(pos || []).map(po => {
                const total = (po.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0)
                return (
                  <tr key={po.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{po.po_number}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(po.date)}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)' }}>{po.sites?.name || '—'}</td>
                    <td style={{ fontSize: 12 }}>{po.suppliers?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(po.purchase_order_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(total)}</td>
                    <td><span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit && po.status === 'ordered' && (
                        <>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(po); setShowAdd(true) }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(po.id)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!(pos || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบสั่งซื้อในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบสั่งซื้อ' : 'เพิ่มใบสั่งซื้อ'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <PurchaseOrderForm
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ยกเลิกใบสั่งซื้อ" message="ยืนยันการยกเลิกใบสั่งซื้อนี้?" onConfirm={handleCancel} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Add PO status badge CSS**

In `src/index.css`, immediately after the existing `.badge-method-cash` rule (in the "Badge status variants" block), add:

```css
.badge-po-ordered   { background: rgba(108,99,255,0.15); color: var(--accent); }
.badge-po-received  { background: rgba(0,212,170,0.15); color: var(--green); }
.badge-po-cancelled { background: rgba(94,97,128,0.25); color: var(--text3); }
```

- [ ] **Step 6: Confirm the build succeeds**

This page isn't routed into `App.jsx` yet (that's Task 5), so it can't be click-tested from the UI in this task. Run `npm run build` (or `npm run dev -- --port 5173` and confirm no console/compile errors on app load) purely to confirm `PurchaseOrders.jsx` and the `useSupabase.js` addition are syntactically valid and import cleanly — full functional click-through verification (create/edit/cancel a PO) happens in Task 5, once the tab is reachable.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/PurchaseOrders.jsx src/index.css
git commit -m "feat: add purchase orders list page with itemized create/edit"
```

---

### Task 5: Route the new tab — `App.jsx`

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `src/pages/PurchaseOrders.jsx` default export (Task 4).
- Produces: nothing consumed by later tasks — this is pure routing glue.

- [ ] **Step 1: Import the new page**

In `src/App.jsx`, replace:

```js
import Expenses    from './pages/Expenses.jsx'
import Income      from './pages/Income.jsx'
```

with:

```js
import Expenses    from './pages/Expenses.jsx'
import PurchaseOrders from './pages/PurchaseOrders.jsx'
import Income      from './pages/Income.jsx'
```

- [ ] **Step 2: Add the TABS entry**

Replace:

```js
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
```

with:

```js
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'purchase_orders',   label: '🧾 ใบสั่งซื้อ',           minRole: 'ADMIN',  module: 'purchase_orders' },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
```

- [ ] **Step 3: Add the render case**

Replace:

```js
      case 'expenses':   return <ProtectedPage minRole="ADMIN"><Expenses   {...props} /></ProtectedPage>
      case 'income':     return <ProtectedPage minRole="ADMIN"><Income     {...props} /></ProtectedPage>
```

with:

```js
      case 'expenses':   return <ProtectedPage minRole="ADMIN"><Expenses   {...props} /></ProtectedPage>
      case 'purchase_orders': return <ProtectedPage minRole="ADMIN"><PurchaseOrders {...props} /></ProtectedPage>
      case 'income':     return <ProtectedPage minRole="ADMIN"><Income     {...props} /></ProtectedPage>
```

- [ ] **Step 4: Manual verification**

Run `npm run dev -- --port 5173`, log in as an ADMIN+ user on the FacadeX tenant (which now has the module seeded per Task 2), confirm "🧾 ใบสั่งซื้อ" appears in the tab bar between รายจ่าย and รายรับ, and clicking it renders the list page without a console error.

Now do the full functional click-through deferred from Task 4: create a PO with 2+ line items, confirm the running total updates live as you type; save; confirm it appears in the list with the correct item count and summed total; edit it (add/remove a line item, change quantity), save, confirm the list total updates and re-opening the edit form shows the updated items (not duplicated — confirms the delete-and-reinsert on edit works); cancel a PO, confirm its status badge changes and edit/cancel buttons disappear (since they're gated on `status === 'ordered'`).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: add purchase orders tab, gated by the purchase_orders module"
```

---

### Task 6: Document view — printable PO + PDF export

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Consumes: `downloadPDF(elementId, filename)` from `src/lib/pdf.js` (existing, used identically to `LaborContractors.jsx`'s `PaymentModal`).
- Produces: nothing consumed by later tasks — self-contained UI addition.

- [ ] **Step 1: Import `downloadPDF`**

At the top of `src/pages/PurchaseOrders.jsx`, add:

```js
import { downloadPDF } from '../lib/pdf.js'
```

- [ ] **Step 2: Add a `PODocumentModal` component**

Insert after `PurchaseOrderForm` (before the `PurchaseOrders` default export):

```jsx
function PODocumentModal({ po, onClose }) {
  const items = po.purchase_order_items || []
  const total = items.reduce((s, it) => s + (it.line_total || 0), 0)

  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`po-doc-${po.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>FACADE X</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>ใบสั่งซื้อ</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 13 }}>
            <div><strong>เลขที่:</strong> {po.po_number}</div>
            <div><strong>วันที่:</strong> {new Date(po.date).toLocaleDateString('th-TH')}</div>
            <div><strong>ไซท์งาน:</strong> {po.sites?.name} ({po.sites?.site_number})</div>
            <div><strong>Supplier:</strong> {po.suppliers?.name}</div>
          </div>
          {po.notes && <div style={{ fontSize: 13, marginBottom: 12 }}><strong>หมายเหตุ:</strong> {po.notes}</div>}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>จำนวน</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid #ddd' }}>
                  <td style={{ padding: '6px 4px' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '2px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '2px solid #111' }}>{fmt(total)} บาท</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`po-doc-${po.id}`, `${po.po_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 3: Wire a "print" trigger into the list and modal state**

In the `PurchaseOrders` component, add state: `const [docRow, setDocRow] = useState(null)`.

In the table row's action cell, add a print button available regardless of status (you can re-print a received order too), before the edit/cancel buttons:

```jsx
<button className="btn btn-sm btn-ghost" onClick={() => setDocRow(po)}>📄</button>
```

At the bottom of the component's JSX (alongside the other conditional modals), add:

```jsx
{docRow && <PODocumentModal po={docRow} onClose={() => setDocRow(null)} />}
```

- [ ] **Step 4: Manual verification**

Open a PO's document view (📄 button), confirm the itemized table renders all line items with correct quantities/unit prices/line totals and the correct grand total; click "ดาวน์โหลด PDF", confirm a PDF file downloads and visually matches the on-screen preview (Thai text renders correctly — this app's `downloadPDF` helper is specifically documented as supporting Thai via canvas rendering).

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "feat: add printable PO document with PDF export"
```

---

### Task 7: Receive flow — auto-create expense, link back from Expenses page

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`
- Modify: `src/pages/Expenses.jsx`
- Modify: `src/hooks/useSupabase.js` (`useExpenses` — no filter change, just confirm `po_id` passes through `select('*')` on `expenses_view`, which it already does after Task 3 — no code change needed here, this file is listed for the verification step only)

**Interfaces:**
- Consumes: `expenses.po_id`/`expenses_view.po_id` (Task 3), `purchase_orders.expense_id`/`status`/`received_date` (Task 1).
- Produces: nothing consumed by later tasks — this is the final task.

- [ ] **Step 1: Add the receive handler to `PurchaseOrders.jsx`**

Add state: `const [receiveRow, setReceiveRow] = useState(null)`.

Add a handler function inside the `PurchaseOrders` component, alongside `handleCancel`:

```js
const handleReceive = async () => {
  if (!receiveRow) return
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
      payment_method: 'transfer',
      status: 'pending',
      notes: `จาก ใบสั่งซื้อ ${receiveRow.po_number}`,
      po_id: receiveRow.id,
    }
    const { data: expense, error: expError } = await supabase.from('expenses').insert(expensePayload).select().single()
    if (expError) throw expError
    await auditLog('expenses', expense.id, 'INSERT', null, expensePayload)

    const poUpdate = { status: 'received', received_date: expensePayload.date, expense_id: expense.id }
    const { error: poError } = await supabase.from('purchase_orders').update(poUpdate).eq('id', receiveRow.id)
    if (poError) throw poError
    await auditLog('purchase_orders', receiveRow.id, 'UPDATE', null, poUpdate)

    setReceiveRow(null); refetch(); showToast('รับของแล้ว สร้างรายจ่ายอัตโนมัติ')
  } catch (e) {
    alert('Error: ' + e.message + ' — หากสร้างรายจ่ายไปแล้วแต่ใบสั่งซื้อยังไม่อัปเดต ให้ตรวจสอบหน้ารายจ่ายและอัปเดตใบสั่งซื้อด้วยตนเอง')
  }
}
```

- [ ] **Step 2: Add the receive button and confirm dialog**

In the table row's action cell (added in Task 4), for rows with `status === 'ordered'`, add before the edit button:

```jsx
<button className="btn btn-sm btn-primary" onClick={() => setReceiveRow(po)}>✅ รับของแล้ว</button>
```

At the bottom of the component's JSX, alongside the other modals:

```jsx
{receiveRow && (
  <ConfirmDialog
    title="ยืนยันรับของ"
    message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt((receiveRow.purchase_order_items || []).reduce((s, it) => s + (it.line_total || 0), 0))} บาท?`}
    onConfirm={handleReceive}
    onCancel={() => setReceiveRow(null)}
  />
)}
```

- [ ] **Step 3: Add a read-only PO reference indicator to `Expenses.jsx`**

In `src/pages/Expenses.jsx`, find the table row rendering (the `<td>` for the description column, showing `e.description` and `e.invoice_no`):

```jsx
                  <td style={{ maxWidth: 220 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{e.description}</div>
                    {e.invoice_no && <div style={{ fontSize: 10, color: 'var(--text3)' }}>#{e.invoice_no}</div>}
                  </td>
```

Replace with:

```jsx
                  <td style={{ maxWidth: 220 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{e.description}</div>
                    {e.invoice_no && <div style={{ fontSize: 10, color: 'var(--text3)' }}>#{e.invoice_no}</div>}
                    {e.po_id && <span className="badge" style={{ background: 'rgba(108,99,255,0.15)', color: 'var(--accent)', fontSize: 10, marginTop: 2 }}>🧾 จาก PO</span>}
                  </td>
```

This is read-only (no click-through to the PO detail — Phase 1 keeps this as a simple visual indicator; navigating from Expenses to the specific PO is not built here, matching the spec's explicit scope boundary).

- [ ] **Step 4: Manual verification**

On an `ordered` PO with 2+ line items, click "✅ รับของแล้ว", confirm the dialog shows the correct total, confirm it. Verify: the PO's status badge changes to "✅ รับของแล้ว" and its receive/edit/cancel buttons disappear; a new row appears on the Expenses page with the correct site/category/supplier/amount (matching the PO's item total exactly) and the "🧾 จาก PO" indicator next to its description; the expense's `payment_method` is "โอน" (transfer) and status is "⏳ ค้างจ่าย" (pending), editable normally from there on.

Then confirm guard rails: attempt to receive or edit a `cancelled` PO (buttons should not be present); attempt to receive an already-`received` PO (button should not be present).

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseOrders.jsx src/pages/Expenses.jsx
git commit -m "feat: receive flow auto-creates linked expense, shown on Expenses page"
```

---

## Self-Review Notes

- **Spec coverage:** data model + numbering + module-gated RLS (spec §Data Model, §Permissions & Module Gating) → Tasks 1–2; `expenses.po_id`/view (spec §UI "Note: this requires adding po_id...") → Task 3; list/CRUD/line-items (spec §UI "List page"/"Add/Edit modal") → Task 4; tab routing (spec §Permissions) → Task 5; document/PDF (spec §UI "Document view") → Task 6; receive flow + Expenses linking (spec §UI "Receive flow"/"Linking back") → Task 7. All spec sections covered; Phase 2 (RFQ) explicitly out of scope per spec and not touched anywhere in this plan.
- **Placeholder scan:** no TBD/TODO; every step has complete code. Task order was fixed during self-review so the page (Task 4) is created before it's routed (Task 5) — no placeholder/stub component needed at any point, and Task 4's build-only verification step is honest about what it can and can't confirm before routing exists.
- **Type/name consistency:** `po_number`, `status` (`ordered`/`received`/`cancelled`), `expense_id`, `po_id`, `PO_STATUSES`/`PO_STATUS_LABELS`, `usePurchaseOrders`, `lineTotal()` are used identically everywhere they're introduced and consumed across tasks. `auditLog` calls match its existing 5-arg signature from `src/lib/audit.js` throughout.
