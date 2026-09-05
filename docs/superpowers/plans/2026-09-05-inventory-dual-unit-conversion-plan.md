# Inventory Dual-Unit Conversion (Glass & Aluminum) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Purchase Orders correctly convert glass (bought by sheet, stocked by ตรม.) and aluminum profiles (bought by rod, stocked by กก. pooled per color) into the inventory ledger's base units, plus a sheet-count estimate report and Excel bulk-import for the two new master-data tables this requires.

**Architecture:** Two new master-data concepts — a `unit_conversion_mode` flag on `inventory_items` and a standalone `aluminum_profiles` lookup table — feed two new branches into `PurchaseOrders.jsx`'s existing `receiveStockPlan()` function, which already is the single source of truth both the receive-confirm preview and the actual `record_stock_movement()` RPC call read from. Nothing about the stock ledger itself (`inventory_stock_balances`, `stock_movements`, the RPC) changes — every new calculation happens client-side, before that already-shipped, already-reviewed machinery is called exactly as it is today.

**Tech Stack:** React + Vite, Supabase (Postgres + PostgREST + RLS), vitest for pure-JS logic, Playwright for live verification, the `xlsx` npm package (already a dependency) for both parsing uploaded Excel and generating the two new template files.

**Spec:** `docs/superpowers/specs/2026-09-05-inventory-dual-unit-conversion-design.md` — read it in full before touching any task. This plan implements every section of that spec, including its Excel bulk-import addendum.

## Global Constraints

- Live Supabase project `yyzbgdmgyvvypfcjuhtr`, no local Postgres. Migration workflow: dry-run in `execute_sql` (`BEGIN;...ROLLBACK;`), then `apply_migration` (takes effect on production immediately), then write the identical SQL to `supabase/migrations/YYYY-MM-DD-NN-<name>.sql`, then update `supabase/schema.sql`. Today's date is 2026-09-05; the last-used suffix is `-09` (from tonight's earlier Phase 1 work), so this plan's migration is `-10`.
- **CRITICAL test-isolation rule, learned the hard way earlier tonight:** one implementer on the prior plan tested a security-relevant RPC against the REAL FacadeX company production tenant instead of an isolated one, and the work had to be redone. Every task's live verification in THIS plan must use a freshly-created, disposable test tenant with a unique email (e.g. `dualunit-taskN@facadex-test.local`) via the standard `auth.users`/`auth.identities` INSERT pattern below — never any real/existing tenant, site, item, or profile.
  ```sql
  BEGIN;
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    '<unique-email>@facadex-test.local', crypt('testpassword123', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(),
    '', '', '', ''
  );
  INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  SELECT gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
  FROM auth.users u WHERE u.email = '<unique-email>@facadex-test.local';
  -- tenants/user_roles auto-created by handle_new_user() trigger. Never insert those two directly.
  COMMIT;
  ```
  New tenant owners get an active trial (`has_module_access()` returns true during trial), so no extra module-grant step is needed. Clean up fully afterward in FK-dependency order, verified with a final 0-row count query.
- No unit test runner beyond the real vitest suite at the repo root (90 passing tests as of tonight, in `src/lib/*.test.js`). New pure-JS logic gets real tests in the existing `src/lib/inventoryCost.test.js` file (append to it — it already tests the same module's `computeWeightedAverageCost`/`convertToBaseUnit`). Every UI/integration task additionally verifies live: `npx vite build`, a throwaway test tenant, Playwright against `http://localhost:5199`, full cleanup, then commit + push directly to `main` (`git fetch origin main`, confirm `git log HEAD..origin/main --oneline` is empty, then `git push origin worktree-quotation-module:main`).
- **Playwright:** log in via the real login form. No client-side router — navigate via `await page.evaluate(() => sessionStorage.setItem('pendingTab', 'inventory'))` then `await page.reload()`.
- **Sandbox note:** multi-line heredoc bash commands are rejected as "too complex to verify." Write commit messages to a plain temp file first, then `git commit -F <file>`.
- **RLS consistency:** the new `aluminum_profiles` table's RLS must be gated `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')` — the exact same shape as every other table in the inventory module, per Ruling A from tonight's earlier Phase 1 plan (this is still buying-side functionality, not a new paid module).
- **Single-source-of-truth discipline, hard-won tonight:** `receiveStockPlan()` in `PurchaseOrders.jsx` is read by BOTH the receive-confirm preview (`ConfirmDialog`'s `message`) and the actual RPC-posting loop inside `handleReceive`. Every new conversion branch this plan adds to that function automatically satisfies this discipline as long as it stays inside that one function — do not compute glass/aluminum conversions a second time anywhere else.
- **Payload round-trip discipline, learned from a near-miss tonight:** the prior plan's Task 5 brief initially forgot to list a required field in `handleSave`'s `itemsPayload` mapping, and the implementer had to catch and fix it themselves. Every new field this plan adds to a PO line item (`aluminum_profile_id`, `rod_length_m`, `glass_width_m`, `glass_height_m`) MUST appear in all four places: `EMPTY_ITEM`, `editFormInitial`'s `.map()`, `handleSave`'s `itemsPayload` mapping, AND `usePurchaseOrders()`'s `.select()` string (so `receiveStockPlan()` can actually read the values back from a loaded PO) — Task 4 below lists all four explicitly; treat that list as a checklist, not a suggestion.
- **Type/name consistency across tasks:** hooks are `useAluminumProfiles()` (active-only) and `useAllAluminumProfiles()` (all, for management), mirroring `useInventoryItems()`/`useAllInventoryItems()` exactly. Pure-JS helpers are `computeAluminumWeightKg(rodCount, lengthM, linearWeightKgPerM)`, `computeGlassAreaSqm(sheetCount, widthM, heightM)`, `estimateSheetCount(areaSqm, referenceAreaSqm)`, all added to the existing `src/lib/inventoryCost.js`.

---

### Task 1: Migration — `unit_conversion_mode`, `aluminum_profiles`, PO-item conversion fields

**Files:**
- Create: `supabase/migrations/2026-09-05-10-dual-unit-conversion.sql`
- Modify: `supabase/schema.sql` — `inventory_items`' table definition (currently `supabase/schema.sql:728-735`) gains 2 columns; a new `aluminum_profiles` section is inserted after the existing `inventory_item_unit_factors` RLS block; `purchase_order_items`' table definition (currently `supabase/schema.sql:657-668`) gains 4 columns.

**Interfaces:**
- Produces: `inventory_items.unit_conversion_mode TEXT NOT NULL DEFAULT 'plain' CHECK (IN ('plain','aluminum_profile','glass_dimension'))`; `inventory_items.reference_area_sqm NUMERIC` (nullable); table `aluminum_profiles(id, tenant_id, name, linear_weight_kg_per_m, default_length_m, active, created_at)`; `purchase_order_items.aluminum_profile_id UUID NULL REFERENCES aluminum_profiles(id) ON DELETE SET NULL`, `.rod_length_m NUMERIC`, `.glass_width_m NUMERIC`, `.glass_height_m NUMERIC` (all nullable).

- [ ] **Step 1: Dry-run the migration**

```sql
ALTER TABLE inventory_items ADD COLUMN unit_conversion_mode TEXT NOT NULL DEFAULT 'plain'
  CHECK (unit_conversion_mode IN ('plain', 'aluminum_profile', 'glass_dimension'));
