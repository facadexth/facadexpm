# PO Deposit Deduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a purchase order's receive step deduct supplier deposits (own tax invoice each) so only the remainder becomes an expense, and let the PO document scan read "Deduct Down Payment" lines to pre-fill that deduction.

**Architecture:** Two additive tables (`supplier_deposits`, `po_deposit_applications`) plus one nullable `purchase_orders.deposit_hint` JSONB; one atomic RPC `receive_po_with_deposits` replaces the client-side "insert expense + update PO" part of receiving (stock posting stays as today). Pure math lives in `src/lib/depositMath.js` (tested against two real invoices). Extraction gains a `deposit_deductions` array that the PO form stores in `deposit_hint`; the receive dialog reads it.

**Tech Stack:** React 18 + Vite, Supabase (Postgres RPC/RLS), vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-po-deposit-deduction-design.md`

## Global Constraints

- Additive-only migrations; do NOT add columns to `expenses` (view `e.*` freeze). One new nullable column on `purchase_orders` is allowed (`deposit_hint`); send it from the client only when non-empty so code deployed before the migration keeps working.
- **Never apply a migration yourself.** Write the `.sql` and stop; the owner dry-runs then applies. Read-only schema checks via `SCAN DOCS/kc-yk-work/dbq.py` in the main checkout are allowed (live production project: SELECT/catalog queries only).
- Module/role gate `has_module_access('purchase_orders')` + `is_admin_or_owner()`; tenant isolation via `tenant_id = current_tenant_id()`; SECURITY DEFINER functions set `search_path = public`, REVOKE from PUBLIC/anon, GRANT to authenticated.
- VAT: a deposit and the remainder are separate tax invoices. Deduction VAT = `amount_no_vat × deposit.vat / deposit.amount_no_vat` (2dp); when a deduction uses up a deposit's whole remaining net, it takes the remaining VAT exactly (no rounding leftover). Remainder `net + vat = amount` always.
- Stock valuation is unchanged (PO goods value ex-VAT) — deposits only affect the expense.
- Thai UI strings; money rounded to 2dp with the same `round2`; follow surrounding code style.
- Run `npx vitest run` and `npm run build` before every commit; existing tests stay green. Commit trailers (verbatim on every commit):
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Upq692foSk71qFm1jPANAh`.
- Work happens in a NEW worktree branched from `worktree-supplier-credit-note-peak-export` (see Sequencing in the spec); the controller sets it up before Task 1.

## Review Focus

- Receive with a full deduction (invoice total 0): no expense row, PO `received`, `expense_id` null, stock still posted in full.
- Receive twice / race: second call must error `not_ordered`, never double-post expense or applications.
- Over-limit: deduction above a deposit's remaining, above the PO subtotal, or of another supplier's deposit must fail with nothing written.
- VAT rounding on partial deductions (real case: 9,786 − 2,935.80 → net 6,850.20, VAT 479.51, total 7,329.71) and on the "use up the whole deposit" case.
- Deposit expense with applications cannot be deleted or have its amounts edited (server enforced, not only hidden in the UI).
- Extraction: malformed/missing `deposit_deductions` must degrade to "nothing pre-filled"; a read ref that matches no registered deposit must show a warning and never deduct silently.
- Deploy order: code before migration must not break any existing page (PO list, receive without deposits, Expenses page).

---

## File Structure

- Create `src/lib/depositMath.js` (+ `.test.js`) — pure math.
- Create `supabase/migrations/2026-10-07-01-supplier-deposits.sql` — tables, RLS, triggers, `deposit_hint`.
- Create `supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql` — RPC.
- Create `supabase/tests/po_deposit_test.sql` — BEGIN…ROLLBACK script (never run by implementers).
- Modify `src/hooks/useSupabase.js` — `useSupplierDeposits`, `useDepositExpenseIds`, `registerSupplierDeposit`, `receivePoWithDeposits`.
- Create `src/components/DepositRegisterModal.jsx`; modify `src/pages/Expenses.jsx` — register button, usage badge, lock.
- Create `src/components/ReceiveDepositBlock.jsx`; modify `src/pages/PurchaseOrders.jsx` — receive via RPC, deposit block, PO detail shows applied deposits, scan stores `deposit_hint`.
- Modify `src/lib/poDocumentExtraction.js` (+ test), `supabase/functions/_shared/po-extract-prompt.ts` (+ `src/lib/poExtractPrompt.test.js`), `scripts/eval-po-extract.mjs` fixtures.

---

### Task 1: Deposit math

**Files:**
- Create: `src/lib/depositMath.js`
- Test: `src/lib/depositMath.test.js`

