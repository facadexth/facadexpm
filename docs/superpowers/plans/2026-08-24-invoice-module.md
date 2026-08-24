# Invoice Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add progress billing (ใบแจ้งหนี้) against a signed quotation's line items, tracked per physical unit, plus a combined ใบเสร็จรับเงิน/ใบกำกับภาษี issued on payment that reconciles into the existing `incomes` table.

**Architecture:** Five new Postgres tables (`quotation_item_units`, `invoices`, `invoice_items`, `invoice_item_draws`, `receipts`), all tenant-scoped with the same RLS shape `quotations` already uses, gated behind a new `invoices` module. A single per-unit progress ledger (`quotation_item_units`) is the only state either UI mode (โหมดง่าย/โหมดละเอียด) reads or writes — no separate representations to keep in sync. A new page (`Invoices.jsx`) mirrors `Quotations.jsx`'s list/form/PDF-export structure. Marking an invoice paid is an app-level transaction mirroring `PurchaseOrders.jsx`'s `handleReceive()` exactly, writing into `receipts` and `incomes`.

**Tech Stack:** React + Vite, Supabase (Postgres + RLS), `html2pdf.js`/`html2canvas` for document export, Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-24-invoice-module-design.md`

## Global Constraints

- Every new table gets `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` and a single `admin_full_access` RLS policy (`is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices')`) — all five new tables gate on `invoices`, not `quotations` (see spec's Module Gating section for why `quotation_item_units` specifically must not gate on `quotations`).
- VAT rate is `0.07`, matching `quotationCalc.js`'s `VAT_RATE` — do not hardcode a different value anywhere.
- One invoice always bills against exactly one quotation. Payment is single-shot (`unpaid → paid`, no partial payments). Receipt and tax invoice are one combined document (`receipts` table carries both number series). All three confirmed with the user during brainstorming — do not add multi-quotation invoices, partial payment tracking, or a separate tax-invoice table.
- No manual DB/browser click-through during implementation — no login credentials are available to the implementer. Verification bar is: migrations self-reviewed against the precedent files cited in each task, `npx vite build`, and `npm test`. Matches how the Quotation module was verified.
- Every SQL migration file must also be appended to `supabase/schema.sql` (the consolidated snapshot) in the same task/commit.
- `quotation_item_units` is seeded **lazily** (first time the invoice item-selection screen opens for a quotation), never at quotation-acceptance time — see Task 6.

---

## Task 1: `invoices` module key + `quotation_item_units` — the per-unit progress ledger

**Files:**
- Create: `supabase/migrations/2026-08-24-01-invoices-module-key.sql`
- Create: `supabase/migrations/2026-08-24-02-quotation-item-units.sql`
- Modify: `supabase/schema.sql`
- Create: `supabase/tests/invoice_module_test.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()` (all existing).
- Produces: module key `'invoices'` added to `tenant_modules.module_key`'s CHECK constraint. Table `quotation_item_units(id, quotation_item_id, unit_index, unit_qty, cumulative_pct, updated_at, tenant_id)`, unique on `(quotation_item_id, unit_index)`.

- [ ] **Step 1: Module key migration**

```sql
-- supabase/migrations/2026-08-24-01-invoices-module-key.sql
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices'));
```

- [ ] **Step 2: `quotation_item_units` migration**

```sql
-- supabase/migrations/2026-08-24-02-quotation-item-units.sql
-- The single source of truth for how much of each quotation line has been
-- billed, tracked per physical unit -- see
-- docs/superpowers/specs/2026-08-24-invoice-module-design.md, Data Model.
-- Rows are seeded LAZILY by the app (first time the invoice item-selection
-- screen opens for a quotation), never at quotation-acceptance time -- this
-- table gates on the 'invoices' module, but acceptance is a
-- 'quotations'-only action that must keep working for tenants without
-- 'invoices' at all.
CREATE TABLE quotation_item_units (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_item_id UUID NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,
  unit_index        INT NOT NULL,
  unit_qty          NUMERIC NOT NULL,
  cumulative_pct    NUMERIC NOT NULL DEFAULT 0 CHECK (cumulative_pct BETWEEN 0 AND 100),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (quotation_item_id, unit_index)
);

CREATE INDEX idx_quotation_item_units_quotation_item_id ON quotation_item_units(quotation_item_id);
CREATE INDEX idx_quotation_item_units_tenant_id ON quotation_item_units(tenant_id);

ALTER TABLE quotation_item_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_item_units FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

- [ ] **Step 3: Append both migrations' DDL to `supabase/schema.sql`**

Find the existing `CREATE TABLE tenant_modules` block (search `module_key IN`) and replace that CHECK line's value list in place (schema.sql is a from-scratch snapshot — show the final constraint directly, not a DROP+ADD pair) to include `'invoices'`. Then find the `quotation_items` table block (search `CREATE TABLE quotation_items`) and insert `quotation_item_units`'s full DDL immediately after `quotation_items`' RLS policy block ends.

- [ ] **Step 4: Start the RLS test file**

```sql
-- supabase/tests/invoice_module_test.sql
-- Regression tests for the Invoice module. Disposable-fixture style,
-- matching supabase/tests/quotation_module_test.sql -- safe to run against
-- production, self-cleans on every path.

-- ── Test 1: quotation_item_units is invisible and unwritable without the
-- 'invoices' module enabled, even for a tenant that DOES have 'quotations'
-- -- confirming the two modules gate independently.
--
-- Fixture/structure mirrors supabase/tests/quotation_module_test.sql's
-- Test 2 exactly (that file's comment block documents why): tenant_modules
-- has no 'enabled' column -- module access is presence-of-row, checked via
-- EXISTS, and a tenant on an active-trial gets blanket access regardless
-- of tenant_modules rows, so the negative-path fixture must be a
-- trial-expired, paid-plan tenant instead. The insert is attempted as the
-- 'authenticated' role under a real admin/owner's JWT claims (without that
-- switch the statement runs as the superuser connection and RLS never
-- applies at all), and the REGRESSION check sits outside the
-- BEGIN/EXCEPTION block so it can't catch its own raised exception. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_item_id UUID;
  test_admin_email TEXT;
  new_unit_id UUID;
  insert_succeeded BOOLEAN := false;
BEGIN
  SELECT qi.id, q.tenant_id INTO test_quotation_item_id, test_tenant_id
  FROM quotation_items qi
  JOIN quotations q ON q.id = qi.quotation_id
  JOIN tenants t ON t.id = q.tenant_id AND t.trial_ends_at < now() AND t.plan = 'active'
  WHERE EXISTS (SELECT 1 FROM tenant_modules tm WHERE tm.tenant_id = t.id AND tm.module_key = 'quotations')
    AND NOT EXISTS (SELECT 1 FROM tenant_modules tm WHERE tm.tenant_id = t.id AND tm.module_key = 'invoices')
  LIMIT 1;

  IF test_quotation_item_id IS NULL THEN
    RAISE NOTICE 'Test 1 (quotation_item_units module gating): SKIPPED — no quotation_item fixture on a trial-expired/paid tenant with quotations but not invoices';
  ELSE
    SELECT user_email INTO test_admin_email FROM user_roles
      WHERE tenant_id = test_tenant_id AND role IN ('OWNER','ADMIN') AND status = 'approved' LIMIT 1;

    IF test_admin_email IS NULL THEN
      RAISE NOTICE 'Test 1 (quotation_item_units module gating): SKIPPED — no admin/owner fixture for that tenant';
    ELSE
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"email":"' || test_admin_email || '"}';
      BEGIN
        INSERT INTO quotation_item_units (quotation_item_id, unit_index, unit_qty)
          VALUES (test_quotation_item_id, 0, 1) RETURNING id INTO new_unit_id;
        insert_succeeded := true;
      EXCEPTION WHEN insufficient_privilege OR others THEN
        insert_succeeded := false;
      END;
      RESET role;

      IF insert_succeeded THEN
        DELETE FROM quotation_item_units WHERE id = new_unit_id;
        RAISE EXCEPTION 'quotation_item_units RLS REGRESSION: insert succeeded without the invoices module enabled';
      ELSE
        RAISE NOTICE 'Test 1 (quotation_item_units module gating blocks writes without invoices module): TEST PASSED';
      END IF;
    END IF;
  END IF;
END $$;
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-24-01-invoices-module-key.sql supabase/migrations/2026-08-24-02-quotation-item-units.sql supabase/schema.sql supabase/tests/invoice_module_test.sql
git commit -m "feat: add invoices module key and quotation_item_units progress ledger"
```

---

## Task 2: `invoices`, `invoice_items`, `invoice_item_draws` + `invoice_number` auto-numbering

**Files:**
- Create: `supabase/migrations/2026-08-24-03-invoices.sql`
- Create: `supabase/migrations/2026-08-24-04-invoice-items.sql`
- Create: `supabase/migrations/2026-08-24-05-invoice-item-draws.sql`
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/invoice_module_test.sql`

