# Invoice-Ratio COGS Stock Deduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an invoice is issued, let an admin deduct an approximate material-cost value from the stock ledger, split across categories by tenant-configurable percentages, sourced from the invoice's site first and ส่วนกลาง second — as a reviewable queue inside the Inventory page, with zero changes to `Invoices.jsx`.

**Architecture:** No new heavy server-side procedure. `record_stock_movement()` gains `'sale_out'`/`'sale_reversal'` support (mirroring its existing `transfer_out`/`purchase_in` branches exactly — same signature, same privilege/tenant checks). The actual sourcing/allocation math is a pure, fully-unit-tested JS function (`computeInvoiceDeductionPlan`) that reads already-loaded client-side state and returns a list of movements to post; the UI then loops calling the existing RPC once per movement — the exact same "client computes the plan, then posts it as a sequence of RPC calls" pattern already used by `PurchaseOrders.jsx`'s `receiveStockPlan()`/`handleReceive()` and Phase 1's site-completion transfer. This keeps every task reviewable against a working precedent already in this codebase, rather than requiring a new, harder-to-verify multi-branch stored procedure.

**Tech Stack:** React + Vite + Supabase (Postgres, multi-tenant RLS), vitest for pure-JS logic.

**Spec:** `docs/superpowers/specs/2026-09-05-inventory-categories-adjustment-cogs-design.md` — this plan implements spec decisions 6-8 only (decisions 1-5 and 9 were implemented by the prior `2026-09-05-inventory-categories-adjustment-plan.md`, already live on `main`).

## Global Constraints

