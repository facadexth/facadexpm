# Client Deposit Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a site collect a client deposit (มัดจำ) as a real income transaction, then auto-deduct a configurable percentage of it from every subsequent income collected for that site until the deposit is used up, gated behind a new paid `client_deposits` module.

**Architecture:** Two new columns on `incomes` (`income_type`, `deposit_deduction`) plus one on `sites` (`default_deposit_pct`), a `site_deposit_summary` view mirroring the existing `site_retention_summary` pattern, a pure calculation module (`src/lib/depositCalc.js`) that both the Income form and its unit tests share, and a new read-only `Deposits.jsx` summary tab wired the same way `Retention.jsx` was wired into `App.jsx`.

**Tech Stack:** React 18 + Vite, Supabase (Postgres + PostgREST), Vitest.

## Global Constraints

- Every new/modified Postgres view MUST have `WITH (security_invoker = true)`. This codebase had a real cross-tenant RLS leak from a view that omitted it (`sites_progress`, see `supabase/migrations/2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql`) — this is a hard project-wide rule, not a suggestion.
- `income_type = 'มัดจำ'` rows compute VAT / withholding-tax / retention exactly like `'ปกติ'` rows (same formula, same site defaults). The only thing special about a `'มัดจำ'` row is that its own `deposit_deduction` is always `0`.
- `deposit_deduction` on a `'ปกติ'` row is clamped so the running total deducted for a site can never exceed that site's total collected deposit: `deposit_deduction = min(proposed, remaining_balance)`, never negative.
- Do NOT retroactively recalculate `deposit_deduction` on other rows when a site's `default_deposit_pct` changes or when an unrelated row is edited/deleted. This mirrors the existing, deliberate behavior of `vat`/`tax_withheld`/`retention` (computed once at save time, not live-recalculated) — documented in the spec as an explicit simplification, not a gap to close.
- The `client_deposits` module gate only needs to hide two UI surfaces: the `default_deposit_pct` field on the Sites form, and the `income_type` selector + `deposit_pct` field on the Income form. Because a tenant without the module can never set `default_deposit_pct` above its `DEFAULT 0`, and can never create a `'มัดจำ'` row, the calculation engine itself needs no module check — the gating cascades naturally. Do not add `hasModuleAccess` checks inside `depositCalc.js` or the SQL view.
- Do NOT touch anything under `labor_contracts`/`labor_payments`/`contractor_summary` — that is a separate, pre-existing retention system for labor subcontractors and is unrelated to this feature.
- Never write to the live Supabase database as a side effect of "manual verification" during implementation. A prior task in this codebase's history (the retention-tracking plan) accidentally set a real production site's column to a guessed test value while verifying a migration; it had to be caught and reverted. Read-only `SELECT`/`information_schema` checks are fine; `INSERT`/`UPDATE`/`DELETE` against the live project are not part of any step in this plan — if you believe you need one to verify something, stop and ask instead of running it.

---

### Task 1: Database schema, view, module gate, and calculation module

**Files:**
- Create: `supabase/migrations/2026-08-19-03-client-deposit-tracking.sql`
- Modify: `supabase/schema.sql` (mirror the migration + fix a pre-existing gap, see Step 3)
- Create: `src/lib/depositCalc.js`
- Create: `src/lib/depositCalc.test.js`
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces (used by Task 2, 3, 4):
  - `sites.default_deposit_pct` — `NUMERIC DEFAULT 0`
  - `incomes.income_type` — `TEXT NOT NULL DEFAULT 'ปกติ'`, one of `'ปกติ' | 'มัดจำ'`
  - `incomes.deposit_deduction` — `NUMERIC DEFAULT 0`
  - View `site_deposit_summary` — columns `site_id, site_number, name, default_deposit_pct, total_deposit, total_deducted, remaining_balance`
  - `export function round2(n)` in `src/lib/depositCalc.js` — `(number) => number`, rounds to 2 decimal places
  - `export function calcDepositDeduction(noVat, depositPct, remainingBalance)` in `src/lib/depositCalc.js` — `(number, number, number) => number`, returns the clamped deduction amount
  - `export function remainingBalanceForEdit(siteRemainingBalance, rowPriorDeduction)` in `src/lib/depositCalc.js` — `(number, number) => number`
  - `export function useSiteDepositSummary()` in `src/hooks/useSupabase.js` — returns `{ data, loading, error, refetch }` where `data` is an array of `site_deposit_summary` rows ordered by `name`
  - `export function useSiteDepositBalance(siteId)` in `src/hooks/useSupabase.js` — returns `{ data, loading, error, refetch }` where `data` is a single `site_deposit_summary` row (or `null` if `siteId` is falsy)