**Interfaces:**
- Consumes: `quotation_item_units` (Task 1).
- Produces: table `invoices(id, invoice_number, quotation_id, site_id, date, status, has_vat, price_includes_vat, subtotal, vat, total, notes, paid_date, income_id, created_at, updated_at, tenant_id)`. Table `invoice_items(id, invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, tenant_id)`. Table `invoice_item_draws(id, invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount, tenant_id)`.

- [ ] **Step 1: `invoices` migration (header + auto-numbering)**

```sql
-- supabase/migrations/2026-08-24-03-invoices.sql
-- income_id references incomes(id), which already exists (src/pages/Income.jsx,
-- schema.sql:365) -- set once the invoice is marked paid (Task 8).
CREATE TABLE invoices (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number      TEXT NOT NULL UNIQUE DEFAULT '',
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid','paid','void')),
  has_vat             BOOLEAN NOT NULL,
  price_includes_vat  BOOLEAN NOT NULL,
  subtotal            NUMERIC NOT NULL DEFAULT 0,
  vat                 NUMERIC NOT NULL DEFAULT 0,
  total               NUMERIC NOT NULL DEFAULT 0,
  notes               TEXT,
  paid_date           DATE,
  income_id           UUID REFERENCES incomes(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoices_quotation_id ON invoices(quotation_id);
CREATE INDEX idx_invoices_site_id ON invoices(site_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);

-- Auto-numbering: identical pattern to generate_quotation_number()
-- (supabase/schema.sql, search generate_quotation_number) -- INV- + year +
-- zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM 'INV-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM invoices
  WHERE invoice_number LIKE 'INV-' || year_part || '-%';
  NEW.invoice_number := 'INV-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW
  WHEN (NEW.invoice_number IS NULL OR NEW.invoice_number = '')
  EXECUTE FUNCTION generate_invoice_number();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoices FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

- [ ] **Step 2: `invoice_items` migration**

```sql
-- supabase/migrations/2026-08-24-04-invoice-items.sql
-- description/unit/unit_price are snapshotted at invoice-creation time (not
-- read live from quotation_items), same reasoning as invoices.has_vat --
-- an invoice's printed numbers must never silently shift if the source
-- quotation is ever revisited. draw_qty is the total unit-equivalents this
-- invoice billed for this line, across all its quotation_item_units rows.
CREATE TABLE invoice_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  quotation_item_id  UUID NOT NULL REFERENCES quotation_items(id) ON DELETE RESTRICT,
  description        TEXT NOT NULL,
  unit               TEXT,
  unit_price         NUMERIC NOT NULL,
  draw_qty           NUMERIC NOT NULL,
  line_total         NUMERIC NOT NULL,
  sort_order         INT NOT NULL DEFAULT 0,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_tenant_id ON invoice_items(tenant_id);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

- [ ] **Step 3: `invoice_item_draws` migration (per-unit audit trail)**

```sql
-- supabase/migrations/2026-08-24-05-invoice-item-draws.sql
-- Records exactly which quotation_item_units row moved from what % to
-- what %, and for how much money, on this invoice -- powers the
-- "ประวัติการเรียกเก็บ" history shown per unit in โหมดละเอียด, and is what
-- Task 8's void handler reads to reverse a mistaken invoice's ledger effect.
CREATE TABLE invoice_item_draws (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_item_id         UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  quotation_item_unit_id  UUID NOT NULL REFERENCES quotation_item_units(id) ON DELETE RESTRICT,
  prior_pct               NUMERIC NOT NULL,
  target_pct              NUMERIC NOT NULL,
  amount                  NUMERIC NOT NULL,
  tenant_id               UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_item_draws_invoice_item_id ON invoice_item_draws(invoice_item_id);
CREATE INDEX idx_invoice_item_draws_unit_id ON invoice_item_draws(quotation_item_unit_id);
CREATE INDEX idx_invoice_item_draws_tenant_id ON invoice_item_draws(tenant_id);

ALTER TABLE invoice_item_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_item_draws FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

- [ ] **Step 4: Append all three migrations' DDL to `supabase/schema.sql`**

Insert immediately after `quotation_item_units` (added in Task 1): `invoices` + its trigger function, then `invoice_items`, then `invoice_item_draws`, in that order.

- [ ] **Step 5: Extend the RLS test file**

Append to `supabase/tests/invoice_module_test.sql`:

```sql
-- ── Test 2: invoice auto-numbering produces INV-<year>-NNN, sequential
-- within the year, matching generate_quotation_number()'s behavior. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_id UUID;
  test_site_id UUID;
  first_number TEXT;
  second_number TEXT;
  first_id UUID;
  second_id UUID;
BEGIN
  -- An active-trial tenant has full module access implicitly (matches
  -- has_module_access()'s own logic and quotation_module_test.sql's Test 3
  -- fixture-selection pattern) -- no tenant_modules join needed, and
  -- tenant_modules has no 'enabled' column to join on in the first place.
  SELECT q.id, q.tenant_id, q.site_id INTO test_quotation_id, test_tenant_id, test_site_id
  FROM quotations q
  JOIN tenants t ON t.id = q.tenant_id AND t.trial_ends_at > now()
  WHERE q.site_id IS NOT NULL
  LIMIT 1;

  IF test_quotation_id IS NULL THEN
    RAISE NOTICE 'Test 2 (invoice auto-numbering): SKIPPED — no accepted quotation with a site on an active-trial tenant';
  ELSE
    INSERT INTO invoices (quotation_id, site_id, date, has_vat, price_includes_vat, tenant_id)
      VALUES (test_quotation_id, test_site_id, CURRENT_DATE, true, false, test_tenant_id)
      RETURNING id, invoice_number INTO first_id, first_number;
    INSERT INTO invoices (quotation_id, site_id, date, has_vat, price_includes_vat, tenant_id)
      VALUES (test_quotation_id, test_site_id, CURRENT_DATE, true, false, test_tenant_id)
      RETURNING id, invoice_number INTO second_id, second_number;

    IF first_number !~ '^INV-\d{4}-\d{3}$' OR second_number !~ '^INV-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'invoice_number REGRESSION: expected INV-YYYY-NNN format, got % and %', first_number, second_number;
    END IF;
    IF SUBSTRING(second_number FROM 'INV-\d{4}-(\d+)$')::INT != SUBSTRING(first_number FROM 'INV-\d{4}-(\d+)$')::INT + 1 THEN
      RAISE EXCEPTION 'invoice_number REGRESSION: expected sequential numbers, got % then %', first_number, second_number;
    END IF;

    DELETE FROM invoices WHERE id IN (first_id, second_id);
    RAISE NOTICE 'Test 2 (invoice auto-numbering INV-YYYY-NNN, sequential): TEST PASSED';
  END IF;
END $$;
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-24-03-invoices.sql supabase/migrations/2026-08-24-04-invoice-items.sql supabase/migrations/2026-08-24-05-invoice-item-draws.sql supabase/schema.sql supabase/tests/invoice_module_test.sql
git commit -m "feat: add invoices/invoice_items/invoice_item_draws schema"
```

---

## Task 3: `receipts` + auto-numbering + `site_financial_summary.invoiced_pct`

**Files:**
- Create: `supabase/migrations/2026-08-24-06-receipts.sql`
- Create: `supabase/migrations/2026-08-24-07-site-invoiced-pct.sql`
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/invoice_module_test.sql`

**Interfaces:**
- Consumes: `invoices` (Task 2), `quotation_item_units`/`quotation_items`/`quotations`/`sites` (existing + Task 1).
- Produces: table `receipts(id, receipt_number, tax_invoice_number, invoice_id, date, amount, tenant_id)`, `invoice_id UNIQUE`. `site_financial_summary` gains `invoiced_amount`, `invoiced_pct` columns, computed the same "pure derived view" way `billing_pct` already is.

- [ ] **Step 1: `receipts` migration (combined document, two number series)**