- **Live Supabase project** `yyzbgdmgyvvypfcjuhtr`, no local Postgres. Migration workflow: dry-run in `BEGIN; ... ROLLBACK;` via `execute_sql`, then `apply_migration` (takes effect on production IMMEDIATELY), then write the identical SQL to `supabase/migrations/YYYY-MM-DD-NN-<name>.sql` (check `supabase/migrations/` for today's date's highest-numbered file before choosing NN — as of this plan being written, the highest is `2026-09-05-14`), then update `supabase/schema.sql` to match.
- **CRITICAL test-isolation rule** (two real incidents happened during this session's earlier work from violating this): every live-verification step MUST use a brand-new, disposable throwaway test tenant — a fresh `auth.users`/`auth.identities` INSERT with a unique email and empty-string (not NULL) `confirmation_token`/`recovery_token`/`email_change_token_new`/`email_change`. `tenants`/`user_roles` are auto-created by the `handle_new_user()` trigger — never insert those two directly. Never touch any real/existing tenant, site, or data. After verification, delete every row created, in FK order (see Task briefs below for the exact order), and **always delete `tenants` by its own explicit id, never by a foreign key column** (e.g. `owner_user_id`) that a later `auth.users` delete could null out via `ON DELETE SET NULL` first — this exact mistake happened once already tonight and was only caught by re-checking row counts.
- **`record_stock_movement()`'s signature does not change** (still the same 8 parameters, same order) — `CREATE OR REPLACE FUNCTION` with an identical signature correctly replaces the existing function; changing the parameter list would create a second overloaded function and silently break every existing caller (PO receive, site-completion transfer, the opening-balance/adjustment feature).
- **`Invoices.jsx` gets zero changes.** This is a hard spec requirement (decision 8) — the new feature only ever *reads* the existing `invoices` table.
- **Accepted risk, explicitly ruled on (resolves the spec's first Open Question):** a duplicate-confirm race (two admins confirming the same invoice's deduction at the same moment) is not closed with a new lock/table. The existing `record_stock_movement()` RPC already has this identical race today for `purchase_in` (two concurrent PO receives) and it has never been treated as something to fix — this plan holds the same posture for consistency. The UI does perform one fresh re-check immediately before executing the confirm loop (query for any existing `reference_type='invoice' AND reference_id=<id>` movement and abort with a clear message if found), which narrows the window without adding new schema. If it needs full atomicity later, that's a follow-up, not scope creep here.
- **Movement quantities/values are not artificially rounded** at computation time — full floating-point precision flows through `computeInvoiceDeductionPlan()` exactly as `receiveStockPlan()` and `computeAluminumWeightKg()` already do elsewhere in this codebase. Only display values are rounded, via the existing `fmt()` helper.
- **Cross-task naming, fixed now so every task agrees:** the pure function is `computeInvoiceDeductionPlan()` in `src/lib/inventoryCost.js`; its result shape is `{ steps, categoryResults, totalTargetValue, totalDeductedValue, totalShortfall }` where each `steps` entry is `{ type: 'sale_out'|'transfer_out'|'transfer_in', inventoryItemId, siteId, quantity, unitCost, categoryId }`; the settings hook is `useInventoryCogsSettings()` returning `{ material_pct, category_splits }` (snake_case, matching the spec's literal stored JSON shape) with `refetch`; the save helper is `saveInventoryCogsSettings(materialPct, categorySplits)`; the queue hook is `useUnprocessedInvoices()` returning invoices with `sites(name, site_number)` embedded, plus `refetch`.

---

### Task 1: `record_stock_movement()` gains `sale_out`/`sale_reversal` support

**Files:**
- Create: `supabase/migrations/2026-09-05-15-invoice-cogs-sale-movement-types.sql`
- Modify: `supabase/schema.sql` — `record_stock_movement()`'s body (currently at the section added by the prior plan; find it by content, not a guessed line number, since other work may have touched nearby lines since).

**Interfaces:**
- Produces: `record_stock_movement()` now accepts `p_movement_type IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment', 'sale_out', 'sale_reversal')`. No other interface changes.

- [ ] **Step 1: Read the current live function body first**

Run `execute_sql` with `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'record_stock_movement';` and confirm it matches the body below before proceeding — other work landed on `main` throughout tonight, so don't trust this plan's memory of the function over the live database.

- [ ] **Step 2: Dry-run the migration**

```sql
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

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment', 'sale_out', 'sale_reversal') THEN
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
  ELSIF p_movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  ELSE -- transfer_out, sale_out
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

The only changes from the live version: the `NOT IN (...)` list gains `'sale_out'`, `'sale_reversal'`; the blend-in branch's `IN (...)` list gains `'sale_reversal'` (it behaves exactly like `purchase_in`/`transfer_in` — adds quantity, blends WAC); the `ELSE` branch's comment gains `sale_out` (its logic — subtract quantity, WAC unchanged — was already correct for any outflow type, no code change needed there beyond the comment).

Run via `execute_sql` wrapped in `BEGIN; ... ROLLBACK;`. Expected: no errors.

- [ ] **Step 3: Apply live via `apply_migration`**

- [ ] **Step 4: Verify schema state**

```sql
SELECT pronargs FROM pg_proc WHERE proname = 'record_stock_movement';
```

Expected: exactly one row, `pronargs = 8` (confirms `CREATE OR REPLACE` replaced rather than duplicated).

- [ ] **Step 5: Live-verify with a real session**

Create a throwaway test tenant (`inv-cogs-task1@facadex-test.local`). Create one `inventory_items` row and one `sites` row via authenticated REST.

1. `record_stock_movement(item, site, 'purchase_in', 100, 50, 'purchase_order', null, null)` — expect `new_quantity_on_hand: 100, new_weighted_average_cost: 50`.
2. `record_stock_movement(item, site, 'sale_out', 30, null, 'invoice', null, null)` — expect `new_quantity_on_hand: 70, new_weighted_average_cost: 50` (unchanged WAC — an outflow never changes WAC). Confirm the `stock_movements` row has `movement_type = 'sale_out', quantity = 30`.
3. `record_stock_movement(item, site, 'sale_reversal', 30, 50, 'invoice', null, null)` — expect `new_quantity_on_hand: 100, new_weighted_average_cost: 50` exactly (a full round-trip sale-then-reversal at the same quantity and unit cost must restore the exact original balance — this is the concrete check that the blend formula is correct for a reversal, not just "doesn't error").
4. Confirm `p_movement_type = 'sale_out'` with `p_quantity <= 0` is rejected (same positive-quantity rule as every other non-adjustment type).
5. Confirm an unrelated type not in the list (e.g. `'bogus_type'`) is still rejected with `unsupported_movement_type`.

- [ ] **Step 6: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `inventory_items` → `inventory_categories` → `sites` → `site_phases` → `app_settings` → `audit_logs` → `user_roles` → `tenants` (by explicit id) → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 7: Write the migration file**

`supabase/migrations/2026-09-05-15-invoice-cogs-sale-movement-types.sql`, containing the exact SQL from Step 2, preceded by:

```sql
-- ============================================================
-- record_stock_movement(): add sale_out / sale_reversal support,
-- for the invoice-ratio COGS stock deduction feature.
-- See docs/superpowers/specs/2026-09-05-inventory-categories-adjustment-cogs-design.md
-- and docs/superpowers/plans/2026-09-05-invoice-ratio-cogs-deduction-plan.md.
-- ============================================================
```

- [ ] **Step 8: Update `supabase/schema.sql`**

Replace `record_stock_movement()`'s body in place with the new version.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/2026-09-05-15-invoice-cogs-sale-movement-types.sql supabase/schema.sql
git commit -m "feat: record_stock_movement() supports sale_out/sale_reversal for invoice-ratio COGS deduction"
```

---

### Task 2: `computeInvoiceDeductionPlan()` — the sourcing/allocation algorithm

**Files:**
- Modify: `src/lib/inventoryCost.js` — add the new function.
- Modify: `src/lib/inventoryCost.test.js` — add the new test suite.

**Interfaces:**
- Consumes: nothing (pure function, no imports needed beyond what's already in the file).
- Produces: `computeInvoiceDeductionPlan({ invoiceSubtotal, materialPct, categorySplits, siteId, centralSiteId, items, balances })` returning `{ steps, categoryResults, totalTargetValue, totalDeductedValue, totalShortfall }` — this exact shape is consumed by Task 4.

- [ ] **Step 1: Read the current file first**

Read `src/lib/inventoryCost.js` in full to see its existing exports (`computeWeightedAverageCost`, `convertToBaseUnit`, `computeAluminumWeightKg`, `computeGlassAreaSqm`, `estimateSheetCount`) and match its existing code style (plain exported functions, JSDoc comments explaining the *why* where non-obvious).

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/inventoryCost.test.js`:

```js
import { computeInvoiceDeductionPlan } from './inventoryCost.js'

describe('computeInvoiceDeductionPlan', () => {
  const SITE = 'site-1'
  const CENTRAL = 'central-1'
  const CAT_ALU = 'cat-alu'
  const CAT_GLASS = 'cat-glass'

  const items = [
    { id: 'item-alu-1', category_id: CAT_ALU },
    { id: 'item-alu-2', category_id: CAT_ALU },
    { id: 'item-glass-1', category_id: CAT_GLASS },
    { id: 'item-uncategorized', category_id: null },
  ]

  it('deducts proportionally when the site alone has enough stock', () => {
    const balances = [
      { inventory_item_id: 'item-alu-1', site_id: SITE, quantity_on_hand: 100, weighted_average_cost: 10 }, // value 1000
      { inventory_item_id: 'item-alu-2', site_id: SITE, quantity_on_hand: 50, weighted_average_cost: 20 },  // value 1000
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 1000000, materialPct: 70, categorySplits: { [CAT_ALU]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    // target = 1,000,000 * 0.7 * 0.35 = 245,000. Site total value = 2000, way short --
    // wait: this case is deliberately "site has enough" so use a realistic target instead.
    expect(result.categoryResults[0].targetValue).toBeCloseTo(245000, 2)
  })

  it('splits a fully-covered category proportionally by each item\'s site value, never draining below target', () => {
    const balances = [
      { inventory_item_id: 'item-alu-1', site_id: SITE, quantity_on_hand: 1000, weighted_average_cost: 100 }, // value 100,000
      { inventory_item_id: 'item-alu-2', site_id: SITE, quantity_on_hand: 500, weighted_average_cost: 100 },  // value 50,000
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    // target = 100,000 * 0.7 * 0.35 = 24,500. Site total value = 150,000 -- plenty.
    const cat = result.categoryResults[0]
    expect(cat.targetValue).toBeCloseTo(24500, 2)
    expect(cat.deductedValue).toBeCloseTo(24500, 2)
    expect(cat.shortfall).toBe(0)
    expect(result.steps).toHaveLength(2)
    expect(result.steps.every(s => s.type === 'sale_out' && s.siteId === SITE)).toBe(true)
    // item-alu-1 holds 2/3 of the category's site value (100k of 150k) -- it should
    // supply 2/3 of the deducted value: 24500 * (100000/150000) = 16333.33..., at
    // cost 100/unit -> qty 163.333...
    const step1 = result.steps.find(s => s.inventoryItemId === 'item-alu-1')
    expect(step1.quantity).toBeCloseTo(163.333, 2)
    const step2 = result.steps.find(s => s.inventoryItemId === 'item-alu-2')
    expect(step2.quantity).toBeCloseTo(81.667, 2)
    // together they should equal exactly the target value
    const totalValueTaken = step1.quantity * 100 + step2.quantity * 100
    expect(totalValueTaken).toBeCloseTo(24500, 2)
  })

  it('drains the site then backfills the shortfall from ส่วนกลาง via a transfer+sale_out triplet', () => {
    const balances = [
      { inventory_item_id: 'item-alu-1', site_id: SITE, quantity_on_hand: 10, weighted_average_cost: 100 },     // value 1,000 at site
      { inventory_item_id: 'item-alu-1', site_id: CENTRAL, quantity_on_hand: 500, weighted_average_cost: 100 }, // value 50,000 at central
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    // target = 24,500. Site only has 1,000 -- drains it entirely, needs 23,500 more from central.
    const cat = result.categoryResults[0]
    expect(cat.deductedValue).toBeCloseTo(24500, 2)
    expect(cat.shortfall).toBe(0)

    const siteDrainStep = result.steps.find(s => s.type === 'sale_out' && s.siteId === SITE && s.quantity === 10)
    expect(siteDrainStep).toBeTruthy()

    const transferOut = result.steps.find(s => s.type === 'transfer_out')
    const transferIn = result.steps.find(s => s.type === 'transfer_in')
    const backfillSaleOut = result.steps.filter(s => s.type === 'sale_out' && s.siteId === SITE)
      .find(s => s.quantity !== 10)
    expect(transferOut.siteId).toBe(CENTRAL)
    expect(transferIn.siteId).toBe(SITE)
    // 23,500 worth at 100/unit = 235 units, moved from central then sold out at the site
    expect(transferOut.quantity).toBeCloseTo(235, 2)
    expect(transferIn.quantity).toBeCloseTo(235, 2)
    expect(backfillSaleOut.quantity).toBeCloseTo(235, 2)
  })

  it('reports a shortfall (never blocks, never fabricates stock) when site + ส่วนกลาง together are insufficient', () => {
    const balances = [
      { inventory_item_id: 'item-alu-1', site_id: SITE, quantity_on_hand: 5, weighted_average_cost: 100 },    // value 500
      { inventory_item_id: 'item-alu-1', site_id: CENTRAL, quantity_on_hand: 10, weighted_average_cost: 100 }, // value 1,000
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    // target = 24,500. Only 1,500 exists anywhere. Deducted = 1,500, shortfall = 23,000.
    const cat = result.categoryResults[0]
    expect(cat.deductedValue).toBeCloseTo(1500, 2)
    expect(cat.shortfall).toBeCloseTo(23000, 2)
    expect(result.totalShortfall).toBeCloseTo(23000, 2)
  })

  it('reports the full target as shortfall when a category has zero stock anywhere and no central site', () => {
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_GLASS]: 35 },
      siteId: SITE, centralSiteId: null, items, balances: [],
    })
    const cat = result.categoryResults[0]
    expect(cat.deductedValue).toBe(0)
    expect(cat.shortfall).toBeCloseTo(24500, 2)
    expect(result.steps).toHaveLength(0)
  })

  it('skips a category with a 0% split entirely (no target, no steps, no shortfall)', () => {
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 0 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances: [],
    })
    expect(result.categoryResults[0]).toEqual({ categoryId: CAT_ALU, targetValue: 0, deductedValue: 0, shortfall: 0 })
    expect(result.steps).toHaveLength(0)
  })

  it('ignores items with no category_id entirely, even if they have huge balances at the site', () => {
    const balances = [
      { inventory_item_id: 'item-uncategorized', site_id: SITE, quantity_on_hand: 100000, weighted_average_cost: 1000 },
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    // the uncategorized item's balance must never be touched by the CAT_ALU category's sourcing
    expect(result.steps).toHaveLength(0)
    expect(result.categoryResults[0].shortfall).toBeCloseTo(24500, 2)
  })

  it('handles multiple categories independently in one call', () => {
    const balances = [
      { inventory_item_id: 'item-alu-1', site_id: SITE, quantity_on_hand: 1000, weighted_average_cost: 100 },
      { inventory_item_id: 'item-glass-1', site_id: SITE, quantity_on_hand: 1000, weighted_average_cost: 50 },
    ]
    const result = computeInvoiceDeductionPlan({
      invoiceSubtotal: 100000, materialPct: 70, categorySplits: { [CAT_ALU]: 35, [CAT_GLASS]: 35 },
      siteId: SITE, centralSiteId: CENTRAL, items, balances,
    })
    expect(result.categoryResults).toHaveLength(2)
    expect(result.totalTargetValue).toBeCloseTo(24500 * 2, 2)
    expect(result.steps.filter(s => s.categoryId === CAT_ALU)).toHaveLength(1)
    expect(result.steps.filter(s => s.categoryId === CAT_GLASS)).toHaveLength(1)
  })
})
```

Note: the first test above (`'deducts proportionally when the site alone has enough stock'`) is intentionally sparse — it exists to lock in the target-value arithmetic in isolation before the more detailed proportional-split tests that follow it. Do not delete it as "redundant" with the second test; they check different things (raw target-value math vs. the full proportional-split-and-drain behavior).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: FAIL — `computeInvoiceDeductionPlan is not a function` (or similar import error).

- [ ] **Step 4: Implement `computeInvoiceDeductionPlan()`**

Add to `src/lib/inventoryCost.js`:

```js
/**
 * Computes the sequence of stock_movements to post for one invoice's
 * ratio-based COGS deduction (spec decisions 6-8). Pure function, no I/O --
 * the caller loads items/balances once and re-uses this for every invoice
 * in the queue, and for live-previewing edits before confirming.
 *
 * Sourcing per category: the invoice's own site first: if its balance in
 * that category covers the target, deduct proportionally by each item's
 * value share and stop. If not, drain the site's balance in that category
 * entirely, then attempt to cover the remainder from ส่วนกลาง via a
 * transfer_out (central) + transfer_in (site) + sale_out (site) triplet
 * per item, again proportional by value share. If even that's short,
 * deduct everything available and report the unmet amount as a shortfall
 * -- this function never fabricates stock and never throws for a
 * shortfall; it only reports it in categoryResults for the caller to warn
 * about.
 *
 * Items with no category_id can never participate (there's nothing to
 * assign their value to) -- this is intentional, not an oversight.
 *
 * @param {object} params
 * @param {number} params.invoiceSubtotal - the invoice's pre-VAT amount
 * @param {number} params.materialPct - 0-100
 * @param {Record<string, number>} params.categorySplits - { categoryId: pct }; need not sum to 100 here, the caller validates that before calling
 * @param {string} params.siteId - the invoice's site id
 * @param {string|null} params.centralSiteId - ส่วนกลาง's site id, or null if no such site exists yet
 * @param {Array<{id: string, category_id: string|null}>} params.items
 * @param {Array<{inventory_item_id: string, site_id: string, quantity_on_hand: number, weighted_average_cost: number}>} params.balances
 * @returns {{
 *   steps: Array<{type: 'sale_out'|'transfer_out'|'transfer_in', inventoryItemId: string, siteId: string, quantity: number, unitCost: number, categoryId: string}>,
 *   categoryResults: Array<{categoryId: string, targetValue: number, deductedValue: number, shortfall: number}>,
 *   totalTargetValue: number, totalDeductedValue: number, totalShortfall: number,
 * }}
 */
export function computeInvoiceDeductionPlan({ invoiceSubtotal, materialPct, categorySplits, siteId, centralSiteId, items, balances }) {
  const materialValue = invoiceSubtotal * (materialPct / 100)
  const steps = []
  const categoryResults = []

  for (const [categoryId, splitPct] of Object.entries(categorySplits || {})) {
    const targetValue = materialValue * (splitPct / 100)
    if (!(targetValue > 0)) {
      categoryResults.push({ categoryId, targetValue: 0, deductedValue: 0, shortfall: 0 })
      continue
    }

    const categoryItemIds = new Set(items.filter(it => it.category_id === categoryId).map(it => it.id))
    const valueOf = (b) => b.quantity_on_hand * b.weighted_average_cost
    const inCategory = (siteFilter) => (balances || []).filter(b =>
      b.site_id === siteFilter && categoryItemIds.has(b.inventory_item_id) && b.quantity_on_hand > 0 && b.weighted_average_cost > 0)

    const siteBalances = inCategory(siteId)
    const siteTotalValue = siteBalances.reduce((s, b) => s + valueOf(b), 0)

    let deductedValue = 0

    if (siteTotalValue >= targetValue) {
      for (const b of siteBalances) {
        const share = valueOf(b) / siteTotalValue
        const valueToTake = targetValue * share
        steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: valueToTake / b.weighted_average_cost, unitCost: b.weighted_average_cost, categoryId })
      }
      deductedValue = targetValue
    } else {
      for (const b of siteBalances) {
        steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: b.quantity_on_hand, unitCost: b.weighted_average_cost, categoryId })
      }
      deductedValue = siteTotalValue
      const remaining = targetValue - siteTotalValue

      if (remaining > 0 && centralSiteId) {
        const centralBalances = inCategory(centralSiteId)
        const centralTotalValue = centralBalances.reduce((s, b) => s + valueOf(b), 0)

        if (centralTotalValue > 0) {
          const transferValue = Math.min(remaining, centralTotalValue)
          for (const b of centralBalances) {
            const share = valueOf(b) / centralTotalValue
            const valueToTransfer = transferValue * share
            const qty = valueToTransfer / b.weighted_average_cost
            steps.push({ type: 'transfer_out', inventoryItemId: b.inventory_item_id, siteId: centralSiteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
            steps.push({ type: 'transfer_in', inventoryItemId: b.inventory_item_id, siteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
            steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
          }
          deductedValue += transferValue
        }
      }
    }

    const shortfall = Math.max(0, targetValue - deductedValue)
    categoryResults.push({ categoryId, targetValue, deductedValue, shortfall })
  }

  return {
    steps,
    categoryResults,
    totalTargetValue: categoryResults.reduce((s, c) => s + c.targetValue, 0),
    totalDeductedValue: categoryResults.reduce((s, c) => s + c.deductedValue, 0),
    totalShortfall: categoryResults.reduce((s, c) => s + c.shortfall, 0),
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: PASS, all cases.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npx vitest run`

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js
git commit -m "feat: computeInvoiceDeductionPlan — invoice-ratio COGS sourcing algorithm"
```

---

### Task 3: hooks — settings and the unprocessed-invoice queue

**Files:**
- Modify: `src/hooks/useSupabase.js`.

**Interfaces:**
- Consumes: `useQuery`, `supabase`, `saveAppSetting` (all already in this file).
- Produces: `useInventoryCogsSettings()` returning `{ data: { material_pct, category_splits }, loading, error, refetch }`; `saveInventoryCogsSettings(materialPct, categorySplits)` (async, throws on error, matching `saveAppSetting`'s own contract); `useUnprocessedInvoices()` returning `{ data, loading, error, refetch }` where `data` is an array of `invoices` rows (with `sites(name, site_number)` embedded) that have no `stock_movements` row with `reference_type='invoice'` referencing them yet.

- [ ] **Step 1: Add the settings hook and save helper**

Add near the existing `useAppSetting`/`saveAppSetting` functions (find them by content):

```js
const INVENTORY_COGS_SETTINGS_KEY = 'inventory_cogs_ratio'

/** { material_pct, category_splits: {categoryId: pct} }, with sensible
 *  defaults if the tenant has never saved this setting. */
export function useInventoryCogsSettings() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('app_settings').select('value').eq('key', INVENTORY_COGS_SETTINGS_KEY).maybeSingle()
    if (error) throw error
    if (!data?.value) return { material_pct: 70, category_splits: {} }
    try {
      const parsed = JSON.parse(data.value)
      return { material_pct: parsed.material_pct ?? 70, category_splits: parsed.category_splits ?? {} }
    } catch {
      return { material_pct: 70, category_splits: {} }
    }
  })
}

export async function saveInventoryCogsSettings(materialPct, categorySplits) {
  await saveAppSetting(INVENTORY_COGS_SETTINGS_KEY, JSON.stringify({ material_pct: materialPct, category_splits: categorySplits }))
}
```

- [ ] **Step 2: Add the unprocessed-invoices queue hook**

Add near `usePurchaseOrders()` or another invoice-adjacent hook (find by content):

```js
/** Invoices with a site and a billed status, that have no stock_movements
 *  row yet with reference_type='invoice' pointing at them -- the queue
 *  for the invoice-ratio COGS deduction feature. Client-side filter
 *  (load both lists, subtract), matching this file's existing pattern for
 *  similar lookups rather than a raw SQL view or RPC just for a list. */
export function useUnprocessedInvoices() {
  return useQuery(async () => {
    const { data: invoices, error: invErr } = await supabase
      .from('invoices')
      .select('*, sites(name, site_number)')
      .in('status', ['unpaid', 'paid'])
      .not('site_id', 'is', null)
      .order('date', { ascending: false })
    if (invErr) throw invErr

    const { data: processedRefs, error: refErr } = await supabase
      .from('stock_movements')
      .select('reference_id')
      .eq('reference_type', 'invoice')
    if (refErr) throw refErr

    const processedIds = new Set((processedRefs || []).map(r => r.reference_id))
    return (invoices || []).filter(inv => !processedIds.has(inv.id))
  })
}
```

- [ ] **Step 3: Build**

```bash
npx vite build
```

- [ ] **Step 4: Live-verify**

Create a throwaway test tenant (`inv-cogs-task3@facadex-test.local`). Via authenticated REST: confirm `GET /rest/v1/app_settings?key=eq.inventory_cogs_ratio` returns 0 rows for a fresh tenant (so `useInventoryCogsSettings()`'s default-fallback path is what a real new tenant hits). Call `saveInventoryCogsSettings(65, {'cat-1': 100})`-equivalent via a direct REST upsert to `app_settings` with `key=inventory_cogs_ratio, value='{"material_pct":65,"category_splits":{"cat-1":100}}'`, then confirm a subsequent read parses back to exactly that. Create one site, one client, one invoice with `status='unpaid'` and a real `site_id` — confirm it appears in a `useUnprocessedInvoices()`-equivalent query (both REST calls, manually intersect the results). Post one `record_stock_movement` call with `p_reference_type='invoice', p_reference_id=<that invoice's id>` — confirm the invoice now disappears from the unprocessed set. Also create one invoice with `status='void'` — confirm it never appears in the unprocessed set regardless of whether it has a matching movement.

- [ ] **Step 5: Clean up the test tenant**

Same FK order as Task 1's Step 6, plus `invoices`, `clients` if created. Verify 0 rows.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: inventory COGS settings + unprocessed-invoice queue hooks"
```

---

### Task 4: the "ตัดสต็อกจากใบแจ้งหนี้" tab — settings panel, queue, preview, confirm

**Files:**
- Modify: `src/pages/Inventory.jsx` — new tab, new components, wiring.

**Interfaces:**
- Consumes: `computeInvoiceDeductionPlan` (Task 2); `useInventoryCogsSettings`, `saveInventoryCogsSettings`, `useUnprocessedInvoices` (Task 3); `useInventoryCategories`, `useAllInventoryItems`, `useStockBalances`, `useSites` (already imported in this file).
- Produces: no new exports — extends the main `Inventory` component and adds two new local components, `CogsSettingsPanel` and `InvoiceDeductionRow`.

- [ ] **Step 1: Read the current file first**

Read `src/pages/Inventory.jsx` in full — this plan builds on top of the merged-table/adjustment work from the prior plan (`BalanceRow`, `tableRows`, `centralSite`, the view-toggle button row, `categories`). Find every anchor point by content, not by line number.

- [ ] **Step 2: Insert the new tab button in the spec-mandated order**

The spec's decision 9 final tab order is: (1) รายการสินค้าคงคลัง, (2) ตัดสต็อกจากใบแจ้งหนี้ (new), (3) หน้าตัดอลูมิเนียม, (4) ประวัติการเคลื่อนไหว. The current button row order is `items`, `movements`, `profiles` — change it to `items`, `invoice_deduction`, `profiles`, `movements`:

```jsx
<button className={`btn btn-sm ${view === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('items')}>📦 รายการสินค้าคงคลัง</button>
<button className={`btn btn-sm ${view === 'invoice_deduction' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('invoice_deduction')}>🧾 ตัดสต็อกจากใบแจ้งหนี้</button>
<button className={`btn btn-sm ${view === 'profiles' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('profiles')}>🔧 หน้าตัดอลูมิเนียม</button>
<button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
```

Reorder the corresponding `{view === '...' && (...)}` blocks to match this same order in the JSX (cosmetic, but keep the file's visual structure matching its own button order).

- [ ] **Step 3: Wire the new hooks and local state into the main component**

Add alongside the existing hook calls:

```js
const { data: cogsSettings, refetch: refetchCogsSettings } = useInventoryCogsSettings()
const { data: unprocessedInvoices, refetch: refetchUnprocessedInvoices } = useUnprocessedInvoices()
const { data: allInventoryItems } = useAllInventoryItems()
const [expandedInvoiceId, setExpandedInvoiceId] = useState(null)
const [confirmingInvoiceId, setConfirmingInvoiceId] = useState(null)
```

(`items`/`balances`/`categories`/`sites`/`centralSite` are already loaded by the existing component from the prior plan's work — reuse them, don't add duplicate hook calls. If the existing `items` variable is item-definitions-only without every field `computeInvoiceDeductionPlan` needs, confirm it has at least `id` and `category_id` — it does, per the prior plan's Task 2 embed work.)

- [ ] **Step 4: Add `CogsSettingsPanel`**

Add above `export default function Inventory()`:

```jsx
function CogsSettingsPanel({ settings, categories, onSaved }) {
  const [materialPct, setMaterialPct] = useState(String(settings?.material_pct ?? 70))
  const [splits, setSplits] = useState(() => {
    const initial = {}
    for (const c of categories || []) initial[c.id] = String(settings?.category_splits?.[c.id] ?? 0)
    return initial
  })
  const [saving, setSaving] = useState(false)

  const sum = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const validSum = Math.abs(sum - 100) < 0.01

  const save = async () => {
    if (!validSum) { alert('ผลรวม % ต้องเท่ากับ 100'); return }
    const pct = parseFloat(materialPct)
    if (isNaN(pct) || pct < 0 || pct > 100) { alert('% ต้นทุนวัสดุต้องอยู่ระหว่าง 0-100'); return }
    setSaving(true)
    try {
      const numericSplits = Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, parseFloat(v) || 0]))
      await saveInventoryCogsSettings(pct, numericSplits)
      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>ตั้งค่าสัดส่วนการตัดสต็อก (ค่าเริ่มต้น แก้ไขได้ทีละใบแจ้งหนี้)</div>
      <div>
        <label className="label">% ต้นทุนวัสดุของยอดใบแจ้งหนี้ (ก่อน VAT)</label>
        <input className="input input-sm" style={{ width: 100 }} type="number" min="0" max="100" step="0.1" value={materialPct} onChange={e => setMaterialPct(e.target.value)} />
      </div>
      <div>
        <label className="label">สัดส่วนแยกตามหมวดหมู่ (ต้องรวมเป็น 100%)</label>
        <div style={{ display: 'grid', gap: 6 }}>
          {(categories || []).map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 160, fontSize: 13 }}>{c.name}</span>
              <input className="input input-sm" style={{ width: 90 }} type="number" min="0" max="100" step="0.1"
                value={splits[c.id] ?? '0'} onChange={e => setSplits(s => ({ ...s, [c.id]: e.target.value }))} />
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>%</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, marginTop: 6, color: validSum ? 'var(--green)' : 'var(--red)' }}>
          รวม {sum.toFixed(1)}% {validSum ? '✓' : '— ต้องเท่ากับ 100%'}
        </div>
      </div>
      <button className="btn btn-sm btn-primary" style={{ justifySelf: 'start' }} disabled={saving || !validSum} onClick={save}>{saving ? '⏳' : '💾 บันทึกค่าเริ่มต้น'}</button>
    </div>
  )
}
```

- [ ] **Step 5: Add `InvoiceDeductionRow`**

Add below `CogsSettingsPanel`:

```jsx
function InvoiceDeductionRow({ invoice, categories, items, balances, centralSite, defaultSettings, expanded, onToggle, onConfirmed }) {
  const [materialPct, setMaterialPct] = useState(String(defaultSettings?.material_pct ?? 70))
  const [splits, setSplits] = useState(() => {
    const initial = {}
    for (const c of categories || []) initial[c.id] = String(defaultSettings?.category_splits?.[c.id] ?? 0)
    return initial
  })
  const [confirming, setConfirming] = useState(false)

  const numericSplits = Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, parseFloat(v) || 0]))
  const plan = expanded ? computeInvoiceDeductionPlan({
    invoiceSubtotal: invoice.subtotal, materialPct: parseFloat(materialPct) || 0, categorySplits: numericSplits,
    siteId: invoice.site_id, centralSiteId: centralSite?.id || null, items: items || [], balances: balances || [],
  }) : null

  const sum = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const validSum = Math.abs(sum - 100) < 0.01

  const confirm = async () => {
    if (!validSum) { alert('ผลรวม % ต้องเท่ากับ 100'); return }
    if (!plan || !plan.steps.length) { alert('ไม่มีรายการให้ตัดสต็อก'); return }
    setConfirming(true)
    try {
      const { data: existing, error: checkErr } = await supabase
        .from('stock_movements').select('id').eq('reference_type', 'invoice').eq('reference_id', invoice.id).limit(1)
      if (checkErr) throw checkErr
      if (existing?.length) { alert('ใบแจ้งหนี้นี้ถูกตัดสต็อกไปแล้ว — กำลังรีเฟรชรายการ'); onConfirmed(); return }

      for (const step of plan.steps) {
        const { error } = await supabase.rpc('record_stock_movement', {
          p_inventory_item_id: step.inventoryItemId, p_site_id: step.siteId, p_movement_type: step.type,
          p_quantity: step.quantity, p_unit_cost: step.unitCost,
          p_reference_type: 'invoice', p_reference_id: invoice.id, p_notes: null,
        })
        if (error) throw error
      }
      if (plan.totalShortfall > 0.01) {
        alert(`ตัดสต็อกสำเร็จบางส่วน — ขาดอีก ${fmt(plan.totalShortfall)} บาท (สต็อกไม่พอทั้งที่ไซท์งานและส่วนกลาง)`)
      }
      onConfirmed()
    } catch (e) { alert('ตัดสต็อกไม่สำเร็จ: ' + e.message) }
    finally { setConfirming(false) }
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={onToggle}>
        <div>
          <strong>{invoice.invoice_number}</strong>
          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text3)' }}>{invoice.sites?.name} · {fmt(invoice.subtotal)} บาท (ก่อน VAT)</span>
        </div>
        <span>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <div>
            <label className="label">% ต้นทุนวัสดุ (สำหรับใบนี้)</label>
            <input className="input input-sm" style={{ width: 100 }} type="number" min="0" max="100" step="0.1" value={materialPct} onChange={e => setMaterialPct(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {(categories || []).map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 160, fontSize: 13 }}>{c.name}</span>
                <input className="input input-sm" style={{ width: 90 }} type="number" min="0" max="100" step="0.1"
                  value={splits[c.id] ?? '0'} onChange={e => setSplits(s => ({ ...s, [c.id]: e.target.value }))} />
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>%</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: validSum ? 'var(--green)' : 'var(--red)' }}>รวม {sum.toFixed(1)}% {validSum ? '✓' : '— ต้องเท่ากับ 100%'}</div>
          {plan && (
            <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>ตัวอย่างการตัดสต็อก</div>
              {plan.categoryResults.map(cr => {
                const cat = (categories || []).find(c => c.id === cr.categoryId)
                return (
                  <div key={cr.categoryId} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{cat?.name || cr.categoryId}</span>
                    <span className="font-mono">
                      {fmt(cr.deductedValue)} / {fmt(cr.targetValue)} บาท
                      {cr.shortfall > 0.01 && <span style={{ color: 'var(--red)' }}> (ขาด {fmt(cr.shortfall)})</span>}
                    </span>
                  </div>
                )
              })}
              <div style={{ fontWeight: 700, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                รวม {fmt(plan.totalDeductedValue)} บาท{plan.totalShortfall > 0.01 && <span style={{ color: 'var(--red)' }}> — ขาด {fmt(plan.totalShortfall)} บาท</span>}
              </div>
            </div>
          )}
          <button className="btn btn-sm btn-primary" style={{ justifySelf: 'start' }} disabled={confirming || !validSum} onClick={confirm}>
            {confirming ? '⏳' : '✅ ยืนยันตัดสต็อก'}
          </button>
        </div>
      )}
    </div>
  )
}
```

Add the import: `import { computeInvoiceDeductionPlan } from '../lib/inventoryCost.js'` (alongside `computeWeightedAverageCost`/`computeAluminumWeightKg`/`computeGlassAreaSqm`, if those are already imported here — otherwise add a fresh import line).

- [ ] **Step 6: Add the `invoice_deduction` view block**

```jsx
{view === 'invoice_deduction' && (
  <>
    <CogsSettingsPanel settings={cogsSettings} categories={categories} onSaved={refetchCogsSettings} />
    {!centralSite && (
      <div className="alert alert-error" style={{ marginBottom: 14 }}>ไม่พบไซท์งานชื่อ "ส่วนกลาง" — การตัดสต็อกจะดึงจากไซท์งานได้อย่างเดียว ไม่มีที่มาสำรอง</div>
    )}
    {(unprocessedInvoices || []).map(inv => (
      <InvoiceDeductionRow
        key={inv.id} invoice={inv} categories={categories} items={allInventoryItems} balances={balances}
        centralSite={centralSite} defaultSettings={cogsSettings}
        expanded={expandedInvoiceId === inv.id}
        onToggle={() => setExpandedInvoiceId(id => id === inv.id ? null : inv.id)}
        onConfirmed={() => { setExpandedInvoiceId(null); refetchUnprocessedInvoices(); refetchBalances(); refetchItems() }}
      />
    ))}
    {!(unprocessedInvoices || []).length && (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีใบแจ้งหนี้ที่รอตัดสต็อก</div>
    )}
  </>
)}
```

Note: `!centralSite` here is a *warning*, not a blocker — unlike the merged item table's adjustment feature (which requires ส่วนกลาง to exist at all, since decision 3 hard-requires it), the invoice-deduction sourcing algorithm degrades gracefully with `centralSiteId: null` (per Task 2's `computeInvoiceDeductionPlan`, which already handles a null `centralSiteId` by simply skipping the backfill step and reporting a larger shortfall instead) — never block confirming, matching decision 7's own non-blocking posture.

- [ ] **Step 7: Build**

```bash
npx vite build
```

- [ ] **Step 8: Live-verify**

Create a throwaway test tenant (`inv-cogs-task4@facadex-test.local`). Via authenticated REST: create a site named `ส่วนกลาง`, a second job site, one `inventory_categories` row (or use the 4 auto-seeded ones), one `inventory_items` row in that category, a `purchase_in` movement giving that item stock at the job site (enough to fully cover a small test invoice), a client, and one `invoice` with `status='unpaid'`, `site_id` = the job site, and a known `subtotal`.

Navigate to the Inventory page's new tab (or drive it via REST + reasoning if no browser/Playwright tool is available in your environment, clearly disclosing which in your report): confirm the invoice appears in the queue; expand it; confirm the live preview shows the expected target/deducted values matching a hand-calculated expectation from the seeded numbers; confirm the settings panel's sum-to-100 validation blocks saving when the splits don't sum to 100; click "ยืนยันตัดสต็อก"; confirm `stock_movements` now has `sale_out` row(s) with `reference_type='invoice', reference_id=<the invoice id>`; confirm the invoice disappears from the queue on refetch; confirm attempting to process the same invoice again (calling the confirm path a second time, e.g. via a second REST-driven pass) is caught by the pre-confirm existence check and shows the "already processed" message rather than posting a duplicate.

- [ ] **Step 9: Clean up the test tenant**

Same FK order as Task 1's Step 6, plus `invoices`, `clients`. Verify 0 rows.

- [ ] **Step 10: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: invoice-ratio COGS stock deduction tab (settings, queue, preview, confirm)"
git push origin worktree-quotation-module:main
```

