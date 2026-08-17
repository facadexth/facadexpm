# Expense Filters, Billing-Date Credit Terms & Supplier-Gated Payment Methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supplier/Status/date-type filters to the Expenses page, fix the credit-term lookup bug, gate the payment-method dropdown by the selected supplier's configured credit terms, extend the billing-date auto-calc to cheque payments, and add a new `awaiting_billing` status.

**Architecture:** All changes are confined to the existing Expenses feature slice: one new dated SQL migration (widens a CHECK constraint), edits to `src/pages/Expenses.jsx` (form + filter row), `src/hooks/useSupabase.js` (`useExpenses` filter logic), and `src/index.css` (one new badge rule, added in the two places badge rules already live). No new files, no new tables.

**Tech Stack:** React 18 (function components, hooks), Supabase Postgres + PostgREST via `@supabase/supabase-js`, plain CSS. No automated JS test suite in this repo — verification is manual dev-server click-through plus Supabase MCP `execute_sql` schema checks, matching the pattern used throughout `supabase/tests/*.sql` and prior design docs (e.g. `docs/superpowers/specs/2026-08-14-ot-decouple-design.md`).

## Global Constraints

- Full design context: `docs/superpowers/specs/2026-08-17-expense-filters-credit-terms-design.md` — read it before starting if anything below is ambiguous.
- Dev server: run from `/Users/plfx/code/FacadeXPM/facadex-app` with `npm run dev -- --port 5173`.
- Supabase project id for all migration/`execute_sql` calls: `yyzbgdmgyvvypfcjuhtr`.
- Apply migrations with `mcp__plugin_supabase_supabase__apply_migration` (not raw `execute_sql`) so they're tracked, then mirror the resulting schema into `supabase/schema.sql` by hand (this repo keeps `schema.sql` as a manually-synced reference, not a generated file).
- Migration file naming: `supabase/migrations/YYYY-MM-DD-NN-description.sql`, continuing the existing sequence (last one is `2026-08-16-15-signup-seeds-app-settings.sql`, so this feature starts at `2026-08-17-01-...`).
- **No suppliers in the live database currently have `credit_days` set** (verified via `execute_sql`). Any manual verification step that needs a credit-terms supplier must create or temporarily edit one via the Suppliers page, and should clean up afterward (delete the temp supplier, or revert the edited one) rather than leaving test data in place.
- `awaiting_billing` status is purely manual — do not add any auto-transition logic anywhere in this plan.

---

### Task 1: Migration — allow `awaiting_billing` as an expense status

**Files:**
- Create: `supabase/migrations/2026-08-17-01-expense-awaiting-billing-status.sql`
- Modify: `supabase/schema.sql:244-245`

**Interfaces:**
- Produces: `expenses.status` now accepts `'awaiting_billing'` in addition to the existing four values. Later tasks (2) rely on the database accepting this value without error.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-08-17-01-expense-awaiting-billing-status.sql
-- Add 'awaiting_billing' to expenses.status allowed values — a manual
-- status for credit/cheque expenses that haven't been billed yet.

ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('awaiting_billing','paid','pending','check_issued','check_cleared'));
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "expense_awaiting_billing_status"`, and the SQL body from Step 1.

- [ ] **Step 3: Verify the constraint accepted the new value**

Run via `mcp__plugin_supabase_supabase__execute_sql` against project `yyzbgdmgyvvypfcjuhtr`:

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'expenses'::regclass AND conname = 'expenses_status_check';
```

Expected: the returned definition's `ARRAY[...]` list includes `'awaiting_billing'::text` alongside the four existing values.

- [ ] **Step 4: Update the reference schema doc**

In `supabase/schema.sql`, find:

```sql
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('paid','pending','check_issued','check_cleared')),
```

Replace with:

```sql
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('awaiting_billing','paid','pending','check_issued','check_cleared')),
```

