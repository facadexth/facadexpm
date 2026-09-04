# Inventory Module — Phase 1 (Buying-Side Stock Ledger) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give FacadeXPM real physical stock tracking with weighted-average-cost valuation for materials bought via Purchase Orders — the "buying side" needed to replace PEAK's inventory module — without touching the sell side (catalog/quotation/invoice/COGS), which is Phase 2 and explicitly out of scope here.

**Architecture:** Four new tables (`inventory_items`, `inventory_item_unit_factors`, `inventory_stock_balances`, `stock_movements`) plus one nullable FK on `purchase_order_items`. All stock/cost math is centralized in one SECURITY DEFINER Postgres function, `record_stock_movement()`, so the ledger insert and the running-balance recalculation happen atomically in one round trip — mirroring `perform_worker_checkin()`'s pattern (`supabase/schema.sql:2051`). The React side gets three new read hooks, one PurchaseOrders.jsx enhancement (link PO lines to inventory items, post stock on receive), one new admin page (`Inventory.jsx`: item management, valuation report, movement ledger), and one Sites.jsx enhancement (leftover-to-central-stock transfer at site completion).

**Tech Stack:** React + Vite, Supabase (Postgres + PostgREST + RLS), vitest for pure-JS logic, Playwright for live verification. No ORM, no local Postgres — all migrations apply directly to the live project.

**Spec:** `docs/superpowers/specs/2026-09-01-inventory-module-design.md` — read it in full before touching any task; every table definition and business rule below is copied from it verbatim except where a Ruling explicitly narrows or resolves something the spec left open. This plan implements only the spec's own "Phase 1" bullet list; its "Phase 2" bullet list (catalog_items linking, invoice-triggered `sale_out`/`sale_reversal`, COGS report) is a future plan.

## Global Constraints

- Live Supabase project `yyzbgdmgyvvypfcjuhtr`, no local Postgres. Every migration task: dry-run in `BEGIN;...ROLLBACK;` via the `execute_sql` MCP tool, then `apply_migration` (this takes effect on production immediately), then write the identical SQL to `supabase/migrations/YYYY-MM-DD-NN-<name>.sql`, then update `supabase/schema.sql` to match. Today is 2026-09-05; the last-used suffix is `-05`, so this plan's migrations are `-06`, `-07`, `-08`.
- No unit test runner exists beyond the real vitest suite at the repo root (`src/lib/*.test.js`, run via `npx vitest run` — 84 passing tests as of this plan). Any new pure-JS logic gets a real vitest file next to it, following `src/lib/thaiBahtText.test.js`'s `describe`/`it`/`expect` pattern. Every UI/integration task additionally verifies live: `npx vite build`, a throwaway Supabase test tenant, Playwright against `http://localhost:5199`, full cleanup afterward, then commit + push directly to `main`.
- **Throwaway test tenant pattern** (verbatim, reused from `docs/superpowers/plans/2026-09-01-worker-checkin-checkout.md`, used throughout this project):
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
  -- user_roles/tenants rows auto-created by handle_new_user() trigger. Never insert those two directly.
  COMMIT;
  ```
  New tenant owners get an active trial (`has_module_access()` returns true during trial regardless of `tenant_modules`), so no extra module-grant step is needed to test admin/owner write paths. Give every task's test tenant a distinct email local-part (e.g. `inv-task1@facadex-test.local`) so parallel/sequential test runs never collide. Clean up fully afterward in FK-dependency order, verified with a final 0-row count query.
- **Playwright:** log in via the real login form (`input[type=email]`/`input[type=password]`, click submit) — API signup + localStorage token injection does not work in this app. No client-side router — navigate via `await page.evaluate(() => sessionStorage.setItem('pendingTab', '<tab-id>'))` then `await page.reload()`.
- **Sandbox note:** multi-line heredoc bash commands are rejected as "too complex to verify." Write commit messages to a plain temp file first, then `git commit -F <file>`.
- **Ruling A — module gating.** All new tables and `record_stock_movement()` are gated on `has_module_access('purchase_orders')`, the same module key `purchase_orders`/`purchase_order_items` already use (`supabase/schema.sql:707-719`) — not a new `'inventory'` module key. Phase 1 is an extension of the buying-side capability tenants already have; a new paid module key would require touching the `packages`/`tenant_modules` grant system (`TenantManagement.jsx`, package definitions), which is out of scope for this plan. Revisit this choice if/when Phase 2 (sell-side) is planned.
- **Ruling B — catalog_items link deferred.** The spec's `ALTER TABLE catalog_items ADD COLUMN inventory_item_id ...` belongs to its own Phase 2 bullet list ("catalog_items linking, invoice-triggered sale_out/sale_reversal..."), not Phase 1 ("inventory_items, unit factors, inventory_stock_balances, stock_movements, PO-linking, site-completion leftover transfer, the stock card + valuation reports"). This plan does **not** touch `catalog_items` at all.
- **Ruling C — `adjustment` movement type has no Phase 1 UI.** `stock_movements.movement_type`'s CHECK constraint includes all six values from the spec's data model verbatim (`purchase_in, transfer_in, transfer_out, sale_out, sale_reversal, adjustment`) so the schema matches the spec exactly, but `record_stock_movement()` only accepts `'purchase_in' | 'transfer_in' | 'transfer_out'` and raises an exception on anything else. `sale_out`/`sale_reversal` are Phase 2 (invoice-triggered). A manual `adjustment` entry point was explicitly left as an open planning question in the spec ("Exact UI surface for... a manual adjustment movement... is a planning-time decision, not fixed here") and Phase 1's own task list doesn't include one — do not build one.
- **Ruling D — tenant-ownership check inside the SECURITY DEFINER function.** Because `record_stock_movement()` runs as SECURITY DEFINER (bypasses RLS), it must not trust its UUID parameters blindly — a caller could pass another tenant's `inventory_item_id`/`site_id`. Task 2 explicitly re-verifies both belong to `current_tenant_id()` before writing anything, mirroring `perform_worker_checkin()`'s pattern of scoping every FK input inside the function body rather than relying on RLS (`supabase/schema.sql:2066-2076`).
- **Ruling E — `transfer_out` may take a balance negative without a hard block**, consistent with this app's existing non-blocking posture (PO/expense creation has no stock gates either). The spec's decision #12 ("insufficient stock is a soft warning, not a hard block") is written specifically about `sale_out` at invoice time (Phase 2), but the same posture is extended to `transfer_out` here for consistency rather than left undefined.
- **Ruling F — only the fixed-factor conversion style is built.** The spec's decision #3 describes two unit-conversion styles: fixed-factor (aluminium-style, `inventory_item_unit_factors`) and per-transaction dimension entry (glass-style, width × height captured on the movement itself, "no stored row needed"). This plan implements only the fixed-factor style (Task 1's table, Task 5's `convertToBaseUnit()` lookup). No width/height input UI is built. A PO line for a dimension-priced item can still be received today by typing the already-computed base-unit quantity (e.g. the sqm figure) directly into the existing quantity field with a unit matching the item's `base_unit` — Task 5's conversion logic treats a PO line whose unit has no matching factor row as already being in base units (1:1), which is exactly this manual workaround. A dedicated dimension-entry UI is future work, not part of Phase 1's task list.
- **View column-freeze gotcha:** N/A for this plan — no new SQL views are created; every report reads tables directly via PostgREST embeds (matching `usePurchaseOrders`'s existing `sites(name, site_number)` embed pattern), which always reflects current columns.
- **Function-overload gotcha:** `CREATE OR REPLACE FUNCTION` with a changed parameter list creates a second overload, not a replacement. Not expected to occur in this plan (each function is created once, in Task 2), but if any later task needs to change `record_stock_movement()`'s signature, it must `DROP FUNCTION record_stock_movement(<exact old signature>)` first.
- **Type/name consistency across tasks** (so later tasks don't have to guess): the RPC is always called as `supabase.rpc('record_stock_movement', { p_inventory_item_id, p_site_id, p_movement_type, p_quantity, p_unit_cost, p_reference_type, p_reference_id, p_notes })`. Hooks are always `useInventoryItems()`, `useInventoryItemUnitFactors()`, `useStockBalances()`, `useStockMovements(filters)`. Pure-JS helpers live in `src/lib/inventoryCost.js` as `computeWeightedAverageCost(oldQty, oldWac, incomingQty, incomingUnitCost)` and `convertToBaseUnit(quantity, factorToBase)`.

---

### Task 1: `inventory_items` + `inventory_item_unit_factors`

**Files:**
- Create: `supabase/migrations/2026-09-05-06-inventory-items.sql`
- Modify: `supabase/schema.sql` — insert the new section immediately after the `purchase_order_items` RLS block (currently ending at line 719) and before the `-- CATALOG_ITEMS` section header (currently line 721-722).

**Interfaces:**
- Produces: table `inventory_items(id, tenant_id, name, base_unit, active, created_at)`; table `inventory_item_unit_factors(id, tenant_id, inventory_item_id, unit_name, factor_to_base)`, `UNIQUE(inventory_item_id, unit_name)`. Both RLS-enabled, single `admin_full_access` policy each, gated `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')` (Ruling A).
- Consumes: `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()` — all pre-existing functions, unchanged.

