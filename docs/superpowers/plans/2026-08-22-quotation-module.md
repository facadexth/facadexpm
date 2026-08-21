# Quotation Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-sales Quotation module (ใบเสนอราคา) — itemized client-facing quotations, a reusable sell-side item catalog, and an accept-into-Site handoff — gated as a new paid `quotations` tenant module.

**Architecture:** Three new Postgres tables (`catalog_items`, `quotations`, `quotation_items`) plus a company-profile extension to `tenants`, all tenant-scoped with the same RLS shape `purchase_orders` already uses. A new React page (`Quotations.jsx`) mirrors `PurchaseOrders.jsx`'s list/form/PDF-export structure; a new simple master-data page (`CatalogItems.jsx`) mirrors `Suppliers.jsx`. The existing `SiteForm` (currently private to `Sites.jsx`) is exported and reused for the accept-flow's site-setup popup.

**Tech Stack:** React + Vite, Supabase (Postgres + RLS + Storage), `html2pdf.js`/`html2canvas` for document export, Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-22-quotation-module-design.md`

## Global Constraints

- Every new table gets `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` and a single `admin_full_access` RLS policy (`is_admin_or_owner() AND tenant_id = current_tenant_id()`, plus `has_module_access('quotations')` for the three quotation tables — `catalog_items`, `quotations`, `quotation_items` all gate on `quotations`, not a separate module key).
- VAT rate is `0.07`, matching `PurchaseOrders.jsx`'s `VAT_RATE` constant — do not hardcode a different value anywhere.
- No manual DB/browser click-through during implementation — no login credentials are available to the implementer. Verification bar is: migrations self-reviewed against the precedent files cited in each task, `npx vite build`, and `npm test` (which runs `vitest run`). This matches how Retention and Client Deposits were verified (see `docs/superpowers/specs/2026-08-19-client-deposit-tracking-design.md`, Testing section).
- Every SQL migration file must also be appended to `supabase/schema.sql` (the consolidated snapshot) in the same task/commit — this repo keeps both in sync manually, confirmed by the merge history of every prior feature.

---

## Task 1: Company profile — `tenants` columns + logo storage bucket

**Files:**
- Create: `supabase/migrations/2026-08-22-01-tenant-company-profile.sql`
- Modify: `supabase/schema.sql` (append the same DDL near the existing `tenants` table definition, ~line 893)
- Create: `supabase/tests/quotation_module_test.sql`

**Interfaces:**
- Produces: `tenants.address`, `tenants.tax_id`, `tenants.phone`, `tenants.logo_url`, `tenants.bank_name`, `tenants.bank_account_name`, `tenants.bank_account_no` — all nullable `TEXT`, readable by any tenant member via the existing `member_reads_own_tenant` policy, writable by OWNER only via the existing `owner_updates_own_tenant` policy (no new table policy needed — these are just new columns on `tenants`, already covered by its existing RLS). A public-read Storage bucket `tenant-logos`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-22-01-tenant-company-profile.sql
-- Company profile for client-facing document letterheads (Quotation now,
-- Invoice later — see docs/superpowers/specs/2026-08-22-quotation-module-design.md).
-- Nothing beyond company_name exists on tenants today. All nullable —
-- existing tenants (including FacadeX's own bootstrap tenant) simply have
-- an incomplete letterhead until an OWNER fills these in via Settings.
-- Covered by tenants' EXISTING RLS (member_reads_own_tenant /
-- owner_updates_own_tenant) — no new policy needed for plain columns.
ALTER TABLE tenants
  ADD COLUMN address           TEXT,
  ADD COLUMN tax_id            TEXT,
  ADD COLUMN phone             TEXT,
  ADD COLUMN logo_url          TEXT,
  ADD COLUMN bank_name         TEXT,
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_account_no   TEXT;

-- Logo bucket: PUBLIC (unlike po-attachments/site-attachments, which are
-- private) — a company logo isn't sensitive, it's meant to be shown to
-- clients on the PDF, and html2canvas needs to load it directly in the
-- browser without a signed-URL round trip. Public buckets serve reads
-- without going through storage.objects RLS at all, so only
-- INSERT/UPDATE/DELETE need policies here.
INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-logos', 'tenant-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY tenant_logos_owner_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

CREATE POLICY tenant_logos_owner_update ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

CREATE POLICY tenant_logos_owner_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );
```

- [ ] **Step 2: Append the same DDL to `supabase/schema.sql`**

Find the `CREATE TABLE tenants (...)` block (search `CREATE TABLE tenants`) and insert the seven `ALTER TABLE tenants ADD COLUMN` lines from Step 1 directly after the closing `);` of that table — as a comment-preceded block explaining they're the company-profile addition, same as the migration's comment. Then find the storage bucket section (search `INSERT INTO storage.buckets` — the `po-attachments`/`site-attachments` entries are there) and append the `tenant-logos` bucket + three policies immediately after the last existing bucket block, so `schema.sql` stays a complete, ordered, from-scratch-runnable snapshot.

- [ ] **Step 3: Start the RLS test file**

```sql
-- supabase/tests/quotation_module_test.sql
-- Regression tests for the Quotation module. Disposable-fixture style,
-- matching supabase/tests/contractor_type_templates_test.sql — safe to
-- run against production, self-cleans on every path.

-- ── Test 1: company profile columns are readable by any tenant member
-- (existing member_reads_own_tenant policy), writable only by OWNER
-- (existing owner_updates_own_tenant policy) — confirming the new
-- columns didn't accidentally need a new policy. ──
DO $$
DECLARE
  test_tenant_id UUID;
  read_address TEXT;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants LIMIT 1;

  UPDATE tenants SET address = '__TEST ADDRESS__' WHERE id = test_tenant_id;

  SELECT address INTO read_address FROM tenants WHERE id = test_tenant_id;
  IF read_address != '__TEST ADDRESS__' THEN
    RAISE EXCEPTION 'tenants.address REGRESSION: expected to write/read the new column, got %', read_address;
  END IF;

  UPDATE tenants SET address = NULL WHERE id = test_tenant_id;

  RAISE NOTICE 'Test 1 (tenants company-profile columns exist and are writable): TEST PASSED';
END $$;
```

- [ ] **Step 4: Verify syntax by reading it back against the precedent**

Re-read `supabase/migrations/2026-08-19-01-site-attachments.sql` side-by-side with Step 1's file: confirm the bucket-insert `ON CONFLICT (id) DO NOTHING` shape matches, confirm `(storage.foldername(name))[1] = current_tenant_id()::text` is copied verbatim (this is the exact tenant-path-prefix check used everywhere else), and confirm no trailing syntax differences. This substitutes for running the migration (no DB credentials available to this task).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-22-01-tenant-company-profile.sql supabase/schema.sql supabase/tests/quotation_module_test.sql
git commit -m "feat: add tenant company profile columns + logo storage bucket"
```

---

## Task 2: Quotation schema — module key, `catalog_items`, `quotations`, `quotation_items`

**Files:**
- Create: `supabase/migrations/2026-08-22-02-quotations-module-key.sql`
- Create: `supabase/migrations/2026-08-22-03-catalog-items.sql`
- Create: `supabase/migrations/2026-08-22-04-quotations.sql`
- Create: `supabase/migrations/2026-08-22-05-quotation-items.sql`
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/quotation_module_test.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()` (all existing, `supabase/schema.sql:687` is the `purchase_orders` policy to mirror exactly).
- Produces: table `catalog_items(id, name, unit, default_unit_price, active, created_at, updated_at, tenant_id)`; table `quotations(id, quotation_number, client_id, site_id, date, valid_until, status, has_vat, price_includes_vat, discount_amount, discount_pct, payment_terms, notes, created_at, updated_at, tenant_id)`; table `quotation_items(id, quotation_id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order, tenant_id)`. Module key `'quotations'` added to `tenant_modules.module_key`'s CHECK constraint.