- [ ] **Step 1: Write the failing test for the calculation module**

Create `src/lib/depositCalc.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { round2, calcDepositDeduction, remainingBalanceForEdit } from './depositCalc.js'

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(10.005)).toBeCloseTo(10.01, 2)
    expect(round2(10.001)).toBe(10)
  })
})

describe('calcDepositDeduction', () => {
  it('deducts the full percentage when the balance covers it', () => {
    // 10,000 * 20% = 2,000, remaining balance 5,000 covers it fully
    expect(calcDepositDeduction(10000, 20, 5000)).toBe(2000)
  })

  it('clamps to the remaining balance when the deposit is nearly exhausted', () => {
    // 10,000 * 20% = 2,000 proposed, but only 1,500 remains
    expect(calcDepositDeduction(10000, 20, 1500)).toBe(1500)
  })

  it('returns 0 once the remaining balance is exactly 0', () => {
    expect(calcDepositDeduction(10000, 20, 0)).toBe(0)
  })

  it('returns 0 when depositPct is 0 or falsy (no deposit configured)', () => {
    expect(calcDepositDeduction(10000, 0, 5000)).toBe(0)
    expect(calcDepositDeduction(10000, undefined, 5000)).toBe(0)
  })

  it('returns 0 when noVat is 0 or falsy', () => {
    expect(calcDepositDeduction(0, 20, 5000)).toBe(0)
    expect(calcDepositDeduction(undefined, 20, 5000)).toBe(0)
  })

  it('never goes negative even if remainingBalance is negative (defensive)', () => {
    expect(calcDepositDeduction(10000, 20, -500)).toBe(0)
  })

  it('rounds the result to 2 decimal places', () => {
    // 333.33 * 15% = 49.9995 -> rounds to 50.00
    expect(calcDepositDeduction(333.33, 15, 1000)).toBe(50)
  })
})

describe('remainingBalanceForEdit', () => {
  it('adds the row\'s own prior deduction back onto the current balance', () => {
    // view shows 5,000 remaining AFTER this row already deducted 2,000 --
    // the true balance available when re-editing this row is 7,000
    expect(remainingBalanceForEdit(5000, 2000)).toBe(7000)
  })

  it('returns the balance unchanged for a new row with no prior deduction', () => {
    expect(remainingBalanceForEdit(5000, undefined)).toBe(5000)
    expect(remainingBalanceForEdit(5000, 0)).toBe(5000)
  })

  it('treats a missing site balance as 0', () => {
    expect(remainingBalanceForEdit(undefined, 2000)).toBe(2000)
    expect(remainingBalanceForEdit(null, 2000)).toBe(2000)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- depositCalc`
Expected: FAIL — `Failed to resolve import "./depositCalc.js"` (the module doesn't exist yet)

- [ ] **Step 3: Implement the calculation module**

Create `src/lib/depositCalc.js`:

```js
// ============================================================
// Client deposit (มัดจำ) deduction math -- see
// docs/superpowers/specs/2026-08-19-client-deposit-tracking-design.md.
//
// A 'มัดจำ' income row never deducts from itself. Every 'ปกติ' row for the
// same site auto-deducts a % of its own pre-VAT amount from the site's
// deposit balance, clamped so the running total deducted can never exceed
// the total deposit actually collected.
// ============================================================

export function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * @param {number} noVat - the row's pre-VAT amount
 * @param {number} depositPct - the % to deduct (site.default_deposit_pct,
 *   or a per-row override)
 * @param {number} remainingBalance - the deposit balance available to this
 *   row (site_deposit_summary.remaining_balance, with this row's own prior
 *   deduction added back in via remainingBalanceForEdit if this is an edit)
 * @returns {number} the deposit_deduction to apply, clamped to
 *   [0, remainingBalance], rounded to 2 decimal places
 */
export function calcDepositDeduction(noVat, depositPct, remainingBalance) {
  const proposed = round2((noVat || 0) * (depositPct || 0) / 100)
  const balance  = Math.max(0, remainingBalance || 0)
  return Math.min(proposed, balance)
}

/**
 * Adds a row's own previously-saved deposit_deduction back onto the site's
 * current remaining_balance. Without this, re-editing a row would be
 * charged against a balance that still includes that same row's earlier
 * deduction -- double counting. Pass 0/undefined for a brand-new row.
 */
export function remainingBalanceForEdit(siteRemainingBalance, rowPriorDeduction) {
  return (siteRemainingBalance || 0) + (rowPriorDeduction || 0)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- depositCalc`
Expected: PASS, 11 tests passing (1 round2 + 7 calcDepositDeduction + 3 remainingBalanceForEdit)

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/2026-08-19-03-client-deposit-tracking.sql`:

```sql
-- Client deposit (มัดจำ) tracking -- see
-- docs/superpowers/specs/2026-08-19-client-deposit-tracking-design.md.
-- A deposit is recorded as a real incomes row (income_type = 'มัดจำ');
-- every subsequent 'ปกติ' row for that site auto-deducts a % of its own
-- pre-VAT amount against the deposit balance until it's exhausted (see
-- src/lib/depositCalc.js). This is a separate money flow from client
-- retention (site_retention_summary) and from the labor subcontractor
-- retention system (contractor_summary) -- neither is touched here.
ALTER TABLE sites ADD COLUMN default_deposit_pct NUMERIC DEFAULT 0;