```sql
-- supabase/migrations/2026-08-24-06-receipts.sql
-- One physical document (ใบเสร็จรับเงิน/ใบกำกับภาษี combined), printed with
-- two independently-sequential numbers -- Thai tax practice expects the tax
-- invoice series to be its own unbroken sequence even when printed on the
-- same page as the receipt. invoice_id is UNIQUE because payment is
-- single-shot -- at most one receipt can ever exist per invoice.
CREATE TABLE receipts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number      TEXT NOT NULL UNIQUE DEFAULT '',
  tax_invoice_number  TEXT NOT NULL UNIQUE DEFAULT '',
  invoice_id          UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  amount              NUMERIC NOT NULL,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_receipts_invoice_id ON receipts(invoice_id);
CREATE INDEX idx_receipts_tenant_id ON receipts(tenant_id);

CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RCP-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE receipt_number LIKE 'RCP-' || year_part || '-%';
  NEW.receipt_number := 'RCP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receipt_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.receipt_number IS NULL OR NEW.receipt_number = '')
  EXECUTE FUNCTION generate_receipt_number();

CREATE OR REPLACE FUNCTION generate_tax_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(tax_invoice_number FROM 'TIN-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE tax_invoice_number LIKE 'TIN-' || year_part || '-%';
  NEW.tax_invoice_number := 'TIN-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tax_invoice_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.tax_invoice_number IS NULL OR NEW.tax_invoice_number = '')
  EXECUTE FUNCTION generate_tax_invoice_number();

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON receipts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

- [ ] **Step 2: `site_financial_summary.invoiced_pct` migration**

```sql
-- supabase/migrations/2026-08-24-07-site-invoiced-pct.sql
-- Adds a second, distinct progress figure alongside the existing
-- billing_pct (= % collected, driven by incomes -- unchanged). invoiced_pct
-- answers "how much of the contract has been billed" the instant an
-- invoice is created, computed the same pure-derived-view way billing_pct
-- already is -- nothing stored on sites itself. See spec's "Site Progress"
-- section. CREATE OR REPLACE VIEW of the exact existing definition
-- (supabase/schema.sql, search site_financial_summary) plus one new LEFT
-- JOIN and two new columns -- every existing column is untouched.
CREATE OR REPLACE VIEW site_financial_summary WITH (security_invoker = true) AS
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name            AS client_display_name,
  c.client_number,
  COALESCE(exp.total_expense, 0)                                    AS total_expense,
  COALESCE(inc.total_income, 0)                                     AS total_income,
  COALESCE(inc.total_income, 0) - COALESCE(exp.total_expense, 0)    AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inc.total_income, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct,
  COALESCE(exp.outstanding_expense, 0) AS outstanding_expense,
  s.distance_km,
  s.map_url,
  c.contact_person AS client_contact_person,
  c.phone          AS client_phone,
  s.has_vat, s.contract_value_no_vat,
  s.default_vat_pct, s.default_tax_withheld_pct, s.default_retention_pct,
  s.default_retention_period_days, s.default_deposit_pct,
  COALESCE(inv.invoiced_amount, 0) AS invoiced_amount,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inv.invoiced_amount, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS invoiced_pct
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN (
  SELECT site_id,
         SUM(amount) AS total_expense,
         SUM(CASE WHEN status IN ('pending','check_issued') THEN amount ELSE 0 END) AS outstanding_expense
  FROM expenses
  GROUP BY site_id
) exp ON exp.site_id = s.id
LEFT JOIN (
  SELECT site_id, SUM(received_amount) AS total_income
  FROM incomes
  GROUP BY site_id
) inc ON inc.site_id = s.id
LEFT JOIN (
  SELECT q.site_id,
         SUM(qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price) AS invoiced_amount
  FROM quotation_item_units qiu
  JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
  JOIN quotations q ON q.id = qi.quotation_id
  WHERE q.site_id IS NOT NULL
  GROUP BY q.site_id
) inv ON inv.site_id = s.id;
```

- [ ] **Step 3: Append both migrations' DDL to `supabase/schema.sql`**

Insert `receipts` + its two trigger functions immediately after `invoice_item_draws` (Task 2). Then find the existing `site_financial_summary` view definition (search `CREATE OR REPLACE VIEW site_financial_summary`) and replace it in place with Step 2's version — this is a snapshot file, so the final view definition should appear once, not as a base version plus a later `CREATE OR REPLACE` patch.

- [ ] **Step 4: Extend the RLS test file**

Append to `supabase/tests/invoice_module_test.sql`:

```sql
-- ── Test 3: receipt auto-numbering produces both RCP-YYYY-NNN and
-- TIN-YYYY-NNN on a single insert, independently sequential. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_invoice_id UUID;
  rcp_number TEXT;
  tin_number TEXT;
  new_receipt_id UUID;
BEGIN
  SELECT i.id, i.tenant_id INTO test_invoice_id, test_tenant_id
  FROM invoices i
  WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.invoice_id = i.id)
  LIMIT 1;

  IF test_invoice_id IS NULL THEN
    RAISE NOTICE 'Test 3 (receipt auto-numbering): SKIPPED — no invoice fixture without an existing receipt';
  ELSE
    INSERT INTO receipts (invoice_id, date, amount, tenant_id)
      VALUES (test_invoice_id, CURRENT_DATE, 1000, test_tenant_id)
      RETURNING id, receipt_number, tax_invoice_number INTO new_receipt_id, rcp_number, tin_number;

    IF rcp_number !~ '^RCP-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'receipt_number REGRESSION: expected RCP-YYYY-NNN format, got %', rcp_number;
    END IF;
    IF tin_number !~ '^TIN-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'tax_invoice_number REGRESSION: expected TIN-YYYY-NNN format, got %', tin_number;
    END IF;

    DELETE FROM receipts WHERE id = new_receipt_id;
    RAISE NOTICE 'Test 3 (receipt auto-numbering: both RCP-YYYY-NNN and TIN-YYYY-NNN): TEST PASSED';
  END IF;
END $$;
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-24-06-receipts.sql supabase/migrations/2026-08-24-07-site-invoiced-pct.sql supabase/schema.sql supabase/tests/invoice_module_test.sql
git commit -m "feat: add receipts (combined receipt/tax invoice) and site invoiced_pct"
```

---

## Task 4: `invoiceCalc.js` — pure calc logic, unit-tested

**Files:**
- Create: `src/lib/invoiceCalc.js`
- Create: `src/lib/invoiceCalc.test.js`

**Interfaces:**
- Produces: `export const VAT_RATE = 0.07`; `export function isCountable(quantity)`; `export function buildUnitSeedRows(quotationItem)`; `export function waterfall(units, qty)`; `export function openQty(units)`; `export function drawQty(units)`; `export function drawAmount(units, unitPrice)`; `export function calcInvoiceTotals(invoiceItems, { hasVat, priceIncludesVat })`.

  `units` shape used throughout: `[{ unitQty: number, cumulativePct: number, target?: number }]` — `target` is only present after `waterfall()` or a manual per-unit edit sets it; `cumulativePct` is the persisted prior state.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/invoiceCalc.test.js
import { describe, it, expect } from 'vitest'
import { isCountable, buildUnitSeedRows, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals } from './invoiceCalc.js'

describe('isCountable', () => {
  it('true for small whole numbers', () => {
    expect(isCountable(5)).toBe(true)
    expect(isCountable(1)).toBe(true)
    expect(isCountable(20)).toBe(true)
  })
  it('false for large or fractional quantities', () => {
    expect(isCountable(21)).toBe(false)
    expect(isCountable(45)).toBe(false)
    expect(isCountable(2.5)).toBe(false)
  })
})

describe('buildUnitSeedRows', () => {
  it('fragments a small whole-number quantity into one row per unit', () => {
    const rows = buildUnitSeedRows({ id: 'qi-1', quantity: 3 })
    expect(rows).toEqual([
      { quotation_item_id: 'qi-1', unit_index: 0, unit_qty: 1 },
      { quotation_item_id: 'qi-1', unit_index: 1, unit_qty: 1 },
      { quotation_item_id: 'qi-1', unit_index: 2, unit_qty: 1 },
    ])
  })
  it('keeps a large or fractional quantity as a single row', () => {
    expect(buildUnitSeedRows({ id: 'qi-2', quantity: 45 })).toEqual([
      { quotation_item_id: 'qi-2', unit_index: 0, unit_qty: 45 },
    ])
    expect(buildUnitSeedRows({ id: 'qi-3', quantity: 2.5 })).toEqual([
      { quotation_item_id: 'qi-3', unit_index: 0, unit_qty: 2.5 },
    ])
  })
})

describe('waterfall', () => {
  it('exact-fills units in order, one at a time', () => {
    const units = [{ unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 2)
    expect(result.map(u => u.target)).toEqual([100, 100, 0])
  })
  it('partially fills the unit where the budget runs out', () => {
    const units = [{ unitQty: 1, cumulativePct: 40 }, { unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 2)
    // finishes unit 0 (needs 0.6 more), fully fills unit 1 (needs 1), leaves 0.4 for unit 2
    expect(result.map(u => u.target)).toEqual([100, 100, 40])
  })
  it('already-complete units are skipped and their target mirrors cumulativePct', () => {
    const units = [{ unitQty: 1, cumulativePct: 100 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 1)
    expect(result.map(u => u.target)).toEqual([100, 100])
  })
  it('a continuous single-row item fills proportionally, not in whole-unit jumps', () => {
    const units = [{ unitQty: 45, cumulativePct: 0 }]
    const result = waterfall(units, 22.5)
    expect(result[0].target).toBe(50)
  })
  it('budget exhausted before all units filled leaves the rest untouched', () => {
    const units = [{ unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 0)
    expect(result.map(u => u.target)).toEqual([0, 0])
  })
})

describe('openQty / drawQty / drawAmount', () => {
  const units = [{ unitQty: 1, cumulativePct: 40, target: 100 }, { unitQty: 1, cumulativePct: 0, target: 0 }]

  it('openQty sums remaining capacity across all units, ignoring target', () => {
    expect(openQty(units)).toBeCloseTo(1.6) // 0.6 remaining on unit 0 + 1 on unit 1
  })
  it('drawQty sums the (target - cumulativePct) delta across all units', () => {
    expect(drawQty(units)).toBeCloseTo(0.6) // only unit 0 has target > cumulativePct here
  })
  it('drawAmount is drawQty times unit price', () => {
    expect(drawAmount(units, 26000)).toBeCloseTo(15600)
  })
})

describe('calcInvoiceTotals', () => {
  const items = [{ line_total: 1000 }]

  it('no VAT', () => {
    expect(calcInvoiceTotals(items, { hasVat: false })).toEqual({ subtotal: 1000, vat: 0, total: 1000 })
  })
  it('VAT added on top', () => {
    expect(calcInvoiceTotals(items, { hasVat: true, priceIncludesVat: false })).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('price already includes VAT, backed out', () => {
    expect(calcInvoiceTotals([{ line_total: 1070 }], { hasVat: true, priceIncludesVat: true })).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('empty items list totals to zero', () => {
    expect(calcInvoiceTotals([], { hasVat: true, priceIncludesVat: false })).toEqual({ subtotal: 0, vat: 0, total: 0 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/invoiceCalc.test.js`