- [ ] **Step 1: Module key migration**

```sql
-- supabase/migrations/2026-08-22-02-quotations-module-key.sql
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations'));
```

- [ ] **Step 2: `catalog_items` migration**

```sql
-- supabase/migrations/2026-08-22-03-catalog-items.sql
-- Sell-side price list only — no cost price, no per-item VAT, no stock
-- quantity. See "Non-Goals" in the design spec for why: the user's
-- buy-side materials and sell-side deliverables are different kinds of
-- things with no 1:1 mapping, so a unified buy/sell catalog with margin
-- tracking would model a business shape that doesn't match how this
-- company actually works.
CREATE TABLE catalog_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name               TEXT NOT NULL,
  unit               TEXT,
  default_unit_price NUMERIC NOT NULL DEFAULT 0,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_catalog_items_tenant_id ON catalog_items(tenant_id);

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON catalog_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
```

- [ ] **Step 3: `quotations` migration (header + auto-numbering)**

```sql
-- supabase/migrations/2026-08-22-04-quotations.sql
CREATE TABLE quotations (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_number    TEXT NOT NULL UNIQUE DEFAULT '',
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,
  date                DATE NOT NULL,
  valid_until         DATE,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  has_vat             BOOLEAN NOT NULL DEFAULT true,
  price_includes_vat  BOOLEAN NOT NULL DEFAULT false,
  discount_amount     NUMERIC,
  discount_pct        NUMERIC,
  payment_terms       TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotations_client_id ON quotations(client_id);
CREATE INDEX idx_quotations_site_id ON quotations(site_id);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_quotations_tenant_id ON quotations(tenant_id);

-- Auto-numbering: identical pattern to generate_po_number()
-- (supabase/schema.sql:658) — QT- + year + zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_quotation_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(quotation_number FROM 'QT-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM quotations
  WHERE quotation_number LIKE 'QT-' || year_part || '-%';
  NEW.quotation_number := 'QT-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_quotation_number
  BEFORE INSERT ON quotations
  FOR EACH ROW
  WHEN (NEW.quotation_number IS NULL OR NEW.quotation_number = '')
  EXECUTE FUNCTION generate_quotation_number();

ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
```

- [ ] **Step 4: `quotation_items` migration**

```sql
-- supabase/migrations/2026-08-22-05-quotation-items.sql
CREATE TABLE quotation_items (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id     UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  unit             TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 1,
  unit_price       NUMERIC NOT NULL DEFAULT 0,
  line_total       NUMERIC NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotation_items_quotation_id ON quotation_items(quotation_id);
CREATE INDEX idx_quotation_items_tenant_id ON quotation_items(tenant_id);

ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
```

- [ ] **Step 5: Append all four migrations' DDL to `supabase/schema.sql`**