- [ ] **Step 1: Dry-run the migration**

Run via the `execute_sql` MCP tool, wrapped in `BEGIN; ... ROLLBACK;`:

```sql
CREATE TABLE inventory_items (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  base_unit   TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_items_tenant_id ON inventory_items(tenant_id);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

CREATE TABLE inventory_item_unit_factors (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit_name           TEXT NOT NULL,
  factor_to_base      NUMERIC NOT NULL,
  UNIQUE (inventory_item_id, unit_name)
);

CREATE INDEX idx_inventory_item_unit_factors_tenant_id ON inventory_item_unit_factors(tenant_id);
CREATE INDEX idx_inventory_item_unit_factors_item_id ON inventory_item_unit_factors(inventory_item_id);

ALTER TABLE inventory_item_unit_factors ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_item_unit_factors FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
```

Expected: no errors.

- [ ] **Step 2: Apply live via `apply_migration`**

Use the exact SQL from Step 1 (without the `BEGIN`/`ROLLBACK` wrapper).

- [ ] **Step 3: Verify schema state**

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('inventory_items','inventory_item_unit_factors');
SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('inventory_items','inventory_item_unit_factors');
```

Expected: both tables `rowsecurity = true`, one `admin_full_access` policy row each.

- [ ] **Step 4: Live-verify RLS with a real session**

Create a throwaway test tenant (email `inv-task1@facadex-test.local`) per the Global Constraints pattern. Log in via Playwright (real login form), extract the session's `access_token` from `localStorage` (`page.evaluate(() => JSON.parse(Object.values(localStorage).find(v => v.includes('access_token'))).access_token)` — or read the exact storage key this app's Supabase client uses from `src/lib/supabase.js` if that generic search doesn't match). Using `page.evaluate` with `fetch()`, `POST` to `<SUPABASE_URL>/rest/v1/inventory_items` (read `SUPABASE_URL` and the anon key from `src/lib/supabase.js`) with headers `apikey`, `Authorization: Bearer <access_token>`, `Content-Type: application/json`, `Prefer: return=representation`, body `{"name":"Test Aluminium","base_unit":"kg"}`. Expect `201` and a row back with a generated `id` and this tenant's `tenant_id`. Then `GET` the same endpoint and confirm exactly one row.

- [ ] **Step 5: Clean up the test tenant**

Delete in FK-dependency order: `inventory_items` (test row) → `user_roles` → `tenants` → `auth.identities` → `auth.users`, filtered by the test email/tenant. Verify with a final `SELECT COUNT(*)` returning `0` across all five.

- [ ] **Step 6: Write the migration file**

Create `supabase/migrations/2026-09-05-06-inventory-items.sql` with the exact SQL from Step 1 (no `BEGIN`/`ROLLBACK`), preceded by this header comment:

```sql
-- ============================================================
-- Inventory module Phase 1, part 1/3: item definitions.
-- See docs/superpowers/specs/2026-09-01-inventory-module-design.md
-- and docs/superpowers/plans/2026-09-05-inventory-phase1-plan.md.
-- ============================================================
```

- [ ] **Step 7: Update `supabase/schema.sql`**

Insert the same SQL (header comment + both `CREATE TABLE`s + indexes + RLS) right after the existing `purchase_order_items` RLS block (after the line `WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));` that closes `purchase_order_items`'s policy, currently line 719), before the `-- ----...` / `-- CATALOG_ITEMS` header. Add one line above the inserted block: `-- Phase 1 buying-side module gates on 'purchase_orders', not a new module key (see the Phase 1 plan's Ruling A).`

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-05-06-inventory-items.sql supabase/schema.sql
git commit -m "feat: inventory items + unit-factor tables (inventory Phase 1, part 1/3)"
```

---

### Task 2: `inventory_stock_balances` + `stock_movements` + `record_stock_movement()`

**Files:**
- Create: `supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql`
- Modify: `supabase/schema.sql` — insert immediately after Task 1's new section.

**Interfaces:**
- Consumes: `inventory_items` (Task 1), `sites` (existing), `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()`, `auth.email()`.
- Produces: table `inventory_stock_balances(id, tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)`, `UNIQUE(inventory_item_id, site_id)`; table `stock_movements(id, tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)`; function `record_stock_movement(p_inventory_item_id UUID, p_site_id UUID, p_movement_type TEXT, p_quantity NUMERIC, p_unit_cost NUMERIC, p_reference_type TEXT, p_reference_id UUID, p_notes TEXT) RETURNS TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)`, callable via `supabase.rpc('record_stock_movement', {...})`. Every later task that posts a movement calls this function — never inserts into `stock_movements`/`inventory_stock_balances` directly from the client.

- [ ] **Step 1: Dry-run the migration**

```sql
CREATE TABLE inventory_stock_balances (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id      UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  site_id                UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  quantity_on_hand       NUMERIC NOT NULL DEFAULT 0,
  weighted_average_cost  NUMERIC NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inventory_item_id, site_id)
);

CREATE INDEX idx_inventory_stock_balances_tenant_id ON inventory_stock_balances(tenant_id);
CREATE INDEX idx_inventory_stock_balances_site_id ON inventory_stock_balances(site_id);

ALTER TABLE inventory_stock_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_stock_balances FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