ALTER TABLE incomes ADD COLUMN income_type TEXT NOT NULL DEFAULT 'ปกติ'
  CHECK (income_type IN ('ปกติ', 'มัดจำ'));
ALTER TABLE incomes ADD COLUMN deposit_deduction NUMERIC DEFAULT 0;

-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
CREATE VIEW site_deposit_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.default_deposit_pct,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0) AS total_deposit,
  COALESCE(SUM(i.deposit_deduction), 0)                                    AS total_deducted,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)
    - COALESCE(SUM(i.deposit_deduction), 0)                                AS remaining_balance
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.default_deposit_pct;

-- Widen the module gate to add this paid module, same shape as
-- 2026-08-17-03-purchase-orders-module-key.sql. Not seeding it for any
-- tenant here -- granting access is a separate business decision the
-- user will make later, unlike purchase_orders which had to be seeded
-- immediately for the live FacadeX tenant to avoid locking them out.
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits'));
```

- [ ] **Step 6: Apply the migration to the live database**

Use `mcp__plugin_supabase_supabase__apply_migration` with:
- `project_id`: read from `VITE_SUPABASE_URL` in `.env` (same project used by every prior migration this session — `yyzbgdmgyvvypfcjuhtr`)
- `name`: `client_deposit_tracking`
- `query`: the full SQL from Step 5

- [ ] **Step 7: Verify the migration (read-only checks only)**

Run via `mcp__plugin_supabase_supabase__execute_sql` (SELECT-only — do not run any statement that writes data):

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sites' AND column_name = 'default_deposit_pct';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'incomes' AND column_name IN ('income_type', 'deposit_deduction')
ORDER BY column_name;

SELECT * FROM site_deposit_summary LIMIT 1;

SELECT relname, reloptions FROM pg_class WHERE relname = 'site_deposit_summary';
```