**Interfaces:**
- Produces: `round2(n)`; `depositRemaining(deposit, applications)` → `{ net, vat }` where `deposit = { amount_no_vat, vat }`, `applications = [{ amount_no_vat, vat }]`; `splitDeduction(deposit, remaining, amountNoVat)` → `{ net, vat }` (VAT pro-rata, exact leftover when it uses up the remaining net); `computeReceivePlan({ subtotal, vat }, deductions)` where `deductions = [{ net, vat }]` → `{ netToPay, vatToPay, total, createExpense }`; `validateDeduction({ supplierOk, remainingNet, amountNoVat, uncoveredNet })` → `null | 'wrong_supplier' | 'not_positive' | 'exceeds_remaining' | 'exceeds_po'`; `normalizeDepositRef(s)`; `matchDepositByRef(ref, deposits)` where `deposits = [{ id, deposit_invoice_no }]` → deposit or `null`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { round2, depositRemaining, splitDeduction, computeReceivePlan, validateDeduction, normalizeDepositRef, matchDepositByRef } from './depositMath.js'

describe('depositRemaining', () => {
  it('subtracts applications from net and vat', () => {
    expect(depositRemaining({ amount_no_vat: 1000, vat: 70 }, [{ amount_no_vat: 400, vat: 28 }])).toEqual({ net: 600, vat: 42 })
  })
  it('is the full deposit with no applications', () => {
    expect(depositRemaining({ amount_no_vat: 212754.6, vat: 14892.82 }, [])).toEqual({ net: 212754.6, vat: 14892.82 })
  })
})

describe('splitDeduction', () => {
  const dep = { amount_no_vat: 1000, vat: 70 }
  it('takes VAT pro-rata at the deposit rate', () => {
    expect(splitDeduction(dep, { net: 1000, vat: 70 }, 2935.8 / 10)).toEqual({ net: 293.58, vat: 20.55 })
  })
  it('takes the exact remaining VAT when it uses up the whole remaining net', () => {
    expect(splitDeduction({ amount_no_vat: 3, vat: 0.21 }, { net: 1, vat: 0.07 }, 1)).toEqual({ net: 1, vat: 0.07 })
  })
})

describe('computeReceivePlan (real CAC invoices)', () => {
  it('IV6903055: 9,786 less 2,935.80 -> net 6,850.20, VAT 479.51, total 7,329.71', () => {
    // PO subtotal 9,786.00, VAT 685.02; deposit VAT rate 7% -> deduction VAT 205.51
    const p = computeReceivePlan({ subtotal: 9786, vat: 685.02 }, [{ net: 2935.8, vat: 205.51 }])
    expect(p).toEqual({ netToPay: 6850.2, vatToPay: 479.51, total: 7329.71, createExpense: true })
  })
  it('IV6903014: fully deducted -> no expense', () => {
    const p = computeReceivePlan({ subtotal: 41004, vat: 2870.28 }, [{ net: 41004, vat: 2870.28 }])
    expect(p).toEqual({ netToPay: 0, vatToPay: 0, total: 0, createExpense: false })
  })
  it('no deductions behaves like today', () => {
    expect(computeReceivePlan({ subtotal: 100, vat: 7 }, [])).toEqual({ netToPay: 100, vatToPay: 7, total: 107, createExpense: true })
  })
})

describe('validateDeduction', () => {
  const ok = { supplierOk: true, remainingNet: 100, amountNoVat: 50, uncoveredNet: 80 }
  it('accepts a valid deduction', () => expect(validateDeduction(ok)).toBeNull())
  it('rejects other supplier', () => expect(validateDeduction({ ...ok, supplierOk: false })).toBe('wrong_supplier'))
  it('rejects zero/negative/NaN', () => {
    expect(validateDeduction({ ...ok, amountNoVat: 0 })).toBe('not_positive')
    expect(validateDeduction({ ...ok, amountNoVat: NaN })).toBe('not_positive')
  })
  it('rejects above remaining and above the PO', () => {
    expect(validateDeduction({ ...ok, amountNoVat: 100.01 })).toBe('exceeds_remaining')
    expect(validateDeduction({ ...ok, amountNoVat: 90, remainingNet: 200 })).toBe('exceeds_po')
  })
})