CREATE TABLE stock_movements (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  movement_type       TEXT NOT NULL CHECK (movement_type IN
                        ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment')),
  quantity            NUMERIC NOT NULL,
  unit_cost           NUMERIC,
  reference_type      TEXT,
  reference_id        UUID,
  notes               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_tenant_id ON stock_movements(tenant_id);
CREATE INDEX idx_stock_movements_item_site ON stock_movements(inventory_item_id, site_id);
CREATE INDEX idx_stock_movements_reference ON stock_movements(reference_type, reference_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON stock_movements FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- Atomically posts one stock_movements row and recalculates the
-- affected (item, site) balance's weighted-average cost, per
-- docs/superpowers/specs/2026-09-01-inventory-module-design.md's
-- Business Logic > Purchasing formula:
--   new_wac = (old_qty*old_wac + moved_qty*unit_cost) / (old_qty + moved_qty)
-- SECURITY DEFINER (like perform_worker_checkin(), schema.sql) so it
-- must re-verify privilege AND that both FK inputs belong to the
-- caller's own tenant before writing anything (Ruling D) -- RLS is
-- bypassed inside this function, nothing here can be assumed safe.
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
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out') THEN
    RAISE EXCEPTION 'unsupported_movement_type: %', p_movement_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, p_movement_type, p_quantity, p_unit_cost, p_reference_type, p_reference_id, p_notes, auth.email())
  RETURNING id INTO v_movement_id;

  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
  FROM inventory_stock_balances
  WHERE inventory_item_id = p_inventory_item_id AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_old_qty := 0;
    v_old_wac := 0;
  END IF;

  IF p_movement_type IN ('purchase_in', 'transfer_in') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
  ELSE
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
  END IF;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$$;

GRANT EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) TO authenticated;
```

Expected: no errors.

- [ ] **Step 2: Apply live via `apply_migration`**

- [ ] **Step 3: Verify schema + function state**

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('inventory_stock_balances','stock_movements');
SELECT proname, pronargs FROM pg_proc WHERE proname = 'record_stock_movement';
```

Expected: both tables `rowsecurity = true`; exactly one `record_stock_movement` row with `pronargs = 8`.

- [ ] **Step 4: Live-verify the RPC with a real session**

Create a throwaway test tenant (`inv-task2@facadex-test.local`). As that tenant's owner, via `execute_sql` (safe here — this is just fixture setup, not the thing under test), insert one `sites` row (any name) and one `inventory_items` row (`base_unit = 'kg'`), both with this tenant's `tenant_id`. Log in via Playwright, extract the real `access_token`, and via `page.evaluate` + `fetch()` `POST` to `<SUPABASE_URL>/rest/v1/rpc/record_stock_movement` with body:
```json
{"p_inventory_item_id":"<the item id>","p_site_id":"<the site id>","p_movement_type":"purchase_in","p_quantity":100,"p_unit_cost":50,"p_reference_type":"manual","p_reference_id":null,"p_notes":"test"}
```
Expect `200` with `[{"movement_id":"...","new_quantity_on_hand":100,"new_weighted_average_cost":50}]`. Call it again with `p_quantity:100,p_unit_cost:70` and expect `new_quantity_on_hand:200, new_weighted_average_cost:60` (matches `computeWeightedAverageCost(100,50,100,70)=60`, the same case Task 4's vitest file will assert). Then call with `p_movement_type:"transfer_out","p_quantity":50` (no `p_unit_cost` needed) and expect `new_quantity_on_hand:150, new_weighted_average_cost:60` (WAC unchanged on transfer-out, per the spec). Finally call once more with `p_movement_type:"sale_out"` and confirm it's rejected (Ruling C — unsupported in Phase 1).

Cross-check via `execute_sql`: `SELECT COUNT(*) FROM stock_movements WHERE inventory_item_id = '<id>'` should be `3` (the two successful calls that reached the insert, since `sale_out` is rejected before any insert — confirm this by checking the count is exactly 3, not 4).

- [ ] **Step 5: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `inventory_items` → `sites` → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 6: Write the migration file**

`supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql`, same header-comment style as Task 1, containing the exact SQL from Step 1.

- [ ] **Step 7: Update `supabase/schema.sql`**

Insert right after Task 1's new section. Add above the function: `-- record_stock_movement(): the ONLY writer of stock_movements/inventory_stock_balances -- see the Phase 1 plan's Ruling D on why it re-checks tenant ownership itself.`

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql supabase/schema.sql
git commit -m "feat: stock ledger tables + atomic record_stock_movement() RPC (inventory Phase 1, part 2/3)"
```

---

### Task 3: link `purchase_order_items` to `inventory_items`

**Files:**
- Create: `supabase/migrations/2026-09-05-08-po-items-inventory-link.sql`
- Modify: `supabase/schema.sql` — add the column to the existing `purchase_order_items` table definition (currently `supabase/schema.sql:657-667`).

**Interfaces:**
- Consumes: `inventory_items` (Task 1), `purchase_order_items` (existing).
- Produces: `purchase_order_items.inventory_item_id UUID NULL REFERENCES inventory_items(id) ON DELETE SET NULL` — nullable, so every existing PO line and every PO line an admin doesn't choose to link keeps behaving exactly as today (pure expense, no stock effect).

- [ ] **Step 1: Dry-run**

```sql
ALTER TABLE purchase_order_items ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
CREATE INDEX idx_purchase_order_items_inventory_item_id ON purchase_order_items(inventory_item_id);
```

- [ ] **Step 2: Apply live via `apply_migration`**

- [ ] **Step 3: Verify**

```sql
SELECT column_name, is_nullable, data_type FROM information_schema.columns
WHERE table_name = 'purchase_order_items' AND column_name = 'inventory_item_id';
```

Expected: one row, `is_nullable = 'YES'`, `data_type = 'uuid'`.

- [ ] **Step 4: Write the migration file**

`supabase/migrations/2026-09-05-08-po-items-inventory-link.sql` with the Step 1 SQL plus a header comment noting it's part 3/3 of inventory Phase 1's schema.

- [ ] **Step 5: Update `supabase/schema.sql`**

In the `purchase_order_items` table definition, add the new column right after `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` (currently line 666), and add the new index next to the table's other indexes (currently lines 669-674). No RLS change needed — `purchase_order_items`'s existing policy already covers this column.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-05-08-po-items-inventory-link.sql supabase/schema.sql
git commit -m "feat: link purchase_order_items to inventory_items (inventory Phase 1, part 3/3)"
```

---

### Task 4: hooks + pure-JS cost/unit-conversion helpers

**Files:**
- Create: `src/lib/inventoryCost.js`
- Create: `src/lib/inventoryCost.test.js`
- Modify: `src/hooks/useSupabase.js` — add a new `// ── Inventory ──` section (append near the end of the file, after the existing `// ── Bank Accounts ──` / `useUnits()` section around line 908).

**Interfaces:**
- Produces: `computeWeightedAverageCost(oldQty, oldWac, incomingQty, incomingUnitCost)` → `number`; `convertToBaseUnit(quantity, factorToBase)` → `number`. Hooks `useInventoryItems()`, `useInventoryItemUnitFactors()`, `useStockBalances()`, `useStockMovements(filters = {})` — each returns `{ data, loading, error, refetch }` via the existing `useQuery` helper, matching every other hook in this file.
- Consumes: `useQuery`, `fetchAllRows`, `supabase` — all already defined/imported at the top of `useSupabase.js`.

- [ ] **Step 1: Write the failing tests**

`src/lib/inventoryCost.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { computeWeightedAverageCost, convertToBaseUnit } from './inventoryCost.js'

describe('computeWeightedAverageCost', () => {
  it('first receipt into an empty balance', () => {
    expect(computeWeightedAverageCost(0, 0, 100, 50)).toBe(50)
  })
  it('blends a second receipt at a different cost', () => {
    expect(computeWeightedAverageCost(100, 50, 100, 70)).toBe(60)
  })
  it('zero-cost leftover transfer pulls the average down (decision #6)', () => {
    expect(computeWeightedAverageCost(50, 100, 50, 0)).toBe(50)
  })
  it('unequal quantities weight correctly', () => {
    expect(computeWeightedAverageCost(10, 100, 90, 10)).toBe(19)
  })
})

describe('convertToBaseUnit', () => {
  it('applies a fixed conversion factor (aluminium: 1 piece = 2.3 kg)', () => {
    expect(convertToBaseUnit(5, 2.3)).toBeCloseTo(11.5)
  })
  it('factor of 1 is a no-op', () => {
    expect(convertToBaseUnit(42, 1)).toBe(42)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/inventoryCost.test.js
```

Expected: FAIL — `inventoryCost.js` doesn't exist yet.

- [ ] **Step 3: Implement**

`src/lib/inventoryCost.js`:

```js
// ============================================================
// Pure-JS mirror of record_stock_movement()'s weighted-average-cost
// math (supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql)
// -- used to preview the effect of a purchase_in/transfer_in movement
// client-side before the RPC actually posts it. Keep in lockstep with
// the SQL function's formula; if one changes, change both.
// ============================================================

/**
 * New weighted-average cost after adding incomingQty units at
 * incomingUnitCost to an existing balance of oldQty @ oldWac. Matches
 * docs/superpowers/specs/2026-09-01-inventory-module-design.md's
 * Business Logic > Purchasing formula.
 */
export function computeWeightedAverageCost(oldQty, oldWac, incomingQty, incomingUnitCost) {
  const newQty = oldQty + incomingQty
  if (newQty === 0) return 0
  return (oldQty * oldWac + incomingQty * incomingUnitCost) / newQty
}

/** Converts a quantity in an alternate unit to the item's base unit
 *  using a fixed factor (aluminium-style, spec decision #3). */
export function convertToBaseUnit(quantity, factorToBase) {
  return quantity * factorToBase
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/inventoryCost.test.js
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Add the hooks**

In `src/hooks/useSupabase.js`, append after the `useUnits()` function (currently ending line 908):

```js
// ── Inventory ────────────────────────────────────────────────

/** Every active inventory item, for link-pickers on PO lines and the
 *  Inventory page. */
export function useInventoryItems() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return data
  })
}