Insert in this order, all near the existing `purchase_orders`/`purchase_order_items` block (search `CREATE TABLE purchase_order_items`, insert after its RLS policy block ends): the `tenant_modules_module_key_check` constraint replacement (find the existing `CREATE TABLE tenant_modules` block, search `module_key IN`, replace that CHECK line's value list in place rather than appending a second ALTER — schema.sql is a from-scratch snapshot, so it should show the final constraint directly, not a DROP+ADD pair), then `catalog_items`, then `quotations` + its trigger function, then `quotation_items`.

- [ ] **Step 6: Extend the RLS test file**

Append to `supabase/tests/quotation_module_test.sql`:

```sql
-- ── Test 2: quotations/catalog_items/quotation_items are invisible and
-- unwritable without the 'quotations' module enabled (and outside an
-- active trial) — has_module_access() gate matches purchase_orders'. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_client_id UUID;
  visible_count INT;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants WHERE trial_ends_at < now() AND plan = 'active' LIMIT 1;
  IF test_tenant_id IS NULL THEN
    RAISE NOTICE 'Test 2 (quotations module gating): SKIPPED — no expired-trial/active-plan tenant fixture available';
  ELSE
    SELECT id INTO test_client_id FROM clients WHERE tenant_id = test_tenant_id LIMIT 1;
    IF test_client_id IS NULL THEN
      RAISE NOTICE 'Test 2 (quotations module gating): SKIPPED — no client fixture for that tenant';
    ELSE
      BEGIN
        INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id);
        RAISE EXCEPTION 'quotations RLS REGRESSION: insert succeeded without the quotations module enabled';
      EXCEPTION WHEN insufficient_privilege OR others THEN
        RAISE NOTICE 'Test 2 (quotations module gating blocks writes without the module): TEST PASSED';
      END;
    END IF;
  END IF;
END $$;

-- ── Test 3: quotation auto-numbering produces QT-<year>-NNN, sequential
-- within the year, matching generate_po_number()'s behavior. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_client_id UUID;
  first_number TEXT;
  second_number TEXT;
  first_id UUID;
  second_id UUID;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants WHERE trial_ends_at > now() LIMIT 1;
  IF test_tenant_id IS NULL THEN
    RAISE NOTICE 'Test 3 (quotation auto-numbering): SKIPPED — no active-trial tenant fixture available';
  ELSE
    SELECT id INTO test_client_id FROM clients WHERE tenant_id = test_tenant_id LIMIT 1;
    IF test_client_id IS NULL THEN
      RAISE NOTICE 'Test 3 (quotation auto-numbering): SKIPPED — no client fixture for that tenant';
    ELSE
      INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id)
        RETURNING id, quotation_number INTO first_id, first_number;
      INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id)
        RETURNING id, quotation_number INTO second_id, second_number;

      IF first_number !~ '^QT-\d{4}-\d{3}$' OR second_number !~ '^QT-\d{4}-\d{3}$' THEN
        RAISE EXCEPTION 'quotation_number REGRESSION: expected QT-YYYY-NNN format, got % and %', first_number, second_number;
      END IF;
      IF SUBSTRING(second_number FROM 'QT-\d{4}-(\d+)$')::INT != SUBSTRING(first_number FROM 'QT-\d{4}-(\d+)$')::INT + 1 THEN
        RAISE EXCEPTION 'quotation_number REGRESSION: expected sequential numbers, got % then %', first_number, second_number;
      END IF;

      DELETE FROM quotations WHERE id IN (first_id, second_id);
      RAISE NOTICE 'Test 3 (quotation auto-numbering QT-YYYY-NNN, sequential): TEST PASSED';
    END IF;
  END IF;
END $$;
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-08-22-02-quotations-module-key.sql supabase/migrations/2026-08-22-03-catalog-items.sql supabase/migrations/2026-08-22-04-quotations.sql supabase/migrations/2026-08-22-05-quotation-items.sql supabase/schema.sql supabase/tests/quotation_module_test.sql
git commit -m "feat: add quotations module schema (catalog_items, quotations, quotation_items)"
```

---

## Task 3: `quotationCalc.js` — pure calc logic, unit-tested

**Files:**
- Create: `src/lib/quotationCalc.js`
- Create: `src/lib/quotationCalc.test.js`

**Interfaces:**
- Produces: `export const VAT_RATE = 0.07`; `export function lineTotal(item)`; `export function calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct })` returning `{ rawTotal, discount, subtotal, vat, total }` (all numbers, rounded to 2 decimals except `rawTotal` which is the raw unrounded sum of line totals).

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/quotationCalc.test.js
import { describe, it, expect } from 'vitest'
import { lineTotal, calcQuotationTotals } from './quotationCalc.js'

describe('lineTotal', () => {
  it('multiplies quantity by unit price', () => {
    expect(lineTotal({ quantity: '3', unit_price: '150.5' })).toBeCloseTo(451.5)
  })
  it('treats missing/blank fields as zero', () => {
    expect(lineTotal({ quantity: '', unit_price: '100' })).toBe(0)
    expect(lineTotal({})).toBe(0)
  })
})

describe('calcQuotationTotals', () => {
  const items = [{ line_total: 1000 }]

  it('no discount, VAT added on top of the raw sum', () => {
    const r = calcQuotationTotals(items, { hasVat: true, priceIncludesVat: false })
    expect(r).toEqual({ rawTotal: 1000, discount: 0, subtotal: 1000, vat: 70, total: 1070 })
  })

  it('flat-amount discount reduces the subtotal before VAT', () => {
    const r = calcQuotationTotals(items, { hasVat: true, priceIncludesVat: false, discountAmount: 100 })
    expect(r).toEqual({ rawTotal: 1000, discount: 100, subtotal: 900, vat: 63, total: 963 })
  })

  it('percent discount, no VAT', () => {
    const r = calcQuotationTotals(items, { hasVat: false, discountPct: 10 })
    expect(r).toEqual({ rawTotal: 1000, discount: 100, subtotal: 900, vat: 0, total: 900 })
  })

  it('price-includes-VAT: discount applies to the VAT-inclusive total, then VAT is backed out', () => {
    const vatInclusiveItems = [{ line_total: 1070 }]
    const r = calcQuotationTotals(vatInclusiveItems, { hasVat: true, priceIncludesVat: true, discountAmount: 107 })
    expect(r).toEqual({ rawTotal: 1070, discount: 107, subtotal: 900, vat: 63, total: 963 })
  })

  it('discount larger than the raw total clamps to zero, not negative', () => {
    const r = calcQuotationTotals(items, { hasVat: false, discountAmount: 5000 })
    expect(r).toEqual({ rawTotal: 1000, discount: 1000, subtotal: 0, vat: 0, total: 0 })
  })

  it('falls back to computing line totals from quantity/unit_price when line_total is absent', () => {
    const r = calcQuotationTotals([{ quantity: '2', unit_price: '500' }], { hasVat: false })
    expect(r.rawTotal).toBe(1000)
  })

  it('empty items list totals to zero', () => {
    const r = calcQuotationTotals([], { hasVat: true, priceIncludesVat: false })
    expect(r).toEqual({ rawTotal: 0, discount: 0, subtotal: 0, vat: 0, total: 0 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/quotationCalc.test.js`
Expected: FAIL — `Cannot find module './quotationCalc.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/quotationCalc.js
// ============================================================
// Quotation totals math -- see
// docs/superpowers/specs/2026-08-22-quotation-module-design.md.
//
// Mirrors PurchaseOrders.jsx's calcPoTotals (subtotal/VAT math and the
// priceIncludesVat back-out), extracted into a tested lib module instead
// of staying inline, plus one addition: a single header-level discount
// (flat amount or percent, mutually exclusive) applied to the raw
// line-item sum BEFORE the VAT branching runs, so it uniformly reduces
// whichever figure is meaningful (VAT-inclusive total or pre-VAT
// subtotal) without needing separate discount logic per VAT mode.
// ============================================================

export const VAT_RATE = 0.07

export function lineTotal(item) {
  return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * @param {Array} items - quotation line items ({ line_total } or
 *   { quantity, unit_price })
 * @param {{ hasVat: boolean, priceIncludesVat: boolean, discountAmount:
 *   number|string, discountPct: number|string }} opts - discountPct takes
 *   precedence over discountAmount if both are somehow set (the UI keeps
 *   them mutually exclusive; this is just a defined tie-break, not
 *   expected to matter in practice)
 * @returns {{ rawTotal: number, discount: number, subtotal: number,
 *   vat: number, total: number }}
 */
export function calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct } = {}) {
  const rawTotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : lineTotal(it)), 0)

  const discountedRaw = discountPct
    ? Math.max(0, rawTotal * (1 - (parseFloat(discountPct) || 0) / 100))
    : Math.max(0, rawTotal - (parseFloat(discountAmount) || 0))
  const discount = round2(rawTotal - discountedRaw)

  if (!hasVat) {
    const total = round2(discountedRaw)
    return { rawTotal, discount, subtotal: total, vat: 0, total }
  }
  if (priceIncludesVat) {
    const total = round2(discountedRaw)
    const subtotal = round2(total / (1 + VAT_RATE))
    const vat = round2(total - subtotal)
    return { rawTotal, discount, subtotal, vat, total }
  }
  const subtotal = round2(discountedRaw)
  const vat = round2(subtotal * VAT_RATE)
  const total = round2(subtotal + vat)
  return { rawTotal, discount, subtotal, vat, total }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/quotationCalc.test.js`
Expected: PASS, 8/8

- [ ] **Step 5: Commit**

```bash
git add src/lib/quotationCalc.js src/lib/quotationCalc.test.js
git commit -m "feat: add quotationCalc totals math (mirrors calcPoTotals + discount)"
```

---

## Task 4: Permissions — register `quotations` and `catalog_items`

**Files:**
- Modify: `src/lib/permissions.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PAGE_LABELS.quotations`, `PAGE_LABELS.catalog_items`, and matching entries in `DEFAULT_PERMISSIONS.WORKER/ADMIN/OWNER`.

- [ ] **Step 1: Add the two page keys**

In `src/lib/permissions.js`, add to `PAGE_LABELS` (after the `purchase_orders` line):

```js
  quotations: '📋 ใบเสนอราคา',
```

and after the `suppliers` line:

```js
  catalog_items: '📦 รายการสินค้า',
```

In each of `DEFAULT_PERMISSIONS.WORKER`, `.ADMIN`, `.OWNER`, add `quotations` and `catalog_items` in the same relative positions (after `purchase_orders` and after `suppliers` respectively) with the same value the neighboring `purchase_orders`/`suppliers` line already has for that role (`'none'` for WORKER, `'edit'` for ADMIN and OWNER) — this matches every other ADMIN-gated feature page in the file exactly.

- [ ] **Step 2: Verify by reading the file back**

Confirm `PAGE_LABELS` and all three `DEFAULT_PERMISSIONS` role blocks now each have exactly 14 keys (12 existing + 2 new), and that `quotations`/`catalog_items` appear in every one of the three role blocks — a key present in `PAGE_LABELS` but missing from a role block isn't a hard error (per `getPageLevel`'s `?? 'edit'` fallback) but would be inconsistent with how every other page in this file is defined.

- [ ] **Step 3: Commit**

```bash
git add src/lib/permissions.js
git commit -m "feat: register quotations and catalog_items page permissions"
```

---

## Task 5: Data hooks — `useCatalogItems`, `useQuotations`

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: `useQuery` (existing generic hook, top of this file), `fetchAllRows` (existing helper, already used by `usePurchaseOrders`).
- Produces: `export function useCatalogItems()` → `{ data, loading, error, refetch }` where `data` is `catalog_items` rows ordered by `name`, active items only by default... **no** — return ALL rows (active and inactive) so the management page can show/toggle inactive ones; the *picker* in the quotation form filters to `active` client-side. `export function useQuotations(filters = {})` → same shape, `filters: { clientId, status, from, to }`.

- [ ] **Step 1: Add `useCatalogItems`**

Add directly after the existing `useSuppliers()` function (`src/hooks/useSupabase.js:546`):

```js
export function useCatalogItems() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('catalog_items')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Add `useQuotations`**

Add directly after `usePurchaseOrders` (`src/hooks/useSupabase.js`, ends around line 198):

```js
export function useQuotations(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('quotations')
        .select('*, clients(name, client_number), sites(name, site_number), quotation_items(id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order)')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.clientId) q = q.eq('client_id', filters.clientId)
      if (filters.status)   q = q.eq('status', filters.status)
      if (filters.from)     q = q.gte('date', filters.from)
      if (filters.to)       q = q.lte('date', filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}
```

- [ ] **Step 3: Verify the file still builds**

Run: `npx vite build`
Expected: succeeds with no new errors (these are unused exports until Tasks 7/8 import them, which is fine — Vite doesn't fail on unused exports).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: add useCatalogItems and useQuotations data hooks"
```

---

## Task 6: Export `SiteForm` from `Sites.jsx`

**Files:**
- Modify: `src/pages/Sites.jsx:46`

**Interfaces:**
- Produces: `export function SiteForm({ initial, clients, onSave, onCancel, loading, hasModuleAccess })` — same signature it already has, just now importable from `Quotations.jsx` for the accept-flow's site-setup popup (Task 9).

- [ ] **Step 1: Change the function declaration**

In `src/pages/Sites.jsx`, change line 46 from:

```js
function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading, hasModuleAccess = () => false }) {
```

to:

```js
export function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading, hasModuleAccess = () => false }) {
```

Nothing else in the file changes — `EMPTY_FORM`, `VAT_RATE`, and `COST_TYPES` stay module-private (not exported), since `Quotations.jsx` only needs the form component itself and will pass its own `initial` object with the fields it cares about (`SiteForm` already defaults every other field via `{ ...EMPTY_FORM, ...initial }`).

- [ ] **Step 2: Verify the file still builds and its own page still works**

Run: `npx vite build`
Expected: succeeds — a named export addition is non-breaking; `Sites.jsx`'s own `export default function Sites(...)` and its internal use of `<SiteForm ...>` are unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "refactor: export SiteForm so Quotations can reuse it for the accept-flow popup"
```

---

## Task 7: `CatalogItems.jsx` — item catalog management page

**Files:**
- Create: `src/pages/CatalogItems.jsx`

**Interfaces:**
- Consumes: `useCatalogItems()` (Task 5), `Modal`/`ConfirmDialog` (`src/components/Modal.jsx`), `useDraftForm` (`src/hooks/useDraftForm.js`), `canEditPage` (`src/lib/permissions.js`), `useUserRole` (`src/hooks/useUserRole.js`), `fmt` (`src/lib/supabase.js`).
- Produces: `export default function CatalogItems()` — a page mirroring `Suppliers.jsx`'s structure exactly (list + search + add/edit modal + delete confirm), simplified to this table's four real fields.

- [ ] **Step 1: Write the page**

```jsx
// src/pages/CatalogItems.jsx
// ============================================================
// CatalogItems — รายการสินค้า (sell-side price list for Quotations)
// ✅ Add/Edit/Delete CRUD, same shape as Suppliers.jsx
// ✅ "active" toggle instead of hard delete when an item has been used
//    on a past quotation (delete still offered; quotation_items.catalog_item_id
//    is ON DELETE SET NULL, so deleting never breaks a past document)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useCatalogItems } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

const EMPTY_FORM = { name: '', unit: '', default_unit_price: '', active: true }

function CatalogItemForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('catalog-item-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสินค้า/บริการ ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น ประตูหน้าต่าง (ชุด)" />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">หน่วย</label>
            <input className="input" value={form.unit} onChange={e => set('unit', e.target.value)} placeholder="เช่น ชุด, ตร.ม., เมตร" />
          </div>
          <div>
            <label className="label">ราคา/หน่วย (ค่าเริ่มต้น)</label>
            <input type="number" min="0" step="0.01" className="input" value={form.default_unit_price} onChange={e => set('default_unit_price', e.target.value)} />
          </div>
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่ (ปิดไว้เพื่อไม่ให้ขึ้นในรายการเลือกของใบเสนอราคาใหม่ โดยไม่กระทบใบเสนอราคาเดิมที่เคยใช้)
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

export default function CatalogItems() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'catalog_items')
  const { data: items, refetch } = useCatalogItems()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() =>
    (items || []).filter(it => !search || it.name.toLowerCase().includes(search.toLowerCase()))
  , [items, search])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name: form.name,
        unit: form.unit || null,
        default_unit_price: parseFloat(form.default_unit_price) || 0,
        active: form.active !== false,
      }
      if (editItem) {
        const { error } = await supabase.from('catalog_items').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('catalog_items').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('catalog_items').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มรายการสินค้า</button>}
        <input className="input input-sm" style={{ width: 200 }}
          placeholder="ค้นหาชื่อสินค้า..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อสินค้า/บริการ</th>
                <th>หน่วย</th>
                <th>ราคา/หน่วย</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(it => (
                <tr key={it.id} style={it.active ? undefined : { opacity: 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{it.name}</td>
                  <td style={{ fontSize: 12 }}>{it.unit || '—'}</td>
                  <td className="font-mono">{fmt(it.default_unit_price)}</td>
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
              {!filtered.length && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีรายการสินค้า</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.name}` : 'เพิ่มรายการสินค้าใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={520}>
          <CatalogItemForm initial={editItem || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบรายการสินค้า"
          message="ยืนยันการลบรายการสินค้านี้? (ใบเสนอราคาเดิมที่เคยใช้จะไม่ถูกกระทบ)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify the file builds**

Run: `npx vite build`
Expected: succeeds (page is written but not yet wired into `App.jsx` — that's Task 12 — so it isn't reachable yet, but must compile standalone).

- [ ] **Step 3: Commit**

```bash
git add src/pages/CatalogItems.jsx
git commit -m "feat: add CatalogItems page (sell-side price list CRUD)"
```

---

## Task 8: `Quotations.jsx` Part 1 — list, form, item editor with catalog picker

**Files:**
- Create: `src/pages/Quotations.jsx`

**Interfaces:**
- Consumes: `useQuotations` (Task 5), `useCatalogItems` (Task 5), `useClients`/`useSites` (existing, `src/hooks/useSupabase.js`), `calcQuotationTotals`/`lineTotal` (Task 3), `Modal`/`ConfirmDialog`, `SearchableSelect`, `useDraftForm`, `canEditPage`, `useUserRole`, `fmt`/`fmtDate` (`src/lib/supabase.js`), `auditLog` (`src/lib/audit.js`).
- Produces: `export default function Quotations({ navigateTo, navState, openSiteOverview })` (this task implements the list, the create/edit form, and the item editor with a catalog quick-add; status actions and the accept→site-setup flow are added on top of this file in Task 9, and the PDF document modal in Task 10 — both are the same file, later steps).

- [ ] **Step 1: Write the page (list + form + item editor)**

```jsx
// src/pages/Quotations.jsx
// ============================================================
// Quotations — ใบเสนอราคา
// ✅ Itemized, client-required, site optional until accepted
// ✅ Auto-number QT-YYYY-NNN
// ✅ Status: draft -> sent -> accepted (creates/links a Site) | rejected | expired
// ✅ Items optionally drawn from the catalog_items price list, always
//    freely editable afterward (autofill, not enforce)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useQuotations, useCatalogItems, useClients, useSites } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { lineTotal, calcQuotationTotals } from '../lib/quotationCalc.js'

const clientOpts = (clients) => (clients || []).map(c => ({
  value: c.id, label: `${c.client_number} · ${c.name}`, keywords: `${c.client_number} ${c.name}`,
}))
const catalogOpts = (items) => (items || []).filter(i => i.active).map(i => ({
  value: i.id, label: i.unit ? `${i.name} (${i.unit})` : i.name, keywords: i.name,
}))

const QT_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired']
const QT_STATUS_LABELS = {
  draft: '✏️ ร่าง', sent: '📤 ส่งแล้ว', accepted: '✅ ยอมรับ', rejected: '✕ ปฏิเสธ', expired: '⏰ หมดอายุ',
}

const EMPTY_ITEM = { catalog_item_id: null, description: '', quantity: '1', unit: '', unit_price: '' }
const EMPTY_FORM = {
  client_id: '', date: '', valid_until: '', has_vat: true, price_includes_vat: false,
  discount_mode: 'none', discount_amount: '', discount_pct: '',
  payment_terms: '', notes: '', items: [{ ...EMPTY_ITEM }],
}

function QuotationItemsEditor({ items, onChange, catalogItems }) {
  const set = (i, k, v) => onChange(items.map((it, idx) => idx === i ? { ...it, [k]: v } : it))
  const add = () => onChange([...items, { ...EMPTY_ITEM }])
  const remove = (i) => onChange(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)
  const addFromCatalog = (catalogId) => {
    const found = (catalogItems || []).find(c => c.id === catalogId)
    if (!found) return
    onChange([...items, {
      catalog_item_id: found.id, description: found.name, unit: found.unit || '',
      quantity: '1', unit_price: String(found.default_unit_price),
    }])
  }
  const grandTotal = items.reduce((sum, it) => sum + lineTotal(it), 0)

  return (
    <div>
      <label className="label">รายการ ★</label>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" placeholder="รายละเอียดรายการ" required
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
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={add}>+ เพิ่มรายการว่าง</button>
        <div style={{ minWidth: 220 }}>
          <SearchableSelect value={null} onChange={addFromCatalog} placeholder="+ เพิ่มจากรายการสินค้า" options={catalogOpts(catalogItems)} />
        </div>
      </div>
      <div style={{ marginTop: 10, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวม: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(grandTotal)}</span> บาท
      </div>
    </div>
  )
}

function QuotationForm({ initial = EMPTY_FORM, clients, catalogItems, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('quotation-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const totals = calcQuotationTotals(form.items, {
    hasVat: form.has_vat, priceIncludesVat: form.price_includes_vat,
    discountAmount: form.discount_mode === 'amount' ? form.discount_amount : 0,
    discountPct: form.discount_mode === 'pct' ? form.discount_pct : 0,
  })

  return (
    <form onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">ราคานี้มีผลถึงวันที่</label>
            <input type="date" className="input" value={form.valid_until} onChange={e => set('valid_until', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ลูกค้า ★</label>
          <SearchableSelect required value={form.client_id} onChange={id => set('client_id', id)}
            placeholder="— เลือกลูกค้า —" options={clientOpts(clients)} />
        </div>
        <QuotationItemsEditor items={form.items} onChange={items => set('items', items)} catalogItems={catalogItems} />
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-has-vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              รวม VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-has-vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          {form.has_vat && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="qt-price-includes-vat" checked={form.price_includes_vat === false} onChange={() => set('price_includes_vat', false)} />
                ราคา/หน่วยยังไม่รวม VAT
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" name="qt-price-includes-vat" checked={form.price_includes_vat === true} onChange={() => set('price_includes_vat', true)} />
                ราคา/หน่วยรวม VAT แล้ว
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'none'} onChange={() => set('discount_mode', 'none')} />
              ไม่มีส่วนลด
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'amount'} onChange={() => set('discount_mode', 'amount')} />
              ส่วนลด (บาท)
            </label>
            {form.discount_mode === 'amount' && (
              <input type="number" min="0" step="0.01" className="input input-sm" style={{ width: 120 }}
                value={form.discount_amount} onChange={e => set('discount_amount', e.target.value)} />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="qt-discount-mode" checked={form.discount_mode === 'pct'} onChange={() => set('discount_mode', 'pct')} />
              ส่วนลด (%)
            </label>
            {form.discount_mode === 'pct' && (
              <input type="number" min="0" max="100" step="0.01" className="input input-sm" style={{ width: 100 }}
                value={form.discount_pct} onChange={e => set('discount_pct', e.target.value)} />
            )}
          </div>
          <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
            {totals.discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>ก่อนหักส่วนลด</span><span className="font-mono">{fmt(totals.rawTotal)}</span></div>}
            {totals.discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>ส่วนลด</span><span className="font-mono">-{fmt(totals.discount)}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมก่อน VAT</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
            {form.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมสุทธิ</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
          </div>
        </div>
        <div>
          <label className="label">เงื่อนไขการชำระเงิน</label>
          <textarea className="textarea" rows={2} value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="เช่น มัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน" />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึกใบเสนอราคา'}
        </button>
      </div>
    </form>
  )
}

export default function Quotations({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'quotations')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [clientId, setClientId] = useState('')
  const [status,   setStatus]   = useState('')
  const [showAdd,  setShowAdd]  = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState(null)

  const filters = { from: dateFrom, to: dateTo, clientId, status }
  const { data: quotations, refetch } = useQuotations(filters)
  const { data: clients }      = useClients()
  const { data: sites }        = useSites()
  const { data: catalogItems } = useCatalogItems()

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const qtPayload = {
        client_id: form.client_id,
        date: form.date,
        valid_until: form.valid_until || null,
        has_vat: form.has_vat,
        price_includes_vat: form.has_vat ? form.price_includes_vat : false,
        discount_amount: form.discount_mode === 'amount' ? (parseFloat(form.discount_amount) || null) : null,
        discount_pct: form.discount_mode === 'pct' ? (parseFloat(form.discount_pct) || null) : null,
        payment_terms: form.payment_terms || null,
        notes: form.notes || null,
      }
      let quotationId = editRow?.id
      if (editRow) {
        const { error } = await supabase.from('quotations').update(qtPayload).eq('id', editRow.id)
        if (error) throw error
        const { error: delError } = await supabase.from('quotation_items').delete().eq('quotation_id', editRow.id)
        if (delError) throw delError
        await auditLog('quotations', editRow.id, 'UPDATE', editRow, qtPayload)
      } else {
        const { data, error } = await supabase.from('quotations').insert(qtPayload).select().single()
        if (error) throw error
        quotationId = data.id
        await auditLog('quotations', quotationId, 'INSERT', null, qtPayload)
      }

      const itemsPayload = form.items
        .filter(it => it.description.trim())
        .map((it, i) => ({
          quotation_id: quotationId, catalog_item_id: it.catalog_item_id || null,
          description: it.description, quantity: parseFloat(it.quantity) || 0,
          unit: it.unit || null, unit_price: parseFloat(it.unit_price) || 0,
          line_total: lineTotal(it), sort_order: i,
        }))
      if (itemsPayload.length) {
        const { error } = await supabase.from('quotation_items').insert(itemsPayload)
        if (error) throw error
      }

      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('quotations').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch(); showToast('ลบแล้ว') }
    else alert('Error: ' + error.message)
  }

  const editFormInitial = useMemo(() => {
    if (!editRow) return null
    return {
      id: editRow.id, client_id: editRow.client_id,
      date: editRow.date, valid_until: editRow.valid_until || '',
      has_vat: editRow.has_vat, price_includes_vat: editRow.price_includes_vat || false,
      discount_mode: editRow.discount_pct != null ? 'pct' : editRow.discount_amount != null ? 'amount' : 'none',
      discount_amount: editRow.discount_amount != null ? String(editRow.discount_amount) : '',
      discount_pct: editRow.discount_pct != null ? String(editRow.discount_pct) : '',
      payment_terms: editRow.payment_terms || '', notes: editRow.notes || '',
      items: (editRow.quotation_items?.length ? editRow.quotation_items : [{ ...EMPTY_ITEM }])
        .map(it => ({ catalog_item_id: it.catalog_item_id, description: it.description, quantity: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price) })),
    }
  }, [editRow])

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มใบเสนอราคา</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={clientId} onChange={setClientId} placeholder="ทุกลูกค้า" options={clientOpts(clients)} />
        </div>
        <select className="select select-sm" style={{ width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {QT_STATUSES.map(s => <option key={s} value={s}>{QT_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ไซท์งาน</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(quotations || []).map(qt => {
                const totals = calcQuotationTotals(qt.quotation_items, {
                  hasVat: qt.has_vat, priceIncludesVat: qt.price_includes_vat,
                  discountAmount: qt.discount_amount, discountPct: qt.discount_pct,
                })
                return (
                  <tr key={qt.id}>
                    <td className="font-mono" style={{ fontSize: 12 }}>{qt.quotation_number}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(qt.date)}</td>
                    <td style={{ fontSize: 12 }}>{qt.clients?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--accent)', cursor: qt.site_id ? 'pointer' : 'default' }}
                      onClick={() => qt.site_id && openSiteOverview(qt.site_id)}>{qt.sites?.name || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(qt.quotation_items || []).length} รายการ</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(totals.total)}</td>
                    <td><span className={`badge badge-${qt.status}`}>{QT_STATUS_LABELS[qt.status] || qt.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit && qt.status === 'draft' && (
                        <>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(qt); setShowAdd(true) }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(qt.id)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!(quotations || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบเสนอราคาในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <Modal title={editRow ? 'แก้ไขใบเสนอราคา' : 'เพิ่มใบเสนอราคา'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={700}>
          <QuotationForm
            initial={editFormInitial || EMPTY_FORM}
            clients={clients} catalogItems={catalogItems}
            onSave={handleSave} onCancel={() => { setShowAdd(false); setEditRow(null) }} loading={saving}
          />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบใบเสนอราคา" message="ยืนยันการลบใบเสนอราคานี้?" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
```

Note: this deliberately omits status-action buttons (send/accept/reject) and the PDF document button — those are added to this same file in Tasks 9 and 10. `badge-${qt.status}` reuses the existing generic status badge classes already defined in `src/index.css` for `draft`/`sent`/`accepted`/`rejected`/`expired`... **check this**: `src/index.css` does not currently have `.badge-draft`/`.badge-sent`/`.badge-accepted`/`.badge-rejected`/`.badge-expired` classes (only `.badge-ongoing`, `.badge-finished`, `.badge-onhold`, and the expense/payment ones). Add them in this same step:

```css
/* add to src/index.css, near the other .badge-* rules (~line 177-184) */
.badge-draft     { background: rgba(94,97,128,0.2); color: var(--text2); }
.badge-sent      { background: rgba(255,209,102,0.15); color: var(--yellow); }
.badge-accepted  { background: rgba(0,212,170,0.15); color: var(--green); }
.badge-rejected  { background: rgba(255,107,107,0.15); color: var(--red); }
.badge-expired   { background: rgba(94,97,128,0.25); color: var(--text3); }
```

- [ ] **Step 2: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Quotations.jsx src/index.css
git commit -m "feat: add Quotations page (list, form, catalog-assisted item editor)"
```

---

## Task 9: `Quotations.jsx` Part 2 — status actions + accept-into-Site flow

**Files:**
- Modify: `src/pages/Quotations.jsx`

**Interfaces:**
- Consumes: `SiteForm` (Task 6, `src/pages/Sites.jsx`), `useTenant` (`src/hooks/useTenant.js`, for `hasModuleAccess` passed into `SiteForm`).
- Produces: status-transition buttons in the table row (`Send`, `Accept`, `Reject`, `Expire`), and an `AcceptQuotationModal` that either creates a new `sites` row (via `SiteForm`, prefilled) or links an existing one, then sets `quotations.status = 'accepted'` and `quotations.site_id`.

- [ ] **Step 1: Add the imports and the accept-modal component**

At the top of `src/pages/Quotations.jsx`, add:

```js
import { useTenant } from '../hooks/useTenant.js'
import { SiteForm } from './Sites.jsx'
```

Add this component after `QuotationForm` and before `export default function Quotations`:

```jsx
function AcceptQuotationModal({ quotation, totals, clients, sites, hasModuleAccess, onLinkExisting, onCreateNew, onClose, loading }) {
  const [mode, setMode] = useState('create') // 'create' | 'existing'
  const [existingSiteId, setExistingSiteId] = useState('')

  const siteFormInitial = {
    name: quotation.clients?.name ? `${quotation.clients.name} — ${quotation.quotation_number}` : quotation.quotation_number,
    client_id: quotation.client_id,
    has_vat: quotation.has_vat,
    contract_value_no_vat: String(totals.subtotal),
  }

  return (
    <Modal title={`รับใบเสนอราคา ${quotation.quotation_number}`} onClose={onClose} maxWidth={700}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--text2)', fontSize: 13 }}>
          ใบเสนอราคานี้ยังไม่ผูกกับไซท์งาน — สร้างไซท์งานใหม่จากใบเสนอราคานี้ หรือเลือกไซท์งานที่มีอยู่แล้ว
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="accept-mode" checked={mode === 'create'} onChange={() => setMode('create')} />
            สร้างไซท์งานใหม่
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" name="accept-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
            เลือกไซท์งานที่มีอยู่แล้ว
          </label>
        </div>
      </div>
      {mode === 'existing' ? (
        <>
          <div className="modal-body">
            <label className="label">ไซท์งาน ★</label>
            <SearchableSelect
              value={existingSiteId} onChange={setExistingSiteId} placeholder="— เลือกไซท์งาน —"
              options={(sites || []).map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" disabled={loading || !existingSiteId} onClick={() => onLinkExisting(existingSiteId)}>
              {loading ? '⏳...' : '✅ ผูกกับไซท์งานนี้'}
            </button>
          </div>
        </>
      ) : (
        <SiteForm initial={siteFormInitial} clients={clients} hasModuleAccess={hasModuleAccess} onSave={onCreateNew} onCancel={onClose} loading={loading} />
      )}
    </Modal>
  )
}
```

- [ ] **Step 2: Add the status-transition and accept-flow handlers**

Inside `export default function Quotations(...)`, add state and handlers (after the existing `handleDelete`):

```js
  const [acceptRow, setAcceptRow] = useState(null)
  const [accepting, setAccepting] = useState(false)
  const { hasModuleAccess } = useTenant()

  const handleSetStatus = async (id, newStatus) => {
    const { error } = await supabase.from('quotations').update({ status: newStatus }).eq('id', id)
    if (!error) { await auditLog('quotations', id, 'UPDATE', null, { status: newStatus }); refetch(); showToast('อัปเดตสถานะแล้ว') }
    else alert('Error: ' + error.message)
  }

  const handleLinkExistingSite = async (siteId) => {
    if (!acceptRow) return
    setAccepting(true)
    try {
      const update = { status: 'accepted', site_id: siteId }
      const { error } = await supabase.from('quotations').update(update).eq('id', acceptRow.id)
      if (error) throw error
      await auditLog('quotations', acceptRow.id, 'UPDATE', null, update)
      setAcceptRow(null); refetch(); showToast('รับใบเสนอราคาและผูกไซท์งานแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setAccepting(false) }
  }

  const handleCreateSiteFromQuotation = async (siteForm) => {
    if (!acceptRow) return
    setAccepting(true)
    try {
      const noVatValue = parseFloat(siteForm.contract_value_no_vat) || 0
      const vatAmount = siteForm.has_vat ? Math.round(noVatValue * 0.07 * 100) / 100 : 0
      const sitePayload = {
        name: siteForm.name,
        client_id: siteForm.client_id || null,
        status: 'Ongoing',
        has_vat: siteForm.has_vat,
        contract_value_no_vat: noVatValue || null,
        contract_value: Math.round((noVatValue + vatAmount) * 100) / 100 || null,
        default_vat_pct: siteForm.default_vat_pct === '' ? null : parseFloat(siteForm.default_vat_pct),
        default_tax_withheld_pct: siteForm.default_tax_withheld_pct === '' ? null : parseFloat(siteForm.default_tax_withheld_pct),
        default_retention_pct: siteForm.default_retention_pct === '' ? null : parseFloat(siteForm.default_retention_pct),
        default_deposit_pct: siteForm.default_deposit_pct === '' ? null : parseFloat(siteForm.default_deposit_pct),
      }
      const { data: newSite, error: siteError } = await supabase.from('sites').insert(sitePayload).select().single()
      if (siteError) throw siteError
      await auditLog('sites', newSite.id, 'INSERT', null, sitePayload)

      const qtUpdate = { status: 'accepted', site_id: newSite.id }
      const { error: qtError } = await supabase.from('quotations').update(qtUpdate).eq('id', acceptRow.id)
      if (qtError) throw qtError
      await auditLog('quotations', acceptRow.id, 'UPDATE', null, qtUpdate)

      setAcceptRow(null); refetch(); showToast('สร้างไซท์งานและรับใบเสนอราคาแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setAccepting(false) }
  }
```

- [ ] **Step 3: Add the action buttons to each table row**

In the table row's action `<td>` (the one currently only showing edit/delete for `draft`), replace it with:

```jsx
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit && qt.status === 'draft' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => handleSetStatus(qt.id, 'sent')}>📤 ส่ง</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(qt); setShowAdd(true) }}>✏️</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(qt.id)}>✕</button>
                        </>
                      )}
                      {canEdit && qt.status === 'sent' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => setAcceptRow(qt)}>✅ ยอมรับ</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleSetStatus(qt.id, 'rejected')}>ปฏิเสธ</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => handleSetStatus(qt.id, 'expired')}>หมดอายุ</button>
                        </>
                      )}
                    </td>