Expected: first query returns 1 row; second returns 2 rows; third succeeds (even if the one row has all-zero deposit columns — that's correct, no site has deposits yet); fourth shows `reloptions` containing `security_invoker=true`.

Then run `mcp__plugin_supabase_supabase__get_advisors` (type: `security`) and confirm no *new* warnings were introduced by this migration (only the same pre-existing warnings noted in the retention-tracking migration's report, if any).

- [ ] **Step 8: Mirror the migration into `supabase/schema.sql`, and fix a pre-existing gap in the same view**

In `supabase/schema.sql`, the `sites` table definition has, at lines 185-188:
```sql
  default_vat_pct           NUMERIC DEFAULT 7,
  default_tax_withheld_pct  NUMERIC DEFAULT 3,
  default_retention_pct     NUMERIC DEFAULT 0,
  default_retention_period_days INTEGER,               -- client retention due date = end_date + this many days; NULL until set explicitly
```
Add a new line immediately after line 188:
```sql
  default_deposit_pct       NUMERIC DEFAULT 0,          -- see site_deposit_summary; 0 = no deposit tracked for this site
```

Find the `incomes` table definition (search for `retention          NUMERIC DEFAULT 0,` inside `CREATE TABLE incomes`) and add two new lines immediately after it:
```sql
  income_type     TEXT NOT NULL DEFAULT 'ปกติ' CHECK (income_type IN ('ปกติ', 'มัดจำ')),
  deposit_deduction NUMERIC DEFAULT 0,
```

Find `CREATE TABLE tenant_modules` and its `CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders'))` line; change it to:
```sql
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits')),
```

Find `CREATE OR REPLACE VIEW site_financial_summary` (around line 1445). Its SELECT list currently ends with:
```sql
  s.has_vat, s.contract_value_no_vat,
  s.default_vat_pct, s.default_tax_withheld_pct, s.default_retention_pct
```
This view backs `useSites()`, which is what populates the Sites edit form. It is missing `default_retention_period_days` -- a pre-existing gap from the retention-tracking feature (confirmed live: 0 sites currently have that column set, so nothing has been silently wiped yet, but re-saving a site that *does* have it set would blank it back to NULL, since the edit form can never see the existing value). Fix this in the same edit that adds the new deposit column, since both need to be selected here for their respective site forms to round-trip correctly:
```sql
  s.default_vat_pct, s.default_tax_withheld_pct, s.default_retention_pct,
  s.default_retention_period_days, s.default_deposit_pct
```

Immediately after the `site_retention_summary` view definition (ends around line 1503 with `s.retention_released, s.retention_released_date;`), add the new view:
```sql

-- Client deposit (มัดจำ) tracking -- see
-- 2026-08-19-03-client-deposit-tracking.sql. Separate money flow from
-- site_retention_summary above -- a deposit is collected once upfront and
-- progressively deducted from later income, retention is withheld from
-- every income and returned once at project close.
CREATE VIEW site_deposit_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.default_deposit_pct,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0) AS total_deposit,
  COALESCE(SUM(i.deposit_deduction), 0)                                    AS total_deducted,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)
    - COALESCE(SUM(i.deposit_deduction), 0)                                AS remaining_balance
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.default_deposit_pct;
```

- [ ] **Step 9: Add the two hooks**

In `src/hooks/useSupabase.js`, immediately after the existing `useSiteRetentionSummary` function (currently ends around line 94 with the closing `}` before the `// ── Expenses` comment), add:

```js
export function useSiteDepositSummary() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_deposit_summary')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}

export function useSiteDepositBalance(siteId) {
  return useQuery(async () => {
    if (!siteId) return null
    const { data, error } = await supabase
      .from('site_deposit_summary')
      .select('*')
      .eq('site_id', siteId)
      .single()
    if (error) throw error
    return data
  }, [siteId])
}
```

- [ ] **Step 10: Run the full test suite and build**

Run: `npm test`
Expected: all existing tests plus the 11 new `depositCalc` tests pass (36 total: 25 existing + 11 new).

Run: `npm run build`
Expected: succeeds with no new errors (only pre-existing chunk-size warnings).

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/2026-08-19-03-client-deposit-tracking.sql supabase/schema.sql src/lib/depositCalc.js src/lib/depositCalc.test.js src/hooks/useSupabase.js
git commit -m "feat: add client deposit tracking (schema + view + calc + hooks)"
```

---

### Task 2: Sites form — deposit % field

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: `sites.default_deposit_pct` (Task 1), `hasModuleAccess(moduleKey)` from `useTenant()` (existing hook, already used in `App.jsx`)
- Produces: nothing new consumed by later tasks (Task 3/4 read `default_deposit_pct` from `useSites()`/`site_deposit_summary` directly, not from this form)

- [ ] **Step 1: Thread `hasModuleAccess` into the Sites page and its form**

In `src/pages/Sites.jsx`, `useTenant` is already imported (line 15). Change line 214 from:
```js
  const { tenant } = useTenant()
```
to:
```js
  const { tenant, hasModuleAccess } = useTenant()
```

Change the `SiteForm` function signature (line 46) from:
```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading }) {
```
to:
```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading, hasModuleAccess = () => false }) {
```

Pass the prop where `SiteForm` is rendered (line 477-483):
```js
          <SiteForm
            initial={editSite || EMPTY_FORM}
            clients={clients || []}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditSite(null) }}
            loading={saving}
            hasModuleAccess={hasModuleAccess}
          />
```

- [ ] **Step 2: Add the field to `EMPTY_FORM`**

Change lines 39-40 from:
```js
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  default_retention_period_days: '',
```
to:
```js
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  default_retention_period_days: '', default_deposit_pct: 0,
```

- [ ] **Step 3: Add the field to the "Income defaults" section**

In the `form-grid-4` block (lines 172-193), add a 5th item after the "ระยะเวลา retention (วัน)" field, gated behind the module (it will wrap to its own row within the existing `form-grid-4` container — no new CSS class needed):

```jsx
            {hasModuleAccess('client_deposits') && (
              <div>
                <label className="label">มัดจำ (%)</label>
                <input type="number" className="input input-sm" min="0" step="0.01"
                  value={form.default_deposit_pct} onChange={e => set('default_deposit_pct', e.target.value)} placeholder="0" />
              </div>
            )}