/** All fixed unit-conversion factors across every inventory item --
 *  a small table, fetched whole and filtered client-side by
 *  (inventory_item_id, unit_name) rather than one query per item. */
export function useInventoryItemUnitFactors() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_item_unit_factors')
      .select('*')
    if (error) throw error
    return data
  })
}

/** Current stock balance per (item, site) -- the valuation report and
 *  the PO receive-preview both read this. */
export function useStockBalances() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_stock_balances')
      .select('*, inventory_items(name, base_unit), sites(name, site_number)')
      .order('inventory_item_id')
    if (error) throw error
    return data
  })
}

/** Append-only stock ledger, newest first -- the stock card. */
export function useStockMovements(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('stock_movements')
        .select('*, inventory_items(name, base_unit), sites(name, site_number)')
        .order('created_at', { ascending: false })
      if (filters.inventoryItemId) q = q.eq('inventory_item_id', filters.inventoryItemId)
      if (filters.siteId) q = q.eq('site_id', filters.siteId)
      return q
    }
    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}
```

- [ ] **Step 6: Build**

```bash
npx vite build
```

Expected: succeeds with no new errors (these hooks aren't imported anywhere yet, so this just confirms no syntax errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js src/hooks/useSupabase.js
git commit -m "feat: inventory hooks + weighted-average-cost/unit-conversion helpers"
```

---

### Task 5: PurchaseOrders.jsx — link PO lines to inventory items, post stock on receive

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx` (full file read in this plan's research; key anchors below use this session's current line numbers)
- Modify: `src/components/Modal.jsx` — one-line change to `ConfirmDialog` so its `message` prop can safely hold block-level JSX (needed for the receive-preview list below).

**Interfaces:**
- Consumes: `useInventoryItems`, `useInventoryItemUnitFactors`, `useStockBalances` (Task 4), `computeWeightedAverageCost`, `convertToBaseUnit` (Task 4), `record_stock_movement` RPC (Task 2), `purchase_order_items.inventory_item_id` (Task 3), `QuickAddSelect` (existing component).
- Produces: no new exports — this task only changes `PurchaseOrders.jsx`'s internal behavior and `ConfirmDialog`'s render output (still backward-compatible: every existing caller passes a plain string, which renders identically inside a `<div>` as inside a `<p>`).

- [ ] **Step 1: Widen `ConfirmDialog` to accept block-level `message`**

In `src/components/Modal.jsx`, change (currently line 90):

```jsx
        <p style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{message}</p>
```

to:

```jsx
        <div style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{message}</div>
```

(A `<p>` cannot legally contain block-level children like `<div>`; every existing caller passes a plain string, which renders identically either way, so this is a safe widening, not a behavior change for existing callers.)

- [ ] **Step 2: Add `inventory_item_id` to the PO items select and the empty/edit-mapping shapes**

In `src/hooks/useSupabase.js`, in `usePurchaseOrders()` (around line 206), change:

```js
        .select('*, sites(name, site_number), suppliers(name, supplier_number, credit_days), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total), purchase_order_attachments(id)')
```

to:

```js
        .select('*, sites(name, site_number), suppliers(name, supplier_number, credit_days), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total, inventory_item_id), purchase_order_attachments(id)')
```

In `src/pages/PurchaseOrders.jsx`, change `EMPTY_ITEM` (currently line 36) to:

```js
const EMPTY_ITEM = { description: '', quantity: '1', unit: '', unit_price: '', inventory_item_id: '' }
```

And in `editFormInitial`'s `.map()` (currently line 466):

```js
        .map(it => ({ description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price) })),
```

to:

```js
        .map(it => ({ description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price), inventory_item_id: it.inventory_item_id || '' })),
```

- [ ] **Step 3: Add the inventory-item link picker to `ItemsEditor`**

Replace the whole `ItemsEditor` function (currently lines 66-96) with:

```jsx
const inventoryItemOpts = (items) => (items || []).map(it => ({
  value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name,
}))