Expected: FAIL — `Cannot find module './invoiceCalc.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/lib/invoiceCalc.js
// ============================================================
// Invoice progress-billing math -- see
// docs/superpowers/specs/2026-08-24-invoice-module-design.md.
//
// `units` is the in-memory shape of a quotation_item_units group for one
// quotation_item: [{ unitQty, cumulativePct, target? }]. There is only one
// underlying representation -- โหมดง่าย (waterfall over a scalar qty) and
// โหมดละเอียด (direct per-unit target edits) both read and write this same
// shape, which is why switching modes never changes the billed total.
// ============================================================

export const VAT_RATE = 0.07

function round2(n) {
  return Math.round(n * 100) / 100
}

// Countable pieces (ชุด, งาน) get one quotation_item_units row per physical
// unit, so โหมดละเอียด can fragment them (2.1, 2.2, ...). Continuous
// measures (large or fractional quantities, e.g. 45 ตร.ม.) stay a single
// row -- a display heuristic only, not a hard business rule; both cases
// use the identical row shape.
export function isCountable(quantity) {
  return Number.isInteger(quantity) && quantity > 0 && quantity <= 20
}

export function buildUnitSeedRows(quotationItem) {
  const q = quotationItem.quantity
  if (isCountable(q)) {
    return Array.from({ length: q }, (_, i) => ({
      quotation_item_id: quotationItem.id, unit_index: i, unit_qty: 1,
    }))
  }
  return [{ quotation_item_id: quotationItem.id, unit_index: 0, unit_qty: q }]
}

// Fills `qty` (expressed in the item's own physical unit -- ชุด, ตร.ม.,
// whatever) across `units` in array order, completing each unit's
// remaining capacity before moving to the next. Returns a new array with
// `target` set on every unit (already-complete units get target ==
// cumulativePct, i.e. no draw).
export function waterfall(units, qty) {
  let budget = qty
  return units.map(u => {
    if (u.cumulativePct >= 100) return { ...u, target: u.cumulativePct }
    const capacity = u.unitQty * (100 - u.cumulativePct) / 100
    if (budget <= 1e-9) return { ...u, target: u.cumulativePct }
    if (budget >= capacity - 1e-9) {
      budget -= capacity
      return { ...u, target: 100 }
    }
    const target = u.cumulativePct + (budget / u.unitQty) * 100
    budget = 0
    return { ...u, target }
  })
}

// Total remaining capacity across all units, in the item's own physical
// unit -- independent of `target`, used as the max for โหมดง่าย's quantity
// field and as the upper bound waterfall() can ever consume.
export function openQty(units) {
  return units.reduce((s, u) => s + u.unitQty * (100 - u.cumulativePct) / 100, 0)
}

// Total (target - cumulativePct) delta across all units, in the item's own
// physical unit -- what โหมดง่าย displays as its quantity field, derived
// live from whatever โหมดละเอียด last set.
export function drawQty(units) {
  return units.reduce((s, u) => {
    const t = u.target != null ? u.target : u.cumulativePct
    return s + (t - u.cumulativePct) / 100 * u.unitQty
  }, 0)
}

export function drawAmount(units, unitPrice) {
  return drawQty(units) * unitPrice
}

export function calcInvoiceTotals(invoiceItems, { hasVat, priceIncludesVat } = {}) {
  const subtotalRaw = (invoiceItems || []).reduce((s, it) => s + it.line_total, 0)

  if (!hasVat) {
    const total = round2(subtotalRaw)
    return { subtotal: total, vat: 0, total }
  }
  if (priceIncludesVat) {
    const total = round2(subtotalRaw)
    const subtotal = round2(total / (1 + VAT_RATE))
    const vat = round2(total - subtotal)
    return { subtotal, vat, total }
  }
  const subtotal = round2(subtotalRaw)
  const vat = round2(subtotal * VAT_RATE)
  const total = round2(subtotal + vat)
  return { subtotal, vat, total }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/invoiceCalc.test.js`
Expected: PASS, 16/16

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoiceCalc.js src/lib/invoiceCalc.test.js
git commit -m "feat: add invoiceCalc progress-billing math (waterfall, per-unit ledger helpers)"
```

---

## Task 5: Permissions — register `invoices`

**Files:**
- Modify: `src/lib/permissions.js`

**Interfaces:**
- Produces: `PAGE_LABELS.invoices` and matching entries in `DEFAULT_PERMISSIONS.WORKER/ADMIN/OWNER`.

- [ ] **Step 1: Add the page key**

In `src/lib/permissions.js`, add to `PAGE_LABELS` (after the `quotations` line):

```js
  invoices: '🧾 ใบแจ้งหนี้',
```

In each of `DEFAULT_PERMISSIONS.WORKER`, `.ADMIN`, `.OWNER`, add `invoices` in the same relative position (after `quotations`) with the same value the neighboring `quotations` line already has for that role (`'none'` for WORKER, `'edit'` for ADMIN and OWNER).

- [ ] **Step 2: Verify by reading the file back**

Confirm `PAGE_LABELS` and all three `DEFAULT_PERMISSIONS` role blocks each gained exactly one key (`invoices`), and that it appears in every one of the three role blocks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/permissions.js
git commit -m "feat: register invoices page permissions"
```

---

## Task 6: Data hooks + ledger seeding — `useQuotationItemUnits`, `useInvoices`, `useReceipts`

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: `useQuery`, `fetchAllRows` (existing), `buildUnitSeedRows` (Task 4).
- Produces: `export async function ensureQuotationItemUnits(quotationItems)` (idempotent seeding, called once when the item-selection screen opens); `export function useQuotationItemUnits(quotationId, quotationItems)` → `{ data, loading, error, refetch }` where `data` is `quotation_item_units` rows grouped by `quotation_item_id`; `export function useInvoices(filters = {})` → same shape as `useQuotations`, `filters: { siteId, status, from, to }`; `export function useReceipts(invoiceIds)`.

- [ ] **Step 1: Add `ensureQuotationItemUnits` + `useQuotationItemUnits`**

Add directly after the existing `useQuotations` function (`src/hooks/useSupabase.js`):

```js
import { buildUnitSeedRows } from '../lib/invoiceCalc.js'

// Idempotent: only inserts rows for quotation_items that don't have any
// quotation_item_units yet. Safe to call every time the invoice
// item-selection screen opens for a quotation.
export async function ensureQuotationItemUnits(quotationItems) {
  const ids = (quotationItems || []).map(qi => qi.id)
  if (!ids.length) return

  const { data: existing, error: fetchError } = await supabase
    .from('quotation_item_units')
    .select('quotation_item_id')
    .in('quotation_item_id', ids)
  if (fetchError) throw fetchError

  const alreadySeeded = new Set((existing || []).map(r => r.quotation_item_id))
  const toSeed = quotationItems.filter(qi => !alreadySeeded.has(qi.id))
  if (!toSeed.length) return

  const rows = toSeed.flatMap(buildUnitSeedRows)
  const { error: insertError } = await supabase.from('quotation_item_units').insert(rows)
  if (insertError) throw insertError
}

export function useQuotationItemUnits(quotationId, quotationItems) {
  return useQuery(async () => {
    if (!quotationId || !(quotationItems || []).length) return {}
    await ensureQuotationItemUnits(quotationItems)

    const { data, error } = await supabase
      .from('quotation_item_units')
      .select('*')
      .in('quotation_item_id', quotationItems.map(qi => qi.id))
      .order('unit_index')
    if (error) throw error

    const byQuotationItem = {}
    for (const row of data) {
      if (!byQuotationItem[row.quotation_item_id]) byQuotationItem[row.quotation_item_id] = []
      byQuotationItem[row.quotation_item_id].push(row)
    }
    return byQuotationItem
  }, [quotationId, JSON.stringify((quotationItems || []).map(qi => qi.id))])
}
```