ALTER TABLE inventory_items ADD COLUMN reference_area_sqm NUMERIC;

CREATE TABLE aluminum_profiles (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                   TEXT NOT NULL,
  linear_weight_kg_per_m NUMERIC NOT NULL,
  default_length_m       NUMERIC NOT NULL DEFAULT 6.4,
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aluminum_profiles_tenant_id ON aluminum_profiles(tenant_id);

ALTER TABLE aluminum_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON aluminum_profiles FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

ALTER TABLE purchase_order_items ADD COLUMN aluminum_profile_id UUID REFERENCES aluminum_profiles(id) ON DELETE SET NULL;
ALTER TABLE purchase_order_items ADD COLUMN rod_length_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_width_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_height_m NUMERIC;
```

Run via `execute_sql` wrapped in `BEGIN; ... ROLLBACK;`. Expected: no errors.

- [ ] **Step 2: Apply live via `apply_migration`**

Use the exact SQL from Step 1 (without the `BEGIN`/`ROLLBACK` wrapper).

- [ ] **Step 3: Verify schema state**

```sql
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_name = 'inventory_items' AND column_name IN ('unit_conversion_mode', 'reference_area_sqm');
SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'aluminum_profiles';
SELECT policyname FROM pg_policies WHERE tablename = 'aluminum_profiles';
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'purchase_order_items' AND column_name IN ('aluminum_profile_id', 'rod_length_m', 'glass_width_m', 'glass_height_m');
```

Expected: `unit_conversion_mode` non-nullable with default `'plain'`, `reference_area_sqm` nullable; `aluminum_profiles` has `rowsecurity = true` and one `admin_full_access` policy; all 4 new `purchase_order_items` columns present and nullable.

- [ ] **Step 4: Live-verify with a real session**

Create a throwaway test tenant (`dualunit-task1@facadex-test.local`). Log in via Playwright, extract the real `access_token` from `localStorage` (read `SUPABASE_URL` and the anon key from `src/lib/supabase.js`). Via `page.evaluate` + `fetch()`:
1. `POST` to `.../rest/v1/aluminum_profiles` with `{"name":"Test Profile","linear_weight_kg_per_m":1.0}` — expect `201`, and `default_length_m` comes back as `6.4` (the column default).
2. `POST` to `.../rest/v1/inventory_items` with `{"name":"Test Glass","base_unit":"ตรม.","unit_conversion_mode":"glass_dimension","reference_area_sqm":2.88}` — expect `201`.
3. `POST` to `.../rest/v1/inventory_items` with `{"name":"Bad Mode Item","base_unit":"kg","unit_conversion_mode":"not_a_real_mode"}` — expect rejection (the CHECK constraint firing, `400`/`23514`).

- [ ] **Step 5: Clean up the test tenant**

FK order: `aluminum_profiles` (test row) → `inventory_items` (test rows) → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 6: Write the migration file**

`supabase/migrations/2026-09-05-10-dual-unit-conversion.sql`, containing the exact SQL from Step 1, preceded by:

```sql
-- ============================================================
-- Inventory dual-unit conversion for glass & aluminum.
-- See docs/superpowers/specs/2026-09-05-inventory-dual-unit-conversion-design.md
-- and docs/superpowers/plans/2026-09-05-inventory-dual-unit-conversion-plan.md.
-- ============================================================
```

- [ ] **Step 7: Update `supabase/schema.sql`**

Add `unit_conversion_mode` and `reference_area_sqm` to the `inventory_items` table definition (currently ending `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` at line 734, before the closing `);` at line 735) — add both new columns right after `active`. Insert the full `aluminum_profiles` section (with its own header comment referencing this plan) immediately after the existing `inventory_item_unit_factors` RLS policy block. Add the 4 new columns to `purchase_order_items`' table definition (currently ending `inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL` at line 667, before the closing `);` at line 668) — add all 4 right after `inventory_item_id`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-05-10-dual-unit-conversion.sql supabase/schema.sql
git commit -m "feat: dual-unit conversion schema (aluminum profiles, glass mode, PO fields)"
```

---

### Task 2: hooks + pure-JS conversion helpers

**Files:**
- Modify: `src/hooks/useSupabase.js` — add two new hooks right after the existing `useAllInventoryItems()` function (currently ending around line 1132), and extend `useStockBalances()`'s embed (currently `supabase/schema.sql`... actually `src/hooks/useSupabase.js:1149-1158`, the `.select('*, inventory_items(name, base_unit), sites(name, site_number))'` string).
- Modify: `src/lib/inventoryCost.js` — append 3 new functions.
- Modify: `src/lib/inventoryCost.test.js` — append tests for the 3 new functions.