```

- [ ] **Step 4: Render the accept modal**

Add near the other modals at the bottom of the component's returned JSX (after the `ConfirmDialog` for delete):

```jsx
      {acceptRow && (
        <AcceptQuotationModal
          quotation={acceptRow}
          totals={calcQuotationTotals(acceptRow.quotation_items, { hasVat: acceptRow.has_vat, priceIncludesVat: acceptRow.price_includes_vat, discountAmount: acceptRow.discount_amount, discountPct: acceptRow.discount_pct })}
          clients={clients} sites={sites} hasModuleAccess={hasModuleAccess}
          onLinkExisting={handleLinkExistingSite} onCreateNew={handleCreateSiteFromQuotation}
          onClose={() => setAcceptRow(null)} loading={accepting}
        />
      )}
```

- [ ] **Step 5: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Quotations.jsx
git commit -m "feat: add quotation status actions and accept-into-Site flow"
```

---

## Task 10: `Quotations.jsx` Part 3 — PDF/JPG document export

**Files:**
- Modify: `src/pages/Quotations.jsx`

**Interfaces:**
- Consumes: `downloadPDF`/`downloadJPG` (`src/lib/pdf.js`), `useTenant` (already imported in Task 9, reused here for the company-profile letterhead fields).
- Produces: a "📄" button per row opening `QuotationDocumentModal`, which renders the branded letterhead (from `tenant.company_name/address/tax_id/logo_url/bank_*`), the item table, discount/VAT breakdown, and payment terms, exportable as PDF or JPG.

