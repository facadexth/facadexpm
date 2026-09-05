# Inventory Categories + Opening-Balance Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give inventory items a category taxonomy, and let an admin set/correct a stock balance at ส่วนกลาง to match a physical count — laying the foundation the follow-up invoice-ratio-deduction plan depends on.

**Architecture:** A new `inventory_categories` lookup table (mirrors `expense_categories`), a `category_id` FK on `inventory_items`, and a new `'adjustment'` code path inside the existing `record_stock_movement()` RPC (same single-writer discipline as every other movement type). The Inventory page's "รายการสินค้าคงคลัง" and "มูลค่าสต็อก" tabs merge into one table that shows every item's balance per site, with inline-editable quantity/cost on ส่วนกลาง rows only.

**Tech Stack:** React + Vite, Supabase (Postgres + PostgREST + RLS), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-05-inventory-categories-adjustment-cogs-design.md` — this plan implements decisions 1-5 and 9 (categories, adjustment semantics, the merged tab). Decisions 6-8 (the invoice-ratio deduction queue) are a separate, later plan, since they depend on categories existing here first.

## Global Constraints

- Live Supabase project `yyzbgdmgyvvypfcjuhtr`. Migration workflow: dry-run via `execute_sql` in `BEGIN;...ROLLBACK;`, then `apply_migration`, then write to `supabase/migrations/YYYY-MM-DD-NN-<name>.sql`, then update `supabase/schema.sql`. Today is 2026-09-05, last-used suffix is `-10`, so this plan's migration is `-11`.
- **CRITICAL test-isolation rule**, learned from two real incidents tonight: every live-verification step in this plan must use a fresh, disposable throwaway test tenant with a unique email, created via the standard `auth.users`/`auth.identities` pattern below — never any real/existing tenant, site, item, or category.
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
  COMMIT;
  ```
  Clean up fully afterward in FK-dependency order, verified with a final 0-row count query. Watch for the extra trigger-seeded tables found tonight (`site_phases`, `app_settings`, `audit_logs`) beyond the obvious ones — do a systematic FK sweep before declaring cleanup complete, don't just trust a short checklist.