**Interfaces:**
- Produces: `useAluminumProfiles()` (active-only, for the PO-line picker), `useAllAluminumProfiles()` (all, for the Inventory page's own management list) — both return `{ data, loading, error, refetch }` via the existing `useQuery` helper. `computeAluminumWeightKg(rodCount, lengthM, linearWeightKgPerM)`, `computeGlassAreaSqm(sheetCount, widthM, heightM)`, `estimateSheetCount(areaSqm, referenceAreaSqm)` — all pure functions, no side effects.
- Consumes: `useQuery`, `supabase` (already imported at the top of `useSupabase.js`).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/inventoryCost.test.js`:

```js
describe('computeAluminumWeightKg', () => {
  it('rods × length × linear weight', () => {
    expect(computeAluminumWeightKg(20, 6.4, 1.0)).toBeCloseTo(128)
  })
  it('matches the spec example: 1 rod, 6.4m, 1.0 kg/m -> 6.4 kg', () => {
    expect(computeAluminumWeightKg(1, 6.4, 1.0)).toBeCloseTo(6.4)
  })
})

describe('computeGlassAreaSqm', () => {
  it('matches the spec example: 1 sheet, 1.2m x 2.4m -> 2.88 sqm', () => {
    expect(computeGlassAreaSqm(1, 1.2, 2.4)).toBeCloseTo(2.88)
  })
  it('multiple sheets of the same size', () => {
    expect(computeGlassAreaSqm(5, 1.2, 2.4)).toBeCloseTo(14.4)
  })
})

describe('estimateSheetCount', () => {
  it('divides pooled area by the reference sheet size', () => {
    expect(estimateSheetCount(45.5, 2.88)).toBeCloseTo(15.8, 1)
  })
  it('returns null when no reference size is set', () => {
    expect(estimateSheetCount(45.5, null)).toBe(null)
    expect(estimateSheetCount(45.5, 0)).toBe(null)
  })
})
```

Also update the top-of-file import to include the 3 new names:

```js
import { computeWeightedAverageCost, convertToBaseUnit, computeAluminumWeightKg, computeGlassAreaSqm, estimateSheetCount } from './inventoryCost.js'
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/inventoryCost.test.js
```

Expected: FAIL — the 3 new functions don't exist yet.

- [ ] **Step 3: Implement**

Append to `src/lib/inventoryCost.js`:

```js
/** Weight in kg of `rodCount` rods, each `lengthM` meters long, of a
 *  profile whose linear weight is `linearWeightKgPerM` kg per meter.
 *  Matches docs/superpowers/specs/2026-09-05-inventory-dual-unit-conversion-design.md's
 *  aluminum decision #3/#4. */
export function computeAluminumWeightKg(rodCount, lengthM, linearWeightKgPerM) {
  return rodCount * lengthM * linearWeightKgPerM
}

/** Area in sqm of `sheetCount` sheets, each `widthM` x `heightM` meters.
 *  Matches the same spec's glass decision #1. */
export function computeGlassAreaSqm(sheetCount, widthM, heightM) {
  return sheetCount * widthM * heightM
}

/** Approximate physical sheet count for a pooled area balance, per the
 *  same spec's decision #2 (a nominal estimate, not an exact lot count).
 *  Returns null when no reference size is configured, rather than
 *  dividing by zero/null and showing a meaningless number. */
export function estimateSheetCount(areaSqm, referenceAreaSqm) {
  if (!referenceAreaSqm) return null
  return areaSqm / referenceAreaSqm
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/inventoryCost.test.js
```

Expected: all tests PASS (6 new + the 6 existing from Phase 1 = 12 in this file).

- [ ] **Step 5: Add the hooks + extend `useStockBalances()`**

In `src/hooks/useSupabase.js`, right after `useAllInventoryItems()` (currently ending around line 1132), add:

```js
/** Every active aluminum profile, for the PO-line profile picker (a
 *  picker should only offer active profiles). */
export function useAluminumProfiles() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('aluminum_profiles')
      .select('*')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return data
  })
}

/** Every aluminum profile regardless of active flag, for the Inventory
 *  page's own profile-management list -- mirrors useAllInventoryItems(). */
export function useAllAluminumProfiles() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('aluminum_profiles')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}
```

Change `useStockBalances()`'s `.select()` string (currently, at what is today line 1153):

```js
      .select('*, inventory_items(name, base_unit), sites(name, site_number)')
```

to:

```js
      .select('*, inventory_items(name, base_unit, unit_conversion_mode, reference_area_sqm), sites(name, site_number)')
```

(This is needed so the valuation report in Task 3 can compute the sheet-count estimate without a second query.)

- [ ] **Step 6: Build**

```bash
npx vite build
```

Expected: succeeds (these hooks aren't imported anywhere yet — this just confirms no syntax errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js src/hooks/useSupabase.js
git commit -m "feat: aluminum-profile hooks + weight/area/sheet-count conversion helpers"
```

---

### Task 3: `Inventory.jsx` — conversion-mode selector, Profile Master CRUD, sheet-count report

**Files:**
- Modify: `src/pages/Inventory.jsx` (full file read in this plan's research; key anchors below use tonight's current line numbers).