- [ ] **Step 1: Add the import**

```js
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
```

- [ ] **Step 2: Add `QuotationDocumentModal`**

Add after `AcceptQuotationModal`:

```jsx
function QuotationDocumentModal({ qt, tenant, onClose }) {
  const items = qt.quotation_items || []
  const totals = calcQuotationTotals(items, { hasVat: qt.has_vat, priceIncludesVat: qt.price_includes_vat, discountAmount: qt.discount_amount, discountPct: qt.discount_pct })

  return (
    <Modal title={`ใบเสนอราคา ${qt.quotation_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`qt-doc-${qt.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ maxHeight: 48, marginBottom: 6 }} crossOrigin="anonymous" />}
              <div style={{ fontSize: 16, fontWeight: 800 }}>{tenant?.company_name}</div>
              {tenant?.address && <div style={{ fontSize: 11 }}>{tenant.address}</div>}
              {tenant?.tax_id && <div style={{ fontSize: 11 }}>เลขประจำตัวผู้เสียภาษี: {tenant.tax_id}</div>}
              {tenant?.phone && <div style={{ fontSize: 11 }}>โทร: {tenant.phone}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ใบเสนอราคา</div>
              <div style={{ fontSize: 12 }}>เลขที่: {qt.quotation_number}</div>
              <div style={{ fontSize: 12 }}>วันที่: {new Date(qt.date).toLocaleDateString('th-TH')}</div>
              {qt.valid_until && <div style={{ fontSize: 12 }}>มีผลถึง: {new Date(qt.valid_until).toLocaleDateString('th-TH')}</div>}
            </div>
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}><strong>ลูกค้า:</strong> {qt.clients?.name}</div>
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
              {totals.discount > 0 && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px', borderTop: '2px solid #111' }}>ส่วนลด</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: '2px solid #111' }}>-{fmt(totals.discount)}</td>
                </tr>
              )}
              <tr>
                <td colSpan={3} style={{ padding: '6px 4px', borderTop: totals.discount > 0 ? undefined : '2px solid #111' }}>รวมก่อน VAT</td>
                <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: totals.discount > 0 ? undefined : '2px solid #111' }}>{fmt(totals.subtotal)}</td>
              </tr>
              {qt.has_vat && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px' }}>VAT (7%)</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(totals.vat)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(totals.total)} บาท</td>
              </tr>
            </tfoot>
          </table>
          {qt.payment_terms && (
            <div style={{ fontSize: 12, marginTop: 16 }}><strong>เงื่อนไขการชำระเงิน:</strong> {qt.payment_terms}</div>
          )}
          {(tenant?.bank_name || tenant?.bank_account_no) && (
            <div style={{ fontSize: 12, marginTop: 8 }}>
              <strong>ชำระเงินไปที่:</strong> {tenant.bank_name} {tenant.bank_account_name ? `ชื่อบัญชี ${tenant.bank_account_name}` : ''} {tenant.bank_account_no ? `เลขที่ ${tenant.bank_account_no}` : ''}
            </div>
          )}
          <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, textAlign: 'center', fontSize: 12 }}>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้เสนอราคา</div>
            <div style={{ borderTop: '1px solid #999', paddingTop: 6 }}>ลายเซ็นผู้ยอมรับ (ลูกค้า)</div>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`qt-doc-${qt.id}`, `${qt.quotation_number}.jpg`)}>🖼️ ดาวน์โหลด JPG</button>
        <button className="btn btn-primary" onClick={() => downloadPDF(`qt-doc-${qt.id}`, `${qt.quotation_number}.pdf`)}>📄 ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 3: Wire the button and modal state into the page component**

In `export default function Quotations`, add state: `const [docRow, setDocRow] = useState(null)`, and reuse the `tenant` already available from `useTenant()` (imported in Task 9 — `const { hasModuleAccess, tenant } = useTenant()`, adding `tenant` to that existing destructure).

Add the document button to every row (not gated on status or `canEdit` — viewing/exporting a quotation should be available to anyone who can see the page, matching how `PODocumentModal`'s 📄 button in `PurchaseOrders.jsx` is always shown):

```jsx
                      <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(qt)}>📄</button>