describe('deposit ref matching', () => {
  it('normalizes case, spaces and dashes', () => expect(normalizeDepositRef(' AI-6901 007 ')).toBe('ai6901007'))
  it('matches the printed ref to a registered deposit', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: 'AI6901007' }, { id: 'd2', deposit_invoice_no: 'AI6901008' }]
    expect(matchDepositByRef('AI 6901007', deps).id).toBe('d1')
    expect(matchDepositByRef('AI9999999', deps)).toBeNull()
    expect(matchDepositByRef('', deps)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/depositMath.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// ============================================================
// Deposit (หักมัดจำ) math -- pure; mirrored in the receive_po_with_deposits
// RPC (supabase/migrations/2026-10-07-02-...sql), which is the authority.
// ============================================================

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100

const EPS = 0.005

export function depositRemaining(deposit, applications) {
  const usedNet = (applications || []).reduce((s, a) => s + Number(a.amount_no_vat || 0), 0)
  const usedVat = (applications || []).reduce((s, a) => s + Number(a.vat || 0), 0)
  return { net: round2(Number(deposit.amount_no_vat) - usedNet), vat: round2(Number(deposit.vat || 0) - usedVat) }
}

export function splitDeduction(deposit, remaining, amountNoVat) {
  const net = round2(amountNoVat)
  if (Math.abs(net - remaining.net) < EPS) return { net, vat: round2(remaining.vat) }
  const rate = Number(deposit.amount_no_vat) > 0 ? Number(deposit.vat || 0) / Number(deposit.amount_no_vat) : 0
  return { net, vat: round2(net * rate) }
}

export function computeReceivePlan({ subtotal, vat }, deductions) {
  const dNet = (deductions || []).reduce((s, d) => s + d.net, 0)
  const dVat = (deductions || []).reduce((s, d) => s + d.vat, 0)
  const netToPay = Math.max(0, round2(subtotal - dNet))
  const vatToPay = Math.max(0, round2(vat - dVat))
  const total = round2(netToPay + vatToPay)
  return { netToPay, vatToPay, total, createExpense: netToPay > EPS || vatToPay > EPS }
}

export function validateDeduction({ supplierOk, remainingNet, amountNoVat, uncoveredNet }) {
  if (!supplierOk) return 'wrong_supplier'
  if (!Number.isFinite(Number(amountNoVat)) || Number(amountNoVat) <= 0) return 'not_positive'
  if (Number(amountNoVat) > remainingNet + EPS) return 'exceeds_remaining'
  if (Number(amountNoVat) > uncoveredNet + EPS) return 'exceeds_po'
  return null
}

export const normalizeDepositRef = s => String(s || '').toLowerCase().replace(/[\s\-_./]/g, '')

export function matchDepositByRef(ref, deposits) {
  const n = normalizeDepositRef(ref)
  if (!n) return null
  return (deposits || []).find(d => normalizeDepositRef(d.deposit_invoice_no) === n) || null
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/depositMath.test.js` → PASS. If the `2935.8 / 10` VAT figure (20.55) or `6850.2` rounding differs, fix the implementation, not the expected real-document numbers (205.51 = 2,935.80 × 7%).

- [ ] **Step 5: Commit** — `git add src/lib/depositMath.js src/lib/depositMath.test.js` ; message `feat: deposit deduction math`.

---

### Task 2: Migration 1 — tables, RLS, locks, deposit_hint

**Files:**
- Create: `supabase/migrations/2026-10-07-01-supplier-deposits.sql`

**Interfaces:**
- Produces: tables `supplier_deposits`, `po_deposit_applications`; column `purchase_orders.deposit_hint JSONB`; trigger functions `sd_validate`, `expenses_block_deposit_amount_edit`.

- [ ] **Step 1: Read-only schema check** (main checkout, `dbq.py`): confirm `expenses` has `amount`, `amount_no_vat`, `vat`, `supplier_id`, `tenant_id`; list existing triggers on `expenses` (`trg_expense_sync_check_date` expected); record in the commit message body. If `expenses.amount_no_vat` is NOT NULL-free for deposit rows is unknowable, the trigger below handles it.

- [ ] **Step 2: Write the migration**

```sql
-- PO deposit deduction (หักมัดจำ). Spec: docs/superpowers/specs/2026-10-06-po-deposit-deduction-design.md
-- Additive only. No columns added to expenses (expenses_view e.* freezes).

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS deposit_hint JSONB;   -- [{ref, amount_no_vat}] read from a scanned supplier document

CREATE TABLE supplier_deposits (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  expense_id         UUID NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  deposit_invoice_no TEXT NOT NULL CHECK (btrim(deposit_invoice_no) <> ''),
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supplier_deposits_invoice_uq ON supplier_deposits (tenant_id, lower(btrim(deposit_invoice_no)));
CREATE INDEX idx_supplier_deposits_tenant ON supplier_deposits(tenant_id);

CREATE TABLE po_deposit_applications (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  deposit_id    UUID NOT NULL REFERENCES supplier_deposits(id) ON DELETE RESTRICT,
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  amount_no_vat NUMERIC NOT NULL CHECK (amount_no_vat > 0),
  vat           NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pda_deposit ON po_deposit_applications(deposit_id);
CREATE INDEX idx_pda_po ON po_deposit_applications(po_id);
CREATE INDEX idx_pda_tenant ON po_deposit_applications(tenant_id);

ALTER TABLE supplier_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_deposit_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON supplier_deposits FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
-- applications: clients may only READ; rows are written by the receive RPC (definer)
CREATE POLICY admin_read ON po_deposit_applications FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_deposits TO authenticated;
GRANT SELECT ON po_deposit_applications TO authenticated;

-- A deposit must reference a same-tenant expense that has the VAT split (needed for the math).
CREATE OR REPLACE FUNCTION sd_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e RECORD;
BEGIN
  SELECT tenant_id, amount_no_vat, vat, supplier_id INTO e FROM expenses WHERE id = NEW.expense_id;
  IF NOT FOUND OR e.tenant_id IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
  IF e.amount_no_vat IS NULL OR e.vat IS NULL OR e.amount_no_vat <= 0 THEN RAISE EXCEPTION 'deposit_expense_needs_vat_split'; END IF;
  IF e.supplier_id IS NULL THEN RAISE EXCEPTION 'deposit_expense_needs_supplier'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_validate_trg BEFORE INSERT OR UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_validate();

-- Server-side lock: a deposit expense that has applications keeps its amounts and supplier.
CREATE OR REPLACE FUNCTION expenses_block_deposit_edit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_no_vat IS DISTINCT FROM OLD.amount_no_vat
      OR NEW.vat IS DISTINCT FROM OLD.vat OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     AND EXISTS (SELECT 1 FROM po_deposit_applications a JOIN supplier_deposits d ON d.id = a.deposit_id WHERE d.expense_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_block_deposit_edit_trg BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_block_deposit_edit();
```

- [ ] **Step 3: Static check** — `grep -c "CREATE TABLE" ...` = 2; `grep -c "SECURITY DEFINER"` = 2. Do NOT apply. Put the dry-run command in the report: concatenate with `BEGIN;`/`ROLLBACK;` and `npx supabase db query --linked -f`.

- [ ] **Step 4: Commit** — message `feat(db): supplier deposits, deposit applications, deposit lock`.

---

### Task 3: Migration 2 — receive RPC + SQL test

**Files:**
- Create: `supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql`
- Create: `supabase/tests/po_deposit_test.sql`

**Interfaces:**
- Consumes: Task 2 tables. Produces `receive_po_with_deposits(p_po_id UUID, p_applications JSONB, p_expected_subtotal NUMERIC, p_expected_vat NUMERIC) RETURNS UUID` (the remainder expense id, or NULL when none was created). Error strings: `insufficient_privilege`, `po_not_found`, `not_ordered`, `totals_mismatch`, `deposit_not_found`, `deposit_wrong_supplier`, `deposit_exceeds_remaining`, `deposit_exceeds_po`, `deposit_vat_exceeds_po`, `bad_application`.

- [ ] **Step 1: Read-only check** — via `dbq.py`: columns of `purchase_orders` (`has_vat`, `price_includes_vat`, `deposit_hint` not yet), of `purchase_order_items` (`po_id`, `line_total`), of `suppliers` (`credit_days`), and the exact `expenses` columns used by `handleReceive` in `src/pages/PurchaseOrders.jsx` (`date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount, payment_method, status, notes, po_id`). Adjust the INSERT below to what exists.

- [ ] **Step 2: Write the RPC**

```sql
CREATE OR REPLACE FUNCTION receive_po_with_deposits(
  p_po_id UUID, p_applications JSONB, p_expected_subtotal NUMERIC, p_expected_vat NUMERIC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  po purchase_orders%ROWTYPE;
  v_raw NUMERIC; v_sub NUMERIC; v_vat NUMERIC;
  sup RECORD;
  a JSONB; d RECORD;
  v_used_net NUMERIC; v_used_vat NUMERIC; v_rem_net NUMERIC; v_rem_vat NUMERIC;
  v_amt NUMERIC; v_dvat NUMERIC;
  v_sum_net NUMERIC := 0; v_sum_vat NUMERIC := 0;
  v_net NUMERIC; v_vat_pay NUMERIC; v_exp UUID := NULL;
  v_apps JSONB := '[]'::jsonb;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status <> 'ordered' THEN RAISE EXCEPTION 'not_ordered'; END IF;

  -- totals exactly as the client's calcPoTotals
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = v_tenant;
  IF NOT po.has_vat THEN v_sub := v_raw; v_vat := 0;
  ELSIF po.price_includes_vat THEN
    v_sub := round(round(v_raw, 2) / 1.07, 2); v_vat := round(round(v_raw, 2) - v_sub, 2);
  ELSE v_sub := v_raw; v_vat := round(v_sub * 0.07, 2);
  END IF;
  IF abs(v_sub - COALESCE(p_expected_subtotal, -1)) > 0.01 OR abs(v_vat - COALESCE(p_expected_vat, -1)) > 0.01 THEN
    RAISE EXCEPTION 'totals_mismatch';
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(p_applications, '[]'::jsonb)) LOOP
    v_amt := round((a->>'amount_no_vat')::numeric, 2);
    IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'bad_application'; END IF;
    SELECT sd.id, e.supplier_id, e.amount_no_vat, e.vat INTO d
      FROM supplier_deposits sd JOIN expenses e ON e.id = sd.expense_id
     WHERE sd.id = (a->>'deposit_id')::uuid AND sd.tenant_id = v_tenant FOR UPDATE OF sd;
    IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.supplier_id IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
    SELECT COALESCE(SUM(amount_no_vat), 0), COALESCE(SUM(vat), 0) INTO v_used_net, v_used_vat
      FROM po_deposit_applications WHERE deposit_id = d.id;
    v_rem_net := round(d.amount_no_vat - v_used_net, 2); v_rem_vat := round(d.vat - v_used_vat, 2);
    IF v_amt > v_rem_net + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_remaining'; END IF;
    IF abs(v_amt - v_rem_net) < 0.005 THEN v_dvat := v_rem_vat;
    ELSE v_dvat := round(v_amt * d.vat / d.amount_no_vat, 2); END IF;
    v_sum_net := v_sum_net + v_amt; v_sum_vat := v_sum_vat + v_dvat;
    v_apps := v_apps || jsonb_build_object('deposit_id', d.id, 'net', v_amt, 'vat', v_dvat);
  END LOOP;

  IF v_sum_net > v_sub + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_po'; END IF;
  v_net := round(v_sub - v_sum_net, 2); v_vat_pay := round(v_vat - v_sum_vat, 2);
  IF v_vat_pay < -0.005 THEN RAISE EXCEPTION 'deposit_vat_exceeds_po'; END IF;
  v_vat_pay := GREATEST(v_vat_pay, 0);

  IF v_net > 0.005 OR v_vat_pay > 0.005 THEN
    SELECT credit_days INTO sup FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
    INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                          payment_method, status, notes, po_id)
    VALUES (v_tenant, current_date, 'จากใบสั่งซื้อ ' || po.po_number, po.site_id, po.category_id, po.supplier_id,
            (SELECT name FROM suppliers WHERE id = po.supplier_id), v_net, v_vat_pay, round(v_net + v_vat_pay, 2),
            CASE WHEN sup.credit_days IS NOT NULL THEN 'check' ELSE 'transfer' END,
            CASE WHEN sup.credit_days IS NOT NULL THEN 'awaiting_billing' ELSE 'pending' END,
            'จาก ใบสั่งซื้อ ' || po.po_number || CASE WHEN v_sum_net > 0 THEN ' (หักมัดจำ)' ELSE '' END, po.id)
    RETURNING id INTO v_exp;
  END IF;

  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by)
  SELECT v_tenant, (x->>'deposit_id')::uuid, po.id, (x->>'net')::numeric, (x->>'vat')::numeric, auth.email()
    FROM jsonb_array_elements(v_apps) x;

  UPDATE purchase_orders SET status = 'received', received_date = current_date, expense_id = v_exp WHERE id = po.id;
  RETURN v_exp;
END $$;

REVOKE ALL ON FUNCTION receive_po_with_deposits(UUID, JSONB, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_with_deposits(UUID, JSONB, NUMERIC, NUMERIC) TO authenticated;
```
Note: the client uses `new Date().toISOString().slice(0,10)` (UTC) as the expense/receive date; the RPC uses `current_date` in the DB timezone — if the DB runs UTC, add `(now() AT TIME ZONE 'Asia/Bangkok')::date` instead of `current_date` in both places (the existing Bangkok helper `bangkokTodayIso` exists in `src/lib/photoUpload.js`); use the Bangkok date.

- [ ] **Step 3: SQL test** `supabase/tests/po_deposit_test.sql` — BEGIN … ROLLBACK, run as `authenticated` on a scratch tenant like `supabase/tests/supplier_credit_notes_test.sql` (read it for the fixture pattern and its known guesses). Header must say **NOT RUN against any database**. Checks (each negative one in a nested BEGIN … EXCEPTION block):
  1. PO with items 9,786.00, VAT-exclusive, supplier S; deposit expense 43,939.80 net / 3,075.79 VAT registered as `AI-T1`; receive with deposit net 2,935.80 → expense net 6,850.20 / VAT 479.51 / amount 7,329.71, application VAT 205.51, PO `received`.
  2. Full deduction: PO subtotal 41,004 (VAT 2,870.28) vs a deposit of exactly that → returns NULL, no expense with that `po_id`, PO `received`, `expense_id` NULL.
  3. Second receive of the same PO → `not_ordered`.
  4. Deduction above the deposit's remaining → `deposit_exceeds_remaining`, nothing written (no application rows, PO still `ordered`).
  5. Deduction above the PO subtotal → `deposit_exceeds_po`.
  6. Another supplier's deposit → `deposit_wrong_supplier`.
  7. Wrong expected totals → `totals_mismatch`.
  8. Deleting a deposit expense that has applications → foreign_key_violation; updating its amount → `deposit_in_use`.
  9. Client INSERT into `po_deposit_applications` → permission/policy error.

- [ ] **Step 4: Static check** — `grep -c "SECURITY DEFINER" ...02...sql` = 1. Do NOT apply or run the SQL test.

- [ ] **Step 5: Commit** — `feat(db): receive_po_with_deposits RPC and SQL tests`.

---

### Task 4: Hooks and Expenses page (register, usage, lock)

**Files:**
- Modify: `src/hooks/useSupabase.js`
- Create: `src/components/DepositRegisterModal.jsx`
- Modify: `src/pages/Expenses.jsx`

**Interfaces:**
- Consumes: `depositRemaining` (Task 1).
- Produces: `useSupplierDeposits(supplierId)` → `{ data: [{ id, expense_id, deposit_invoice_no, expense: {id,date,supplier_id,amount_no_vat,vat,amount,invoice_no}, applications: [{amount_no_vat,vat,po_id}] }], loading, error, refetch }` (pass `undefined` for all suppliers); `useDepositMap()` → `Map<expense_id, {deposit_invoice_no, remaining:{net,vat}, used:{net,vat}}>`; `registerSupplierDeposit(expenseId, depositInvoiceNo)`; `receivePoWithDeposits(poId, applications, subtotal, vat)`.

- [ ] **Step 1: Hooks** (follow `useSupplierCreditNotes`/`useCreditNoteExpenseIds`; a missing table before the migration must not crash pages — `useQuery` already stores the error and leaves `data` null):

```js
export function useSupplierDeposits(supplierId) {
  return useQuery(async () => {
    const rows = await fetchAllRows(() => {
      let q = supabase.from('supplier_deposits')
        .select('id, expense_id, deposit_invoice_no, expenses!supplier_deposits_expense_id_fkey(id, date, supplier_id, invoice_no, amount, amount_no_vat, vat), po_deposit_applications(amount_no_vat, vat, po_id)')
        .order('created_at', { ascending: false })
      return q
    })
    return (rows || [])
      .map(r => ({ ...r, expense: r.expenses, applications: r.po_deposit_applications || [] }))
      .filter(r => !supplierId || r.expense?.supplier_id === supplierId)
  }, [supplierId])
}

export async function registerSupplierDeposit(expenseId, depositInvoiceNo) {
  const { error } = await supabase.from('supplier_deposits').insert({ expense_id: expenseId, deposit_invoice_no: depositInvoiceNo.trim(), created_by: (await supabase.auth.getUser()).data?.user?.email || null })
  if (error) throw error
}

export async function receivePoWithDeposits(poId, applications, subtotal, vat) {
  const { data, error } = await supabase.rpc('receive_po_with_deposits', {
    p_po_id: poId, p_applications: applications, p_expected_subtotal: subtotal, p_expected_vat: vat,
  })
  if (error) throw error
  return data // remainder expense id or null
}
```
Verify the embed relationship name with the real FK (`supplier_deposits_expense_id_fkey`) — this is the "ambiguous FK embed" trap noted in the project memory: if the embed fails use the exact constraint name from the migration; do not guess. Add `useDepositMap()` built on `useSupplierDeposits()` using `depositRemaining`.

- [ ] **Step 2: Expenses page.** (a) Row action "🏷️ ลงทะเบียนเป็นมัดจำ" (only for expenses with `supplier_id` and `amount_no_vat != null`, not already registered, not a credit-note expense) opens `DepositRegisterModal` (field: เลขที่ใบมัดจำ, required; shows the expense summary; on save call `registerSupplierDeposit`, refetch; map errors: unique violation `23505` → "เลขที่ใบมัดจำนี้มีอยู่แล้ว", `deposit_expense_needs_vat_split` → "รายจ่ายนี้ไม่มียอดก่อน VAT/VAT แยก ลงทะเบียนเป็นมัดจำไม่ได้", `deposit_expense_needs_supplier` → "รายจ่ายนี้ยังไม่ระบุซัพพลายเออร์"). (b) A registered deposit row shows a badge "มัดจำ {no} · ใช้แล้ว X · เหลือ Y" from `useDepositMap`. (c) Rows whose deposit has applications get the same read-only treatment the page already gives credit-note expenses (find `cnExpenseIds` usage near `Expenses.jsx:403,695-719`): hide edit/status/delete, show "🔒 ใช้หักมัดจำแล้ว"; on delete failure with `23503` show "ลบไม่ได้ — มัดจำนี้ถูกใช้หักกับใบสั่งซื้อแล้ว". Hooks must tolerate `data == null` (loading, or table missing): treat as "no deposits".

- [ ] **Step 3: Verify** — `npx vitest run`, `npm run build`. Not live-verifiable until the migration is applied: say so; do not claim UI flows verified.

- [ ] **Step 4: Commit** — `feat: register supplier deposits from the Expenses page`.

---

### Task 5: Receive dialog with deposit deduction

**Files:**
- Create: `src/components/ReceiveDepositBlock.jsx`
- Modify: `src/pages/PurchaseOrders.jsx` (`handleReceive`, the `receiveRow` dialog, PO detail)

**Interfaces:**
- Consumes: Task 1 helpers, Task 4 hooks, `calcPoTotals` (already in `PurchaseOrders.jsx`; export it or pass totals as props).
- Produces: `ReceiveDepositBlock({ po, totals: {subtotal, vat}, onChange })` calling `onChange({ applications: [{deposit_id, amount_no_vat}], plan: computeReceivePlan(...), valid: bool, errors })`.

- [ ] **Step 1: Component.** Lists the PO supplier's deposits with `remaining.net > 0` (from `useSupplierDeposits(po.supplier_id)` + `depositRemaining`); per deposit a checkbox and an ex-VAT amount input (default `min(remaining.net, uncoveredNet)` when ticked); live preview via `computeReceivePlan` with `splitDeduction` per ticked deposit: "รายจ่ายใหม่: ก่อน VAT X · VAT Y" or "ไม่สร้างรายจ่าย (หักครบ)"; per-line error text from `validateDeduction` mapped to Thai ("มัดจำของซัพพลายเออร์อื่น", "ยอดต้องมากกว่า 0", "เกินยอดมัดจำคงเหลือ", "เกินยอดสินค้าที่เหลือ"). Initial selection comes from `po.deposit_hint` (Task 6): for each `{ref, amount_no_vat}` match with `matchDepositByRef`; matched → preticked with the read amount (clamped later by validation, never auto-clamped silently); unmatched refs → a visible amber warning "ไม่พบมัดจำเลขที่ {ref} ในระบบ — เลือกเอง หรือลงทะเบียนมัดจำที่หน้ารายจ่ายก่อน". If there are no registered deposits and no hint, render nothing (receive works exactly as today). Show nothing while `useSupplierDeposits` is loading/errored.

- [ ] **Step 2: `handleReceive`.** Replace the "insert expense + update PO" part with:

```js
const { subtotal, vat } = calcPoTotals(receiveRow.purchase_order_items, receiveRow.has_vat, receiveRow.price_includes_vat)
const expenseId = await receivePoWithDeposits(receiveRow.id, depositApps, subtotal, vat)
if (expenseId) await auditLog('expenses', expenseId, 'INSERT', null, { po_id: receiveRow.id, via: 'receive_po_with_deposits' })
await auditLog('purchase_orders', receiveRow.id, 'UPDATE', null, { status: 'received', deposit_applications: depositApps })
// stock posting loop stays exactly as before
```
Keep the existing `catch` hardening text. RPC error mapping (`not_ordered` → "ใบสั่งซื้อนี้รับของไปแล้ว", `deposit_exceeds_remaining`, `deposit_exceeds_po`, `deposit_wrong_supplier`, `totals_mismatch` → "ยอดใบสั่งซื้อเปลี่ยนไป กรุณาเปิดใหม่", others → message). The dialog text "สร้างรายจ่ายอัตโนมัติ … ยอดรวม X" becomes dynamic from the plan (e.g. "ไม่สร้างรายจ่าย" when `!plan.createExpense`). Confirm stays disabled while the block reports `valid === false`. Toast: "รับของแล้ว" + (expense ? "สร้างรายจ่ายอัตโนมัติ" : "หักมัดจำครบ ไม่สร้างรายจ่าย").

- [ ] **Step 3: PO detail** shows applied deposits ("หักมัดจำ {no}: ก่อน VAT X · VAT Y") from `po_deposit_applications` (small query by `po_id`; tolerate errors).

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run build`. Receiving without any deposit must behave identically (same expense fields); say what was not live-verified.

- [ ] **Step 5: Commit** — `feat: deduct deposits when receiving a purchase order`.

---

### Task 6: Document scan reads deposit deductions

**Files:**
- Modify: `src/lib/poDocumentExtraction.js` (+ `src/lib/poDocumentExtraction.test.js`), `supabase/functions/_shared/po-extract-prompt.ts` (+ `src/lib/poExtractPrompt.test.js`), `scripts/eval-po-extract.mjs` fixtures, `src/pages/PurchaseOrders.jsx` (scan prefill + PO insert)

**Interfaces:**
- Produces: `validateExtraction(raw).data.deposit_deductions: [{ref: string, amount: number}]` (always an array; invalid entries dropped); PO insert sends `deposit_hint: [{ref, amount_no_vat}]` only when non-empty.

- [ ] **Step 1: Tests first.** In `poDocumentExtraction.test.js` add: valid `deposit_deductions` kept (`ref` trimmed, `amount` finite > 0); entries without a ref or with non-numeric/zero/negative amount dropped; missing/non-array → `[]`; a response that is otherwise valid keeps `ok: true`. In `poExtractPrompt.test.js` add assertions that the prompt mentions `deposit_deductions` and the phrases "Deduct Down Payment" and "หักดาวน์เพย์เมนต์" and says the amount is the ex-VAT amount deducted. Run → FAIL.

- [ ] **Step 2: Implement** in `validateExtraction` (add to the returned `data`):

```js
const deposit_deductions = (Array.isArray(raw.deposit_deductions) ? raw.deposit_deductions : [])
  .map(d => {
    if (!d || typeof d !== 'object') return null
    const ref = typeof d.ref === 'string' ? d.ref.trim() : ''
    const amount = toFiniteNumber(d.amount)
    return ref && amount != null && amount > 0 ? { ref, amount } : null
  })
  .filter(Boolean)
```
Prompt (`po-extract-prompt.ts`): add `"deposit_deductions": [ { "ref": string, "amount": number } ]` to the schema and a rule: "If the document has a line that deducts a prior deposit/down payment (e.g. 'Deduct Down Payment AI6901007 41,004.00', 'หักเงินมัดจำ/หักดาวน์เพย์เมนต์ …'), output it in deposit_deductions with the deposit invoice number as ref and the amount deducted (before VAT, as printed on that line). Do NOT reduce unit_price or line items for it; line_items stay at the printed prices. If there is none, return []." Update `scripts/eval-po-extract.mjs` expected-fixture support so a fixture may carry `deposit_deductions` (compare ref normalized + amount); add the two CAC documents (`IV6903014`: ref `AI6901007` amount 41004; `IV6903055`: ref `AI6901007` amount 2935.8) as fixture entries pointing at the scans under `SCAN DOCS/เดือน 3/` (local files, not committed — the script already takes `--raw-dir`/paths; do not copy the scans into git). Do not call the AI from tests.

- [ ] **Step 3: Form wiring.** In the PO create form's scan handler (`PurchaseOrders.jsx` ~line 234-260) put `result.data.deposit_deductions` into form state; show a read-only chip under the items ("อ่านพบการหักมัดจำ {ref} {amount}"); on save include `deposit_hint: deposit_deductions.map(d => ({ ref: d.ref, amount_no_vat: d.amount }))` in the `purchase_orders` insert **only when the list is non-empty** (so the insert still works before the migration). The receive dialog (Task 5) already reads `po.deposit_hint`.

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run build`. The real-model eval on the two CAC scans needs the extraction API key and is NOT run by implementers; list it as an owner step in the report.

- [ ] **Step 5: Commit** — `feat: PO scan reads deposit deductions`.

---

### Task 7: Handoff (no code)

- [ ] Run `npx vitest run` and `npm run build`; report counts.
- [ ] Write `docs/superpowers/plans/2026-10-07-po-deposit-deduction-handoff.md`: apply order (01 then 02, dry-run commands), the SQL test to run after applying, what is verified vs not (RPC under `authenticated`, every UI flow, the real-model scan on the two CAC documents), owner follow-ups (register the existing CAC deposit(s) by hand with their `AI…` numbers; decide order vs the PO-extract upgrade branch), known limits (stock posting not atomic with the RPC; PEAK exports deposit and remainder as ordinary expenses; deposit invoice numbers unique per tenant). Commit it. Do not merge or push.