**Interfaces:**
- Consumes: `useAluminumProfiles`, `useAllAluminumProfiles`, `useStockBalances` (Task 2's extended embed), `estimateSheetCount` (Task 2).
- Produces: no new exports — extends the existing page component only.

- [ ] **Step 1: Add the conversion-mode selector + reference-area field to `ItemForm`**

Change `EMPTY_ITEM_FORM` (currently line 19):

```js
const EMPTY_ITEM_FORM = { name: '', base_unit: '', unit_conversion_mode: 'plain', reference_area_sqm: '', active: true }
```

In `ItemForm`'s render (currently lines 36-62), insert this block right after the "หน่วยหลัก" field (after the closing `</div>` at line 46, before the `{!isAdd && (...)}` block):

```jsx
        <div>
          <label className="label">รูปแบบการแปลงหน่วยตอนรับของ</label>
          <select className="select" value={form.unit_conversion_mode} onChange={e => set('unit_conversion_mode', e.target.value)}>
            <option value="plain">ปกติ (ใช้หน่วยแปลงคงที่ ถ้ามีตั้งไว้)</option>
            <option value="aluminum_profile">อลูมิเนียม (เลือกหน้าตัด + ความยาว ตอนรับของ)</option>
            <option value="glass_dimension">กระจก (กรอกกว้าง×ยาว ตอนรับของ)</option>
          </select>
        </div>
        {form.unit_conversion_mode === 'glass_dimension' && (
          <div>
            <label className="label">ขนาดแผ่นอ้างอิง (ตรม.) — สำหรับรายงานประมาณจำนวนแผ่น</label>
            <input className="input" type="number" min="0" step="0.01" value={form.reference_area_sqm}
              onChange={e => set('reference_area_sqm', e.target.value)} placeholder="เช่น 2.88 (สำหรับแผ่น 1.2×2.4ม.)" />
          </div>
        )}
```

- [ ] **Step 2: Persist the new fields in `handleSave`**

Change `handleSave`'s payload (currently line 137):

```js
      const payload = { name: form.name, base_unit: form.base_unit, active: form.active !== false }
```

to:

```js
      const payload = {
        name: form.name, base_unit: form.base_unit, active: form.active !== false,
        unit_conversion_mode: form.unit_conversion_mode || 'plain',
        reference_area_sqm: form.reference_area_sqm ? parseFloat(form.reference_area_sqm) : null,
      }
```

- [ ] **Step 3: Add the Profile Master CRUD section**

Add a new component right after `UnitFactorsPanel` (currently ending line 109), before the `export default function Inventory()` declaration:

```jsx
const EMPTY_PROFILE_FORM = { name: '', linear_weight_kg_per_m: '', default_length_m: '6.4' }

function ProfileForm({ initial = EMPTY_PROFILE_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('aluminum-profile-form', { ...EMPTY_PROFILE_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อหน้าตัด ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น หน้าตัด X" />
        </div>
        <div>
          <label className="label">น้ำหนัก (กก./เมตร) ★</label>
          <input className="input" required type="number" min="0" step="0.0001" value={form.linear_weight_kg_per_m}
            onChange={e => set('linear_weight_kg_per_m', e.target.value)} />
        </div>
        <div>
          <label className="label">ความยาวมาตรฐาน (เมตร)</label>
          <input className="input" type="number" min="0" step="0.01" value={form.default_length_m}
            onChange={e => set('default_length_m', e.target.value)} placeholder="ค่าเริ่มต้น 6.4" />
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}
```

(`ProfileForm`'s edit-mode `active` checkbox needs `initial.active` carried through; `EMPTY_PROFILE_FORM` doesn't include `active` since new profiles always default to `true` server-side via the column default — only the edit path reads `form.active`, seeded from `initial` via `{ ...EMPTY_PROFILE_FORM, ...initial }`.)

- [ ] **Step 4: Wire the profiles view into the main component**

In the `Inventory` component (currently starting line 111), add to the hook calls (after line 122's `const { data: balances } = useStockBalances()`):

```js
  const { data: profiles, refetch: refetchProfiles } = useAllAluminumProfiles()
```

Add new state (after line 129's `const [saving, setSaving] = useState(false)`):

```js
  const [showProfileForm, setShowProfileForm] = useState(false)
  const [editProfile, setEditProfile] = useState(null)
  const [deleteProfileId, setDeleteProfileId] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)
```

Add handlers (after `handleDelete`, currently ending line 155):

```js
  const handleSaveProfile = async (form) => {
    setSavingProfile(true)
    try {
      const payload = {
        name: form.name,
        linear_weight_kg_per_m: parseFloat(form.linear_weight_kg_per_m) || 0,
        default_length_m: form.default_length_m ? parseFloat(form.default_length_m) : 6.4,
        active: form.active !== false,
      }
      if (editProfile) {
        const { error } = await supabase.from('aluminum_profiles').update(payload).eq('id', editProfile.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('aluminum_profiles').insert(payload)
        if (error) throw error
      }
      setShowProfileForm(false); setEditProfile(null); refetchProfiles()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingProfile(false) }
  }

  const handleDeleteProfile = async () => {
    if (!deleteProfileId) return
    const { error } = await supabase.from('aluminum_profiles').delete().eq('id', deleteProfileId)
    if (!error) { setDeleteProfileId(null); refetchProfiles() }
    else alert('ลบไม่สำเร็จ (อาจมีใบสั่งซื้อผูกอยู่): ' + error.message)
  }
```

Add a 4th view button to the view-toggle row (currently lines 159-163):

```jsx
        <button className={`btn btn-sm ${view === 'profiles' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('profiles')}>🔧 หน้าตัดอลูมิเนียม</button>
```

Add the profiles view block right after the `{view === 'movements' && (...)}` block (currently ending line 245):

```jsx
      {view === 'profiles' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditProfile(null); setShowProfileForm(true) }}>+ เพิ่มหน้าตัด</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อหน้าตัด</th><th>กก./เมตร</th><th>ความยาวมาตรฐาน</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(profiles || []).map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td className="font-mono">{fmt(p.linear_weight_kg_per_m)}</td>
                      <td className="font-mono">{fmt(p.default_length_m)} ม.</td>
                      <td>{p.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditProfile(p); setShowProfileForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteProfileId(p.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(profiles || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีหน้าตัด</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
```

Add the profile modal + confirm-dialog right after the existing `{deleteId && (...)}` block (currently ending line 260):

```jsx
      {showProfileForm && (
        <Modal title={editProfile ? `แก้ไข ${editProfile.name}` : 'เพิ่มหน้าตัดใหม่'} onClose={() => { setShowProfileForm(false); setEditProfile(null) }} maxWidth={480}>
          <ProfileForm initial={editProfile || EMPTY_PROFILE_FORM} onSave={handleSaveProfile} onCancel={() => { setShowProfileForm(false); setEditProfile(null) }} loading={savingProfile} />
        </Modal>
      )}

      {deleteProfileId && (
        <ConfirmDialog title="ลบหน้าตัด" message="ยืนยันการลบ? (ถ้ามีใบสั่งซื้อผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDeleteProfile} onCancel={() => setDeleteProfileId(null)} />
      )}
```

- [ ] **Step 5: Add the sheet-count estimate column to the valuation view**

Change the `'stock'` view's table (currently lines 200-201) header:

```jsx
              <thead><tr><th>สินค้า</th><th>ไซท์งาน</th><th>คงเหลือ</th><th>ต้นทุนเฉลี่ย/หน่วย</th><th>มูลค่ารวม</th></tr></thead>
```

to:

```jsx
              <thead><tr><th>สินค้า</th><th>ไซท์งาน</th><th>คงเหลือ</th><th>ต้นทุนเฉลี่ย/หน่วย</th><th>มูลค่ารวม</th><th>จำนวนแผ่นโดยประมาณ</th></tr></thead>
```

Add a new `<td>` at the end of each row (currently the row ends at line 209 with the "มูลค่ารวม" `<td>`, right before the closing `</tr>` at line 210):

```jsx
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>
                      {(() => {
                        const est = estimateSheetCount(b.quantity_on_hand, b.inventory_items?.reference_area_sqm)
                        return est != null ? `≈ ${fmt(est)} แผ่น (อ้างอิง ${fmt(b.inventory_items.reference_area_sqm)} ตรม./แผ่น)` : '—'
                      })()}
                    </td>
```

Update the empty-state row's `colSpan` (currently `colSpan={5}` at line 212) to `colSpan={6}`.

Add `estimateSheetCount` to the import from `../lib/inventoryCost.js` (this file doesn't import from there yet — add the import line near the top, after the existing `import { fmt } from '../lib/supabase.js'` line):

```js
import { estimateSheetCount } from '../lib/inventoryCost.js'
```

- [ ] **Step 6: Add hook imports**

Update the top-of-file hook import (currently line 11):

```js
import { useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useStockMovements, useAllAluminumProfiles } from '../hooks/useSupabase.js'
```

- [ ] **Step 7: Build**

```bash
npx vite build
```

- [ ] **Step 8: Live-verify**

Create a throwaway test tenant (`dualunit-task3@facadex-test.local`). Log in via Playwright, navigate to `inventory` (`sessionStorage.setItem('pendingTab', 'inventory')` + reload). Click "+ เพิ่มสินค้าคงคลัง", select "กระจก (กรอกกว้าง×ยาว ตอนรับของ)" as the conversion mode, confirm the "ขนาดแผ่นอ้างอิง" field appears, fill it with `2.88`, save. Reopen the item's edit form, confirm both the mode and the reference area persisted correctly. Switch to "🔧 หน้าตัดอลูมิเนียม", add a profile (name, `1.0` kg/m, leave length blank), confirm it saves with `default_length_m = 6.4`. Via `execute_sql`, insert one `inventory_stock_balances` row for the glass item with `quantity_on_hand = 45.5` at any test site, reload the "💰 มูลค่าสต็อก" view, confirm the new column shows `≈ 15.8 แผ่น (อ้างอิง 2.88 ตรม./แผ่น)` (matching Task 2's vitest case for the same numbers).

- [ ] **Step 9: Clean up the test tenant**

FK order: `inventory_stock_balances` → `inventory_items` → `aluminum_profiles` → `sites` (if any created) → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 10: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: conversion-mode selector, aluminum profile CRUD, sheet-count estimate report"
git push origin worktree-quotation-module:main
```

---

### Task 4: `PurchaseOrders.jsx` — profile/dimension inputs + `receiveStockPlan()` extension

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx` (full file read in this plan's research; anchors below use tonight's current line numbers — this file was already modified twice tonight by the Phase 1 plan).
- Modify: `src/hooks/useSupabase.js` — `usePurchaseOrders()`'s `.select()` string.

**Interfaces:**
- Consumes: `useAluminumProfiles` (Task 2), `computeAluminumWeightKg`, `computeGlassAreaSqm` (Task 2), `inventory_items.unit_conversion_mode` (Task 1).
- Produces: no new exports — extends `receiveStockPlan()`, `ItemsEditor`, `PurchaseOrderForm`, `EMPTY_ITEM`, `editFormInitial`, `handleSave` in place.

- [ ] **Step 1: Add the 4 new fields to `usePurchaseOrders()`'s select string**

In `src/hooks/useSupabase.js`, find `usePurchaseOrders()` (its `.select()` currently reads, in relevant part, `purchase_order_items(id, description, quantity, unit, unit_price, line_total, inventory_item_id)`). Change that embed to:

```js
purchase_order_items(id, description, quantity, unit, unit_price, line_total, inventory_item_id, aluminum_profile_id, rod_length_m, glass_width_m, glass_height_m)
```

**This step is required** — without it, `receiveStockPlan()` (Step 4 below) cannot read the new fields back from a loaded PO at all, since PostgREST only returns columns explicitly listed in `.select()`.

- [ ] **Step 2: Add the 4 new fields everywhere a PO line item's shape is defined**

Change `EMPTY_ITEM` (currently line 37):

```js
const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '', inventory_item_id: '', aluminum_profile_id: '', rod_length_m: '', glass_width_m: '', glass_height_m: '' }
```

Change `editFormInitial`'s `.map()` (currently line 534):

```js
        .map(it => ({
          description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price),
          inventory_item_id: it.inventory_item_id || '',
          aluminum_profile_id: it.aluminum_profile_id || '',
          rod_length_m: it.rod_length_m != null ? String(it.rod_length_m) : '',
          glass_width_m: it.glass_width_m != null ? String(it.glass_width_m) : '',
          glass_height_m: it.glass_height_m != null ? String(it.glass_height_m) : '',
        })),
```

Change `handleSave`'s `itemsPayload` mapping (currently lines 420-425):

```js
      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          po_id: poId, description: it.description,
          quantity: parseFloat(it.quantity) || 0, unit: it.unit || null,
          unit_price: parseFloat(it.unit_price) || 0, line_total: lineTotal(it), sort_order: i,
          inventory_item_id: it.inventory_item_id || null,
          aluminum_profile_id: it.aluminum_profile_id || null,
          rod_length_m: it.rod_length_m ? parseFloat(it.rod_length_m) : null,
          glass_width_m: it.glass_width_m ? parseFloat(it.glass_width_m) : null,
          glass_height_m: it.glass_height_m ? parseFloat(it.glass_height_m) : null,
        }))