```

- [ ] **Step 4: Include the field in the save payload**

In `handleSave` (around line 278-281), add a line after `default_retention_period_days`:
```js
        default_retention_period_days: form.default_retention_period_days === '' ? null : parseInt(form.default_retention_period_days, 10),
        default_deposit_pct:       form.default_deposit_pct === '' ? null : parseFloat(form.default_deposit_pct),
```

- [ ] **Step 5: Manual verification (read-only)**

Run: `npm run build`
Expected: succeeds with no new errors.

Run: `npm test`
Expected: all 36 tests still pass (this task touches no tested logic, just form wiring).

Do NOT run any live Supabase write to "test" this — the field's correctness is verified structurally (build succeeds, payload shape matches the migrated column) and will be exercised for real once Task 3 lets you create `'มัดจำ'` income rows against it.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "feat: add deposit % field to the Sites form"
```

---

### Task 3: Income form — deposit type, auto-deduction, and table columns

**Files:**
- Modify: `src/pages/Income.jsx`

**Interfaces:**
- Consumes:
  - `calcDepositDeduction(noVat, depositPct, remainingBalance)`, `remainingBalanceForEdit(siteRemainingBalance, rowPriorDeduction)` from `src/lib/depositCalc.js` (Task 1)
  - `useSiteDepositBalance(siteId)` from `src/hooks/useSupabase.js` (Task 1) — returns `{ data }` where `data` is `null` or a `site_deposit_summary` row (has `.remaining_balance`)
  - `hasModuleAccess(moduleKey)` from `useTenant()` (existing hook)
- Produces: `incomes.income_type`, `incomes.deposit_deduction` populated correctly on every save — consumed by Task 4's `site_deposit_summary` reads (already live via the DB view; no direct JS dependency)

- [ ] **Step 1: Import what this task needs**

At the top of `src/pages/Income.jsx`, change line 10 from:
```js
import { useIncomes, useSites } from '../hooks/useSupabase.js'
```
to:
```js
import { useIncomes, useSites, useSiteDepositBalance } from '../hooks/useSupabase.js'
```

Add two new imports after line 11 (`import { useUserRole } ...`):
```js
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, remainingBalanceForEdit } from '../lib/depositCalc.js'
```

- [ ] **Step 2: Extend `EMPTY_FORM`**

Change line 24-27 from:
```js
const EMPTY_FORM = {
  invoice_no: '', date: '', site_id: '', client_name: '', description: '',
  amount_no_vat: '', vat_pct: '', tax_pct: '', retention_pct: '', received_amount: ''
}
```
to:
```js
const EMPTY_FORM = {
  invoice_no: '', date: '', site_id: '', client_name: '', description: '',
  amount_no_vat: '', vat_pct: '', tax_pct: '', retention_pct: '', received_amount: '',
  income_type: 'ปกติ', deposit_pct: '',
}
```

- [ ] **Step 3: Wire the deposit calculation into `IncomeForm`**

Change the `IncomeForm` function signature (line 29) from:
```js
function IncomeForm({ initial = EMPTY_FORM, sites, onSave, onCancel, loading }) {
```
to:
```js
function IncomeForm({ initial = EMPTY_FORM, sites, onSave, onCancel, loading, hasModuleAccess = () => false }) {
```