function ItemsEditor({ items, onChange, inventoryItems, onInventoryItemCreated }) {
  const { data: units, refetch: refetchUnits } = useUnits()
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการสินค้า ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 150px 100px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" placeholder="รายละเอียดสินค้า" required
                value={it.description} onChange={e => set(i, 'description', e.target.value)} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="จำนวน"
                value={it.quantity} onChange={e => set(i, 'quantity', e.target.value)} />
              <UnitSelect value={it.unit} onChange={v => set(i, 'unit', v)} units={units} onUnitAdded={refetchUnits} />
              <input className="input input-sm" type="number" min="0" step="0.01" placeholder="ราคา/หน่วย"
                value={it.unit_price} onChange={e => set(i, 'unit_price', e.target.value)} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(i)} disabled={items.length === 1}>✕</button>
            </div>
            <div style={{ marginLeft: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', flexShrink: 0 }}>📦 ผูกกับสต็อก:</span>
              <div style={{ flex: 1, maxWidth: 340 }}>
                <QuickAddSelect
                  value={it.inventory_item_id} onChange={v => set(i, 'inventory_item_id', v)}
                  placeholder="— ไม่ผูกกับสต็อก —" options={inventoryItemOpts(inventoryItems)}
                  table="inventory_items" namePlaceholder="ชื่อสินค้าคงคลังใหม่"
                  extraPayload={{ base_unit: it.unit || 'หน่วย' }}
                  onCreated={onInventoryItemCreated}
                  addLabel="+ สร้างใหม่"
                />
              </div>
            </div>
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

- [ ] **Step 4: Thread `inventoryItems`/`onInventoryItemCreated` through `PurchaseOrderForm`**

In `PurchaseOrderForm`'s signature (currently line 98):

```js
function PurchaseOrderForm({ initial = EMPTY_FORM, sites, suppliers, categories, onSave, onCancel, loading, onSiteCreated, onSupplierCreated }) {
```

add `inventoryItems, onInventoryItemCreated` to the destructured props, and in its render (currently line 134):

```jsx
        <ItemsEditor items={form.items} onChange={items => set('items', items)} />
```

change to:

```jsx
        <ItemsEditor items={form.items} onChange={items => set('items', items)} inventoryItems={inventoryItems} onInventoryItemCreated={onInventoryItemCreated} />
```

- [ ] **Step 5: Wire the new hooks + preview computation into the main `PurchaseOrders` component**

Add to the imports (currently lines 8-9):

```js
import { usePurchaseOrders, useSites, useSuppliers, useCategories, useUnits, useInventoryItems, useInventoryItemUnitFactors, useStockBalances } from '../hooks/useSupabase.js'
import { computeWeightedAverageCost, convertToBaseUnit } from '../lib/inventoryCost.js'
```

After the existing hook calls (currently lines 351-354):

```js
  const { data: pos, refetch } = usePurchaseOrders(filters)
  const { data: sites, refetch: refetchSites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers, refetch: refetchSuppliers }  = useSuppliers()
```

add:

```js
  const { data: inventoryItems, refetch: refetchInventoryItems } = useInventoryItems()
  const { data: unitFactors } = useInventoryItemUnitFactors()
  const { data: stockBalances } = useStockBalances()
```

Add this helper right above `handleReceive` (currently line 422), computing per-linked-item base quantity and per-base-unit cost the same way both the preview and the actual RPC call will use — a single source of truth, matching this project's established "measurement pass and real render must derive from the same source" discipline:

```js
  const receiveStockPlan = (po) => {
    if (!po) return []
    return (po.purchase_order_items || [])
      .filter(it => it.inventory_item_id)
      .map(it => {
        const invItem = (inventoryItems || []).find(i => i.id === it.inventory_item_id)
        const factor = (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit)
        const baseQty = factor ? convertToBaseUnit(it.quantity, factor.factor_to_base) : it.quantity
        const unitCostPerBase = baseQty > 0 ? (it.quantity * it.unit_price) / baseQty : it.unit_price
        return { inventoryItemId: it.inventory_item_id, name: invItem?.name || it.description, baseUnit: invItem?.base_unit || it.unit, baseQty, unitCostPerBase }
      })
  }
```

- [ ] **Step 6: Post stock movements inside `handleReceive`**

In `handleReceive` (currently lines 422-457), after the line `await auditLog('purchase_orders', receiveRow.id, 'UPDATE', null, poUpdate)` and before `setReceiveRow(null); refetch(); showToast(...)`, insert:

```js
      for (const plan of receiveStockPlan(receiveRow)) {
        const { error: moveErr } = await supabase.rpc('record_stock_movement', {
          p_inventory_item_id: plan.inventoryItemId, p_site_id: receiveRow.site_id, p_movement_type: 'purchase_in',
          p_quantity: plan.baseQty, p_unit_cost: plan.unitCostPerBase,
          p_reference_type: 'purchase_order', p_reference_id: receiveRow.id, p_notes: null,
        })
        if (moveErr) throw moveErr
      }
      refetchInventoryItems()
```

(This runs after the expense + PO-status update already succeeded, so a stock-post failure surfaces via the existing `catch` block's alert, which already tells the admin to check the expenses page and update the PO manually if something partially succeeded — the same recovery guidance already applies here.)

- [ ] **Step 7: Show a stock preview in the receive confirmation**

Replace the `receiveRow &&` block at the bottom of the component (currently lines 572-579):

```jsx
      {receiveRow && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={`สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ ${receiveRow.po_number} ยอดรวม ${fmt(calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat).total)} บาท?`}
          onConfirm={handleReceive}
          onCancel={() => setReceiveRow(null)}
        />
      )}
```

with:

```jsx
      {receiveRow && (
        <ConfirmDialog
          title="ยืนยันรับของ"
          message={
            <div>
              <div>สร้างรายจ่ายอัตโนมัติจากใบสั่งซื้อ {receiveRow.po_number} ยอดรวม {fmt(calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat).total)} บาท?</div>
              {receiveStockPlan(receiveRow).length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <strong>จะบันทึกเข้าสต็อก:</strong>
                  {receiveStockPlan(receiveRow).map((plan, i) => {
                    const bal = (stockBalances || []).find(b => b.inventory_item_id === plan.inventoryItemId && b.site_id === receiveRow.site_id)
                    const oldQty = bal?.quantity_on_hand || 0
                    const oldWac = bal?.weighted_average_cost || 0
                    const newQty = oldQty + plan.baseQty
                    const newWac = computeWeightedAverageCost(oldQty, oldWac, plan.baseQty, plan.unitCostPerBase)
                    return (
                      <div key={i} style={{ marginTop: 4 }}>
                        📦 {plan.name}: +{fmt(plan.baseQty)} {plan.baseUnit} → คงเหลือ {fmt(newQty)} {plan.baseUnit} @ เฉลี่ย {fmt(newWac)}/{plan.baseUnit}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          }
          onConfirm={handleReceive}
          onCancel={() => setReceiveRow(null)}
        />
      )}
```

- [ ] **Step 8: Pass the new props into `PurchaseOrderForm`'s two call sites**

In the `showAdd` block (currently line 545):

```jsx
          <PurchaseOrderForm
            initial={editFormInitial || EMPTY_FORM}
            sites={sites} categories={categories} suppliers={suppliers || []}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
            onSiteCreated={refetchSites} onSupplierCreated={refetchSuppliers}
          />
```

add `inventoryItems={inventoryItems} onInventoryItemCreated={refetchInventoryItems}`.

- [ ] **Step 9: Build**

```bash
npx vite build
```

- [ ] **Step 10: Live-verify**

Create a throwaway test tenant (`inv-task5@facadex-test.local`) with an owner login. Log in via Playwright, navigate to `purchase_orders` (`sessionStorage.setItem('pendingTab', 'purchase_orders')` + reload). Create a site and a supplier via the existing quick-add pickers if needed. Open "+ เพิ่มใบสั่งซื้อ", fill in one item line (description, quantity `10`, unit `kg`, price `50`), click "+ สร้างใหม่" under "📦 ผูกกับสต็อก" and create a new inventory item (this exercises `QuickAddSelect`'s `extraPayload`), confirm the picker now shows it selected. Save the PO. Click "✅ รับของแล้ว" on the new PO row — confirm the confirm-dialog shows the "จะบันทึกเข้าสต็อก" preview line reading `+10.00 kg → คงเหลือ 10.00 kg @ เฉลี่ย 50.00/kg`. Confirm it. Verify via `execute_sql`: `stock_movements` has one `purchase_in` row for that item/site with `quantity=10, unit_cost=50`, and `inventory_stock_balances` has one row `quantity_on_hand=10, weighted_average_cost=50`. Receive a second PO for the same item/site at a different price and confirm the balance blends correctly (matches `computeWeightedAverageCost`).

- [ ] **Step 11: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `purchase_order_items` → `purchase_orders` → `expenses` → `inventory_items` → `suppliers` → `sites` → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all.

- [ ] **Step 12: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty (nothing new on `main` since this branch started). If not empty, stop and reconcile before continuing.

```bash
git add src/pages/PurchaseOrders.jsx src/components/Modal.jsx src/hooks/useSupabase.js
git commit -m "feat: link PO lines to inventory items, post stock on receive with live preview"
git push origin worktree-quotation-module:main
```

---

### Task 6: `Inventory.jsx` page — item management, valuation report, movement ledger

**Files:**
- Create: `src/pages/Inventory.jsx`
- Modify: `src/App.jsx` — add the lazy import, a `TABS` entry, and a `renderPage()` case.
- Modify: `src/lib/permissions.js` — add an `inventory` key to `PAGE_LABELS` and to all three roles in `DEFAULT_PERMISSIONS`.

**Interfaces:**
- Consumes: `useInventoryItems`, `useInventoryItemUnitFactors`, `useStockBalances`, `useStockMovements` (Task 4).
- Produces: page component `Inventory` (default export), routable via tab id `'inventory'`.

- [ ] **Step 1: Add the `inventory` permission key**

In `src/lib/permissions.js`, add to `PAGE_LABELS` (after the `purchase_orders` line, currently line 20):

```js
  inventory: '📦 คลังสินค้า',
```

Add to `DEFAULT_PERMISSIONS.WORKER` (after `purchase_orders: 'none',`, currently line 51): `inventory: 'none',`
Add to `DEFAULT_PERMISSIONS.ADMIN` (after `purchase_orders: 'edit',`, currently line 77): `inventory: 'edit',`
Add to `DEFAULT_PERMISSIONS.OWNER` (after `purchase_orders: 'edit',`, currently line 100): `inventory: 'edit',`

- [ ] **Step 2: Write `src/pages/Inventory.jsx`**

```jsx
// src/pages/Inventory.jsx
// ============================================================
// Inventory — Phase 1: item definitions + unit factors, stock
// balances (valuation report), stock movement ledger (stock card).
// Admin/owner-only, gated on has_module_access('purchase_orders')
// (see the inventory Phase 1 plan's Ruling A for why this rides on
// the PO module instead of a new module key).
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useInventoryItems, useInventoryItemUnitFactors, useStockBalances, useStockMovements } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import SearchableSelect from '../components/SearchableSelect.jsx'

const EMPTY_ITEM_FORM = { name: '', base_unit: '', active: true }
const EMPTY_FACTOR_FORM = { unit_name: '', factor_to_base: '1' }

const MOVEMENT_TYPE_LABELS = {
  purchase_in: '📥 รับเข้าจากใบสั่งซื้อ',
  transfer_in: '↩️ โอนเข้า',
  transfer_out: '↪️ โอนออก',
  sale_out: '📤 ขายออก',
  sale_reversal: '↩️ ยกเลิกการขาย',
  adjustment: '✏️ ปรับปรุงยอด',
}

function ItemForm({ initial = EMPTY_ITEM_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('inventory-item-form', { ...EMPTY_ITEM_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสินค้าคงคลัง ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น อลูมิเนียมโปรไฟล์ 6063" />
        </div>
        <div>
          <label className="label">หน่วยหลัก (base unit) ★</label>
          <input className="input" required value={form.base_unit} onChange={e => set('base_unit', e.target.value)} placeholder="เช่น kg, ตร.ม." />
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่ (ปิดไว้เพื่อไม่ให้ขึ้นในตัวเลือกผูกกับสต็อกของใบสั่งซื้อใหม่)
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

function UnitFactorsPanel({ item, factors, onChanged }) {
  const [form, setForm] = useState(EMPTY_FACTOR_FORM)
  const [saving, setSaving] = useState(false)
  const itemFactors = factors.filter(f => f.inventory_item_id === item.id)

  const add = async (e) => {
    e.preventDefault()
    if (!form.unit_name.trim() || !form.factor_to_base) return
    setSaving(true)
    try {
      const { error } = await supabase.from('inventory_item_unit_factors').insert({
        inventory_item_id: item.id, unit_name: form.unit_name.trim(), factor_to_base: parseFloat(form.factor_to_base),
      })
      if (error) throw error
      setForm(EMPTY_FACTOR_FORM); onChanged()
    } catch (e2) { alert('Error: ' + e2.message) }
    finally { setSaving(false) }
  }

  const remove = async (id) => {
    const { error } = await supabase.from('inventory_item_unit_factors').delete().eq('id', id)
    if (!error) onChanged(); else alert('Error: ' + error.message)
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <label className="label">หน่วยแปลง (เทียบเป็น {item.base_unit})</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {itemFactors.map(f => (
          <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>1 {f.unit_name} = {f.factor_to_base} {item.base_unit}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(f.id)}>✕</button>
          </div>
        ))}
        {!itemFactors.length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีหน่วยแปลง — ใช้ {item.base_unit} ตรงๆ ในใบสั่งซื้อ</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="input input-sm" style={{ flex: 1 }} placeholder="ชื่อหน่วย เช่น piece" value={form.unit_name} onChange={e => setForm(f => ({ ...f, unit_name: e.target.value }))} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>=</span>
        <input className="input input-sm" style={{ width: 90 }} type="number" step="0.0001" min="0" placeholder="อัตรา" value={form.factor_to_base} onChange={e => setForm(f => ({ ...f, factor_to_base: e.target.value }))} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{item.base_unit}</span>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={add}>+ เพิ่ม</button>
      </div>
    </div>
  )
}

export default function Inventory() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'inventory')
  const [view, setView] = useState('items')

  const { data: items, refetch: refetchItems } = useInventoryItems()
  const { data: factors, refetch: refetchFactors } = useInventoryItemUnitFactors()
  const { data: balances } = useStockBalances()
  const [movementItemFilter, setMovementItemFilter] = useState('')
  const { data: movements } = useStockMovements({ inventoryItemId: movementItemFilter || undefined })

  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)

  const totalValue = useMemo(() => (balances || []).reduce((s, b) => s + b.quantity_on_hand * b.weighted_average_cost, 0), [balances])
  const itemOpts = (items || []).map(it => ({ value: it.id, label: `${it.name} (${it.base_unit})`, keywords: it.name }))

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = { name: form.name, base_unit: form.base_unit, active: form.active !== false }
      if (editItem) {
        const { error } = await supabase.from('inventory_items').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('inventory_items').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetchItems()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('inventory_items').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetchItems() }
    else alert('ลบไม่สำเร็จ (อาจมีสต็อกหรือประวัติผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'items' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('items')}>📦 รายการสินค้าคงคลัง</button>
        <button className={`btn btn-sm ${view === 'stock' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('stock')}>💰 มูลค่าสต็อก</button>
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
      </div>

      {view === 'items' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มสินค้าคงคลัง</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อ</th><th>หน่วยหลัก</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(items || []).map(it => (
                    <tr key={it.id}>
                      <td style={{ fontWeight: 600 }}>{it.name}</td>
                      <td style={{ fontSize: 12 }}>{it.base_unit}</td>
                      <td>{it.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(it); setShowForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(it.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(items || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสินค้าคงคลัง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'stock' && (
        <div className="card">
          <div style={{ padding: '12px 16px', fontWeight: 700 }}>มูลค่าสต็อกรวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totalValue)}</span> บาท</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>สินค้า</th><th>ไซท์งาน</th><th>คงเหลือ</th><th>ต้นทุนเฉลี่ย/หน่วย</th><th>มูลค่ารวม</th></tr></thead>
              <tbody>
                {(balances || []).map(b => (
                  <tr key={b.id}>
                    <td>{b.inventory_items?.name}</td>
                    <td style={{ fontSize: 12 }}>{b.sites?.name}</td>
                    <td className="font-mono">{fmt(b.quantity_on_hand)} {b.inventory_items?.base_unit}</td>
                    <td className="font-mono">{fmt(b.weighted_average_cost)}</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(b.quantity_on_hand * b.weighted_average_cost)}</td>
                  </tr>
                ))}
                {!(balances || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสต็อก</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'movements' && (
        <>
          <div style={{ marginBottom: 14, maxWidth: 320 }}>
            <SearchableSelect value={movementItemFilter} onChange={setMovementItemFilter} placeholder="ทุกรายการสินค้า" options={itemOpts} />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>วันที่</th><th>สินค้า</th><th>ไซท์งาน</th><th>ประเภท</th><th>จำนวน</th><th>ต้นทุน/หน่วย</th></tr></thead>
                <tbody>
                  {(movements || []).map(m => (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(m.created_at).toLocaleString('th-TH')}</td>
                      <td>{m.inventory_items?.name}</td>
                      <td style={{ fontSize: 12 }}>{m.sites?.name}</td>
                      <td style={{ fontSize: 12 }}>{MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type}</td>
                      <td className="font-mono">{fmt(m.quantity)} {m.inventory_items?.base_unit}</td>
                      <td className="font-mono">{m.unit_cost != null ? fmt(m.unit_cost) : '—'}</td>
                    </tr>
                  ))}
                  {!(movements || []).length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีประวัติ</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.name}` : 'เพิ่มสินค้าคงคลังใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={520}>
          <ItemForm initial={editItem || EMPTY_ITEM_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
          {editItem && (
            <div className="modal-body" style={{ paddingTop: 0 }}>
              <UnitFactorsPanel item={editItem} factors={factors || []} onChanged={refetchFactors} />
            </div>
          )}
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบสินค้าคงคลัง" message="ยืนยันการลบ? (ถ้ามีประวัติสต็อกผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire the tab into `src/App.jsx`**

Add the lazy import after `const PurchaseOrders = lazy(...)` (currently line 26):

```js
const Inventory          = lazy(() => import('./pages/Inventory.jsx'))
```

In the `TABS` array, inside the `'💸 รายจ่าย'` group's `children`, add right after the `purchase_orders` entry (currently line 54):

```js
    { id: 'inventory',       label: '📦 คลังสินค้า',   minRole: 'ADMIN', module: 'purchase_orders' },
```

In `renderPage()`'s `switch`, add right after the `purchase_orders` case (currently line 310):

```jsx
        case 'inventory': return <Inventory {...props} />
```

- [ ] **Step 4: Build**

```bash
npx vite build
```

- [ ] **Step 5: Live-verify**

Create a throwaway test tenant (`inv-task6@facadex-test.local`) with an owner login. Log in via Playwright, navigate to `inventory` (`sessionStorage.setItem('pendingTab', 'inventory')` + reload). Confirm the page renders with the three view buttons and an empty "รายการสินค้าคงคลัง" list. Click "+ เพิ่มสินค้าคงคลัง", create an item (name + base_unit), confirm it appears in the list. Click "แก้ไข" on it, confirm the "หน่วยแปลง" panel appears in the edit modal; add a unit factor (e.g. `piece` = `2.3`), confirm it appears in the list and persists after closing/reopening the modal. Switch to "💰 มูลค่าสต็อก" and "📜 ประวัติการเคลื่อนไหว" — both should render empty-state messages (no stock/movements exist yet for this fresh tenant). Then, via `execute_sql`, insert one `inventory_stock_balances` row and one `stock_movements` row directly for this tenant/item/a test site, and confirm both new views now show that row correctly (name, site, formatted numbers) after a page reload.

Also confirm role gating: log in as a WORKER-role user on the same tenant (create one via the existing pattern of a second `auth.users`/`auth.identities` row + `user_roles.role = 'WORKER'`) and confirm the "📦 คลังสินค้า" nav entry does not appear (matches `minRole: 'ADMIN'`).

- [ ] **Step 6: Clean up the test tenant**

FK order: `stock_movements` → `inventory_stock_balances` → `inventory_item_unit_factors` → `inventory_items` → `sites` → `user_roles` (both rows) → `tenants` → `auth.identities` (both) → `auth.users` (both). Verify 0 rows across all.

- [ ] **Step 7: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Inventory.jsx src/App.jsx src/lib/permissions.js
git commit -m "feat: Inventory page (item management, valuation report, movement ledger)"
git push origin worktree-quotation-module:main
```

---

### Task 7: site-completion leftover-to-central-stock transfer

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: `record_stock_movement` RPC (Task 2), `inventory_stock_balances` (Task 2, read directly for the leftover-count form — this is a page-scoped one-off query, not promoted to a shared hook since nothing else needs "balances filtered to one site with quantity > 0").
- Produces: no new exports — replaces the site-completion click handler's behavior when a site has linked stock.

- [ ] **Step 1: Add `useEffect` to the existing React import**

Change (currently line 10):

```js
import { useState, useMemo } from 'react'
```

to:

```js
import { useState, useMemo, useEffect } from 'react'
```

- [ ] **Step 2: Add the `SiteCompleteModal` component**

Add this new component above the main `export default function Sites` declaration (find that declaration first via `grep -n "^export default function Sites" src/pages/Sites.jsx` since this plan doesn't have its exact line number):

```jsx
// Site completion with linked stock: per spec decision #6, the job keeps
// 100% of its original cost -- leftover material re-enters stock at
// unit_cost = 0 (it's already fully expensed). Modeled as a transfer_out
// at this site paired with a transfer_in at the tenant's "ส่วนกลาง"
// (central) site, both posted via record_stock_movement() so the
// weighted-average recalculation happens atomically for each.
function SiteCompleteModal({ site, onClose, onDone }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error: err } = await supabase
        .from('inventory_stock_balances')
        .select('inventory_item_id, quantity_on_hand, inventory_items(name, base_unit)')
        .eq('site_id', site.id)
        .gt('quantity_on_hand', 0)
      if (cancelled) return
      if (err) { setError(err.message); setLoading(false); return }
      setRows((data || []).map(r => ({
        inventory_item_id: r.inventory_item_id,
        name: r.inventory_items?.name,
        base_unit: r.inventory_items?.base_unit,
        quantity_on_hand: r.quantity_on_hand,
        leftover: String(r.quantity_on_hand),
      })))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [site.id])

  const setLeftover = (id, v) => setRows(rs => rs.map(r => r.inventory_item_id === id ? { ...r, leftover: v } : r))

  const handleConfirm = async () => {
    setSaving(true)
    setError(null)
    try {
      const toTransfer = rows.filter(r => (parseFloat(r.leftover) || 0) > 0)
      if (toTransfer.length) {
        const { data: central, error: centralErr } = await supabase
          .from('sites').select('id').eq('name', 'ส่วนกลาง').limit(1)
        if (centralErr) throw centralErr
        const centralId = central?.[0]?.id
        if (!centralId) {
          throw new Error('ไม่พบไซท์งานชื่อ "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน เพื่อใช้เป็นที่รับวัสดุที่เหลือกลับเข้าสต็อกกลาง')
        }
        for (const r of toTransfer) {
          const qty = parseFloat(r.leftover) || 0
          const { error: outErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: r.inventory_item_id, p_site_id: site.id, p_movement_type: 'transfer_out',
            p_quantity: qty, p_unit_cost: null, p_reference_type: 'site_completion', p_reference_id: site.id, p_notes: null,
          })
          if (outErr) throw outErr
          const { error: inErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: r.inventory_item_id, p_site_id: centralId, p_movement_type: 'transfer_in',
            p_quantity: qty, p_unit_cost: 0, p_reference_type: 'site_completion', p_reference_id: site.id, p_notes: null,
          })
          if (inErr) throw inErr
        }
      }
      const { error: siteErr } = await supabase.from('sites')
        .update({ status: 'Completed', end_date: new Date().toISOString().slice(0, 10) }).eq('id', site.id)
      if (siteErr) throw siteErr
      onDone()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <Modal title={`จบไซท์งาน — ${site.name}`} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--text2)', fontSize: 13 }}>
          ไซท์นี้มีวัสดุคงคลังค้างอยู่ — กรอกจำนวนที่เหลือจริงต่อรายการ (ถ้าใช้หมดแล้วให้ใส่ 0) เพื่อโอนเข้าสต็อกกลาง (ส่วนกลาง) ที่ต้นทุน 0 บาท (งานนี้รับรู้ต้นทุนเต็มจำนวนไปแล้ว)
        </p>
        {loading ? <div>⏳ กำลังโหลด...</div> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map(r => (
              <div key={r.inventory_item_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13 }}>{r.name} (มี {fmt(r.quantity_on_hand)} {r.base_unit})</span>
                <input className="input input-sm" style={{ width: 100 }} type="number" min="0" step="0.0001" max={r.quantity_on_hand}
                  value={r.leftover} onChange={e => setLeftover(r.inventory_item_id, e.target.value)} />
              </div>
            ))}
            {!rows.length && <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่มีวัสดุคงคลังค้างอยู่ที่ไซท์นี้</div>}
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={handleConfirm}>
          {saving ? '⏳...' : '✅ ยืนยันจบไซท์งาน'}
        </button>
      </div>
    </Modal>
  )
}
```

(`fmt` and `Modal` are already imported in this file — see lines 19-20.)

- [ ] **Step 3: Add `completeSite` state and a stock-aware click handler**

Near the existing `const [completeId,  setCompleteId]  = useState(null)` (currently line 307), add:

```js
  const [completeSite, setCompleteSite] = useState(null)
```

Add this handler near `handleComplete` (currently lines 367-372):

```js
  const handleCompleteClick = async (s) => {
    const { data, error } = await supabase.from('inventory_stock_balances').select('id').eq('site_id', s.id).gt('quantity_on_hand', 0).limit(1)
    if (error) { alert('Error: ' + error.message); return }
    if (data?.length) setCompleteSite(s)
    else setCompleteId(s.id)
  }
```

- [ ] **Step 4: Route the "✅ จบไซท์งาน" action through the new handler**

Change (currently line 525):

```jsx
                            ...(s.status === 'Ongoing' ? [{ label: '✅ จบไซท์งาน', onClick: () => setCompleteId(s.id) }] : []),
```

to:

```jsx
                            ...(s.status === 'Ongoing' ? [{ label: '✅ จบไซท์งาน', onClick: () => handleCompleteClick(s) }] : []),
```

- [ ] **Step 5: Render the new modal**

Near the existing `{completeId && (<ConfirmDialog .../>)}` block (currently lines 572-580), add:

```jsx
      {completeSite && (
        <SiteCompleteModal
          site={completeSite}
          onClose={() => setCompleteSite(null)}
          onDone={() => { setCompleteSite(null); refetch() }}
        />
      )}
```

(Keep the existing `completeId`/`ConfirmDialog` block unchanged — it still handles the fast path for sites with no linked stock.)

- [ ] **Step 6: Build**

```bash
npx vite build
```

- [ ] **Step 7: Live-verify**

Create a throwaway test tenant (`inv-task7@facadex-test.local`) with an owner login. Via `execute_sql`, create two sites for this tenant: one named exactly `ส่วนกลาง`, one named e.g. `Test Site A` with `status = 'Ongoing'`. Create one `inventory_items` row. Call `record_stock_movement` (as this tenant's owner, via the real REST RPC endpoint with a real `access_token`, same pattern as Task 2's Step 4) to post a `purchase_in` of `20` units at `Test Site A`.

Log in via Playwright as the owner, navigate to `sites`, find `Test Site A`'s row, open its row-actions menu, click "✅ จบไซท์งาน" — confirm the `SiteCompleteModal` opens (not the plain `ConfirmDialog`) showing one row for the inventory item with "มี 20.00 <unit>" and a leftover input pre-filled `20`. Change it to `15`, click "✅ ยืนยันจบไซท์งาน". Confirm the modal closes and the site now shows status `Completed`. Verify via `execute_sql`:
- `inventory_stock_balances` for `Test Site A`/this item: `quantity_on_hand = 5` (20 − 15).
- `inventory_stock_balances` for `ส่วนกลาง`/this item: `quantity_on_hand = 15, weighted_average_cost = 0`.
- `stock_movements` has one new `transfer_out` row (`site_id = Test Site A`, `quantity = 15`) and one new `transfer_in` row (`site_id = ส่วนกลาง`, `quantity = 15, unit_cost = 0`), both `reference_type = 'site_completion'`.

Then create a second `Ongoing` site with no stock at all, click "✅ จบไซท์งาน" on it, and confirm the plain `ConfirmDialog` (not `SiteCompleteModal`) opens — the no-stock fast path still works unchanged.

Finally, test the missing-central-site error path: on a fresh test tenant with no `ส่วนกลาง` site, attempt to complete a site with linked stock and confirm the modal shows the Thai error message about creating a site named "ส่วนกลาง" first, and that the site's status is NOT changed (still `Ongoing`) since the transfer failed before the status update ran.

- [ ] **Step 8: Clean up all test tenants**

FK order per tenant: `stock_movements` → `inventory_stock_balances` → `inventory_items` → `sites` → `user_roles` → `tenants` → `auth.identities` → `auth.users`. Verify 0 rows across all, across every test tenant created in this task.

- [ ] **Step 9: Push**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

Expected: empty. If not, stop and reconcile.

```bash
git add src/pages/Sites.jsx
git commit -m "feat: transfer leftover stock to central site on site completion"
git push origin worktree-quotation-module:main
```

---

## After all tasks: final whole-branch review

Once all 7 tasks are complete, dispatch the final code reviewer (per `superpowers:subagent-driven-development`) on the most capable available model, covering the full diff across all 7 tasks together — with particular attention to:
- Every place `has_module_access('purchase_orders')` is used for the new tables (Ruling A) is consistent and no table was accidentally left ungated.
- `record_stock_movement()`'s tenant-ownership checks (Ruling D) can't be bypassed by any caller in `PurchaseOrders.jsx` or `Sites.jsx`.
- The receive-time stock-posting logic in `PurchaseOrders.jsx` and the preview computation use the exact same `receiveStockPlan()` values (no drift between what's shown and what's posted — this project's established "measurement pass must match real render" discipline, applied here to "preview must match posted values").
- No `catalog_items` changes leaked in (Ruling B).
- `git diff main...HEAD --stat` to confirm only the files listed across these 7 tasks changed.

If the review is clean, this Phase 1 build is done — return to whatever the user asked for after this plan (Phase 2 sell-side integration is a separate future plan, not a continuation of this one).