---

## After all tasks: final whole-branch review

Dispatch the final code reviewer on the most capable available model, covering the full diff across all 4 tasks, with particular attention to:

- `record_stock_movement()`'s extended type list doesn't change behavior for any of the 5 pre-existing movement types — trace the diff line-by-line against the pre-Task-1 version.
- `computeInvoiceDeductionPlan()`'s value-conservation property: for every category, `deductedValue + shortfall === targetValue` exactly (a rounding or logic bug here would silently over- or under-deduct real inventory value) — spot check this arithmetic identity holds across the test suite's cases, and consider whether an additional property-based or fuzz-style test is warranted given how much this function is trusted.
- The confirm loop in `InvoiceDeductionRow` posts every step with `reference_type: 'invoice', reference_id: invoice.id` — including `transfer_out`/`transfer_in` backfill steps, matching spec decision 7's point 5 exactly (this is what makes the invoice "processed"; missing it on even one step type would leave the invoice stuck in the queue forever or double-payable).
- Confirm no path lets `InvoiceDeductionRow` call `record_stock_movement` before the pre-confirm existence re-check completes — a race where the check passes but a concurrent duplicate slips in between check and post is the accepted risk from this plan's Global Constraints, but a *missing* check entirely would be a real regression, not an accepted risk.
- `Invoices.jsx` has zero diff lines in the whole plan (grep the final diff for that filename — it should not appear at all).

If the review returns findings, dispatch ONE fix subagent with the complete list, one scoped re-review, adjudicate any residuals per the subagent-driven-development skill's breaker. Once clean and pushed, this plan (and the whole two-plan inventory-categories/opening-balance/invoice-COGS arc from the same spec) is complete.