Change the calculation block (lines 34-39) from:
```js
  // คำนวณ VAT / Tax ถูกหัก / Retention อัตโนมัติจาก % ของมูลค่าก่อน VAT
  const noVat       = parseFloat(form.amount_no_vat) || 0
  const vatAmt       = noVat * (parseFloat(form.vat_pct)       || 0) / 100
  const taxAmt        = noVat * (parseFloat(form.tax_pct)       || 0) / 100
  const retentionAmt = noVat * (parseFloat(form.retention_pct) || 0) / 100
  const calcReceived = () => noVat + vatAmt - taxAmt - retentionAmt
```
to:
```js
  // คำนวณ VAT / Tax ถูกหัก / Retention อัตโนมัติจาก % ของมูลค่าก่อน VAT
  const noVat       = parseFloat(form.amount_no_vat) || 0
  const vatAmt       = noVat * (parseFloat(form.vat_pct)       || 0) / 100
  const taxAmt        = noVat * (parseFloat(form.tax_pct)       || 0) / 100
  const retentionAmt = noVat * (parseFloat(form.retention_pct) || 0) / 100

  const isDepositRow = form.income_type === 'มัดจำ'
  const depositModuleOn = hasModuleAccess('client_deposits')
  const { data: depositBalance } = useSiteDepositBalance(depositModuleOn ? form.site_id : null)
  // `initial` (not `form`) on purpose -- this must stay the value this row
  // had BEFORE this edit session started, not drift as the user edits
  // other fields. See remainingBalanceForEdit's doc comment.
  const remainingBalance = remainingBalanceForEdit(depositBalance?.remaining_balance, initial?.deposit_deduction)
  const depositAmt = (depositModuleOn && !isDepositRow)
    ? calcDepositDeduction(noVat, parseFloat(form.deposit_pct) || 0, remainingBalance)
    : 0

  const calcReceived = () => noVat + vatAmt - taxAmt - retentionAmt - depositAmt
```

- [ ] **Step 4: Auto-fill `deposit_pct` when the site changes**

Change the `SearchableSelect onChange` handler (lines 70-80) from:
```js
              onChange={id => {
                const site = (sites || []).find(s => s.id === id)
                setForm(f => ({
                  ...f,
                  site_id: id,
                  client_name: site?.client_display_name || site?.client_name || f.client_name,
                  vat_pct:       site?.default_vat_pct          ?? f.vat_pct,
                  tax_pct:       site?.default_tax_withheld_pct ?? f.tax_pct,
                  retention_pct: site?.default_retention_pct    ?? f.retention_pct,
                }))
              }}
```
to:
```js
              onChange={id => {
                const site = (sites || []).find(s => s.id === id)
                setForm(f => ({
                  ...f,
                  site_id: id,
                  client_name: site?.client_display_name || site?.client_name || f.client_name,
                  vat_pct:       site?.default_vat_pct          ?? f.vat_pct,
                  tax_pct:       site?.default_tax_withheld_pct ?? f.tax_pct,
                  retention_pct: site?.default_retention_pct    ?? f.retention_pct,
                  deposit_pct:   site?.default_deposit_pct      ?? f.deposit_pct,
                }))
              }}
```

- [ ] **Step 5: Add the "ประเภทรายรับ" selector**

Immediately after the "รายละเอียด ★" field (lines 92-95) and before the `form-grid-4` block, insert:
```jsx
        {hasModuleAccess('client_deposits') && (
          <div>
            <label className="label">ประเภทรายรับ</label>
            <select className="select" value={form.income_type} onChange={e => set('income_type', e.target.value)}>
              <option value="ปกติ">ปกติ</option>
              <option value="มัดจำ">มัดจำ</option>
            </select>
          </div>
        )}
```

- [ ] **Step 6: Add the "หักมัดจำ (%)" field**

Inside the `form-grid-4` block, immediately after the "Retention (%)" field (lines 114-119), add:
```jsx
          {hasModuleAccess('client_deposits') && !isDepositRow && (
            <div>
              <label className="label">หักมัดจำ (%)</label>
              <input type="number" className="input" min="0" step="0.01" value={form.deposit_pct}
                onChange={e => set('deposit_pct', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {fmt(depositAmt)} บาท (คงเหลือมัดจำ {fmt(remainingBalance)})
              </div>
            </div>
          )}
```

- [ ] **Step 7: Include `income_type`/`deposit_deduction` in the save payload**

Change the `onSubmit` handler's `onSave(...)` call (lines 45-51) from:
```js
      onSave({
        ...form,
        vat: vatAmt.toFixed(2),
        tax_withheld: taxAmt.toFixed(2),
        retention: retentionAmt.toFixed(2),
        received_amount: form.received_amount || calcReceived(),
      })
```
to:
```js
      onSave({
        ...form,
        vat: vatAmt.toFixed(2),
        tax_withheld: taxAmt.toFixed(2),
        retention: retentionAmt.toFixed(2),
        deposit_deduction: depositAmt.toFixed(2),
        received_amount: form.received_amount || calcReceived(),
      })
```

- [ ] **Step 8: Include the new fields in `handleSave`'s DB payload**

In the `Income` component's `handleSave` (lines 176-187), add two lines after `retention`:
```js
        retention:      parseFloat(form.retention) || 0,
        income_type:     form.income_type || 'ปกติ',
        deposit_deduction: parseFloat(form.deposit_deduction) || 0,
        received_amount: parseFloat(form.received_amount) || 0,
```