```

- [ ] **Step 3: Add the conditional profile/dimension inputs to `ItemsEditor`**

Add a `profileOpts` helper near the existing `inventoryItemOpts` (currently lines 67-69):

```js
const profileOpts = (profiles) => (profiles || []).map(p => ({
  value: p.id, label: `${p.name} (${p.linear_weight_kg_per_m} กก./ม.)`, keywords: p.name,
}))
```

Change `ItemsEditor`'s signature (currently line 71) to accept the profiles list:

```js
function ItemsEditor({ items, onChange, inventoryItems, onInventoryItemCreated, aluminumProfiles }) {
```

Add a profile-select handler right after `set`/`add`/`remove`/`grandTotal` (currently lines 73-76):

```js
  const selectProfile = (i, profileId) => {
    const profile = (aluminumProfiles || []).find(p => p.id === profileId)
    onChange(items.map((it, idx) => idx === i
      ? { ...it, aluminum_profile_id: profileId, rod_length_m: profile ? String(profile.default_length_m) : it.rod_length_m }
      : it))
  }
```

Insert this block right after the existing "📦 ผูกกับสต็อก" sub-row `<div>` (currently ending line 106, right before the outer `</div>` that closes each item's block at line 107):

```jsx
            {(() => {
              const linkedItem = (inventoryItems || []).find(i => i.id === it.inventory_item_id)
              const mode = linkedItem?.unit_conversion_mode
              if (mode === 'aluminum_profile') {
                return (
                  <div style={{ marginLeft: 4, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)', flexShrink: 0 }}>🔧 หน้าตัด:</span>
                    <div style={{ width: 200 }}>
                      <SearchableSelect required value={it.aluminum_profile_id} onChange={v => selectProfile(i, v)}
                        placeholder="— เลือกหน้าตัด —" options={profileOpts(aluminumProfiles)} />
                    </div>
                    <span style={{ color: 'var(--text3)' }}>ยาว (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.01" required
                      value={it.rod_length_m} onChange={e => set(i, 'rod_length_m', e.target.value)} />
                  </div>
                )
              }
              if (mode === 'glass_dimension') {
                return (
                  <div style={{ marginLeft: 4, display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)', flexShrink: 0 }}>📐 ขนาด:</span>
                    <span style={{ color: 'var(--text3)' }}>กว้าง (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.001" required
                      value={it.glass_width_m} onChange={e => set(i, 'glass_width_m', e.target.value)} />
                    <span style={{ color: 'var(--text3)' }}>ยาว (ม.)</span>
                    <input className="input input-sm" style={{ width: 80 }} type="number" min="0" step="0.001" required
                      value={it.glass_height_m} onChange={e => set(i, 'glass_height_m', e.target.value)} />
                  </div>
                )
              }
              return null
            })()}
```

- [ ] **Step 4: Thread `aluminumProfiles` through `PurchaseOrderForm` and its two render call sites**

In `PurchaseOrderForm`'s signature (currently line 118), add `aluminumProfiles` to the destructured props:

```js
function PurchaseOrderForm({ initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading, onSiteCreated, onSupplierCreated, inventoryItems, onInventoryItemCreated, aluminumProfiles }) {
```

In its render (currently line 154), pass it through to `ItemsEditor`:

```jsx
        <ItemsEditor items={form.items} onChange={items => set('items', items)} inventoryItems={inventoryItems} onInventoryItemCreated={onInventoryItemCreated} aluminumProfiles={aluminumProfiles} />
```

In the main `PurchaseOrders` component, add the hook call (after line 376's `const { data: unitFactors } = useInventoryItemUnitFactors()`):

```js
  const { data: aluminumProfiles } = useAluminumProfiles()
```

Add `useAluminumProfiles` to the hook import (currently line 9):

```js
import { usePurchaseOrders, useSites, useSuppliers, useCategories, useUnits, useInventoryItems, useInventoryItemUnitFactors, useStockBalances, useAluminumProfiles } from '../hooks/useSupabase.js'
```

Pass the new prop at the `PurchaseOrderForm` call site (currently line 618):

```jsx
            inventoryItems={inventoryItems} onInventoryItemCreated={refetchInventoryItems} aluminumProfiles={aluminumProfiles}
```

- [ ] **Step 5: Extend `receiveStockPlan()` with the two new conversion branches**

Add `computeAluminumWeightKg, computeGlassAreaSqm` to the import from `../lib/inventoryCost.js` (currently line 10):

```js
import { computeWeightedAverageCost, convertToBaseUnit, computeAluminumWeightKg, computeGlassAreaSqm } from '../lib/inventoryCost.js'
```

Replace `receiveStockPlan()`'s body (currently lines 446-465) with:

```js
  const receiveStockPlan = (po) => {
    if (!po) return []
    return (po.purchase_order_items || [])
      .filter(it => it.inventory_item_id)
      .map(it => {
        const invItem = (inventoryItems || []).find(i => i.id === it.inventory_item_id)
        let baseQty, unitCostPerBase

        if (invItem?.unit_conversion_mode === 'aluminum_profile' && it.aluminum_profile_id) {
          const profile = (aluminumProfiles || []).find(p => p.id === it.aluminum_profile_id)
          const length = it.rod_length_m || profile?.default_length_m || 0
          baseQty = profile ? computeAluminumWeightKg(it.quantity, length, profile.linear_weight_kg_per_m) : it.quantity
          unitCostPerBase = baseQty > 0 ? (it.quantity * it.unit_price) / baseQty : it.unit_price
        } else if (invItem?.unit_conversion_mode === 'glass_dimension' && it.glass_width_m && it.glass_height_m) {
          baseQty = computeGlassAreaSqm(it.quantity, it.glass_width_m, it.glass_height_m)
          unitCostPerBase = baseQty > 0 ? (it.quantity * it.unit_price) / baseQty : it.unit_price
        } else {
          const factor = (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit)
          baseQty = factor ? convertToBaseUnit(it.quantity, factor.factor_to_base) : it.quantity
          unitCostPerBase = baseQty > 0 ? (it.quantity * it.unit_price) / baseQty : it.unit_price
        }

        // The expense is posted ex-VAT (calcPoTotals backs VAT out of a
        // VAT-inclusive price via subtotal = total / 1.07). Stock must be
        // capitalized at the same ex-VAT cost, regardless of which branch
        // above computed it (final-review Fix 3 from the Phase 1 plan).
        if (po.has_vat && po.price_includes_vat) {
          unitCostPerBase = unitCostPerBase / (1 + VAT_RATE)
        }

        return { inventoryItemId: it.inventory_item_id, name: invItem?.name || it.description, baseUnit: invItem?.base_unit || it.unit, baseQty, unitCostPerBase }
      })
  }
```

- [ ] **Step 6: Build**

```bash
npx vite build
```

- [ ] **Step 7: Live-verify**

Create a throwaway test tenant (`dualunit-task4@facadex-test.local`) with an owner login. Log in via Playwright, navigate to `purchase_orders`. Create a site and a supplier via the existing quick-add pickers.

**Aluminum scenario:** navigate to `inventory`, create an item named "อลูมิเนียม สีขาว" with `unit_conversion_mode = 'aluminum_profile'`. Switch to "🔧 หน้าตัดอลูมิเนียม", create a profile "หน้าตัด X" with `linear_weight_kg_per_m = 1.0`, `default_length_m = 6.4`. Navigate back to `purchase_orders`, create a PO with one item linked to "อลูมิเนียม สีขาว" — confirm the "🔧 หน้าตัด" picker + "ยาว (ม.)" field appear, confirm selecting the profile auto-fills length to `6.4`. Set quantity to `20`, unit_price to whatever, save, then receive it. Confirm the receive-preview shows `+128.00 kg` (20 × 6.4 × 1.0). Verify via `execute_sql`: `stock_movements` has one `purchase_in` row with `quantity = 128`.

**Glass scenario:** create a second item "กระจก 6มม.ใส" with `unit_conversion_mode = 'glass_dimension'`, `reference_area_sqm = 2.88`. Create a second PO with one item linked to it, quantity `1`, and confirm the "📐 ขนาด" width/height fields appear; leaving them blank and attempting to submit the form must be blocked by the browser's native required-field validation. Fill in width `1.2`, height `2.4`, unit_price `1200`, save, receive. Confirm the preview shows `+2.88 ตรม.` and the posted cost matches (`unit_cost = 1200 / 2.88 ≈ 416.67`). Verify via `execute_sql`.

- [ ] **Step 8: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `purchase_order_items` → `purchase_orders` → `expenses` → `inventory_items` → `aluminum_profiles` → `suppliers` → `sites` → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 9: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/PurchaseOrders.jsx src/hooks/useSupabase.js
git commit -m "feat: aluminum-profile and glass-dimension receive-time conversion"
git push origin worktree-quotation-module:main
```

---

### Task 5: Excel bulk import — `inventory_items` and `aluminum_profiles`

**Files:**
- Modify: `src/components/ExcelUpload.jsx` (full file read in this plan's research).
- Modify: `src/pages/Inventory.jsx` — add the "📥 Import Excel" + "📄 Template" UI on both the `'items'` and `'profiles'` views.
- Create: `scripts/generate-inventory-templates.cjs` (a one-off Node script to generate the two binary `.xlsx` template files — a plan document can't embed a binary spreadsheet, so this task runs a script instead of hand-authoring one).
- Create (by running the script, not by hand): `public/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx`, `public/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx`.

**Interfaces:**
- Consumes: the `xlsx` npm package (already a dependency, already imported in `ExcelUpload.jsx`).
- Produces: `ExcelUpload`'s `type` prop accepts two new values, `'inventory_item'` and `'aluminum_profile'`, in addition to its existing `'expense'|'income'|'site'|'client'|'supplier'`.

- [ ] **Step 1: Generate the two template files**

Create `scripts/generate-inventory-templates.cjs`:

```js
const XLSX = require('xlsx')

function buildTemplate(title, headers, hints, outPath) {
  const rows = [
    [title],
    [],
    headers,
    hints,
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, outPath)
  console.log('wrote', outPath)
}

buildTemplate(
  'แบบฟอร์มนำเข้ารายการสินค้าคงคลัง',
  ['ชื่อสินค้าคงคลัง', 'หน่วยหลัก', 'รูปแบบการแปลงหน่วย', 'ขนาดแผ่นอ้างอิง (ตรม.)'],
  ['เช่น อลูมิเนียม สีขาว', 'เช่น กก., ตรม., ชิ้น', 'ปกติ / อลูมิเนียม (ตามหน้าตัด) / กระจก (กว้าง×ยาว)', 'กรอกเฉพาะแบบกระจก เช่น 2.88'],
  'public/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx'
)

buildTemplate(
  'แบบฟอร์มนำเข้าหน้าตัดอลูมิเนียม',
  ['ชื่อหน้าตัด', 'น้ำหนัก (กก./เมตร)', 'ความยาวมาตรฐาน (เมตร)'],
  ['เช่น หน้าตัด X', 'เช่น 1.0', 'เช่น 6.4 (เว้นว่างได้ ค่าเริ่มต้น 6.4)'],
  'public/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx'
)
```

Run it:

```bash
node scripts/generate-inventory-templates.cjs
```

Expected output: `wrote public/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx` and `wrote public/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx`. Verify both files now exist in `public/templates/`.

- [ ] **Step 2: Add the two parse functions to `ExcelUpload.jsx`**

Add right after the existing `parseSupplierSheet()` function (currently ending around line 266, right before `export default function ExcelUpload`):

```js
const CONVERSION_MODE_OPTS = ['plain', 'aluminum_profile', 'glass_dimension']
function normalizeConversionMode(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (s.includes('อลูมิเนียม') || s.includes('aluminum') || s.includes('หน้าตัด')) return 'aluminum_profile'
  if (s.includes('กระจก') || s.includes('glass') || s.includes('กว้าง')) return 'glass_dimension'
  return 'plain'
}

async function parseInventoryItemSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อสินค้าคงคลัง')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อสินค้าคงคลัง)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    records.push({
      name: String(row[0]),
      base_unit: row[1] ? String(row[1]) : '',
      unit_conversion_mode: normalizeConversionMode(row[2]),
      reference_area_sqm: row[3] != null ? parseFloat(row[3]) : null,
    })
  }
  return records
}

async function parseAluminumProfileSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อหน้าตัด')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อหน้าตัด)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    const linearWeight = parseFloat(row[1])
    if (!linearWeight) continue
    records.push({
      name: String(row[0]),
      linear_weight_kg_per_m: linearWeight,
      default_length_m: row[2] != null ? parseFloat(row[2]) : 6.4,
    })
  }
  return records
}
```

- [ ] **Step 3: Wire the two new `type` values into `processFile`, `handleImport`, and `label`**

Change the `records = ...` ternary chain inside `processFile` (currently lines 347-352):

```js
      const records =
        type === 'expense'          ? await parseExpenseSheet(ws)          :
        type === 'income'           ? await parseIncomeSheet(ws)           :
        type === 'site'             ? await parseSiteSheet(ws)             :
        type === 'client'           ? await parseClientSheet(ws)           :
        type === 'inventory_item'   ? await parseInventoryItemSheet(ws)    :
        type === 'aluminum_profile' ? await parseAluminumProfileSheet(ws)  :
                                       await parseSupplierSheet(ws)
```

Change the `table = ...` ternary chain inside `handleImport` (currently lines 396-401):

```js
      const table =
        type === 'expense'          ? 'expenses'  :
        type === 'income'           ? 'incomes'   :
        type === 'site'             ? 'sites'     :
        type === 'client'           ? 'clients'   :
        type === 'inventory_item'   ? 'inventory_items'   :
        type === 'aluminum_profile' ? 'aluminum_profiles' :
                                       'suppliers'
```

Change the `label = ...` ternary chain (currently lines 417-422):

```js
  const label =
    type === 'expense'          ? 'รายจ่าย'   :
    type === 'income'           ? 'รายรับ'    :
    type === 'site'             ? 'ไซท์งาน'  :
    type === 'client'           ? 'ลูกค้า'   :
    type === 'inventory_item'   ? 'รายการสินค้าคงคลัง' :
    type === 'aluminum_profile' ? 'หน้าตัดอลูมิเนียม'  :
                                   'Supplier'
```

- [ ] **Step 4: Add preview-table columns for the two new types**

In the preview `<thead><tr>` ternary chain (currently lines 461-471), insert two new branches right before the final `<>` (the Supplier branch):

```jsx
                    {type === 'expense' ? <>
                      <th>Invoice no.</th><th>วันที่</th><th>รายละเอียด</th><th>ไซท์</th><th>หมวด</th><th>Supplier</th><th>มูลค่า (รวม VAT)</th><th>สถานะ</th>
                    </> : type === 'income' ? <>
                      <th>เลขใบแจ้งหนี้</th><th>วันที่</th><th>ไซท์</th><th>ลูกค้า</th><th>ยอดรับจริง</th>
                    </> : type === 'site' ? <>
                      <th>ชื่อไซท์งาน</th><th>ลูกค้า</th><th>สถานะ</th><th>มูลค่าสัญญา</th><th>วันจบงาน</th>
                    </> : type === 'client' ? <>
                      <th>ชื่อลูกค้า / บริษัท</th><th>ผู้ติดต่อ</th><th>ตำแหน่ง</th><th>เบอร์โทร</th><th>ประเภท</th>
                    </> : type === 'inventory_item' ? <>
                      <th>ชื่อสินค้าคงคลัง</th><th>หน่วยหลัก</th><th>รูปแบบการแปลงหน่วย</th><th>ขนาดแผ่นอ้างอิง (ตรม.)</th>
                    </> : type === 'aluminum_profile' ? <>
                      <th>ชื่อหน้าตัด</th><th>กก./เมตร</th><th>ความยาวมาตรฐาน (ม.)</th>
                    </> : <>
                      <th>ชื่อ Supplier</th><th>หมวดสินค้า</th><th>ผู้ติดต่อ</th><th>เบอร์โทร</th><th>เงื่อนไขชำระ</th>
                    </>}
```

In the preview `<tbody>{preview.slice(0, 50).map(...)}` ternary chain (currently lines 477-548), insert the matching data rows right before the final `<>` (the Supplier branch):

```jsx
                      {type === 'expense' ? <>
                        {/* ...unchanged... */}
                      </> : type === 'income' ? <>
                        {/* ...unchanged... */}
                      </> : type === 'site' ? <>
                        {/* ...unchanged... */}
                      </> : type === 'client' ? <>
                        {/* ...unchanged... */}
                      </> : type === 'inventory_item' ? <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td style={{ fontSize: 12 }}>{r.base_unit}</td>
                        <td style={{ fontSize: 12 }}>{r.unit_conversion_mode}</td>
                        <td className="font-mono">{r.reference_area_sqm != null ? r.reference_area_sqm : '—'}</td>
                      </> : type === 'aluminum_profile' ? <>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td className="font-mono">{r.linear_weight_kg_per_m}</td>
                        <td className="font-mono">{r.default_length_m}</td>
                      </> : <>
                        {/* ...unchanged supplier branch... */}
                      </>}
```

(The `{/* ...unchanged... */}` markers above mean: leave those branches' existing JSX exactly as it is today — only insert the two new branches in between the existing `client` branch and the trailing `supplier` else.)

Update the "และอีก N รายการ" row's `colSpan` (currently `colSpan={type === 'expense' ? 8 : 5}`, appears once for the header context and once near line 552) to account for the two new column counts:

```jsx
colSpan={{ expense: 8, income: 5, site: 5, client: 5, inventory_item: 4, aluminum_profile: 3 }[type] ?? 5}
```

- [ ] **Step 5: Wire the import UI into `Inventory.jsx`**

In `src/pages/Inventory.jsx`, add the import (near the top, with the other component imports):

```js
import ExcelUpload from '../components/ExcelUpload.jsx'
```

Add two new pieces of state in the main `Inventory` component (alongside the existing `showForm`/`showProfileForm` state):

```js
  const [showImportItems, setShowImportItems] = useState(false)
  const [showImportProfiles, setShowImportProfiles] = useState(false)
```

In the `'items'` view block, right after the existing "+ เพิ่มสินค้าคงคลัง" button, add:

```jsx
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportItems(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx" download>📄 Template</a>
          {showImportItems && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="inventory_item" onSuccess={() => { setShowImportItems(false); refetchItems() }} />
            </div>
          )}
```

In the `'profiles'` view block, right after the existing "+ เพิ่มหน้าตัด" button, add the parallel block:

```jsx
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportProfiles(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx" download>📄 Template</a>
          {showImportProfiles && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="aluminum_profile" onSuccess={() => { setShowImportProfiles(false); refetchProfiles() }} />
            </div>
          )}
```

- [ ] **Step 6: Build**

```bash
npx vite build
```

- [ ] **Step 7: Live-verify**

Create a throwaway test tenant (`dualunit-task5@facadex-test.local`). Log in via Playwright, navigate to `inventory`. On the "📦 รายการสินค้าคงคลัง" view, click "📥 Import Excel", drag-and-drop (or use the file input with) the generated `TEMPLATE_รายการสินค้าคงคลัง.xlsx` — but first, in a scratch copy of that file, fill in one data row (e.g. `กระจก ทดสอบ | ตรม. | กระจก (กว้าง×ยาว) | 2.5`) using a small Node script with the `xlsx` package (write and read back a copy — do not hand-edit the real template file in `public/templates/`). Confirm the preview modal shows 1 row with the correct parsed values (`unit_conversion_mode` normalized to `glass_dimension`). Click "นำเข้า", confirm success, confirm the new item appears in the list with the right mode. Repeat the same pattern for "🔧 หน้าตัดอลูมิเนียม" with `TEMPLATE_หน้าตัดอลูมิเนียม.xlsx` (one row: `หน้าตัด ทดสอบ | 1.2 | ` blank length — confirm it defaults to `6.4`).

- [ ] **Step 8: Clean up the test tenant**

FK order: `inventory_items` (imported test rows) → `aluminum_profiles` (imported test rows) → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 9: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/components/ExcelUpload.jsx src/pages/Inventory.jsx scripts/generate-inventory-templates.cjs public/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx public/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx
git commit -m "feat: Excel bulk-import for inventory items and aluminum profiles"
git push origin worktree-quotation-module:main
```

---

## After all tasks: final whole-branch review

Once all 5 tasks are complete, dispatch the final code reviewer (per `superpowers:subagent-driven-development`) on the most capable available model, covering the full diff across all 5 tasks together — with particular attention to:
- Every place a new PO-item field (`aluminum_profile_id`, `rod_length_m`, `glass_width_m`, `glass_height_m`) needs to round-trip is actually wired: `usePurchaseOrders()`'s select, `EMPTY_ITEM`, `editFormInitial`, `handleSave`'s `itemsPayload` — the exact class of near-miss flagged in this plan's Global Constraints.
- `receiveStockPlan()`'s three branches (aluminum, glass, existing fixed-factor/1:1) are mutually exclusive and correctly ordered — an item that's `aluminum_profile` mode but has no `aluminum_profile_id` set on a given line falls through sensibly (to the 1:1 fallback, per the `&&` guard in each `if`) rather than crashing.
- The VAT-adjustment step at the end of `receiveStockPlan()` still applies uniformly regardless of which branch computed `unitCostPerBase` above it.
- No new SQL views were introduced (this project's "view column freeze" gotcha) and no change was made to `record_stock_movement()`, `inventory_stock_balances`, or `stock_movements` — this plan is entirely about computing correct inputs to that already-shipped machinery.
- `git diff main...HEAD --stat` to confirm only the files listed across these 5 tasks changed (plus the two new binary `.xlsx` templates and the one new `.cjs` script).

If the review returns findings, dispatch ONE fix subagent with the complete list, then one scoped re-review, adjudicating any residual findings exactly as the subagent-driven-development skill's breaker describes (park with a ruling, or fix if load-bearing).

## After the final review is clean: live preview for the user

The business owner explicitly asked to see this feature working before considering it complete ("ขอ preview ให้ดูก่อนนะจะได้ช่วยดูว่าครบไหม"). Once the final review is clean and everything is pushed, the controller (not a dispatched subagent) personally does a live Playwright walkthrough against a throwaway test tenant, capturing screenshots of:
1. The item form's conversion-mode selector (all 3 options visible in the dropdown).
2. The Profile Master CRUD section (🔧 หน้าตัดอลูมิเนียม) with at least one profile listed.
3. A Purchase Order's item row showing the aluminum profile picker + length field.
4. A Purchase Order's item row showing the glass width/height fields.
5. The receive-confirm preview showing a computed kg or ตรม. value.
6. The valuation report's new "จำนวนแผ่นโดยประมาณ" column with a real estimate shown.
7. Both "📥 Import Excel" buttons and their template-download links.

Clean up the test tenant fully afterward. Publish the screenshots as an Artifact (or present them directly in chat, whichever fits) for the user to review, then use `superpowers:finishing-a-development-branch` — though since this session pushes directly to `main` continuously and there is no separate feature branch to merge, that step is a formality confirming the working tree is clean and everything already pushed matches `origin/main`.