- [ ] **Step 5: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app
git add supabase/migrations/2026-08-17-01-expense-awaiting-billing-status.sql supabase/schema.sql
git commit -m "feat: allow awaiting_billing as an expense status"
```

---

### Task 2: Add `awaiting_billing` to the Expenses UI (status list, labels, badge)

**Files:**
- Modify: `src/pages/Expenses.jsx:29-30`
- Modify: `src/index.css:141-144` and `src/index.css:264-267` (two separate badge-rule blocks already exist in this file; both must get the new rule)

**Interfaces:**
- Consumes: the widened DB constraint from Task 1 (so saving `status: 'awaiting_billing'` doesn't error).
- Produces: `STATUSES` now includes `'awaiting_billing'` as its first entry; `STATUS_LABELS.awaiting_billing === '🧾 รอวางบิล'`. Task 6/7 (filter row) render off this same `STATUSES` array and need no separate change to pick it up.

- [ ] **Step 1: Update `STATUSES` and `STATUS_LABELS`**

In `src/pages/Expenses.jsx`, replace:

```js
const STATUSES = ['paid', 'pending', 'check_issued', 'check_cleared']
const STATUS_LABELS = { paid: '✅ จ่ายแล้ว', pending: '⏳ ค้างจ่าย', check_issued: '📄 ออกเช็ค', check_cleared: '🏦 เช็คผ่าน' }
```

with:

```js
const STATUSES = ['awaiting_billing', 'pending', 'check_issued', 'check_cleared', 'paid']
const STATUS_LABELS = {
  awaiting_billing: '🧾 รอวางบิล',
  pending: '⏳ ค้างจ่าย',
  check_issued: '📄 ออกเช็ค',
  check_cleared: '🏦 เช็คผ่าน',
  paid: '✅ จ่ายแล้ว',
}
```

(`EMPTY_FORM.status` on line 35 stays `'pending'` — unchanged. The default for a brand-new expense is not `awaiting_billing`; the user picks it explicitly when it applies.)

- [ ] **Step 2: Add the badge CSS rule in both locations**

In `src/index.css`, immediately before the first `.badge-paid` rule (around line 141):

```css
.badge-awaiting_billing { background: rgba(255,209,102,0.1); color: var(--yellow); }
.badge-paid { background: rgba(0,212,170,0.15); color: var(--green); }
```

And immediately before the second `.badge-paid` rule (around line 264, inside the "Badge status variants" block):

```css
.badge-awaiting_billing { background: rgba(255,209,102,0.1); color: var(--yellow); }
.badge-paid         { background: rgba(0,212,170,0.15); color: var(--green); }
```

(Only the `.badge-awaiting_billing` line is new in each block — leave the existing `.badge-paid`/etc. lines as they are, just insert above them.)

- [ ] **Step 3: Manual verification**

Run `npm run dev -- --port 5173` from `facadex-app/`, open the Expenses tab, open any existing expense row's status (click the status badge to open the toggle-status dialog), change it to "🧾 รอวางบิล", confirm:
- The dropdown in the toggle dialog lists it first.
- After saving, the table shows a badge with the new label in a distinct yellow-tinted style (not falling back to unstyled/default).
- The status filter dropdown in the toolbar (existing, `Expenses.jsx:301-304`) now lists "🧾 รอวางบิล" as an option and filtering by it returns the row you just changed.

Change the row back to its original status afterward so you don't leave test data behind.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Expenses.jsx src/index.css
git commit -m "feat: add awaiting_billing expense status with badge styling"
```

---

### Task 3: Fix credit-term lookup bug (`payment_terms` → `credit_days`)

**Files:**
- Modify: `src/pages/Expenses.jsx:43-47`

**Interfaces:**
- Produces: `creditTermDays` (a `number | null` local to `ExpenseForm`) is now sourced from `suppliers.credit_days`. Task 4 relies on this same variable name and semantics (`null` = no credit terms).

- [ ] **Step 1: Replace the buggy lookup**

Replace:

```js
  // เครดิตเทอมของ Supplier ที่เลือก (วัน) — ใช้คำนวณวันครบกำหนดจากวันวางบิล
  const selectedSupplier = suppliers.find(s => s.id === form.supplier_id)
  const creditTermDays = (() => {
    const days = parseInt(selectedSupplier?.payment_terms, 10)
    return isNaN(days) ? null : days
  })()
```

with:

```js
  // เครดิตเทอมของ Supplier ที่เลือก (วัน) — ใช้คำนวณวันครบกำหนดจากวันวางบิล
  const selectedSupplier = suppliers.find(s => s.id === form.supplier_id)
  const creditTermDays = selectedSupplier?.credit_days ?? null
```

- [ ] **Step 2: Manual verification**

This requires a supplier with `credit_days` set — none exist in the live DB today (confirmed by query). In the Suppliers tab, edit any existing supplier: set "วิธีชำระเงิน (Default)" to "จ่ายเช็ค (เครดิต)" or "มีเครดิต แต่ใช้เป็นโอน" and "จำนวนวันเครดิต" to e.g. `30`, save.

In the Expenses tab, open "+ เพิ่มรายจ่าย", select that supplier, set payment method to "เครดิต", fill "วันวางบิล" with today's date. Confirm "วันครบกำหนด (due date)" auto-fills to today + 30 days, and the helper text below it reads "คำนวณจากเครดิตเทอมของ Supplier (30 วัน) — แก้ไขเองได้" (not the "ไม่พบเครดิตเทอมของ Supplier" fallback text, which is what it showed before this fix regardless of the supplier's actual terms).

Close the form without saving (or delete the test expense if saved). Revert the supplier's payment terms back to its original values afterward.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "fix: read supplier credit term from credit_days, not legacy payment_terms"
```

---

### Task 4: Supplier-gated payment methods + billing-date extended to cheque

**Files:**
- Modify: `src/pages/Expenses.jsx:49-60` (`setBillingDate`)
- Modify: `src/pages/Expenses.jsx:101-159` (Supplier `SearchableSelect` onChange, payment-method `<select>`, and the billing-date/due-date conditional block)

**Interfaces:**
- Consumes: `creditTermDays` and `selectedSupplier` from Task 3 (same names, same file).
- Produces: `methodOptions` (array of allowed `payment_method` values for the current supplier selection) — local to `ExpenseForm`, not consumed elsewhere.

- [ ] **Step 1: Generalize `setBillingDate` to target `check_date` for cheque payments**

Replace:

```js
  // วันวางบิล → คำนวณวันครบกำหนดให้อัตโนมัติ (เฉพาะตอนที่ยังไม่ได้กรอกวันครบกำหนดเอง)
  const setBillingDate = (val) => {
    setForm(f => {
      const next = { ...f, billing_date: val }
      if (!f.due_date && val && creditTermDays != null) {
        const d = new Date(val)
        d.setDate(d.getDate() + creditTermDays)
        next.due_date = d.toISOString().slice(0, 10)
      }
      return next
    })
  }
```

with:

```js
  // วันวางบิล → คำนวณวันครบกำหนดให้อัตโนมัติ
  // เช็ค: เขียนลง check_date · เครดิต: เขียนลง due_date — เฉพาะตอนที่ยังไม่ได้กรอกวันครบกำหนดเอง
  const setBillingDate = (val) => {
    setForm(f => {
      const next = { ...f, billing_date: val }
      const targetField = f.payment_method === 'check' ? 'check_date' : 'due_date'
      if (!f[targetField] && val && creditTermDays != null) {
        const d = new Date(val)
        d.setDate(d.getDate() + creditTermDays)
        next[targetField] = d.toISOString().slice(0, 10)
      }
      return next
    })
  }
```

- [ ] **Step 2: Compute `methodOptions` from the selected supplier**

Immediately after the `creditTermDays` line (from Task 3), add:

```js
  const supplierHasCredit = !selectedSupplier || selectedSupplier.credit_days != null
  const methodOptions = supplierHasCredit ? ['transfer', 'check', 'cash', 'credit'] : ['transfer', 'cash']