- [ ] **Step 2: Add `useInvoices`**

Add directly after `useQuotationItemUnits`:

```js
export function useInvoices(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('invoices')
        .select('*, quotations(quotation_number, client_id, clients(name)), sites(name, site_number), invoice_items(id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order)')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId) q = q.eq('site_id', filters.siteId)
      if (filters.status) q = q.eq('status', filters.status)
      if (filters.from)   q = q.gte('date', filters.from)
      if (filters.to)     q = q.lte('date', filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}
```

- [ ] **Step 3: Add `useReceipts`**

Add directly after `useInvoices`:

```js
export function useReceipts(invoiceIds) {
  return useQuery(async () => {
    const ids = (invoiceIds || []).filter(Boolean)
    if (!ids.length) return []
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .in('invoice_id', ids)
    if (error) throw error
    return data
  }, [JSON.stringify(invoiceIds || [])])
}
```

- [ ] **Step 4: Verify the file still builds**

Run: `npx vite build`
Expected: succeeds (unused exports until Task 7 imports them, which is fine).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: add useQuotationItemUnits (with lazy ledger seeding), useInvoices, useReceipts"
```

---

## Task 7: `Invoices.jsx` Part 1 — list + item-selection create screen

**Files:**
- Create: `src/pages/Invoices.jsx`

**Interfaces:**
- Consumes: `useInvoices`, `useQuotationItemUnits` (Task 6), `useQuotations`, `useSites` (existing), `waterfall`/`openQty`/`drawQty`/`drawAmount`/`calcInvoiceTotals`/`isCountable` (Task 4), `Modal`/`ConfirmDialog`, `SearchableSelect`, `canEditPage`, `useUserRole`, `fmt`/`fmtDate`, `auditLog`.
- Produces: `export default function Invoices({ navigateTo, navState, openSiteOverview })` — list + the item-selection create screen. Status actions (mark paid / void) are added in Task 8; PDF export in Task 9 — same file, later steps.

**Note on the rendering-discipline concern in the spec:** the spec's prototype (raw HTML/JS) hit a bug where rebuilding the whole row list's `innerHTML` on every keystroke destroyed the input being typed into. That bug is specific to manual DOM manipulation — it does not apply here. This is a normal React component: item state lives in `useState`, each row's `<input>` is a controlled component keyed by a stable id, and React's reconciliation keeps the same DOM node across re-renders as long as the key doesn't change. Do not add any manual `patchAmounts()`-style workaround; a plain `setState` on every `onChange` is correct and sufficient.

- [ ] **Step 1: Write the page**

```jsx
// src/pages/Invoices.jsx
// ============================================================
// Invoices — ใบแจ้งหนี้ (progress billing against a signed quotation)
// ✅ One invoice always bills exactly one accepted quotation with a site
// ✅ Work-completion % tracked per physical unit (quotation_item_units),
//    the single source of truth both โหมดง่าย and โหมดละเอียด read/write
// ✅ โหมดง่าย (default): tick = 100% of what's left, or type a quantity.
//    โหมดละเอียด: per-unit % control, one row per physical unit (2.1, 2.2, ...)
// ✅ Area-type lines (large/fractional quantity) always bill in their own
//    unit, never fragment, ignore the mode switch entirely
// ✅ Status: unpaid -> paid (reconciles into incomes, Task 8) | void
//    (reverses the ledger, Task 8) -- PDF export in Task 9
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useInvoices, useQuotationItemUnits, useQuotations, useSites } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { auditLog } from '../lib/audit.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import { isCountable, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals } from '../lib/invoiceCalc.js'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))

const INV_STATUSES = ['unpaid', 'paid', 'void']
const INV_STATUS_LABELS = { unpaid: '🕓 ยังไม่ชำระ', paid: '✅ ชำระแล้ว', void: '✕ ยกเลิก' }

// One entry per quotation_item: { quotationItemId, description, unit,
// unitPrice, totalQty, units: [{ id, unitIndex, unitQty, cumulativePct,
// target }] }. `checked` (โหมดง่าย full-remaining lock) lives per entry.
function buildLineState(quotationItems, unitsByQuotationItem) {
  return (quotationItems || []).map(qi => {
    const rawUnits = unitsByQuotationItem[qi.id] || []
    const units = rawUnits.map(u => ({
      id: u.id, unitIndex: u.unit_index, unitQty: u.unit_qty, cumulativePct: u.cumulative_pct,
      target: u.cumulative_pct < 100 ? 100 : u.cumulative_pct,
    }))
    return {
      quotationItemId: qi.id, description: qi.description, unit: qi.unit,
      unitPrice: qi.unit_price, totalQty: qi.quantity, checked: true, units,
    }
  })
}