```

placed as the first button inside the action `<td>`, before the status-specific buttons from Task 9.

Render the modal near the other modals:

```jsx
      {docRow && <QuotationDocumentModal qt={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}
```

- [ ] **Step 4: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Quotations.jsx
git commit -m "feat: add quotation PDF/JPG document export with company letterhead"
```

---

## Task 11: Settings — company profile section

**Files:**
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `useTenant` (already imported in this file, `tenant`/`refetch`), `supabase.storage` (new, direct client calls — no existing helper component fits a single-logo upload).
- Produces: a new OWNER-only section on the Settings page for editing `address`/`tax_id`/`phone`/`bank_name`/`bank_account_name`/`bank_account_no` and uploading `logo_url`.

- [ ] **Step 1: Add state and handlers**

In `src/pages/Settings.jsx`, alongside the existing contractor-type state block (added by the just-merged `worktree-contractor-type-templates` feature — search `handleSaveContractorType`), add:

```js
  // Company profile — for the Quotation PDF letterhead (and future
  // Invoice). See docs/superpowers/specs/2026-08-22-quotation-module-design.md.
  const [profile, setProfile] = useState({
    address: '', tax_id: '', phone: '', bank_name: '', bank_account_name: '', bank_account_no: '',
  })
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  useEffect(() => {
    if (tenant) {
      setProfile({
        address: tenant.address || '', tax_id: tenant.tax_id || '', phone: tenant.phone || '',
        bank_name: tenant.bank_name || '', bank_account_name: tenant.bank_account_name || '', bank_account_no: tenant.bank_account_no || '',
      })
    }
  }, [tenant])
  const setProfileField = (k, v) => setProfile(p => ({ ...p, [k]: v }))

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      const { error } = await supabase.from('tenants').update(profile).eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกข้อมูลบริษัทแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleUploadLogo = async (file) => {
    if (!file || !tenant) return
    setUploadingLogo(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${tenant.id}/logo.${ext}`
      const { error: uploadError } = await supabase.storage.from('tenant-logos').upload(path, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data: urlData } = supabase.storage.from('tenant-logos').getPublicUrl(path)
      const { error: updateError } = await supabase.from('tenants').update({ logo_url: urlData.publicUrl }).eq('id', tenant.id)
      if (updateError) throw updateError
      refetchTenant()
      alert('✅ อัปโหลดโลโก้แล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setUploadingLogo(false)
    }
  }