```

- [ ] **Step 3: Gate the Supplier field's `onChange` to reset an incompatible payment method**

Replace:

```jsx
            <SearchableSelect
              value={form.supplier_id}
              onChange={id => {
                const sup = suppliers.find(s => s.id === id)
                set('supplier_id', id)
                if (sup) set('supplier', sup.name)
                else if (!id) set('supplier', '')
              }}
              placeholder="— เลือก Supplier —"
              options={supplierOpts(suppliers)}
            />
```

with:

```jsx
            <SearchableSelect
              value={form.supplier_id}
              onChange={id => {
                const sup = suppliers.find(s => s.id === id)
                const hasCredit = !sup || sup.credit_days != null
                setForm(f => ({
                  ...f,
                  supplier_id: id,
                  supplier: sup ? sup.name : (id ? f.supplier : ''),
                  payment_method: (!hasCredit && (f.payment_method === 'check' || f.payment_method === 'credit'))
                    ? 'transfer' : f.payment_method,
                }))
              }}
              placeholder="— เลือก Supplier —"
              options={supplierOpts(suppliers)}
            />
```

- [ ] **Step 4: Render only the allowed payment-method options, and extend billing-date to `check`**

Replace:

```jsx
        <div className="form-grid-3">
          <div>
            <label className="label">วิธีชำระ ★</label>
            <select className="select" value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>
              <option value="transfer">โอนเงิน</option>
              <option value="check">เช็ค</option>
              <option value="cash">เงินสด</option>
              <option value="credit">เครดิต</option>
            </select>
          </div>
          {form.payment_method === 'check' && (
            <div>
              <label className="label">วันที่เช็ค / Due date</label>
              <input type="date" className="input" value={form.check_date} onChange={e => set('check_date', e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
        {form.payment_method === 'credit' && (
          <div className="form-grid-2">
            <div>
              <label className="label">วันวางบิล</label>
              <input type="date" className="input" value={form.billing_date} onChange={e => setBillingDate(e.target.value)} />
            </div>
            <div>
              <label className="label">วันครบกำหนด (due date)</label>
              <input type="date" className="input" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {creditTermDays != null ? `คำนวณจากเครดิตเทอมของ Supplier (${creditTermDays} วัน) — แก้ไขเองได้` : 'ไม่พบเครดิตเทอมของ Supplier — กรอกวันครบกำหนดเอง'}
              </div>
            </div>
          </div>
        )}
```

with:

```jsx
        <div className="form-grid-3">
          <div>
            <label className="label">วิธีชำระ ★</label>
            <select className="select" value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>
              {methodOptions.includes('transfer') && <option value="transfer">โอนเงิน</option>}
              {methodOptions.includes('check') && <option value="check">เช็ค</option>}
              {methodOptions.includes('cash') && <option value="cash">เงินสด</option>}
              {methodOptions.includes('credit') && <option value="credit">เครดิต</option>}
            </select>
          </div>
          {form.payment_method === 'check' && (
            <div>
              <label className="label">วันที่เช็ค / Due date</label>
              <input type="date" className="input" value={form.check_date} onChange={e => set('check_date', e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
        {(form.payment_method === 'check' || form.payment_method === 'credit') && (
          <div className="form-grid-2">
            <div>
              <label className="label">วันวางบิล</label>
              <input type="date" className="input" value={form.billing_date} onChange={e => setBillingDate(e.target.value)} />
            </div>
            {form.payment_method === 'credit' && (
              <div>
                <label className="label">วันครบกำหนด (due date)</label>
                <input type="date" className="input" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {creditTermDays != null ? `คำนวณจากเครดิตเทอมของ Supplier (${creditTermDays} วัน) — แก้ไขเองได้` : 'ไม่พบเครดิตเทอมของ Supplier — กรอกวันครบกำหนดเอง'}
                </div>
              </div>
            )}
            {form.payment_method === 'check' && (
              <div style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'end', paddingBottom: 8 }}>
                {creditTermDays != null ? `วันที่เช็คด้านบนคำนวณจากเครดิตเทอมของ Supplier (${creditTermDays} วัน) — แก้ไขเองได้` : 'ไม่พบเครดิตเทอมของ Supplier — กรอกวันที่เช็คเอง'}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 5: Manual verification**

Using a supplier with `credit_days` set to `null` (any untouched supplier in the live DB — confirmed all of them currently qualify) in "+ เพิ่มรายจ่าย": confirm the "วิธีชำระ" dropdown shows only "โอนเงิน" and "เงินสด" — no "เช็ค" or "เครดิต".

Using the supplier you temporarily edited in Task 3 (or set one up again if reverted) with `credit_days = 30`: confirm all four options appear; select "เช็ค"; confirm a "วันวางบิล" field appears; fill it with today's date; confirm "วันที่เช็ค / Due date" (the field from `form-grid-3`, not a new one) auto-fills to today + 30 days.

While that form is still open with "เช็ค" selected and a billing date filled in, change the Supplier field to a cash-only supplier: confirm "วิธีชำระ" resets to "โอนเงิน" and the billing-date block disappears.

Close without saving. Revert any supplier edits made purely for this test.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "feat: gate payment method by supplier credit terms, extend billing date to cheque"
```

---

### Task 5: Supplier filter in the Expenses toolbar

**Files:**
- Modify: `src/pages/Expenses.jsx:294-310` (sub-filters row)

**Interfaces:**
- Consumes: `supplierId`/`setSupplierId` state (already declared at `Expenses.jsx:192`) and `filters.supplierId` (already passed into `useExpenses` at `Expenses.jsx:209`, and already read by the hook at `useSupabase.js:66`) — both pre-existing, uncommitted in the working tree. This task only adds the missing UI control; it does not touch the hook.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add the Supplier dropdown next to the existing Site/Category filters**

In `src/pages/Expenses.jsx`, replace:

```jsx
      {/* ── Sub-filters ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 170 }}>
          <SearchableSelect value={catId} onChange={setCatId} placeholder="ทุกหมวด" options={catOpts(categories)} />
        </div>
        <select className="select select-sm" value={status} onChange={e => setStatus(e.target.value)}>
```

with:

```jsx
      {/* ── Sub-filters ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 170 }}>
          <SearchableSelect value={catId} onChange={setCatId} placeholder="ทุกหมวด" options={catOpts(categories)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" value={status} onChange={e => setStatus(e.target.value)}>
```

(`suppliers` is already destructured from `useSuppliers()` at `Expenses.jsx:213`; `supplierOpts` is already defined at `Expenses.jsx:24-26`. No new imports needed.)

- [ ] **Step 2: Manual verification**

In the dev server, Expenses tab: pick a supplier from the new dropdown, confirm the table narrows to only that supplier's expenses (cross-check against a row's "ผู้จำหน่าย" column). Clear the filter, confirm the full list returns.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "feat: add supplier filter to expenses list"
```

---

### Task 6: Date-type filter (order date / billing date / due date·transfer)

**Files:**
- Modify: `src/hooks/useSupabase.js:57-76` (`useExpenses`)
- Modify: `src/pages/Expenses.jsx:181-284` (toolbar date inputs + `filters` object)

**Interfaces:**
- Consumes: nothing new.
- Produces: `useExpenses(filters)` now accepts an optional `filters.dateField` (`'date' | 'billing_date' | 'due'`, defaults to `'date'` when omitted) — this is the final task, nothing downstream depends on it.

- [ ] **Step 1: Update `useExpenses` to filter on the selected date field**

In `src/hooks/useSupabase.js`, replace:

```js
export function useExpenses(filters = {}) {
  return useQuery(async () => {
    let q = supabase
      .from('expenses_view')
      .select('*')
      .order('date', { ascending: false })

    if (filters.siteId)   q = q.eq('site_id', filters.siteId)
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status)   q = q.eq('status', filters.status)
    if (filters.from)     q = q.gte('date', filters.from)
    if (filters.to)       q = q.lte('date', filters.to)
    if (filters.search)   q = q.ilike('description', `%${filters.search}%`)

    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}
```

with:

```js
export function useExpenses(filters = {}) {
  return useQuery(async () => {
    let q = supabase
      .from('expenses_view')
      .select('*')
      .order('date', { ascending: false })

    if (filters.siteId)   q = q.eq('site_id', filters.siteId)
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status)   q = q.eq('status', filters.status)
    if (filters.search)   q = q.ilike('description', `%${filters.search}%`)

    // dateField: 'date' (วันที่สั่งซื้อ, default) | 'billing_date' (วันวางบิล)
    // | 'due' (วันครบกำหนด/วันโอน — due_date for credit rows, check_date for cheque rows)
    const field = filters.dateField || 'date'
    if (field === 'due') {
      if (filters.from) q = q.or(`due_date.gte.${filters.from},check_date.gte.${filters.from}`)
      if (filters.to)   q = q.or(`due_date.lte.${filters.to},check_date.lte.${filters.to}`)
    } else {
      if (filters.from) q = q.gte(field, filters.from)
      if (filters.to)   q = q.lte(field, filters.to)
    }

    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}
```

- [ ] **Step 2: Add the date-type selector state and pass it into `filters`**

In `src/pages/Expenses.jsx`, replace:

```js
  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState(navState?.siteId || '')
```

with:

```js
  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [dateField, setDateField] = useState('date')
  const [siteId,   setSiteId]   = useState(navState?.siteId || '')
```

Replace:

```js
  const filters = { from: dateFrom, to: dateTo, siteId, categoryId: catId, supplierId, status, search }
```

with:

```js
  const filters = { from: dateFrom, to: dateTo, dateField, siteId, categoryId: catId, supplierId, status, search }
```

- [ ] **Step 3: Add the `<select>` control next to the existing date-range inputs**

Replace:

```jsx
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหารายละเอียด..." value={search} onChange={e => setSearch(e.target.value)} />
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
```

with:

```jsx
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหารายละเอียด..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select select-sm" value={dateField} onChange={e => setDateField(e.target.value)}>
          <option value="date">วันที่สั่งซื้อ</option>
          <option value="billing_date">วันวางบิล</option>
          <option value="due">วันครบกำหนด / วันโอน</option>
        </select>
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
```

- [ ] **Step 4: Manual verification**

In the dev server, Expenses tab:
- Leave "วันที่สั่งซื้อ" selected (default) — confirm the list behaves exactly as before this change (still YTD by default).
- Switch to "วันครบกำหนด / วันโอน", set a wide date range (e.g. this year) — confirm rows with either a `check_date` or `due_date` in range appear (cross-check the "วันเช็ค" column against a couple of rows), and rows with dates outside that range but an order `date` inside YTD are correctly excluded.
- Switch to "วันวางบิล" — confirm only rows with a `billing_date` set in range appear (most existing rows have none, so this will likely show few or zero rows unless you saved a test row with `billing_date` set during Task 3/4 testing).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/Expenses.jsx
git commit -m "feat: filter expenses by order date, billing date, or due date"
```

---

## Self-Review Notes

- **Spec coverage:** migration + status list/badge (spec §"New status") → Task 1–2; credit-term bug fix (spec §"Data Model"/"Form Changes") → Task 3; supplier-gated dropdown + billing-date-for-cheque (spec §"Form Changes") → Task 4; supplier filter (spec §"Filter Row") → Task 5; date-type filter incl. `useExpenses` `dateField`/`due` OR-logic (spec §"Filter Row"/"Data Layer") → Task 6. All spec sections are covered.
- **Placeholder scan:** no TBD/TODO; every step shows exact code and exact verification actions with concrete UI text to check for.
- **Type/name consistency:** `creditTermDays`, `selectedSupplier`, `methodOptions`, `supplierHasCredit`, `dateField`, `filters.dateField` are used with the same names and shapes everywhere they're introduced and consumed across tasks.