function InvoiceItemsEditor({ lines, onChange, mode, onModeChange }) {
  const setLine = (qiId, updater) => onChange(lines.map(l => l.quotationItemId === qiId ? updater(l) : l))

  const toggleChecked = (qiId, checked) => setLine(qiId, l => ({
    ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units,
  }))
  const setQty = (qiId, qty) => setLine(qiId, l => {
    const max = openQty(l.units)
    const clamped = Math.max(0, Math.min(max, qty))
    return { ...l, units: waterfall(l.units, clamped) }
  })
  const setUnitTarget = (qiId, unitIndex, target) => setLine(qiId, l => ({
    ...l,
    units: l.units.map(u => u.unitIndex === unitIndex
      ? { ...u, target: Math.max(u.cumulativePct, Math.min(100, target)) }
      : u),
  }))

  const billableLines = lines.filter(l => openQty(l.units) > 0)
  const allChecked = billableLines.length > 0 && billableLines.every(l => l.checked)

  const toggleAll = (checked) => onChange(lines.map(l => {
    if (openQty(l.units) <= 0) return l
    return { ...l, checked, units: checked ? waterfall(l.units, openQty(l.units)) : l.units }
  }))

  const subtotal = lines.reduce((s, l) => s + drawAmount(l.units, l.unitPrice), 0)

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button type="button" className={`btn btn-sm ${mode === 'easy' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onModeChange('easy')}>โหมดง่าย</button>
        <button type="button" className={`btn btn-sm ${mode === 'advanced' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onModeChange('advanced')}>โหมดละเอียด</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
        <input type="checkbox" checked={allChecked} onChange={e => toggleAll(e.target.checked)} />
        เลือกทั้งหมด
      </label>

      <div style={{ display: 'grid', gap: 10 }}>
        {lines.map((l, no) => {
          const remaining = openQty(l.units)
          const fullyBilled = remaining <= 0
          const totalValue = l.unitPrice * l.totalQty
          const lineAmount = drawAmount(l.units, l.unitPrice)
          const showAdvanced = mode === 'advanced' && isCountable(l.totalQty) && l.units.length > 1
          const isMixed = l.units.length > 1 && l.units.some(u => u.cumulativePct !== l.units[0].cumulativePct)

          if (fullyBilled) {
            return (
              <div key={l.quotationItemId} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 100px', gap: 8, alignItems: 'center', padding: '8px 0', opacity: 0.5 }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{no + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l.totalQty} {l.unit} × {fmt(l.unitPrice)} = {fmt(totalValue)} บาท</div>
                </div>
                <span className="badge badge-accepted" style={{ justifySelf: 'end' }}>เรียกเก็บครบแล้ว</span>
              </div>
            )
          }

          return (
            <div key={l.quotationItemId} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 90px 100px', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{no + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {l.totalQty} {l.unit} × {fmt(l.unitPrice)} = {fmt(totalValue)} บาท · เหลือ {fmt(remaining)} {l.unit}
                    {isMixed && !showAdvanced && <span style={{ fontStyle: 'italic' }}> · เฉลี่ยจากความคืบหน้าที่ไม่เท่ากันต่อชิ้น</span>}
                  </div>
                </div>
                {showAdvanced ? (
                  <span style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic', textAlign: 'right' }}>{fmt(drawQty(l.units))} {l.unit}</span>
                ) : (
                  <input type="number" min="0" max={remaining} step="1" className="input input-sm"
                    style={{ textAlign: 'right' }}
                    value={drawQty(l.units)}
                    disabled={l.checked}
                    onChange={e => {
                      let v = parseFloat(e.target.value)
                      if (isNaN(v) || v < 0) v = 0
                      if (v > remaining) v = remaining
                      setQty(l.quotationItemId, v)
                    }} />
                )}
                <span className="font-mono" style={{ fontWeight: 700, textAlign: 'right', color: l.checked ? 'var(--accent)' : undefined }}>{fmt(lineAmount)}</span>
              </div>
              {!showAdvanced && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, marginLeft: 36, fontSize: 11, color: 'var(--text3)' }}>
                  <input type="checkbox" checked={l.checked} onChange={e => toggleChecked(l.quotationItemId, e.target.checked)} />
                  เก็บเต็มจำนวนที่เหลือ ({fmt(remaining)} {l.unit})
                </label>
              )}
              {showAdvanced && (
                <div style={{ marginLeft: 36, marginTop: 6, display: 'grid', gap: 4 }}>
                  {l.units.map(u => {
                    const label = `${no + 1}.${u.unitIndex + 1}`
                    if (u.cumulativePct >= 100) {
                      return (
                        <div key={u.unitIndex} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px', gap: 8, fontSize: 11, color: 'var(--text3)', opacity: 0.6 }}>
                          <span>{label}</span><span>เสร็จสมบูรณ์แล้ว</span><span style={{ textAlign: 'right' }}>ครบแล้ว</span>
                        </div>
                      )
                    }
                    const amount = (u.target - u.cumulativePct) / 100 * u.unitQty * l.unitPrice
                    return (
                      <div key={u.unitIndex} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 90px 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                        <span style={{ color: 'var(--text3)' }}>{label}</span>
                        <span style={{ color: 'var(--text3)' }}>{u.cumulativePct > 0 ? `เดิม ${u.cumulativePct}%` : 'ยังไม่เริ่ม'}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifySelf: 'end' }}>
                          <input type="number" min={u.cumulativePct} max="100" step="1" className="input input-sm"
                            style={{ width: 60, textAlign: 'right' }}
                            value={u.target}
                            onChange={e => {
                              let v = parseFloat(e.target.value)
                              if (isNaN(v) || v < u.cumulativePct) v = u.cumulativePct
                              if (v > 100) v = 100
                              setUnitTarget(l.quotationItemId, u.unitIndex, v)
                            }} />
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>%</span>
                        </div>
                        <span className="font-mono" style={{ textAlign: 'right', color: amount === 0 ? 'var(--text3)' : 'var(--accent)' }}>{amount === 0 ? '—' : fmt(amount)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 12, textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
        รวมงวดนี้: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(subtotal)}</span> บาท
      </div>
    </div>
  )
}

function CreateInvoiceModal({ quotation, onClose, onSaved }) {
  const items = quotation.quotation_items || []
  const { data: unitsByQuotationItem, loading: unitsLoading } = useQuotationItemUnits(quotation.id, items)
  const [lines, setLines] = useState(null)
  const [mode, setMode] = useState('easy')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (unitsByQuotationItem && !lines) {
      setLines(buildLineState(items, unitsByQuotationItem))
    }
  }, [unitsByQuotationItem]) // eslint-disable-line react-hooks/exhaustive-deps

  if (unitsLoading || !lines) {
    return <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}><div className="modal-body">⏳ กำลังโหลด...</div></Modal>
  }

  const billedLines = lines.filter(l => drawQty(l.units) > 1e-9)
  const invoiceItemsForTotals = billedLines.map(l => ({ line_total: drawAmount(l.units, l.unitPrice) }))
  const totals = calcInvoiceTotals(invoiceItemsForTotals, { hasVat: quotation.has_vat, priceIncludesVat: quotation.price_includes_vat })

  const handleSave = async () => {
    if (!billedLines.length) { alert('กรุณาเลือกอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    try {
      const { data: invoice, error: invError } = await supabase.from('invoices').insert({
        quotation_id: quotation.id, site_id: quotation.site_id, date: format(new Date(), 'yyyy-MM-dd'),
        has_vat: quotation.has_vat, price_includes_vat: quotation.price_includes_vat,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total,
      }).select().single()
      if (invError) throw invError
      await auditLog('invoices', invoice.id, 'INSERT', null, { quotation_id: quotation.id, total: totals.total })

      for (const [sortOrder, l] of billedLines.entries()) {
        const lineDrawQty = drawQty(l.units)
        const lineAmount = drawAmount(l.units, l.unitPrice)
        const { data: invoiceItem, error: itemError } = await supabase.from('invoice_items').insert({
          invoice_id: invoice.id, quotation_item_id: l.quotationItemId,
          description: l.description, unit: l.unit, unit_price: l.unitPrice,
          draw_qty: lineDrawQty, line_total: lineAmount, sort_order: sortOrder,
        }).select().single()
        if (itemError) throw itemError

        for (const u of l.units) {
          if (u.target === u.cumulativePct) continue
          const drawAmt = (u.target - u.cumulativePct) / 100 * u.unitQty * l.unitPrice
          const { error: drawError } = await supabase.from('invoice_item_draws').insert({
            invoice_item_id: invoiceItem.id, quotation_item_unit_id: u.id,
            prior_pct: u.cumulativePct, target_pct: u.target, amount: drawAmt,
          })
          if (drawError) throw drawError

          const { error: updateError } = await supabase.from('quotation_item_units')
            .update({ cumulative_pct: u.target, updated_at: new Date().toISOString() })
            .eq('id', u.id)
          if (updateError) throw updateError
        }
      }

      onSaved()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`สร้างใบแจ้งหนี้ — ${quotation.quotation_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body">
        <InvoiceItemsEditor lines={lines} onChange={setLines} mode={mode} onModeChange={setMode} />
        <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>รวมงวดนี้ (ก่อน VAT)</span><span className="font-mono">{fmt(totals.subtotal)}</span></div>
          {quotation.has_vat && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>VAT (7%)</span><span className="font-mono">{fmt(totals.vat)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><span>รวมเรียกเก็บงวดนี้</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span></div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳...' : '✅ สร้างใบแจ้งหนี้'}
        </button>
      </div>
    </Modal>
  )
}

export default function Invoices({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'invoices')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState('')
  const [status,   setStatus]   = useState('')
  const [pickQuotation, setPickQuotation] = useState(false)
  const [createFor, setCreateFor] = useState(null)
  const [toast, setToast] = useState(null)

  const filters = { from: dateFrom, to: dateTo, siteId, status }
  const { data: invoices, refetch } = useInvoices(filters)
  const { data: sites } = useSites()
  const { data: acceptedQuotations } = useQuotations({ status: 'accepted' })

  const billableQuotations = useMemo(() =>
    (acceptedQuotations || []).filter(q => q.site_id), [acceptedQuotations])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => setPickQuotation(true)}>+ สร้างใบแจ้งหนี้</button>}
        <div style={{ flex: 1 }} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <select className="select select-sm" style={{ width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {INV_STATUSES.map(s => <option key={s} value={s}>{INV_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>เลขที่</th><th>วันที่</th><th>ไซท์งาน</th><th>ลูกค้า</th><th>รายการ</th><th>ยอดรวม</th><th>สถานะ</th><th></th></tr>
            </thead>
            <tbody>
              {(invoices || []).map(inv => (
                <tr key={inv.id}>
                  <td className="font-mono" style={{ fontSize: 12 }}>{inv.invoice_number}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(inv.date)}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: inv.site_id ? 'pointer' : 'default' }}
                    onClick={() => inv.site_id && openSiteOverview(inv.site_id)}>{inv.sites?.name || '—'}</td>
                  <td style={{ fontSize: 12 }}>{inv.quotations?.clients?.name || '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{(inv.invoice_items || []).length} รายการ</td>
                  <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(inv.total)}</td>
                  <td><span className={`badge badge-${inv.status}`}>{INV_STATUS_LABELS[inv.status] || inv.status}</span></td>
                  <td></td>
                </tr>
              ))}
              {!(invoices || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบใบแจ้งหนี้ในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pickQuotation && (
        <Modal title="เลือกใบเสนอราคาที่จะแจ้งหนี้" onClose={() => setPickQuotation(false)} maxWidth={520}>
          <div className="modal-body">
            <SearchableSelect
              value={null}
              onChange={id => { const q = billableQuotations.find(x => x.id === id); setPickQuotation(false); setCreateFor(q) }}
              placeholder="— เลือกใบเสนอราคา —"
              options={billableQuotations.map(q => ({ value: q.id, label: `${q.quotation_number} · ${q.clients?.name || ''}`, keywords: `${q.quotation_number} ${q.clients?.name || ''}` }))}
            />
            {!billableQuotations.length && <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 8 }}>ไม่มีใบเสนอราคาที่ยอมรับแล้วและมีไซท์งานผูกอยู่</p>}
          </div>
        </Modal>
      )}

      {createFor && (
        <CreateInvoiceModal
          quotation={createFor}
          onClose={() => setCreateFor(null)}
          onSaved={() => { setCreateFor(null); refetch(); showToast('สร้างใบแจ้งหนี้สำเร็จ') }}
        />
      )}
    </div>
  )
}
```

Add the invoice status badges to `src/index.css`, near the quotation `.badge-*` rules added in the Quotation module:

```css
/* add to src/index.css, near .badge-draft/.badge-sent/.badge-accepted */
.badge-unpaid { background: rgba(255,209,102,0.15); color: var(--yellow); }
.badge-paid   { background: rgba(0,212,170,0.15); color: var(--green); }
.badge-void   { background: rgba(94,97,128,0.25); color: var(--text3); }
```

- [ ] **Step 2: Verify the file builds**

Run: `npx vite build`
Expected: succeeds (page written but not yet wired into `App.jsx` — Task 10).

- [ ] **Step 3: Commit**

```bash
git add src/pages/Invoices.jsx src/index.css
git commit -m "feat: add Invoices page (list, create screen with easy/advanced item selection)"
```

---

## Task 8: `Invoices.jsx` Part 2 — status actions: mark paid + void

**Files:**
- Modify: `src/pages/Invoices.jsx`

**Interfaces:**
- Consumes: `PurchaseOrders.jsx`'s `handleReceive()` as the direct precedent for the paid-reconciliation shape.
- Produces: "ทำเครื่องหมายว่าชำระแล้ว" action (inserts `receipts`, inserts `incomes`, updates `invoices.status/paid_date/income_id`), and "ยกเลิก" action (reverses each `invoice_item_draws` row's effect on `quotation_item_units.cumulative_pct`, sets `invoices.status = 'void'`), both only available while `status === 'unpaid'`.

- [ ] **Step 1: Add the imports**

```js
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, round2 } from '../lib/depositCalc.js'
```

- [ ] **Step 2: Add the handlers**

Inside `export default function Invoices(...)`, add state and handlers (after the existing hooks, before `showToast`):

```js
  const [payingId, setPayingId] = useState(null)
  const [voidingId, setVoidingId] = useState(null)
  const { tenant, hasModuleAccess } = useTenant()

  // Computes retention/deposit_deduction/received_amount the exact same
  // way IncomeForm does today (src/pages/Income.jsx): site default %s
  // applied to the pre-VAT amount, deposit deduction additionally capped
  // by calcDepositDeduction() against whatever deposit balance the site
  // has left, and only applied at all if the client_deposits module is on
  // (matches IncomeForm's `depositModuleOn` gate).
  const handleMarkPaid = async (invoice) => {
    setPayingId(invoice.id)
    try {
      const { data: receipt, error: receiptError } = await supabase.from('receipts').insert({
        invoice_id: invoice.id, date: format(new Date(), 'yyyy-MM-dd'), amount: invoice.total,
      }).select().single()
      if (receiptError) throw receiptError
      await auditLog('receipts', receipt.id, 'INSERT', null, { invoice_id: invoice.id, amount: invoice.total })

      const { data: site, error: siteError } = await supabase
        .from('sites')
        .select('default_tax_withheld_pct, default_retention_pct, default_deposit_pct')
        .eq('id', invoice.site_id)
        .single()
      if (siteError) throw siteError

      const noVat = invoice.subtotal
      const taxAmt = noVat * (site.default_tax_withheld_pct || 0) / 100
      const retentionAmt = noVat * (site.default_retention_pct || 0) / 100

      let depositAmt = 0
      if (hasModuleAccess('client_deposits')) {
        const { data: depositBalance } = await supabase
          .from('site_deposit_summary')
          .select('remaining_balance')
          .eq('site_id', invoice.site_id)
          .maybeSingle()
        if (depositBalance) {
          depositAmt = calcDepositDeduction(noVat, site.default_deposit_pct || 0, depositBalance.remaining_balance)
        }
      }

      const receivedAmount = round2(noVat + invoice.vat - taxAmt - retentionAmt - depositAmt)

      const incomePayload = {
        invoice_no: invoice.invoice_number,
        date: format(new Date(), 'yyyy-MM-dd'),
        site_id: invoice.site_id,
        client_name: invoice.quotations?.clients?.name || null,
        description: `${invoice.invoice_number} — ${invoice.quotations?.quotation_number || ''}`,
        amount_no_vat: noVat,
        vat: invoice.vat,
        tax_withheld: round2(taxAmt),
        retention: round2(retentionAmt),
        income_type: 'ปกติ',
        deposit_deduction: round2(depositAmt),
        received_amount: receivedAmount,
      }
      const { data: income, error: incomeError } = await supabase.from('incomes').insert(incomePayload).select().single()
      if (incomeError) throw incomeError
      await auditLog('incomes', income.id, 'INSERT', null, incomePayload)

      const invUpdate = { status: 'paid', paid_date: format(new Date(), 'yyyy-MM-dd'), income_id: income.id }
      const { error: invError } = await supabase.from('invoices').update(invUpdate).eq('id', invoice.id)
      if (invError) throw invError
      await auditLog('invoices', invoice.id, 'UPDATE', null, invUpdate)

      refetch(); showToast('ทำเครื่องหมายว่าชำระแล้ว')
    } catch (e) {
      alert('เกิดข้อผิดพลาด (โปรดตรวจสอบและกระทบยอดด้วยตนเองหากมีการบันทึกไปแล้วบางส่วน): ' + e.message)
    } finally {
      setPayingId(null)
    }
  }

  const handleVoid = async (invoice) => {
    setVoidingId(invoice.id)
    try {
      const { data: invoiceItems, error: itemsError } = await supabase
        .from('invoice_items').select('id').eq('invoice_id', invoice.id)
      if (itemsError) throw itemsError

      const { data: draws, error: drawsError } = await supabase
        .from('invoice_item_draws').select('quotation_item_unit_id, prior_pct')
        .in('invoice_item_id', invoiceItems.map(it => it.id))
      if (drawsError) throw drawsError

      for (const d of draws) {
        const { error } = await supabase.from('quotation_item_units')
          .update({ cumulative_pct: d.prior_pct, updated_at: new Date().toISOString() })
          .eq('id', d.quotation_item_unit_id)
        if (error) throw error
      }

      const { error: voidError } = await supabase.from('invoices').update({ status: 'void' }).eq('id', invoice.id)
      if (voidError) throw voidError
      await auditLog('invoices', invoice.id, 'UPDATE', null, { status: 'void' })

      refetch(); showToast('ยกเลิกใบแจ้งหนี้แล้ว')
    } catch (e) {
      alert('ยกเลิกไม่สำเร็จ: ' + e.message)
    } finally {
      setVoidingId(null)
    }
  }
```

- [ ] **Step 3: Add the action buttons to each table row**

Replace the row's currently-empty final `<td></td>` with:

```jsx
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && inv.status === 'unpaid' && (
                      <>
                        <button className="btn btn-sm btn-primary" disabled={payingId === inv.id} onClick={() => handleMarkPaid(inv)}>
                          {payingId === inv.id ? '⏳...' : '✅ ชำระแล้ว'}
                        </button>
                        <button className="btn btn-sm btn-danger" disabled={voidingId === inv.id} onClick={() => handleVoid(inv)}>
                          {voidingId === inv.id ? '⏳...' : '✕ ยกเลิก'}
                        </button>
                      </>
                    )}
                  </td>
```

- [ ] **Step 4: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Invoices.jsx
git commit -m "feat: add invoice mark-paid (receipt + incomes reconciliation) and void (ledger reversal)"
```

---

## Task 9: `Invoices.jsx` Part 3 — PDF/JPG document export

**Files:**
- Modify: `src/pages/Invoices.jsx`

**Interfaces:**
- Consumes: `downloadPDF`/`downloadJPG` (`src/lib/pdf.js`), the `tenant` value from `useTenant()` (already imported and destructured in Task 8 — reused here, not re-declared).
- Produces: a "📄" button per row opening `InvoiceDocumentModal` (the invoice itself); paid invoices additionally get a "🧾" button opening `ReceiptDocumentModal` (the combined ใบเสร็จรับเงิน/ใบกำกับภาษี). Both follow the exact letterhead structure `QuotationDocumentModal` already established.

- [ ] **Step 1: Add the imports**

```js
import { downloadPDF, downloadJPG } from '../lib/pdf.js'
import { useReceipts } from '../hooks/useSupabase.js'
```

- [ ] **Step 2: Add `InvoiceDocumentModal`**

Add after `CreateInvoiceModal`, before `export default function Invoices`:

```jsx
function InvoiceDocumentModal({ invoice, tenant, onClose }) {
  const items = invoice.invoice_items || []
  return (
    <Modal title={`ใบแจ้งหนี้ ${invoice.invoice_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`inv-doc-${invoice.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ maxHeight: 48, marginBottom: 6 }} crossOrigin="anonymous" />}
              <div style={{ fontSize: 16, fontWeight: 800 }}>{tenant?.company_name}</div>
              {tenant?.address && <div style={{ fontSize: 11 }}>{tenant.address}</div>}
              {tenant?.tax_id && <div style={{ fontSize: 11 }}>เลขประจำตัวผู้เสียภาษี: {tenant.tax_id}</div>}
              {tenant?.phone && <div style={{ fontSize: 11 }}>โทร: {tenant.phone}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ใบแจ้งหนี้</div>
              <div style={{ fontSize: 12 }}>เลขที่: {invoice.invoice_number}</div>
              <div style={{ fontSize: 12 }}>วันที่: {new Date(invoice.date).toLocaleDateString('th-TH')}</div>
              <div style={{ fontSize: 12 }}>อ้างอิงใบเสนอราคา: {invoice.quotations?.quotation_number}</div>
            </div>
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}><strong>ลูกค้า:</strong> {invoice.quotations?.clients?.name}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>งวดนี้</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid #ddd' }}>
                  <td style={{ padding: '6px 4px' }}>{it.description}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.draw_qty)} {it.unit || ''}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.unit_price)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ padding: '6px 4px', borderTop: '2px solid #111' }}>รวมก่อน VAT</td>
                <td style={{ textAlign: 'right', padding: '6px 4px', borderTop: '2px solid #111' }}>{fmt(invoice.subtotal)}</td>
              </tr>
              {invoice.has_vat && (
                <tr>
                  <td colSpan={3} style={{ padding: '6px 4px' }}>VAT (7%)</td>
                  <td style={{ textAlign: 'right', padding: '6px 4px' }}>{fmt(invoice.vat)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td colSpan={3} style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมทั้งสิ้น</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(invoice.total)} บาท</td>
              </tr>
            </tfoot>
          </table>
          {(tenant?.bank_name || tenant?.bank_account_no) && (
            <div style={{ fontSize: 12, marginTop: 16 }}>
              <strong>ชำระเงินไปที่:</strong> {tenant.bank_name} {tenant.bank_account_name ? `ชื่อบัญชี ${tenant.bank_account_name}` : ''} {tenant.bank_account_no ? `เลขที่ ${tenant.bank_account_no}` : ''}
            </div>
          )}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(`inv-doc-${invoice.id}`, invoice.invoice_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`inv-doc-${invoice.id}`, invoice.invoice_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

function ReceiptDocumentModal({ invoice, receipt, tenant, onClose }) {
  return (
    <Modal title={`ใบเสร็จรับเงิน/ใบกำกับภาษี ${receipt.receipt_number}`} onClose={onClose} maxWidth={640}>
      <div className="modal-body">
        <div id={`rcp-doc-${receipt.id}`} style={{ fontFamily: 'Sarabun,sans-serif', padding: '20px 24px', background: '#fff', color: '#111' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              {tenant?.logo_url && <img src={tenant.logo_url} alt="" style={{ maxHeight: 48, marginBottom: 6 }} crossOrigin="anonymous" />}
              <div style={{ fontSize: 16, fontWeight: 800 }}>{tenant?.company_name}</div>
              {tenant?.address && <div style={{ fontSize: 11 }}>{tenant.address}</div>}
              {tenant?.tax_id && <div style={{ fontSize: 11 }}>เลขประจำตัวผู้เสียภาษี: {tenant.tax_id}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ใบเสร็จรับเงิน / ใบกำกับภาษี</div>
              <div style={{ fontSize: 12 }}>เลขที่ใบเสร็จ: {receipt.receipt_number}</div>
              <div style={{ fontSize: 12 }}>เลขที่ใบกำกับภาษี: {receipt.tax_invoice_number}</div>
              <div style={{ fontSize: 12 }}>วันที่: {new Date(receipt.date).toLocaleDateString('th-TH')}</div>
              <div style={{ fontSize: 12 }}>อ้างอิงใบแจ้งหนี้: {invoice.invoice_number}</div>
            </div>
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}><strong>ลูกค้า:</strong> {invoice.quotations?.clients?.name}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              <tr style={{ borderBottom: '2px solid #111' }}>
                <td style={{ padding: '8px 4px' }}>ชำระเงินตามใบแจ้งหนี้ {invoice.invoice_number}</td>
                <td style={{ textAlign: 'right', padding: '8px 4px' }}>{fmt(receipt.amount)} บาท</td>
              </tr>
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, fontSize: 15 }}>
                <td style={{ padding: '8px 4px', borderTop: '1px solid #111' }}>รวมรับชำระ</td>
                <td style={{ textAlign: 'right', padding: '8px 4px', borderTop: '1px solid #111' }}>{fmt(receipt.amount)} บาท</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={() => downloadPDF(`rcp-doc-${receipt.id}`, receipt.receipt_number)}>📄 PDF</button>
        <button className="btn btn-ghost" onClick={() => downloadJPG(`rcp-doc-${receipt.id}`, receipt.receipt_number)}>🖼️ JPG</button>
        <button className="btn btn-primary" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 3: Wire the buttons and modals into the main component**

Inside `export default function Invoices(...)`, add (note: `tenant` comes from the `useTenant()` call already added in Task 8 — do not call `useTenant()` a second time):

```js
  const [docRow, setDocRow] = useState(null)
  const [receiptRow, setReceiptRow] = useState(null)
  const { data: receipts } = useReceipts((invoices || []).map(i => i.id))
```

The table row's action `<td>` currently ends (after Task 8's fix round) with the mark-paid/void buttons inside a `canEdit && invoice.status !== 'unpaid' ... return` guard and a `ConfirmDialog`-gated void — read the CURRENT on-disk `src/pages/Invoices.jsx` before editing, don't assume exact line numbers from this brief, since Task 8 went through a fix round after this brief was written.

The document buttons must sit **outside** whatever conditional wraps the status-action buttons — the 📄 button needs to stay visible on every invoice regardless of status (viewing/printing doesn't require edit rights or an unpaid status), and the 🧾 button only ever applies to paid ones, never unpaid. Nesting either inside the status-action conditional would make them disappear for paid/void invoices, which defeats their purpose — viewing a paid invoice's PDF or its receipt is exactly when you need those buttons. Add them as siblings, after whatever status-action JSX Task 8 left in place, inside the same `<td>`:

```jsx
                    <button className="btn btn-sm btn-ghost" onClick={() => setDocRow(inv)}>📄</button>
                    {inv.status === 'paid' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setReceiptRow(inv)}>🧾</button>
                    )}
```

Near the other modals at the bottom of the component's returned JSX:

```jsx
      {docRow && <InvoiceDocumentModal invoice={docRow} tenant={tenant} onClose={() => setDocRow(null)} />}
      {receiptRow && (
        <ReceiptDocumentModal
          invoice={receiptRow}
          receipt={(receipts || []).find(r => r.invoice_id === receiptRow.id)}
          tenant={tenant}
          onClose={() => setReceiptRow(null)}
        />
      )}
```

- [ ] **Step 4: Verify the file builds**

Run: `npx vite build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Invoices.jsx
git commit -m "feat: add invoice and combined receipt/tax-invoice PDF/JPG export"
```

---

## Task 10: Wire `Invoices` into `App.jsx`

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Produces: one new reachable tab — "🧾 ใบแจ้งหนี้" nested under the existing รายรับ group, alongside `quotations`/`sales_report`, module-gated on `invoices`.

- [ ] **Step 1: Add the lazy import**

```js
const Invoices = lazy(() => import('./pages/Invoices.jsx'))
```

- [ ] **Step 2: Add the `TABS` entry**

Inside the existing `'💰 รายรับ'` group's `children` array (after the `quotations` entry):

```js
    { id: 'invoices', label: '🧾 ใบแจ้งหนี้', minRole: 'ADMIN', module: 'invoices' },
```

- [ ] **Step 3: Add the `renderPage()` case**

```js
      case 'invoices': return <ProtectedPage minRole="ADMIN"><Invoices {...props} /></ProtectedPage>
```

- [ ] **Step 4: Verify the app builds and the full test suite still passes**

Run: `npx vite build`
Expected: succeeds.

Run: `npm test`
Expected: all existing tests plus `src/lib/invoiceCalc.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: wire Invoices page into the app nav"
```

---

## Task 11: Final integration check

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npx vite build`
Expected: succeeds with no new warnings.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: every test file passes, including `src/lib/invoiceCalc.test.js`.

- [ ] **Step 3: Spec-coverage self-check**

Re-read `docs/superpowers/specs/2026-08-24-invoice-module-design.md` section by section and confirm each is covered:
- Data Model (`quotation_item_units`, `invoices`, `invoice_items`, `invoice_item_draws`, `receipts`) — Tasks 1, 2, 3.
- Calculation Logic — Task 4.
- Item-Selection UI (easy/advanced mode, waterfall, area vs piece) — Task 7.
- Status Lifecycle (paid reconciliation, void reversal) — Task 8.
- Site Progress (`invoiced_pct`) — Task 3.
- Auto-numbering — Tasks 2, 3.
- Module Gating — Task 1 (DB), Task 5 (permissions.js), Task 10 (App.jsx TABS `module:` key).
- UI (Invoices page, document export) — Tasks 7, 9.
- Testing — Tasks 1–4 (RLS test file + unit tests), Task 8's void path exercised manually against Task 2's `invoice_item_draws` shape (no automated DB test for void, since it requires a live invoice fixture with real draws — note this as a known verification gap, consistent with "no manual DB click-through" constraint; flag for the user to smoke-test once credentials are available).

- [ ] **Step 4: Note what's NOT covered (by design)**

Confirm no task built: partial invoice payments, multi-quotation invoices, separate receipt/tax-invoice documents, a draft/sent state for invoices, in-place invoice editing, or a public client-facing payment portal — all explicitly out of scope per the spec's Non-Goals.

- [ ] **Step 5: Final commit (if Step 3 turned up any gap that needed a fix)**

Only if a gap was found and fixed:

```bash
git add -A
git commit -m "fix: close spec-coverage gap found during final integration check"
```