- [ ] **Step 9: Add `hasModuleAccess` to the `Income` component and pass it to the form**

Change line 141 from:
```js
  const { isAtLeast, role } = useUserRole()
```
to:
```js
  const { isAtLeast, role } = useUserRole()
  const { hasModuleAccess } = useTenant()
```

Pass it into `IncomeForm` (in the Add/Edit Modal, currently ends at line 347 with `loading={saving}`):
```js
            sites={sites}
            onSave={handleSave}
            onCancel={() => { setShowAdd(false); setEditRow(null) }}
            loading={saving}
            hasModuleAccess={hasModuleAccess}
```

- [ ] **Step 10: Carry `income_type`/`deposit_pct` through the edit-row and new-row initial values**

Change the edit-row `initial` object (lines 328-331) from:
```js
            initial={editRow ? {
              ...editRow,
              vat_pct:       editRow.amount_no_vat ? +((editRow.vat||0)           / editRow.amount_no_vat * 100).toFixed(2) : '',
              tax_pct:       editRow.amount_no_vat ? +((editRow.tax_withheld||0)  / editRow.amount_no_vat * 100).toFixed(2) : '',
              retention_pct: editRow.amount_no_vat ? +((editRow.retention||0)     / editRow.amount_no_vat * 100).toFixed(2) : '',
            } : (() => {
```
to:
```js
            initial={editRow ? {
              ...editRow,
              vat_pct:       editRow.amount_no_vat ? +((editRow.vat||0)           / editRow.amount_no_vat * 100).toFixed(2) : '',
              tax_pct:       editRow.amount_no_vat ? +((editRow.tax_withheld||0)  / editRow.amount_no_vat * 100).toFixed(2) : '',
              retention_pct: editRow.amount_no_vat ? +((editRow.retention||0)     / editRow.amount_no_vat * 100).toFixed(2) : '',
              income_type:   editRow.income_type || 'ปกติ',
              deposit_pct:   editRow.amount_no_vat ? +((editRow.deposit_deduction||0) / editRow.amount_no_vat * 100).toFixed(2) : '',
            } : (() => {
```

Change the new-row initial value builder (lines 332-341) from:
```js
              const site = (sites || []).find(s => s.id === siteId)
              return {
                ...EMPTY_FORM,
                site_id: siteId,
                client_name: site?.client_display_name || site?.client_name || '',
                vat_pct:       site?.default_vat_pct          ?? EMPTY_FORM.vat_pct,
                tax_pct:       site?.default_tax_withheld_pct ?? EMPTY_FORM.tax_pct,
                retention_pct: site?.default_retention_pct    ?? EMPTY_FORM.retention_pct,
              }
```
to:
```js
              const site = (sites || []).find(s => s.id === siteId)
              return {
                ...EMPTY_FORM,
                site_id: siteId,
                client_name: site?.client_display_name || site?.client_name || '',
                vat_pct:       site?.default_vat_pct          ?? EMPTY_FORM.vat_pct,
                tax_pct:       site?.default_tax_withheld_pct ?? EMPTY_FORM.tax_pct,
                retention_pct: site?.default_retention_pct    ?? EMPTY_FORM.retention_pct,
                deposit_pct:   site?.default_deposit_pct      ?? EMPTY_FORM.deposit_pct,
              }
```

- [ ] **Step 11: Add a "หักมัดจำ" column to the transactions table**

This table already breaks out VAT/Tax/Retention per row (lines 271-291) — without a matching column here, `received_amount` would change with no visible line item explaining why, which would look like a display bug. Add the column in the same style.

Change the `<thead>` row (lines 265-277) — add a new `<th>` after `<th>Retention</th>`:
```jsx
                <th>Retention</th>
                <th>หักมัดจำ</th>
                <th>ยอดรับจริง</th>
```

Change the `<tbody>` row (lines 280-300) — add a new `<td>` after the Retention `<td>`:
```jsx
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.retention > 0 ? fmt(i.retention) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.deposit_deduction > 0 ? fmt(i.deposit_deduction) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(i.received_amount)}</td>
```

Update the "no rows" placeholder's `colSpan` (there are now 12 columns, not 11) at line 303:
```jsx
                <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบรายรับในช่วงเวลานี้</td></tr>
```

- [ ] **Step 12: Add the deposit total to the footer**