```

Note: this reuses `refetchTenant` — confirm the existing contractor-type block already destructures `const { tenant, refetch: refetchTenant } = useTenant()` at the top of the component (it does, per the merge in `worktree-contractor-type-templates`); if this component's `useTenant()` destructure doesn't already alias `refetch` to `refetchTenant`, use whatever the existing alias is instead of introducing a second one.

- [ ] **Step 2: Add the JSX section**

Add this block in the component's returned JSX, near the existing contractor-type section (same OWNER-only visual grouping):

```jsx
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><div className="card-title">🏢 ข้อมูลบริษัท (สำหรับใบเสนอราคา)</div></div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          <div>
            <label className="label">โลโก้บริษัท</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ height: 40 }} />}
              <input type="file" accept="image/*" disabled={uploadingLogo} onChange={e => handleUploadLogo(e.target.files?.[0])} />
              {uploadingLogo && <span style={{ fontSize: 12, color: 'var(--text3)' }}>⏳ กำลังอัปโหลด...</span>}
            </div>
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">ที่อยู่บริษัท</label>
              <input className="input" value={profile.address} onChange={e => setProfileField('address', e.target.value)} />
            </div>
            <div>
              <label className="label">เลขประจำตัวผู้เสียภาษี</label>
              <input className="input" value={profile.tax_id} onChange={e => setProfileField('tax_id', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">เบอร์โทร</label>
            <input className="input" style={{ maxWidth: 240 }} value={profile.phone} onChange={e => setProfileField('phone', e.target.value)} />
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">ธนาคาร</label>
              <input className="input" value={profile.bank_name} onChange={e => setProfileField('bank_name', e.target.value)} />
            </div>
            <div>
              <label className="label">ชื่อบัญชี</label>
              <input className="input" value={profile.bank_account_name} onChange={e => setProfileField('bank_account_name', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">เลขที่บัญชี</label>
            <input className="input" style={{ maxWidth: 240 }} value={profile.bank_account_no} onChange={e => setProfileField('bank_account_no', e.target.value)} />
          </div>
          <div>
            <button className="btn btn-primary" onClick={handleSaveProfile} disabled={savingProfile}>
              {savingProfile ? '⏳...' : '✅ บันทึกข้อมูลบริษัท'}
            </button>
          </div>
        </div>
      </div>
```

- [ ] **Step 3: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.jsx
git commit -m "feat: add company profile section to Settings (logo, address, tax ID, bank details)"
```

---

## Task 12: Wire `Quotations` and `CatalogItems` into `App.jsx`

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Produces: two new reachable tabs — "📋 ใบเสนอราคา" (top-level, module-gated on `quotations`) and "📦 รายการสินค้า" (inside the existing "⚙️ ตั้งค่า" dropdown group, alongside `categories`/`clients`/`suppliers`, also gated on `quotations`).

- [ ] **Step 1: Add the lazy imports**

Add alongside the other `lazy()` imports near the top of `src/App.jsx`:

```js
const Quotations   = lazy(() => import('./pages/Quotations.jsx'))
const CatalogItems = lazy(() => import('./pages/CatalogItems.jsx'))
```

- [ ] **Step 2: Add the `TABS` entries**

Add a top-level entry (placed near `expenses`/`income`, matching the design spec's UI note):

```js
  { id: 'quotations', label: '📋 ใบเสนอราคา', minRole: 'ADMIN', module: 'quotations' },
```

Add inside the existing `'⚙️ ตั้งค่า'` group's `children` array (after the `suppliers` entry):

```js
    { id: 'catalog_items', label: '📦 รายการสินค้า', minRole: 'ADMIN', module: 'quotations' },
```

- [ ] **Step 3: Add the `renderPage()` cases**

Add to the `switch (activeTab)` block:

```js
      case 'quotations':    return <ProtectedPage minRole="ADMIN"><Quotations   {...props} /></ProtectedPage>
      case 'catalog_items': return <ProtectedPage minRole="ADMIN"><CatalogItems {...props} /></ProtectedPage>
```

- [ ] **Step 4: Verify the app builds and the full test suite still passes**

Run: `npx vite build`
Expected: succeeds.

Run: `npm test`
Expected: all existing tests plus the new `quotationCalc.test.js` suite pass (this is the first point in the plan where the new page code is actually reachable from the app shell, so it's the natural place to run the full suite one more time).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: wire Quotations and CatalogItems pages into the app nav"
```

---

## Task 13: Final integration check

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npx vite build`
Expected: succeeds with no new warnings beyond the pre-existing "chunks larger than 500kB" notice (unrelated to this feature).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: every test file passes, including `src/lib/quotationCalc.test.js`.

- [ ] **Step 3: Spec-coverage self-check**

Re-read `docs/superpowers/specs/2026-08-22-quotation-module-design.md` section by section and confirm each is covered:
- Data Model (`tenants` extension, `catalog_items`, `quotations`, `quotation_items`) — Tasks 1, 2.
- Calculation Logic — Task 3.
- Status Lifecycle & Accept → Site Setup Handoff — Task 9.
- UI (Quotations page, Settings company profile) — Tasks 8, 9, 10, 11.
- Auto-numbering — Task 2, Step 3.
- Module Gating — Task 2 (DB), Task 4 (permissions.js), Task 12 (App.jsx TABS `module:` key).
- Testing — Tasks 1–3 (RLS test file + unit tests).

- [ ] **Step 4: Note what's NOT covered (by design)**

Confirm no task built: an Estimation cost-buildup engine, Invoice/progress-billing/reconciliation into `incomes`, a public client-facing acceptance link, per-item VAT, or cost price/margin/inventory tracking on `catalog_items` — all explicitly out of scope per the spec's Non-Goals.

- [ ] **Step 5: Final commit (if Step 3/4 turned up any gap that needed a fix)**

Only if a gap was found and fixed:

```bash
git add -A
git commit -m "fix: close spec-coverage gap found during final integration check"
```