- No unit test runner beyond the real vitest suite at the repo root (96 passing tests as of tonight). New pure-JS logic gets real tests. Every UI/integration task additionally verifies live: build, throwaway tenant, Playwright (fall back to authenticated REST-level verification if Playwright isn't available in your environment — say explicitly which method you used), full cleanup, then commit + push directly to `main`.
- **RLS consistency:** `inventory_categories` uses the exact same policy shape as every other inventory table: `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')`.
- **`record_stock_movement()`'s signature does not change** — only its internal handling of `p_movement_type = 'adjustment'` is added. This is a `CREATE OR REPLACE` with an *identical* parameter list, so it correctly replaces the existing function rather than creating a second overload (the function-overload gotcha from earlier tonight only applies when the parameter list itself changes).
- **Type/name consistency:** hooks are `useInventoryCategories()` (active items only is not meaningful here — categories don't have an active flag; just one hook, `useInventoryCategories()`, returning all of a tenant's categories). The RPC call for an adjustment is `supabase.rpc('record_stock_movement', { p_inventory_item_id, p_site_id, p_movement_type: 'adjustment', p_quantity: <counted quantity>, p_unit_cost: <counted cost>, p_reference_type: 'manual_adjustment', p_reference_id: null, p_notes: null })`.

---

### Task 1: Migration — `inventory_categories`, `inventory_items.category_id`, seeding, `record_stock_movement()` adjustment support

**Files:**
- Create: `supabase/migrations/2026-09-05-11-inventory-categories-adjustment.sql`
- Modify: `supabase/schema.sql` — a new `inventory_categories` section inserted after the existing `aluminum_profiles` RLS block; `inventory_items`' table definition gains `category_id`; `handle_new_user()` (currently `supabase/schema.sql:2494-2554`) gains a seeding step; `record_stock_movement()` (currently `supabase/schema.sql:856-931`) is replaced with the adjustment-aware version below.

**Interfaces:**
- Produces: table `inventory_categories(id, tenant_id, name, sort_order, created_at)`; `inventory_items.category_id UUID NULL REFERENCES inventory_categories(id) ON DELETE SET NULL`; `record_stock_movement()` now accepts `p_movement_type = 'adjustment'` in addition to the existing three.

- [ ] **Step 1: Dry-run the migration**

```sql
CREATE TABLE inventory_categories (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_categories_tenant_id ON inventory_categories(tenant_id);

ALTER TABLE inventory_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_categories FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

ALTER TABLE inventory_items ADD COLUMN category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION record_stock_movement(
  p_inventory_item_id UUID,
  p_site_id UUID,
  p_movement_type TEXT,
  p_quantity NUMERIC,
  p_unit_cost NUMERIC,
  p_reference_type TEXT,
  p_reference_id UUID,
  p_notes TEXT
)
RETURNS TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_movement_id UUID;
  v_old_qty NUMERIC;
  v_old_wac NUMERIC;
  v_new_qty NUMERIC;
  v_new_wac NUMERIC;
  v_stored_qty NUMERIC;
  v_stored_cost NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment') THEN
    RAISE EXCEPTION 'unsupported_movement_type: %', p_movement_type;
  END IF;

  IF p_movement_type = 'adjustment' THEN
    IF p_quantity IS NULL OR p_quantity < 0 THEN
      RAISE EXCEPTION 'adjustment quantity (new absolute count) must be zero or positive';
    END IF;
  ELSE
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
      RAISE EXCEPTION 'quantity must be positive';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
  FROM inventory_stock_balances
  WHERE inventory_item_id = p_inventory_item_id AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_old_qty := 0;
    v_old_wac := 0;
  END IF;

  IF p_movement_type = 'adjustment' THEN
    v_new_qty := p_quantity;
    v_new_wac := COALESCE(p_unit_cost, v_old_wac);
    v_stored_qty := p_quantity - v_old_qty;
    v_stored_cost := v_new_wac;
  ELSIF p_movement_type IN ('purchase_in', 'transfer_in') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  ELSE
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, p_movement_type, v_stored_qty, v_stored_cost, p_reference_type, p_reference_id, p_notes, auth.email())
  RETURNING id INTO v_movement_id;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$$;
```

Run via `execute_sql` wrapped in `BEGIN; ... ROLLBACK;`. Expected: no errors. Note that `stock_movements.quantity` for an `'adjustment'` row can now legitimately be negative or zero — there is no CHECK constraint on its sign at the table level (never was), so nothing else needs to change to permit this.

- [ ] **Step 2: Apply live via `apply_migration`**

- [ ] **Step 3: Also update `handle_new_user()` in a second `apply_migration` call**

Read the CURRENT full body of `handle_new_user()` from `supabase/schema.sql:2494-2554` first (don't guess at it — it may have changed since this plan was written). Insert this block into the `ELSE` branch (the "genuinely new tenant, not an invited user" branch), right after the existing `app_settings` seed insert and before the `-- Seed expense_categories...` comment:

```sql
    INSERT INTO inventory_categories (tenant_id, name, sort_order) VALUES
      (v_tenant_id, 'อลูมิเนียม/เหล็ก', 1),
      (v_tenant_id, 'กระจก', 2),
      (v_tenant_id, 'อุปกรณ์', 3),
      (v_tenant_id, 'ซิลิโคน/ยาง', 4);
```

Then run `CREATE OR REPLACE FUNCTION handle_new_user()` with the complete function body (the existing body plus this insertion) via `execute_sql` dry-run, then `apply_migration`. Since this is also a same-signature `CREATE OR REPLACE`, it correctly replaces rather than duplicates.

- [ ] **Step 4: Verify schema state**

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'inventory_categories';
SELECT policyname FROM pg_policies WHERE tablename = 'inventory_categories';
SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'category_id';
SELECT pronargs FROM pg_proc WHERE proname = 'record_stock_movement';
```

Expected: `inventory_categories` has RLS enabled with one `admin_full_access` policy; `category_id` present and nullable; `record_stock_movement` still has exactly one row with `pronargs = 8` (confirming the `CREATE OR REPLACE` replaced rather than duplicated).

- [ ] **Step 5: Live-verify with a real session**

Create a throwaway test tenant (`inv-cat-task1@facadex-test.local`). Confirm the 4 default categories were seeded automatically (`GET /rest/v1/inventory_categories` with the real access token — expect exactly 4 rows: อลูมิเนียม/เหล็ก, กระจก, อุปกรณ์, ซิลิโคน/ยาง). Create one `inventory_items` row and one `sites` row via authenticated REST. Call the RPC three times in sequence to test the new `adjustment` path:
1. `record_stock_movement(item, site, 'adjustment', 50, 100, 'manual_adjustment', null, null)` on a fresh balance (no prior rows) — expect `new_quantity_on_hand: 50, new_weighted_average_cost: 100`. Confirm the `stock_movements` row this created has `quantity = 50` (delta from 0), `unit_cost = 100`.
2. `record_stock_movement(item, site, 'adjustment', 30, 120, 'manual_adjustment', null, null)` — expect `new_quantity_on_hand: 30, new_weighted_average_cost: 120` (a downward correction). Confirm the new `stock_movements` row has `quantity = -20` (30 - 50, correctly negative).
3. `record_stock_movement(item, site, 'adjustment', 30, 120, 'manual_adjustment', null, null)` again (re-confirming the same count, no change) — expect `new_quantity_on_hand: 30` still, and confirm this `stock_movements` row has `quantity = 0` (a legitimate zero-delta row, not rejected).

Also confirm `p_quantity = -5` for an adjustment is rejected (negative absolute count is invalid), and confirm the pre-existing `purchase_in`/`transfer_in`/`transfer_out` paths still behave exactly as before (one quick `purchase_in` call, confirm normal blend-in behavior unaffected).

- [ ] **Step 6: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `inventory_items` → `inventory_categories` → `sites` → `site_phases` → `app_settings` → `audit_logs` → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 7: Write the migration file**

`supabase/migrations/2026-09-05-11-inventory-categories-adjustment.sql`, containing the exact SQL from Steps 1 and 3 combined (the table/column/function from Step 1, plus the complete replaced `handle_new_user()` body from Step 3), preceded by:

```sql
-- ============================================================
-- Inventory categories + opening-balance/periodic adjustment support.
-- See docs/superpowers/specs/2026-09-05-inventory-categories-adjustment-cogs-design.md
-- and docs/superpowers/plans/2026-09-05-inventory-categories-adjustment-plan.md.
-- ============================================================
```

- [ ] **Step 8: Update `supabase/schema.sql`**

Insert the `inventory_categories` table/RLS block right after the existing `aluminum_profiles` RLS policy. Add `category_id` to `inventory_items`' table definition, right after `reference_area_sqm`. Replace `record_stock_movement()`'s body in place with the new version. Replace `handle_new_user()`'s body in place with the new version (add a one-line comment above the new INSERT: `-- Every new tenant gets these 4 default categories, matching sites' existing cost-breakdown labels exactly (see the inventory categories/adjustment plan).`).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/2026-09-05-11-inventory-categories-adjustment.sql supabase/schema.sql
git commit -m "feat: inventory categories + opening-balance/periodic-adjustment RPC support"
```

---

### Task 2: hooks

**Files:**
- Modify: `src/hooks/useSupabase.js` — add `useInventoryCategories()`; extend `useAllInventoryItems()` and `useStockBalances()`'s embeds to include category info.

**Interfaces:**
- Produces: `useInventoryCategories()` returning `{ data, loading, error, refetch }` — every category for the tenant, ordered by `sort_order`.
- Consumes: `useQuery`, `supabase`.

- [ ] **Step 1: Add the hook**

Add right after `useAllAluminumProfiles()` (wherever it currently ends — find it by content, not a guessed line number):

```js
/** Every inventory category for the tenant, for the price-list filter
 *  and the item form's category picker. */
export function useInventoryCategories() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_categories')
      .select('*')
      .order('sort_order')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Extend `useAllInventoryItems()`'s embed**

Find `useAllInventoryItems()` (currently `.select('*')`). Change to embed the category name via the new FK:

```js
      .select('*, inventory_categories(name)')
```

- [ ] **Step 3: Extend `useStockBalances()`'s embed**

Find `useStockBalances()`'s `.select()` string (currently `'*, inventory_items(name, base_unit, unit_conversion_mode, reference_area_sqm), sites(name, site_number)'`). Add the nested category embed onto the `inventory_items(...)` sub-select:

```js
      .select('*, inventory_items(name, base_unit, unit_conversion_mode, reference_area_sqm, category_id, inventory_categories(name)), sites(name, site_number)')
```

(`category_id` itself is also added directly, alongside the nested `inventory_categories(name)` embed, so the UI can filter by id while displaying the name.)

- [ ] **Step 4: Build**

```bash
npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: inventory category hook + embed category info on item/balance queries"
```

---

### Task 3: category picker on the item form

**Files:**
- Modify: `src/pages/Inventory.jsx` — `ItemForm` gains a category picker; `handleSave` persists it.

**Interfaces:**
- Consumes: `useInventoryCategories` (Task 2).
- Produces: no new exports — extends `ItemForm`/`handleSave` in place.

- [ ] **Step 1: Add the category picker to `ItemForm`**

Change `EMPTY_ITEM_FORM` (currently `{ name: '', base_unit: '', unit_conversion_mode: 'plain', reference_area_sqm: '', active: true }`) to add `category_id: ''`.

`ItemForm` needs the categories list and a create-callback as new props. Change its signature from `function ItemForm({ initial = EMPTY_ITEM_FORM, onSave, onCancel, loading })` to:

```js
function ItemForm({ initial = EMPTY_ITEM_FORM, onSave, onCancel, loading, categories, onCategoryCreated }) {
```

Also fix its `useDraftForm` initial value to coalesce `category_id` the same way `reference_area_sqm` already is (a `null` DB value must not become an uncontrolled-then-controlled input):

```js
  const [form, setForm, clearDraft] = useDraftForm('inventory-item-form', { ...EMPTY_ITEM_FORM, ...initial, reference_area_sqm: initial?.reference_area_sqm ?? '', category_id: initial?.category_id ?? '' }, isAdd)
```

Insert this block right after the "หน่วยหลัก" field, before the "รูปแบบการแปลงหน่วยตอนรับของ" field:

```jsx
        <div>
          <label className="label">หมวดหมู่</label>
          <QuickAddSelect
            value={form.category_id} onChange={v => set('category_id', v)}
            placeholder="— ไม่มีหมวดหมู่ —" options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))}
            table="inventory_categories" namePlaceholder="ชื่อหมวดหมู่ใหม่"
            onCreated={onCategoryCreated}
            addLabel="+ สร้างใหม่"
          />
        </div>
```

Add the import: `import QuickAddSelect from '../components/QuickAddSelect.jsx'` (alongside the existing `SearchableSelect`/`ExcelUpload` imports).

- [ ] **Step 2: Persist it in `handleSave`**

Add `category_id: form.category_id || null,` to `handleSave`'s payload object (alongside `unit_conversion_mode`/`reference_area_sqm`).

- [ ] **Step 3: Wire categories into the main component and the two `ItemForm` render sites**

Add the hook call in the main `Inventory` component (alongside the other hook calls): `const { data: categories, refetch: refetchCategories } = useInventoryCategories()`. Add the import to the top-of-file hook import line.

`ItemForm` is rendered once, inside the `{showForm && (...)}` block. Pass the new props: `categories={categories} onCategoryCreated={refetchCategories}`.

- [ ] **Step 4: Show the category in the items table**

In the `'items'` view's table (the one with `<thead><tr><th>ชื่อ</th><th>หน่วยหลัก</th>...`), add a `<th>หมวดหมู่</th>` header and a matching `<td>{it.inventory_categories?.name || '—'}</td>` cell in the row mapping, right after the "หน่วยหลัก" column. Update the empty-state row's `colSpan` from `4` to `5`.

- [ ] **Step 5: Build**

```bash
npx vite build
```

- [ ] **Step 6: Live-verify**

Create a throwaway test tenant (`inv-cat-task3@facadex-test.local`). Log in, navigate to `inventory` (`sessionStorage.setItem('pendingTab', 'inventory')` + reload, or use a real Playwright/REST fallback per what's available in your environment). Confirm the 4 default categories exist (seeded by Task 1). Create a new item, use the category picker to select "กระจก", confirm it saves and displays in the items table. Use the picker's "+ สร้างใหม่" to create a brand-new category "อื่นๆ" inline, confirm it becomes selectable immediately.

- [ ] **Step 7: Clean up the test tenant**

Same FK order as Task 1's Step 6. Verify 0 rows.

- [ ] **Step 8: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: category picker on the inventory item form"
git push origin worktree-quotation-module:main
```

---

### Task 4: merge "รายการสินค้าคงคลัง" + "มูลค่าสต็อก" into one table with ส่วนกลาง-only inline adjustment and source resolution

**Files:**
- Modify: `src/pages/Inventory.jsx` — the single largest change in this plan.

**Interfaces:**
- Consumes: `useSites` (new import — for resolving `site_completion` references and finding ส่วนกลาง's id), `usePurchaseOrders` (new import — for resolving `purchase_order` references to a PO number), `useStockMovements` (already imported — reused here with no filter to build the "most recent movement per balance" map).
- Produces: no new exports — replaces the `'items'`/`'stock'` view blocks with one merged view; removes the `'stock'` view button entirely.

- [ ] **Step 1: Add the new imports and hook calls**

Add to the top-of-file hook import: `useSites, usePurchaseOrders` from `../hooks/useSupabase.js`.

In the main component, add:

```js
  const { data: sites } = useSites()
  const { data: allMovements } = useStockMovements({})
  const { data: allPos } = usePurchaseOrders({})
  const [itemsCategoryFilter, setItemsCategoryFilter] = useState('')
  const [savingBalance, setSavingBalance] = useState(null) // the balance-row key currently saving, or null
```

- [ ] **Step 2: Add the source-resolution and row-building helpers**

Add these as plain functions inside the component, above the `return`:

```js
  const centralSite = (sites || []).find(s => s.name === 'ส่วนกลาง')

  const resolveSource = (itemId, siteId) => {
    const itemMovements = (allMovements || []).filter(m => m.inventory_item_id === itemId && m.site_id === siteId)
    if (!itemMovements.length) return '—'
    const latest = itemMovements.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
    if (latest.reference_type === 'purchase_order') {
      const po = (allPos || []).find(p => p.id === latest.reference_id)
      return po ? `PO ${po.po_number}` : 'ใบสั่งซื้อ'
    }
    if (latest.reference_type === 'site_completion') {
      const fromSite = (sites || []).find(s => s.id === latest.reference_id)
      return fromSite ? `โอนจาก ${fromSite.name}` : 'โอนจากไซท์งาน'
    }
    if (latest.reference_type === 'manual_adjustment') return 'ปรับยอด'
    return latest.reference_type || '—'
  }

  const tableRows = useMemo(() => {
    const filteredItems = itemsCategoryFilter
      ? (items || []).filter(it => it.category_id === itemsCategoryFilter)
      : (items || [])
    const rows = []
    for (const item of filteredItems) {
      const itemBalances = (balances || []).filter(b => b.inventory_item_id === item.id)
      if (!itemBalances.length) {
        rows.push({ item, balance: null, isFirstForItem: true })
      } else {
        itemBalances.forEach((balance, i) => rows.push({ item, balance, isFirstForItem: i === 0 }))
      }
    }
    return rows
  }, [items, balances, itemsCategoryFilter])
```

(`centralSite` may be `undefined` if no site is named exactly "ส่วนกลาง" yet — every place below that uses it must handle that case explicitly, not assume it exists.)

- [ ] **Step 3: Add the balance-edit handler**

```js
  const handleSaveBalance = async (itemId, siteId, quantityStr, costStr) => {
    const quantity = parseFloat(quantityStr)
    const cost = parseFloat(costStr)
    if (isNaN(quantity) || quantity < 0 || isNaN(cost) || cost < 0) {
      alert('กรุณากรอกปริมาณและราคาเป็นตัวเลขไม่ติดลบ')
      return
    }
    const key = `${itemId}-${siteId}`
    setSavingBalance(key)
    try {
      const { error } = await supabase.rpc('record_stock_movement', {
        p_inventory_item_id: itemId, p_site_id: siteId, p_movement_type: 'adjustment',
        p_quantity: quantity, p_unit_cost: cost,
        p_reference_type: 'manual_adjustment', p_reference_id: null, p_notes: null,
      })
      if (error) throw error
    } catch (e) { alert('ปรับยอดไม่สำเร็จ: ' + e.message) }
    finally { setSavingBalance(null) }
  }
```

(This does not call any `refetch` itself — Step 5 below wires a shared refetch into the row component that calls this.)

- [ ] **Step 4: Replace the `'items'` and `'stock'` view blocks with one merged view**

Remove the `'stock'` view button entirely from the view-toggle row (currently the button reading `มูลค่าสต็อก`). The view-toggle row now has exactly 3 buttons: `items` (relabel its button text to keep "📦 รายการสินค้าคงคลัง"), `movements`, `profiles`.

Replace the entire `{view === 'items' && (...)}` block AND the entire `{view === 'stock' && (...)}` block (delete both) with this single merged block:

```jsx
      {view === 'items' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มสินค้าคงคลัง</button>}
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportItems(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx" download>📄 Template</a>
          {showImportItems && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="inventory_item" onSuccess={() => { setShowImportItems(false); refetchItems() }} />
            </div>
          )}
          <div style={{ marginBottom: 14, maxWidth: 260 }}>
            <SearchableSelect value={itemsCategoryFilter} onChange={setItemsCategoryFilter} placeholder="ทุกหมวดหมู่"
              options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
          </div>
          <div className="card">
            <div style={{ padding: '12px 16px', fontWeight: 700 }}>มูลค่าสต็อกรวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totalValue)}</span> บาท</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อ</th><th>หมวดหมู่</th><th>ไซท์งาน</th><th>ปริมาณ</th><th>ราคา/หน่วย</th><th>มูลค่ารวม</th><th>แหล่งที่มาล่าสุด</th><th></th></tr></thead>
                <tbody>
                  {tableRows.map(({ item, balance, isFirstForItem }) => (
                    <BalanceRow
                      key={balance ? balance.id : `${item.id}-empty`}
                      item={item} balance={balance} isFirstForItem={isFirstForItem}
                      centralSite={centralSite} canEdit={canEdit} savingKey={savingBalance}
                      resolveSource={resolveSource}
                      onSaveBalance={handleSaveBalance}
                      onEditItem={() => { setEditItem(item); setShowForm(true) }}
                      onDeleteItem={() => setDeleteId(item.id)}
                    />
                  ))}
                  {!tableRows.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสินค้าคงคลัง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 5: Add the `BalanceRow` component**

Add this new component above `export default function Inventory()`, after `ProfileForm`:

```jsx
function BalanceRow({ item, balance, isFirstForItem, centralSite, canEdit, savingKey, resolveSource, onSaveBalance, onEditItem, onDeleteItem }) {
  const siteId = balance ? balance.site_id : centralSite?.id
  const isCentralRow = !!centralSite && siteId === centralSite.id
  const [editing, setEditing] = useState(false)
  const [qtyDraft, setQtyDraft] = useState(String(balance?.quantity_on_hand ?? 0))
  const [costDraft, setCostDraft] = useState(String(balance?.weighted_average_cost ?? 0))
  const key = siteId ? `${item.id}-${siteId}` : null
  const saving = savingKey === key

  const siteName = balance ? balance.sites?.name : (centralSite?.name || 'ส่วนกลาง (ยังไม่มีไซท์นี้)')
  const quantity = balance?.quantity_on_hand ?? 0
  const cost = balance?.weighted_average_cost ?? 0

  const save = async () => {
    if (!siteId) { alert('ไม่พบไซท์งาน "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน'); return }
    await onSaveBalance(item.id, siteId, qtyDraft, costDraft)
    setEditing(false)
  }

  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{item.name}</td>
      <td style={{ fontSize: 12 }}>{item.inventory_categories?.name || '—'}</td>
      <td style={{ fontSize: 12 }}>{siteName}</td>
      <td className="font-mono">
        {editing ? (
          <input className="input input-sm" style={{ width: 90 }} type="number" min="0" step="0.0001" value={qtyDraft} onChange={e => setQtyDraft(e.target.value)} />
        ) : `${fmt(quantity)} ${item.base_unit}`}
      </td>
      <td className="font-mono">
        {editing ? (
          <input className="input input-sm" style={{ width: 90 }} type="number" min="0" step="0.0001" value={costDraft} onChange={e => setCostDraft(e.target.value)} />
        ) : fmt(cost)}
      </td>
      <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(quantity * cost)}</td>
      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{balance ? resolveSource(item.id, balance.site_id) : '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {canEdit && isCentralRow && (
          editing ? (
            <>
              <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? '⏳' : '✅ บันทึก'}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>ยกเลิก</button>
            </>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>ปรับยอด</button>
          )
        )}
        {canEdit && isFirstForItem && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={onEditItem}>แก้ไข</button>
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={onDeleteItem}>ลบ</button>
          </>
        )}
      </td>
    </tr>
  )
}
```

- [ ] **Step 6: Make the RPC call trigger a refetch**

`handleSaveBalance` (Step 3) doesn't refetch on its own — add `refetchItems` is not enough since balances come from a different hook. In the main component, destructure `useStockBalances()`'s refetch too (currently `const { data: balances } = useStockBalances()` — change to `const { data: balances, refetch: refetchBalances } = useStockBalances()`), and change `handleSaveBalance`'s success path to call `refetchBalances()` (and `refetchItems()`, since a first-ever adjustment for a brand-new item, targeting a site it had no balance row at before, changes what `tableRows` should show) right before the `finally` block, inside the `try` after the RPC call succeeds.

- [ ] **Step 7: Build**

```bash
npx vite build
```

- [ ] **Step 8: Live-verify**

Create a throwaway test tenant (`inv-cat-task4@facadex-test.local`) with an owner login. Via authenticated REST, create a site named exactly `ส่วนกลาง`. Create an inventory item (no prior balance anywhere). Navigate to `inventory`'s items view — confirm the new item shows one synthetic row targeting ส่วนกลาง with 0/0 quantity/cost, editable. Click "ปรับยอด", enter `50` quantity and `120` cost, save. Confirm the row now shows `50.00 <unit>` / `120.00` / total `6,000.00`, and "แหล่งที่มาล่าสุด" shows "ปรับยอด". Confirm via `execute_sql` that `stock_movements` has one `adjustment` row with `quantity = 50`. Adjust it again to `30`/`150` — confirm the display updates and the new movement row has `quantity = -20`. Confirm a non-central-site balance row (create one via a real PO receive against a different site first) does NOT show the "ปรับยอด" button — only "แก้ไข"/"ลบ" (item-level) on its first row if it's the item's first row in the table, or nothing if a later row for the same item.

- [ ] **Step 9: Clean up the test tenant**

Same FK order as Task 1's Step 6, plus `purchase_order_items`/`purchase_orders`/`expenses`/`suppliers`/`expense_categories` if a PO receive was used for the non-central-row check. Verify 0 rows.

- [ ] **Step 10: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: merge item/valuation tabs, add ส่วนกลาง-only inline stock adjustment"
git push origin worktree-quotation-module:main
```

---

## After all tasks: final whole-branch review

Dispatch the final code reviewer on the most capable available model, covering the full diff across all 4 tasks — with particular attention to:
- `record_stock_movement()`'s reordering (the balance `SELECT ... FOR UPDATE` now happens before the `stock_movements` insert, not after) doesn't change behavior for the three pre-existing movement types — trace it line-by-line against the pre-existing version.
- The adjustment path's tenant-ownership checks (Ruling D from Phase 1) are unchanged and still apply.
- `BalanceRow`'s `isCentralRow` gate is the *only* thing that makes a balance editable — confirm there's no path to call `handleSaveBalance` against a non-ส่วนกลาง site_id from the UI.
- The synthetic zero-balance row (for an item with no balance anywhere) correctly resolves to ส่วนกลาง's real site id on save, and handles the missing-ส่วนกลาง-site case with a clear message rather than a silent failure or a crash.
- No new SQL view was introduced (the "view column freeze" gotcha) and `stock_movements`'/`inventory_stock_balances`' RLS/grants are unchanged.

If the review returns findings, dispatch ONE fix subagent with the complete list, one scoped re-review, adjudicate any residuals per the subagent-driven-development skill's breaker. Once clean and pushed, this plan is done — the invoice-ratio-deduction plan (decisions 6-8 of the same spec) is a separate follow-up plan that depends on `inventory_categories` existing, which this plan delivers.