Add a `totalDeposit` memo next to the existing totals (lines 166-169):
```js
  const totalReceived   = useMemo(() => (incomes || []).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const totalNoVat      = useMemo(() => (incomes || []).reduce((s, i) => s + (i.amount_no_vat || 0), 0), [incomes])
  const totalTax        = useMemo(() => (incomes || []).reduce((s, i) => s + (i.tax_withheld || 0), 0), [incomes])
  const totalRetention  = useMemo(() => (incomes || []).reduce((s, i) => s + (i.retention || 0), 0), [incomes])
  const totalDeposit    = useMemo(() => (incomes || []).reduce((s, i) => s + (i.deposit_deduction || 0), 0), [incomes])
```

Update the `<tfoot>` row (lines 306-318) to add a matching cell after the Retention total cell:
```jsx
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalRetention)}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalDeposit)}</td>
                  <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalReceived)}</td>
```

- [ ] **Step 13: Verify**

Run: `npm test`
Expected: all 36 tests pass (this task adds no new test file — its logic is already covered by Task 1's `depositCalc.test.js`; this task is integration wiring).

Run: `npm run build`
Expected: succeeds with no new errors.

- [ ] **Step 14: Commit**

```bash
git add src/pages/Income.jsx
git commit -m "feat: add deposit type and auto-deduction to the Income form"
```

---

### Task 4: Deposits summary tab

**Files:**
- Create: `src/pages/Deposits.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `useSiteDepositSummary()` from `src/hooks/useSupabase.js` (Task 1) — array of rows with `site_id, site_number, name, default_deposit_pct, total_deposit, total_deducted, remaining_balance`

- [ ] **Step 1: Create the page**

Create `src/pages/Deposits.jsx`:

```jsx
// ============================================================
// Deposits — สรุปยอดมัดจำ (client deposit) คงเหลือต่อไซท์งาน
// ✅ อ่านอย่างเดียว -- การหักมัดจำเกิดอัตโนมัติทุกครั้งที่บันทึกรายรับ
//    'ปกติ' ในหน้า Income ไม่มี action ใดๆ ในหน้านี้
// ============================================================
import { useSiteDepositSummary } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'

function statusFor(row) {
  if (row.remaining_balance > 0) return { label: 'คงเหลือ', cls: 'badge-paid' }
  return { label: 'หักครบแล้ว', cls: 'badge-finished' }
}

export default function Deposits() {
  const { data: rows } = useSiteDepositSummary()

  const visible = (rows || []).filter(r => r.total_deposit > 0)

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>💰 มัดจำ</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          สรุปยอดมัดจำที่เก็บจากลูกค้าต่อไซท์งาน และยอดคงเหลือหลังหักอัตโนมัติจากรายรับแต่ละงวด
        </p>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ไซท์งาน</th>
                <th>% มัดจำ</th>
                <th>ยอดมัดจำที่เก็บ</th>
                <th>หักไปแล้ว</th>
                <th>คงเหลือ</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => {
                const status = statusFor(row)
                return (
                  <tr key={row.site_id}>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</td>
                    <td className="font-mono" style={{ fontSize: 12, color: 'var(--text2)' }}>{row.default_deposit_pct ?? 0}%</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(row.total_deposit)}</td>
                    <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(row.total_deducted)}</td>
                    <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(row.remaining_balance)}</td>
                    <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                  </tr>
                )
              })}
              {!visible.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีไซท์งานที่มีมัดจำ</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `App.jsx`**

Add the lazy import. In `src/App.jsx`, immediately after the `Retention` lazy import (line 29):
```js
const Retention           = lazy(() => import('./pages/Retention.jsx'))
const Deposits             = lazy(() => import('./pages/Deposits.jsx'))
```

Add the `TABS` entry immediately after the `retention` entry (line 39):
```js
  { id: 'retention',         label: '🔒 Retention',            minRole: 'ADMIN',  module: null },
  { id: 'deposits',          label: '💰 มัดจำ',                minRole: 'ADMIN',  module: 'client_deposits' },
```

Add the `renderPage()` case immediately after the `retention` case (line 117):
```js
      case 'retention':  return <ProtectedPage minRole="ADMIN"><Retention  {...props} /></ProtectedPage>
      case 'deposits':   return <ProtectedPage minRole="ADMIN"><Deposits   {...props} /></ProtectedPage>
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: all 36 tests pass.

Run: `npm run build`
Expected: succeeds; confirm a new `Deposits-*.js` chunk appears in the build output (same lazy-split pattern as `Retention-*.js`).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Deposits.jsx src/App.jsx
git commit -m "feat: add Deposits tab to view client deposit balances per site"
```
