# PO-centric deposits and partial receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create a deposit from a PO (percent or amount), receive a PO in one or several receipts (whole lines, with a received date that dates the stock), deduct the deposit per receipt (percent or value, remaining always visible), and pay a bill in parts by splitting it, with the PO list reduced to a 📄 popup and a ⋯ menu.

**Architecture:** Three additive migrations: (1) receipt tables, new PO status, deposit-to-PO link, lock triggers; (2) three SECURITY DEFINER RPCs (`create_po_deposit`, `receive_po_lines`, `split_payment`) that do each action in one transaction, including the stock movements that the client used to post separately; (3) tax-invoice post/void adapted to POs that have several bills. The client gets pure maths modules mirrored by the RPCs (the RPCs are the authority), thin hook wrappers with Thai error mapping, and three dialogs plus a redesigned PO row.

**Tech Stack:** React 18 + Vite, Supabase (Postgres 15, PostgREST, plpgsql), vitest, Playwright render harness (`scripts/tax-invoice-harness`), esbuild.

**Spec:** `docs/superpowers/specs/2026-10-07-po-deposit-and-partial-receipt-design.md` (approved; rulings R1-R7 binding; open items 2 and 3 accepted by the owner).

## Global Constraints

Every task's requirements implicitly include this section.

- Worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax`, branch `feat/po-deposit-partial-receipt`. Never switch branches, never push, never deploy.
- Implementers NEVER apply migrations and NEVER write to any live database. Allowed: read-only `SELECT`s through the Supabase MCP `execute_sql` on project `kntspldhvcjeaubtqtkn`, or `npx supabase db query --linked` run from `/Users/plfx/code/FacadeXPM/facadex-app` (the main checkout; the worktree has no `supabase/.temp` link) with read-only SQL.
- A migration is applied only by the controller/owner, only after a single-transaction dry run that rolls back: `BEGIN; SET LOCAL lock_timeout='5s'; <migrations>; <test body>; ROLLBACK;` where the test body ends in `RAISE EXCEPTION 'RESULT: <name> ALL PASSED'` (success looks like an error containing that text). A migration is live the instant it commits: an unpushed branch is not "safe".
- Every new SECURITY DEFINER function: `SET search_path = public`; `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon` (helpers and trigger functions also `FROM authenticated`); explicit `GRANT EXECUTE ... TO authenticated` only for the public RPCs; tenant always from `current_tenant_id()`, never from an argument; gate exactly like `receive_po_with_deposits`: `IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;`.
- New tables: RLS on, one `admin_read` SELECT policy `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT SELECT ... TO authenticated`. Clients never write them; only the RPCs do.
- Additive only. No column is added to `expenses` or `purchase_orders` (the `expenses_view` `e.*` list is frozen at creation). The old client stays live while migrations are applied, so: `receive_po_with_deposits`, `DepositRegisterModal`, the legacy un-receive path and every existing query must keep working after each migration on its own.
- PostgREST embeds: every NEW embed names its constraint (`table!constraint_name(...)`). New tables get NO foreign key to `expenses` (a second `purchase_orders`<->`expenses` path would make existing unnamed embeds ambiguous; precedent: `supplier_tax_invoice_pos.expense_id`). Constraint names used by this plan: `po_receipts_po_fk`, `po_receipt_items_receipt_fk`, `po_receipt_items_item_fk`, `po_receipt_items_movement_fk`, `supplier_deposits_po_fk`, `pda_receipt_fk`, `supplier_deposits_expense_id_fkey` (existing), `po_deposit_applications_deposit_id_fkey` (existing), `stie_invoice_fk`.
- Any list query that can exceed 1000 rows uses `fetchAllRows` from `src/lib/fetchAllRows.js` with a stable `.order(...)`.
- PO edit is not atomic (header update, then items delete/insert): a PO with receipts or with its own deposit is edit-locked in the client AND refused by trigger.
- Tax-invoice interplay (R7): `partially_received` is never eligible for tax-invoice linking; receipt stock movements keep `reference_type='purchase_order'`, `reference_id = PO id`, `movement_type='purchase_in'`, and are dated `received_date 12:00 Asia/Bangkok`.
- Money: round to satang with half-away-from-zero (`round2` from `src/lib/depositMath.js` client, `round(x, 2)` server). Client and server may differ by one satang on exact .5 ties; the server value is stored. Totals guard tolerance 0.01.
- UI: every UI task is verified with the Playwright render harness in `scripts/tax-invoice-harness` (loads the REAL `src/index.css`, network blocked, mocked hooks). Run it ALONE (parallel runs make the waits flaky). Each UI task adds scenarios; the run must end in `ALL PASS`.
- The ⋯ menu is the existing `src/components/RowActionsMenu.jsx` (items `{ label, onClick, danger?, disabled?, disabledTitle? }`); a locked item stays visible, disabled, with the explanation as its title.
- `Modal.jsx` caveat: a Modal rendered inside a `<form>` submits it; render dialogs at the page's top level, never inside a form, and never stack a Modal on another Modal (close one, then open the other).
- Thai UI strings follow the neighbouring screens (same verbs/emoji style as `PurchaseOrders.jsx` / `Expenses.jsx`).
- vitest exists (`npm test` = `vitest run`); run `npx vitest run <file>` per task and the whole suite before each commit.
- Commit messages end with the attribution trailer the controller gives (Co-Authored-By / Claude-Session lines).

## Review Focus

The five uncovered-by-spec inputs most likely to bite a real user, each pinned by a test in the owning task:

1. **Double submit / two tabs receiving the same lines** -> exactly one receipt, one bill; the second call gets `line_already_received` (or `po_not_receivable`), shown in Thai. Pinned: Task 4 test B4 (sequential stand-in for the race; the PO row lock serialises the real race) and Task 9 harness scenario "confirm disabled while busy".
2. **Received date edge cases** (blank, tomorrow, a date before the PO, a receipt keyed after midnight Bangkok) -> blank/future refused (`bad_received_date` / `received_date_in_future`), past dates accepted, stock movement `created_at` = that date 12:00 Bangkok whatever the server clock. Pinned: Task 4 tests B3 and B11, Task 9 harness "future date disables confirm".
3. **Deduction typed out of range** (more than the remaining deposit, more than this receipt, 0, blank, 101 %) -> a visible Thai error and a disabled confirm, never a silent clamp. Pinned: Task 1 tests "deductionFromInput errors", Task 4 test B9, Task 9 harness "too large deduction".
4. **Rounding across several receipts** (VAT-inclusive PO, odd satang, deposit used up) -> receipts add up to the PO exactly, the deposit ends at exactly 0.00 net and 0.00 VAT. Pinned: Task 1 tests "incl-VAT final receipt" and "two receipts use the deposit up", Task 4 tests B5 and B8.
5. **Legacy data and the old client** (PO received the old way with no receipt rows; deposit registered from an expense with `pct_of_po` NULL; old client receiving while the new migrations are live) -> popup shows all lines received on `received_date`; legacy deposit selectable with a sensible default; old RPC still receives an ordered PO. Pinned: Task 6 test "poLedgerSummary legacy", Task 3 test A6/A12, Task 4 test B9b, Task 7 harness "legacy received PO popup".

---

## File Structure

Create:
- `src/lib/poReceiptMath.js` (+ `.test.js`) — receipt value, outstanding lines, deduction input -> {gross, net, vat}, default deduction, per-dialog aggregation. Pure.
- `src/lib/poPaymentMath.js` (+ `.test.js`) — deposit-from-PO split, split-payment split. Pure.
- `src/lib/poReceiptErrors.js` (+ `.test.js`) — Thai text for every RPC/trigger code, lock texts, money index builder, ledger summary. Pure.
- `src/components/CreatePoDepositModal.jsx`, `src/components/ReceivePoLinesModal.jsx`, `src/components/SplitPaymentModal.jsx`.
- `supabase/migrations/2026-10-09-01-po-receipts.sql`, `2026-10-09-02-po-receipt-rpcs.sql`, `2026-10-09-03-tax-invoice-multi-bill.sql`.
- `supabase/tests/po_receipt_test_a.sql`, `po_receipt_test_b.sql`, `tax_invoice_multi_bill_test.sql`.
- `supabase/datafix/2026-10-09-thai-german-po2610-038.sql` (owner-run, not part of the release).
- `scripts/tax-invoice-harness/buildExp.mjs`, `entryExp.jsx`, `mockExpHooks.js`, `runExp.mjs`.
- `docs/superpowers/plans/2026-10-09-po-deposit-partial-receipt-handoff.md` (owner handoff, Task 12).

Modify:
- `src/hooks/useSupabase.js` — `usePoMoneyIndex`, `usePoLedger`, `createPoDeposit`, `receivePoLines`, `splitPayment`.
- `src/pages/PurchaseOrders.jsx` — row (📄 + ⋯), status label, PODetailModal, PODocumentModal print/auto action, wiring of the three dialogs, locks.
- `src/pages/Expenses.jsx` — จ่ายบางส่วน action, delete/reconcile error mapping.
- `src/index.css` — `.badge-po-partially_received`.
- `scripts/tax-invoice-harness/mockPoHooks.js`, `mockTenant.js`, `runPo.mjs`, `README.md`.

---

### Task 1: Receipt and deduction maths (pure JS)

**Files:**
- Create: `src/lib/poReceiptMath.js`
- Test: `src/lib/poReceiptMath.test.js`

**Interfaces:**
- Consumes: `round2`, `splitDeduction`, `computeReceivePlan` from `src/lib/depositMath.js`; `calcPoTotals` from `src/lib/poTotals.js`.
- Produces:
  - `outstandingItems(items, receivedItemIds: Set<string>) -> items[]`
  - `receiptValue({ items, hasVat, priceIncludesVat, lineIds: string[], receivedItemIds: Set, priorReceipts: [{goods_subtotal, goods_vat}] }) -> { subtotal, vat, total, isFinal }`
  - `deductionFromInput({ mode: 'percent'|'value', value, receiptTotal, deposit: {amount_no_vat, vat}, remaining: {net, vat} }) -> { code: null|'not_positive'|'bad_percent'|'exceeds_remaining'|'exceeds_receipt', gross?, net?, vat? }`
  - `defaultDeduction({ own: boolean, depositGross, poTotal, remaining: {net, vat}, receiptTotal, isFinal, alreadyCovered = 0 }) -> string` ('' = nothing)
  - `computeReceiveDeductions({ deposits, supplierId, selection: {[id]: {checked, mode, value}}, receipt }) -> { deductions: [{deposit_id, mode, value}], lines: {[id]: {gross, net, vat}}, errors: {[id]: code}, plan, valid }` where `deposits` are `openDeposits()` rows (`{id, supplier_id, expense: {amount_no_vat, vat}, remaining}`) and `plan` is `computeReceivePlan` output (`{netToPay, vatToPay, total, createExpense, overNet, overVat}`).
  - `DEDUCTION_INPUT_TEXT: {[code]: thai}`

Rulings encoded here (beyond the spec text): "percent" in the receive dialog means percent of THIS receipt's value incl. VAT; the deduction input is VAT-inclusive and is turned into net by the deposit's own net/gross ratio, then VAT follows R5 (`splitDeduction`), so the stored gross can differ from the typed gross by 0.01 (the preview shows the stored numbers); the own-deposit default uses the exact ratio deposit gross / PO gross (equals `pct_of_po` because a PO with a deposit is edit-locked); a non-final receipt is valued like `calcPoTotals` of its lines rounded to satang; the final receipt (after it nothing is outstanding) is the PO totals minus all earlier receipts, so receipts always add up to the PO.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/poReceiptMath.test.js
import { describe, it, expect } from 'vitest'
import { outstandingItems, receiptValue, deductionFromInput, defaultDeduction, computeReceiveDeductions } from './poReceiptMath.js'

const exclPo = { hasVat: true, priceIncludesVat: false, items: [
  { id: 'A1', line_total: 60000 }, { id: 'A2', line_total: 40000 },
] }
const dep30 = { amount_no_vat: 30000, vat: 2100 }   // 30 % of 107,000

describe('outstandingItems', () => {
  it('drops received lines', () => {
    expect(outstandingItems(exclPo.items, new Set(['A1'])).map(i => i.id)).toEqual(['A2'])
    expect(outstandingItems(exclPo.items, undefined).length).toBe(2)
  })
})

describe('receiptValue', () => {
  it('first of two receipts is the chosen lines only', () => {
    const r = receiptValue({ ...exclPo, lineIds: ['A1'], receivedItemIds: new Set(), priorReceipts: [] })
    expect(r).toEqual({ subtotal: 60000, vat: 4200, total: 64200, isFinal: false })
  })
  it('final receipt = PO minus earlier receipts', () => {
    const r = receiptValue({ ...exclPo, lineIds: ['A2'], receivedItemIds: new Set(['A1']), priorReceipts: [{ goods_subtotal: 60000, goods_vat: 4200 }] })
    expect(r).toEqual({ subtotal: 40000, vat: 2800, total: 42800, isFinal: true })
  })
  it('incl-VAT final receipt absorbs the rounding so the PO adds up', () => {
    const items = [{ id: 'X', line_total: 100 }, { id: 'Y', line_total: 200 }]
    const first = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['X'], receivedItemIds: new Set(), priorReceipts: [] })
    expect(first).toEqual({ subtotal: 93.46, vat: 6.54, total: 100, isFinal: false })
    const last = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['Y'], receivedItemIds: new Set(['X']), priorReceipts: [{ goods_subtotal: 93.46, goods_vat: 6.54 }] })
    expect(last).toEqual({ subtotal: 186.91, vat: 13.09, total: 200, isFinal: true })
  })
  it('no VAT', () => {
    expect(receiptValue({ items: exclPo.items, hasVat: false, priceIncludesVat: false, lineIds: ['A1'], receivedItemIds: new Set(), priorReceipts: [] }))
      .toEqual({ subtotal: 60000, vat: 0, total: 60000, isFinal: false })
  })
  it('nothing chosen is not final', () => {
    expect(receiptValue({ ...exclPo, lineIds: [], receivedItemIds: new Set(), priorReceipts: [] }).isFinal).toBe(false)
  })
})

describe('deductionFromInput', () => {
  const remaining = { net: 30000, vat: 2100 }
  it('value 19,260 -> 18,000 + 1,260', () => {
    expect(deductionFromInput({ mode: 'value', value: '19260', receiptTotal: 64200, deposit: dep30, remaining }))
      .toEqual({ code: null, gross: 19260, net: 18000, vat: 1260 })
  })
  it('percent of this receipt incl. VAT', () => {
    expect(deductionFromInput({ mode: 'percent', value: '30', receiptTotal: 64200, deposit: dep30, remaining }))
      .toEqual({ code: null, gross: 19260, net: 18000, vat: 1260 })
  })
  it('whole remaining takes the exact remainder (R5)', () => {
    expect(deductionFromInput({ mode: 'value', value: '12840', receiptTotal: 42800, deposit: dep30, remaining: { net: 12000, vat: 840 } }))
      .toEqual({ code: null, gross: 12840, net: 12000, vat: 840 })
  })
  it('ไทย-เยอรมัน: 110,600.55 = 103,365.00 + 7,235.55', () => {
    const dep = { amount_no_vat: 103365, vat: 7235.55 }
    expect(deductionFromInput({ mode: 'value', value: '110600.55', receiptTotal: 221201.10, deposit: dep, remaining: { net: 103365, vat: 7235.55 } }))
      .toEqual({ code: null, gross: 110600.55, net: 103365, vat: 7235.55 })
  })
  it('deductionFromInput errors', () => {
    const base = { receiptTotal: 64200, deposit: dep30, remaining }
    expect(deductionFromInput({ ...base, mode: 'value', value: '' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'value', value: '0' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'value', value: 'abc' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'percent', value: '101' }).code).toBe('bad_percent')
    expect(deductionFromInput({ ...base, mode: 'value', value: '32100.01' }).code).toBe('exceeds_remaining')
    expect(deductionFromInput({ ...base, receiptTotal: 1000, mode: 'value', value: '1000.01' }).code).toBe('exceeds_receipt')
  })
})

describe('defaultDeduction (R4)', () => {
  it('own deposit, non-final: deposit share x receipt', () => {
    expect(defaultDeduction({ own: true, depositGross: 32100, poTotal: 107000, remaining: { net: 30000, vat: 2100 }, receiptTotal: 64200, isFinal: false })).toBe('19260')
  })
  it('own deposit, final: whole remaining', () => {
    expect(defaultDeduction({ own: true, depositGross: 32100, poTotal: 107000, remaining: { net: 12000, vat: 840 }, receiptTotal: 42800, isFinal: true })).toBe('12840')
  })
  it('capped by the receipt', () => {
    expect(defaultDeduction({ own: true, depositGross: 100, poTotal: 100, remaining: { net: 93.46, vat: 6.54 }, receiptTotal: 40, isFinal: true })).toBe('40')
  })
  it('legacy deposit: min(remaining, room)', () => {
    expect(defaultDeduction({ own: false, depositGross: 5350, poTotal: 0, remaining: { net: 5000, vat: 350 }, receiptTotal: 64200, isFinal: false, alreadyCovered: 62000 })).toBe('2200')
  })
  it('nothing left -> empty string', () => {
    expect(defaultDeduction({ own: true, depositGross: 100, poTotal: 100, remaining: { net: 0, vat: 0 }, receiptTotal: 50, isFinal: true })).toBe('')
  })
})

describe('computeReceiveDeductions', () => {
  const own = { id: 'd-own', supplier_id: 'S', expense: dep30, remaining: { net: 30000, vat: 2100 } }
  const other = { id: 'd-other', supplier_id: 'S2', expense: { amount_no_vat: 100, vat: 7 }, remaining: { net: 100, vat: 7 } }
  const receipt = { subtotal: 60000, vat: 4200, total: 64200, isFinal: false }
  it('builds the RPC payload and the bill preview', () => {
    const r = computeReceiveDeductions({ deposits: [own], supplierId: 'S', selection: { 'd-own': { checked: true, mode: 'value', value: '19260' } }, receipt })
    expect(r.valid).toBe(true)
    expect(r.deductions).toEqual([{ deposit_id: 'd-own', mode: 'value', value: 19260 }])
    expect(r.lines['d-own']).toEqual({ gross: 19260, net: 18000, vat: 1260 })
    expect(r.plan).toMatchObject({ netToPay: 42000, vatToPay: 2940, total: 44940, createExpense: true })
  })
  it('two receipts use the deposit up exactly', () => {
    const r2 = computeReceiveDeductions({ deposits: [{ ...own, remaining: { net: 12000, vat: 840 } }], supplierId: 'S',
      selection: { 'd-own': { checked: true, mode: 'value', value: '12840' } }, receipt: { subtotal: 40000, vat: 2800, total: 42800, isFinal: true } })
    expect(r2.lines['d-own']).toEqual({ gross: 12840, net: 12000, vat: 840 })
    expect(r2.plan).toMatchObject({ netToPay: 28000, vatToPay: 1960, total: 29960 })
  })
  it('full cover -> no bill', () => {
    const dep = { id: 'd', supplier_id: 'S', expense: { amount_no_vat: 103365, vat: 7235.55 }, remaining: { net: 103365, vat: 7235.55 } }
    const r = computeReceiveDeductions({ deposits: [dep], supplierId: 'S', selection: { d: { checked: true, mode: 'value', value: '110600.55' } },
      receipt: { subtotal: 103365, vat: 7235.55, total: 110600.55, isFinal: true } })
    expect(r.plan.createExpense).toBe(false)
  })
  it('errors: wrong supplier, too large, unchecked ignored', () => {
    const r = computeReceiveDeductions({ deposits: [own, other], supplierId: 'S',
      selection: { 'd-own': { checked: true, mode: 'value', value: '99999' }, 'd-other': { checked: true, mode: 'value', value: '10' } }, receipt })
    expect(r.errors).toEqual({ 'd-own': 'exceeds_remaining', 'd-other': 'wrong_supplier' })
    expect(r.valid).toBe(false)
    const none = computeReceiveDeductions({ deposits: [own], supplierId: 'S', selection: { 'd-own': { checked: false, mode: 'value', value: '1' } }, receipt })
    expect(none.deductions).toEqual([])
    expect(none.plan.total).toBe(64200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/poReceiptMath.test.js`
Expected: FAIL (cannot resolve `./poReceiptMath.js`).

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/poReceiptMath.js
// Pure maths for receiving a PO in parts (รับของบางส่วน) and deducting a deposit per receipt (หักมัดจำ).
// Mirrored by _po_receipt_value / receive_po_lines in supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql,
// which are the authority (they may differ by one satang on exact .5 ties; the server value is stored).
import { round2, splitDeduction, computeReceivePlan } from './depositMath.js'
import { calcPoTotals } from './poTotals.js'

const EPS = 0.005

export const DEDUCTION_INPUT_TEXT = {
  not_positive: 'ยอดต้องมากกว่า 0',
  bad_percent: 'เปอร์เซ็นต์ต้องไม่เกิน 100',
  exceeds_remaining: 'เกินยอดมัดจำคงเหลือ',
  exceeds_receipt: 'เกินมูลค่าที่รับครั้งนี้',
  wrong_supplier: 'มัดจำของซัพพลายเออร์อื่น',
  bad_deposit: 'ข้อมูลมัดจำไม่ถูกต้อง (VAT คงเหลือติดลบ)',
}

export function outstandingItems(items, receivedItemIds) {
  const got = receivedItemIds || new Set()
  return (items || []).filter(it => !got.has(it.id))
}

/** Value of one receipt. Non-final: calcPoTotals of the chosen lines, rounded to satang.
 *  Final (nothing outstanding after it): PO totals minus every earlier receipt, so the receipts add up to the PO exactly. */
export function receiptValue({ items, hasVat, priceIncludesVat, lineIds, receivedItemIds, priorReceipts }) {
  const ids = new Set(lineIds || [])
  const chosen = (items || []).filter(it => ids.has(it.id))
  const left = outstandingItems(items, receivedItemIds).filter(it => !ids.has(it.id))
  const isFinal = chosen.length > 0 && left.length === 0
  let subtotal
  let vat
  if (isFinal) {
    const po = calcPoTotals(items, hasVat, priceIncludesVat)
    const prevSub = (priorReceipts || []).reduce((s, r) => s + Number(r.goods_subtotal || 0), 0)
    const prevVat = (priorReceipts || []).reduce((s, r) => s + Number(r.goods_vat || 0), 0)
    subtotal = round2(round2(po.subtotal) - prevSub)
    vat = round2(po.vat - prevVat)
  } else {
    const t = calcPoTotals(chosen, hasVat, priceIncludesVat)
    subtotal = round2(t.subtotal)
    vat = round2(t.vat)
  }
  return { subtotal, vat, total: round2(subtotal + vat), isFinal }
}

/** VAT-inclusive input (value in baht, or percent of this receipt incl. VAT) -> stored split.
 *  gross -> net by the deposit's own net/gross ratio, then VAT by R5 (splitDeduction): exact remainder when used up. */
export function deductionFromInput({ mode, value, receiptTotal, deposit, remaining }) {
  const v = Number(value)
  if (value === '' || value == null || !Number.isFinite(v) || v <= 0) return { code: 'not_positive' }
  if (mode === 'percent' && v > 100) return { code: 'bad_percent' }
  const gross = mode === 'percent' ? round2((v / 100) * Number(receiptTotal)) : round2(v)
  if (gross <= 0) return { code: 'not_positive' }
  const remGross = round2(Number(remaining.net) + Number(remaining.vat))
  if (gross > remGross + EPS) return { code: 'exceeds_remaining', gross }
  if (gross > round2(receiptTotal) + EPS) return { code: 'exceeds_receipt', gross }
  if (Math.abs(gross - remGross) < EPS) return { code: null, gross, net: round2(remaining.net), vat: round2(remaining.vat) }
  const dNet = Number(deposit.amount_no_vat)
  const dVat = Number(deposit.vat || 0)
  let net = round2((gross * dNet) / (dNet + dVat))
  if (net > Number(remaining.net)) net = round2(remaining.net)
  if (net <= 0) return { code: 'not_positive', gross }
  const { vat } = splitDeduction(deposit, remaining, net)
  return { code: null, gross, net, vat }
}

/** Default VAT-inclusive deduction (R4) as an input string ('' = nothing to deduct). */
export function defaultDeduction({ own, depositGross, poTotal, remaining, receiptTotal, isFinal, alreadyCovered = 0 }) {
  const remGross = round2(Number(remaining.net) + Number(remaining.vat))
  const room = round2(Number(receiptTotal) - Number(alreadyCovered || 0))
  let g
  if (own && isFinal) g = remGross
  else if (own && Number(poTotal) > 0) g = round2((Number(depositGross) * Number(receiptTotal)) / Number(poTotal))
  else g = remGross
  g = Math.max(0, round2(Math.min(g, remGross, room)))
  return g > 0 ? String(g) : ''
}

/** Aggregates the dialog's deposit rows into the RPC payload, the per-deposit split and the bill preview. */
export function computeReceiveDeductions({ deposits, supplierId, selection, receipt }) {
  const errors = {}
  const lines = {}
  const deductions = []
  const forPlan = []
  let covered = 0
  for (const d of deposits || []) {
    const s = selection?.[d.id]
    if (!s?.checked) continue
    if (d.supplier_id !== supplierId) { errors[d.id] = 'wrong_supplier'; continue }
    if (Number(d.remaining.vat) < 0) { errors[d.id] = 'bad_deposit'; continue }
    const r = deductionFromInput({ mode: s.mode, value: s.value, receiptTotal: receipt.total, deposit: d.expense, remaining: d.remaining })
    if (r.code) { errors[d.id] = r.code; continue }
    if (r.gross > round2(receipt.total - covered) + EPS) { errors[d.id] = 'exceeds_receipt'; continue }
    covered = round2(covered + r.gross)
    lines[d.id] = { gross: r.gross, net: r.net, vat: r.vat }
    forPlan.push({ id: d.id, net: r.net, vat: r.vat })
    deductions.push({ deposit_id: d.id, mode: s.mode, value: Number(s.value) })
  }
  const plan = computeReceivePlan({ subtotal: receipt.subtotal, vat: receipt.vat }, forPlan)
  const valid = Object.keys(errors).length === 0 && !plan.overNet && !plan.overVat
  return { deductions, lines, errors, plan, valid }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/poReceiptMath.test.js` then `npx vitest run`
Expected: all PASS (the whole suite stays green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/poReceiptMath.js src/lib/poReceiptMath.test.js
git commit -m "feat: pure maths for partial PO receipts and per-receipt deposit deduction"
```

---

### Task 2: Deposit-from-PO and split-payment maths (pure JS)

**Files:**
- Create: `src/lib/poPaymentMath.js`
- Test: `src/lib/poPaymentMath.test.js`

**Interfaces:**
- Consumes: `round2` (`depositMath.js`), `VAT_RATE` (`invoiceCalc.js`).
- Produces:
  - `depositFromPo({ mode: 'percent'|'amount', value, poTotal, hasVat }) -> { code: null|'bad_deposit_value'|'deposit_exceeds_po', gross, net, vat, pctOfPo }` (mirror of `create_po_deposit`).
  - `splitPaymentAmounts(bill: {amount, amount_no_vat, vat}, pay) -> { code: null|'bad_split_amount'|'bill_bad_split', paid: {amount, net, vat}, rest: {amount, net, vat} }` (mirror of `split_payment`; `net`/`vat` null when the bill has no VAT split).
  - `DEPOSIT_INPUT_TEXT`, `SPLIT_INPUT_TEXT`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/poPaymentMath.test.js
import { describe, it, expect } from 'vitest'
import { depositFromPo, splitPaymentAmounts } from './poPaymentMath.js'

describe('depositFromPo', () => {
  it('ไทย-เยอรมัน 50 % of 221,201.10', () => {
    expect(depositFromPo({ mode: 'percent', value: '50', poTotal: 221201.10, hasVat: true }))
      .toEqual({ code: null, gross: 110600.55, net: 103365, vat: 7235.55, pctOfPo: 50 })
  })
  it('amount on a VAT PO', () => {
    expect(depositFromPo({ mode: 'amount', value: '32100', poTotal: 107000, hasVat: true }))
      .toEqual({ code: null, gross: 32100, net: 30000, vat: 2100, pctOfPo: 30 })
  })
  it('no-VAT PO keeps VAT 0', () => {
    expect(depositFromPo({ mode: 'percent', value: '10', poTotal: 1000, hasVat: false }))
      .toEqual({ code: null, gross: 100, net: 100, vat: 0, pctOfPo: 10 })
  })
  it('pct keeps 4 decimals', () => {
    expect(depositFromPo({ mode: 'amount', value: '1000', poTotal: 3000, hasVat: false }).pctOfPo).toBe(33.3333)
  })
  it('errors', () => {
    expect(depositFromPo({ mode: 'percent', value: '0', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'percent', value: '100.5', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'amount', value: '', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'bogus', value: '5', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'amount', value: '1000.01', poTotal: 1000, hasVat: true }).code).toBe('deposit_exceeds_po')
  })
})

describe('splitPaymentAmounts', () => {
  it('VAT stays proportional and both parts add up', () => {
    const r = splitPaymentAmounts({ amount: 110600.55, amount_no_vat: 103365, vat: 7235.55 }, '50000')
    expect(r).toEqual({ code: null, paid: { amount: 50000, net: 46728.97, vat: 3271.03 }, rest: { amount: 60600.55, net: 56636.03, vat: 3964.52 } })
  })
  it('receipt bill 44,940 pay 20,000', () => {
    const r = splitPaymentAmounts({ amount: 44940, amount_no_vat: 42000, vat: 2940 }, 20000)
    expect(r.paid).toEqual({ amount: 20000, net: 18691.59, vat: 1308.41 })
    expect(r.rest).toEqual({ amount: 24940, net: 23308.41, vat: 1631.59 })
  })
  it('bill without VAT split splits the amount only', () => {
    expect(splitPaymentAmounts({ amount: 1000, amount_no_vat: null, vat: null }, 400))
      .toEqual({ code: null, paid: { amount: 400, net: null, vat: null }, rest: { amount: 600, net: null, vat: null } })
  })
  it('errors', () => {
    const bill = { amount: 1000, amount_no_vat: 934.58, vat: 65.42 }
    expect(splitPaymentAmounts(bill, '').code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 0).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 1000).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 1200).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts({ amount: 1000, amount_no_vat: 900, vat: 70 }, 500).code).toBe('bill_bad_split')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/poPaymentMath.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/poPaymentMath.js
// Pure mirrors of create_po_deposit (deposit split) and split_payment (partial payment by splitting a bill),
// supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql. The RPCs are the authority.
import { round2 } from './depositMath.js'
import { VAT_RATE } from './invoiceCalc.js'

const EPS = 0.005

export const DEPOSIT_INPUT_TEXT = {
  bad_deposit_value: 'กรอกเปอร์เซ็นต์ (มากกว่า 0 ไม่เกิน 100) หรือจำนวนเงินที่มากกว่า 0',
  deposit_exceeds_po: 'ยอดมัดจำเกินยอดใบสั่งซื้อ',
}

export const SPLIT_INPUT_TEXT = {
  bad_split_amount: 'ยอดที่จ่ายต้องมากกว่า 0 และน้อยกว่ายอดบิล',
  bill_bad_split: 'ยอดก่อน VAT + VAT ของบิลนี้ไม่เท่ากับยอดรวม — แก้ที่หน้ารายจ่ายก่อน',
}

/** Deposit created from a PO: percent (0, 100] of the PO total incl. VAT, or an amount incl. VAT. */
export function depositFromPo({ mode, value, poTotal, hasVat }) {
  const v = Number(value)
  if (mode !== 'percent' && mode !== 'amount') return { code: 'bad_deposit_value' }
  if (value === '' || value == null || !Number.isFinite(v) || v <= 0) return { code: 'bad_deposit_value' }
  if (mode === 'percent' && v > 100) return { code: 'bad_deposit_value' }
  const total = round2(poTotal)
  const gross = mode === 'percent' ? round2((v / 100) * total) : round2(v)
  if (gross <= 0 || total <= 0) return { code: 'bad_deposit_value' }
  if (gross > total + EPS) return { code: 'deposit_exceeds_po', gross }
  const net = hasVat ? round2(gross / (1 + VAT_RATE)) : gross
  const vat = round2(gross - net)
  const pctOfPo = Math.max(0.0001, Math.round((gross / total) * 100 * 10000) / 10000)
  return { code: null, gross, net, vat, pctOfPo }
}

/** Pay part of a pending bill: the paid part keeps VAT in proportion; the rest is exact (no satang lost). */
export function splitPaymentAmounts(bill, pay) {
  const amount = round2(bill.amount)
  const p = Number(pay)
  if (pay === '' || pay == null || !Number.isFinite(p)) return { code: 'bad_split_amount' }
  const paid = round2(p)
  if (amount <= 0 || paid <= 0 || paid >= amount - EPS) return { code: 'bad_split_amount' }
  const hasSplit = bill.amount_no_vat != null && bill.vat != null
  if (!hasSplit) return { code: null, paid: { amount: paid, net: null, vat: null }, rest: { amount: round2(amount - paid), net: null, vat: null } }
  const net = Number(bill.amount_no_vat)
  const vat = Number(bill.vat)
  if (Math.abs(round2(net + vat) - amount) > EPS) return { code: 'bill_bad_split' }
  const paidVat = round2((paid * vat) / amount)
  const paidNet = round2(paid - paidVat)
  return {
    code: null,
    paid: { amount: paid, net: paidNet, vat: paidVat },
    rest: { amount: round2(amount - paid), net: round2(net - paidNet), vat: round2(vat - paidVat) },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/poPaymentMath.test.js` then `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/poPaymentMath.js src/lib/poPaymentMath.test.js
git commit -m "feat: pure maths for deposits created from a PO and split payments"
```

---

### Task 3: Migration 1 — receipt tables, status, deposit-to-PO link, locks (+ SQL test part A)

**Files:**
- Create: `supabase/migrations/2026-10-09-01-po-receipts.sql`
- Test: `supabase/tests/po_receipt_test_a.sql`

**Interfaces:**
- Consumes: live schema (verified 2026-10-07): `purchase_orders.status` CHECK `draft|ordered|received|cancelled`; `supplier_deposits(id, tenant_id, expense_id, deposit_invoice_no, created_by, created_at)`; `po_deposit_applications(id, tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by, created_at)`; triggers `po_block_unreceive_with_deposits_trg`, `po_block_when_tax_invoiced_trg`, `poi_block_when_tax_invoiced_trg`, `expenses_block_deposit_edit_trg`, `sd_validate_trg`, `sd_lock_when_applied_trg`.
- Produces (used by Tasks 4-12):
  - status value `partially_received`.
  - `po_receipts(id, tenant_id, po_id, seq, received_date, received_by, goods_subtotal, goods_vat, expense_id, notes, created_at)`, `UNIQUE (po_id, seq)`.
  - `po_receipt_items(id, tenant_id, receipt_id, po_item_id UNIQUE, quantity, line_total, base_qty, unit_cost, stock_movement_id)`.
  - `supplier_deposits.po_id` (unique when not null), `supplier_deposits.pct_of_po`.
  - `po_deposit_applications.receipt_id`.
  - `expense_splits(id, tenant_id, source_expense_id, new_expense_id UNIQUE, paid_amount, paid_date, payment_method, created_by, created_at)`.
  - transaction-local flag `app.po_receipt_rpc` = `'on'` lets the RPC move PO status.
  - trigger error codes: `po_status_rpc_only`, `po_has_receipts`, `po_has_deposit`, `expense_is_receipt_bill`, `expense_is_split_part`, `deposit_in_use`, `deposit_wrong_supplier`, `cross_tenant_reference`.

Rulings encoded: `po_receipts.expense_id` and `expense_splits` have no FK to `expenses` (PostgREST ambiguity; integrity by RPC + delete trigger); a PO with receipts OR its own deposit refuses status changes and money/supplier field changes unless the RPC flag is on, except the legacy `ordered -> received` move on a PO without receipts (the old client's `receive_po_with_deposits`); receipt bills and split parts cannot be deleted from the client (no un-receive in v1; admin SQL only).

- [ ] **Step 1: Write the failing test** (`supabase/tests/po_receipt_test_a.sql`)

```sql
-- ================================================================
-- Tests for 2026-10-09-01-po-receipts.sql (schema + locks). Part A of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; migration 2026-10-09-01; this body (its BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR whose text contains 'RESULT: po_receipt_test_a ALL PASSED' (the RAISE rolls everything back).
-- Any other error text = failure. Requires 2026-10-07-01..02 and 2026-10-08-01..02 (live).
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID;
  email TEXT := '__test_pra_owner__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID;
  po_r UUID; po_r_item UUID; po_d UUID; po_l UUID; po_x UUID;
  e_dep UUID; d_dep UUID; e_dep2 UUID; e_bill UUID; e_split UUID; r1 UUID; v_msg TEXT; v_status TEXT; v_cnt INT;
BEGIN
  -- fixtures as superuser
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pra__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PRA-1__', '__pra site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pra sup__') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pra sup2__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__pra cat__') RETURNING id INTO t_cat;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pra2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PRA-2__', '__pra site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__pra t2 sup__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__pra t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t2_tenant, 'PO-PRA-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered') RETURNING id INTO t2_po;

  -- po_r: has a receipt (made by superuser, as the RPC will)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-R', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_r;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'a', 1, 100, 100) RETURNING id INTO po_r_item;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'b', 1, 50, 50);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status, po_id)
  VALUES (t_tenant, current_date, 'bill', t_site, t_cat, t_sup, 100, 7, 107, 'transfer', 'pending', po_r) RETURNING id INTO e_bill;
  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, goods_subtotal, goods_vat, expense_id) VALUES (t_tenant, po_r, 1, current_date, 100, 7, e_bill) RETURNING id INTO r1;
  INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total) VALUES (t_tenant, r1, po_r_item, 1, 100);
  PERFORM set_config('app.po_receipt_rpc', 'on', true);
  UPDATE purchase_orders SET status = 'partially_received', received_date = current_date, expense_id = e_bill WHERE id = po_r;
  PERFORM set_config('app.po_receipt_rpc', 'off', true);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount, payment_method, status, po_id)
  VALUES (t_tenant, current_date, 'split part', t_site, t_cat, t_sup, 10, 'transfer', 'pending', po_r) RETURNING id INTO e_split;
  INSERT INTO expense_splits (tenant_id, source_expense_id, new_expense_id, paid_amount, paid_date, payment_method) VALUES (t_tenant, e_bill, e_split, 5, current_date, 'transfer');

  -- A1: status CHECK (flag on, so the lock trigger lets the row reach the CHECK; the failed block also reverts the flag)
  BEGIN
    PERFORM set_config('app.po_receipt_rpc', 'on', true);
    UPDATE purchase_orders SET status = 'bogus' WHERE id = po_r;
    RAISE EXCEPTION 'A1 FAIL: bogus status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF COALESCE(current_setting('app.po_receipt_rpc', true), '') = 'on' THEN RAISE EXCEPTION 'A1 FAIL: flag leaked out of the failed block'; END IF;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_r;
  IF v_status <> 'partially_received' THEN RAISE EXCEPTION 'A1 FAIL: status %', v_status; END IF;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- POs as the tenant admin
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-D', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_d;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_d, 'd', 1, 1000, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-L', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_l;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_l, 'l', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-X', t_site, t_sup2, t_cat, current_date, 'ordered') RETURNING id INTO po_x;

  -- A2: clients read but never write the new tables; other tenant invisible
  BEGIN INSERT INTO po_receipts (po_id, seq, received_date, goods_subtotal) VALUES (po_d, 1, current_date, 1); RAISE EXCEPTION 'A2 FAIL: client wrote po_receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO po_receipt_items (receipt_id, po_item_id, quantity, line_total) VALUES (r1, po_r_item, 1, 1); RAISE EXCEPTION 'A2 FAIL: client wrote po_receipt_items';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO expense_splits (source_expense_id, new_expense_id, paid_amount, paid_date, payment_method) VALUES (e_bill, e_bill, 1, current_date, 'cash'); RAISE EXCEPTION 'A2 FAIL: client wrote expense_splits';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE po_receipts SET notes = 'x' WHERE id = r1; RAISE EXCEPTION 'A2 FAIL: client updated po_receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT count(*) INTO v_cnt FROM po_receipts WHERE id = r1;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'A2 FAIL: owner cannot read own receipt'; END IF;
  SELECT count(*) INTO v_cnt FROM expense_splits WHERE new_expense_id = e_split;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'A2 FAIL: owner cannot read own split'; END IF;

  -- A4: items of a PO with receipts are frozen
  BEGIN UPDATE purchase_order_items SET quantity = 2 WHERE id = po_r_item; RAISE EXCEPTION 'A4 FAIL: item edit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'c', 1, 1, 1); RAISE EXCEPTION 'A4 FAIL: item insert';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM purchase_order_items WHERE po_id = po_r; RAISE EXCEPTION 'A4 FAIL: item delete';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;

  -- A5: PO with receipts: status/money fields refused, notes allowed
  BEGIN UPDATE purchase_orders SET status = 'ordered' WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: un-receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET status = 'received' WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: client finished receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET has_vat = NOT has_vat WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: has_vat';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  UPDATE purchase_orders SET notes = 'ok' WHERE id = po_r;

  -- A7: a client can never set partially_received itself
  BEGIN UPDATE purchase_orders SET status = 'partially_received' WHERE id = po_l; RAISE EXCEPTION 'A7 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_status_rpc_only%' THEN RAISE EXCEPTION 'A7 FAIL: %', v_msg; END IF; END;

  -- A8: deposit linked to a PO (as the RPC will do; clients may also insert supplier_deposits under RLS)
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'dep', t_site, t_cat, t_sup, 300, 21, 321, 'transfer', 'paid') RETURNING id INTO e_dep;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id, pct_of_po) VALUES (e_dep, 'PRA-D1', po_d, 30) RETURNING id INTO d_dep;
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'dep2', t_site, t_cat, t_sup, 10, 0.7, 10.7, 'transfer', 'paid') RETURNING id INTO e_dep2;
  BEGIN INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id) VALUES (e_dep2, 'PRA-D2', po_d); RAISE EXCEPTION 'A8 FAIL: two deposits on one PO';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id) VALUES (e_dep2, 'PRA-D2', po_x); RAISE EXCEPTION 'A8 FAIL: PO of another supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'A8 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id) VALUES (e_dep2, 'PRA-D2', t2_po); RAISE EXCEPTION 'A8 FAIL: PO of another tenant';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A8 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id, pct_of_po) VALUES (e_dep2, 'PRA-D2', po_l, 120); RAISE EXCEPTION 'A8 FAIL: pct 120';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A6: PO with its own deposit: items, cancel and money fields refused; legacy ordered->received (old RPC) still allowed
  BEGIN INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_d, 'e', 1, 1, 1); RAISE EXCEPTION 'A6 FAIL: item insert';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'A6 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET status = 'cancelled' WHERE id = po_d; RAISE EXCEPTION 'A6 FAIL: cancel';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'A6 FAIL: %', v_msg; END IF; END;
  PERFORM receive_po_with_deposits(po_d, '[]'::jsonb, 1000, 70);
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_d;
  IF v_status <> 'received' THEN RAISE EXCEPTION 'A6 FAIL: legacy receive blocked (%)', v_status; END IF;

  -- A9: an applied deposit keeps its PO link
  RESET role;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat) VALUES (t_tenant, d_dep, po_d, 10, 0.7);
  SET LOCAL role = 'authenticated';
  BEGIN UPDATE supplier_deposits SET po_id = po_l WHERE id = d_dep; RAISE EXCEPTION 'A9 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'A9 FAIL: %', v_msg; END IF; END;

  -- A10: receipt bills and split parts cannot be deleted
  BEGIN DELETE FROM expenses WHERE id = e_bill; RAISE EXCEPTION 'A10 FAIL: receipt bill deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_receipt_bill%' THEN RAISE EXCEPTION 'A10 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM expenses WHERE id = e_split; RAISE EXCEPTION 'A10 FAIL: split part deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_split_part%' THEN RAISE EXCEPTION 'A10 FAIL: %', v_msg; END IF; END;

  -- A12: plain legacy flow untouched: receive then un-receive a PO without receipts/deposit
  PERFORM receive_po_with_deposits(po_l, '[]'::jsonb, 100, 7);
  UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po_l;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_l;
  IF v_status <> 'ordered' THEN RAISE EXCEPTION 'A12 FAIL: %', v_status; END IF;

  -- A11: ACL
  RESET role;
  IF has_table_privilege('anon', 'po_receipts', 'SELECT') OR has_table_privilege('anon', 'po_receipt_items', 'SELECT') OR has_table_privilege('anon', 'expense_splits', 'SELECT')
     OR has_table_privilege('authenticated', 'po_receipts', 'INSERT') OR NOT has_table_privilege('authenticated', 'po_receipts', 'SELECT') THEN
    RAISE EXCEPTION 'A11 FAIL: table grants';
  END IF;
  IF has_function_privilege('authenticated', 'po_block_when_receipted()', 'EXECUTE') OR has_function_privilege('anon', 'sd_validate_po()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'expenses_block_receipt_bill_delete()', 'EXECUTE') OR has_function_privilege('authenticated', 'poi_block_when_receipted()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A11 FAIL: trigger function grants';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.po_receipts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.expense_splits'::regclass) THEN RAISE EXCEPTION 'A11 FAIL: RLS off'; END IF;

  -- A3: a PO line is received at most once (unique), checked last because it aborts nothing else
  BEGIN INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total) VALUES (t_tenant, r1, po_r_item, 1, 100); RAISE EXCEPTION 'A3 FAIL';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  RAISE EXCEPTION 'RESULT: po_receipt_test_a ALL PASSED';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Verify the test fails without the migration (read-only proof)**

The test cannot run without the migration (it is a dry-run test). Instead prove the objects do not exist yet with a read-only query (MCP `execute_sql`, project `kntspldhvcjeaubtqtkn`):

```sql
SELECT to_regclass('public.po_receipts') AS t, (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_deposits' AND column_name='po_id') AS c;
```
Expected: both NULL. Do NOT run the test file or the migration against the database.

- [ ] **Step 3: Write the migration** (`supabase/migrations/2026-10-09-01-po-receipts.sql`)

```sql
-- ============================================================
-- PO-centric deposits and partial receipts (มัดจำจากใบสั่งซื้อ / รับของบางส่วน): schema + locks.
-- Spec: docs/superpowers/specs/2026-10-07-po-deposit-and-partial-receipt-design.md
-- Plan: docs/superpowers/plans/2026-10-07-po-deposit-and-partial-receipt-plan.md (Task 3)
-- Requires (live): 2026-10-07-01..02, 2026-10-08-01..02.
-- Additive except the widened purchase_orders status CHECK. No column on expenses / purchase_orders (expenses_view e.* freezes).
-- New tables are SELECT-only for clients; 2026-10-09-02's RPCs write them.
-- po_receipts.expense_id and expense_splits.* have NO foreign key to expenses on purpose: another
-- purchase_orders<->expenses path would make existing unnamed PostgREST embeds ambiguous.
-- ============================================================

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled'));

CREATE TABLE po_receipts (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  po_id          UUID NOT NULL,
  seq            INT NOT NULL CHECK (seq > 0),
  received_date  DATE NOT NULL,
  received_by    TEXT,
  goods_subtotal NUMERIC NOT NULL,
  goods_vat      NUMERIC NOT NULL DEFAULT 0,
  expense_id     UUID,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT po_receipts_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipts_seq_uq UNIQUE (po_id, seq),
  -- NaN sorts above everything in PG, so `< 'Infinity'` rejects NaN and Infinity
  CONSTRAINT po_receipts_finite_check CHECK (goods_subtotal > '-Infinity'::numeric AND goods_subtotal < 'Infinity'::numeric
                                         AND goods_vat > '-Infinity'::numeric AND goods_vat < 'Infinity'::numeric)
);
CREATE INDEX idx_po_receipts_tenant ON po_receipts(tenant_id);
CREATE INDEX idx_po_receipts_expense ON po_receipts(expense_id) WHERE expense_id IS NOT NULL;

CREATE TABLE po_receipt_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  receipt_id        UUID NOT NULL,
  po_item_id        UUID NOT NULL,
  quantity          NUMERIC NOT NULL,
  line_total        NUMERIC NOT NULL,
  base_qty          NUMERIC,
  unit_cost         NUMERIC,
  stock_movement_id UUID,
  CONSTRAINT po_receipt_items_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_item_fk FOREIGN KEY (po_item_id) REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_movement_fk FOREIGN KEY (stock_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_item_uq UNIQUE (po_item_id)          -- R1: a line is received once, in full
);
CREATE INDEX idx_pri_receipt ON po_receipt_items(receipt_id);
CREATE INDEX idx_pri_tenant ON po_receipt_items(tenant_id);
CREATE INDEX idx_pri_movement ON po_receipt_items(stock_movement_id) WHERE stock_movement_id IS NOT NULL;

ALTER TABLE supplier_deposits ADD COLUMN po_id UUID;
ALTER TABLE supplier_deposits ADD COLUMN pct_of_po NUMERIC;
ALTER TABLE supplier_deposits ADD CONSTRAINT supplier_deposits_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT;
ALTER TABLE supplier_deposits ADD CONSTRAINT supplier_deposits_pct_check CHECK (pct_of_po IS NULL OR (pct_of_po > 0 AND pct_of_po <= 100));
CREATE UNIQUE INDEX supplier_deposits_po_uq ON supplier_deposits (po_id) WHERE po_id IS NOT NULL;   -- R6: one deposit per PO

ALTER TABLE po_deposit_applications ADD COLUMN receipt_id UUID;
ALTER TABLE po_deposit_applications ADD CONSTRAINT pda_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT;
CREATE INDEX idx_pda_receipt ON po_deposit_applications(receipt_id) WHERE receipt_id IS NOT NULL;

-- R3 audit trail: which bill a split part came from (split_payment writes it; tax-invoice void follows it).
CREATE TABLE expense_splits (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  source_expense_id UUID NOT NULL,
  new_expense_id    UUID NOT NULL UNIQUE,
  paid_amount       NUMERIC NOT NULL CHECK (paid_amount > 0 AND paid_amount < 'Infinity'::numeric),
  paid_date         DATE NOT NULL,
  payment_method    TEXT NOT NULL,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_splits_source ON expense_splits(source_expense_id);
CREATE INDEX idx_expense_splits_tenant ON expense_splits(tenant_id);

ALTER TABLE po_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_splits ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON po_receipts FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON po_receipt_items FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON expense_splits FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON po_receipts, po_receipt_items, expense_splits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON po_receipts, po_receipt_items, expense_splits TO authenticated;

-- A deposit may name the PO it was paid for: same tenant, same supplier as its expense. Applied -> frozen.
CREATE OR REPLACE FUNCTION sd_validate_po() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_po_tenant UUID; v_po_sup UUID; v_e_sup UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.po_id IS DISTINCT FROM OLD.po_id OR NEW.pct_of_po IS DISTINCT FROM OLD.pct_of_po)
     AND EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  IF NEW.po_id IS NOT NULL THEN
    SELECT tenant_id, supplier_id INTO v_po_tenant, v_po_sup FROM purchase_orders WHERE id = NEW.po_id;
    IF NOT FOUND OR v_po_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
    SELECT supplier_id INTO v_e_sup FROM expenses WHERE id = NEW.expense_id;
    IF v_po_sup IS DISTINCT FROM v_e_sup THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_validate_po_trg BEFORE INSERT OR UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_validate_po();

-- Receipts / the PO's own deposit freeze the PO's money (the PO edit path is not atomic). Status moves only
-- through receive_po_lines (transaction-local flag app.po_receipt_rpc='on'); the legacy ordered -> received of a PO
-- WITHOUT receipts (old client's receive_po_with_deposits) keeps working.
CREATE OR REPLACE FUNCTION po_block_when_receipted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rcpt BOOLEAN; v_dep BOOLEAN; v_code TEXT;
BEGIN
  IF COALESCE(current_setting('app.po_receipt_rpc', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NEW.status = 'partially_received' AND OLD.status IS DISTINCT FROM 'partially_received' THEN RAISE EXCEPTION 'po_status_rpc_only'; END IF;
  v_rcpt := EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id);
  v_dep  := EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = OLD.id);
  IF NOT (v_rcpt OR v_dep) THEN RETURN NEW; END IF;
  v_code := CASE WHEN v_rcpt THEN 'po_has_receipts' ELSE 'po_has_deposit' END;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ordered' AND NEW.status = 'received' AND NOT v_rcpt) THEN
    RAISE EXCEPTION '%', v_code;
  END IF;
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.has_vat IS DISTINCT FROM OLD.has_vat
     OR NEW.price_includes_vat IS DISTINCT FROM OLD.price_includes_vat OR NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice THEN
    RAISE EXCEPTION '%', v_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_block_when_receipted_trg BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION po_block_when_receipted();

CREATE OR REPLACE FUNCTION poi_block_when_receipted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_po UUID := CASE WHEN TG_OP = 'INSERT' THEN NEW.po_id ELSE OLD.po_id END;
        v_po2 UUID := CASE WHEN TG_OP = 'UPDATE' THEN NEW.po_id ELSE NULL END;
BEGIN
  -- parent PO lock first (FOR SHARE), so create_po_deposit / receive_po_lines (FOR UPDATE) are seen or wait for us
  PERFORM 1 FROM purchase_orders WHERE id IN (v_po, v_po2) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM po_receipts WHERE po_id IN (v_po, v_po2)) THEN RAISE EXCEPTION 'po_has_receipts'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id IN (v_po, v_po2)) THEN RAISE EXCEPTION 'po_has_deposit'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poi_block_when_receipted_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION poi_block_when_receipted();

-- No un-receive in v1: a receipt bill or a split part cannot be deleted from the app (admin SQL only).
CREATE OR REPLACE FUNCTION expenses_block_receipt_bill_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM po_receipts WHERE expense_id = OLD.id) THEN RAISE EXCEPTION 'expense_is_receipt_bill'; END IF;
  IF EXISTS (SELECT 1 FROM expense_splits WHERE new_expense_id = OLD.id OR source_expense_id = OLD.id) THEN RAISE EXCEPTION 'expense_is_split_part'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER expenses_block_receipt_bill_delete_trg BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_block_receipt_bill_delete();

REVOKE ALL ON FUNCTION sd_validate_po(), po_block_when_receipted(), poi_block_when_receipted(), expenses_block_receipt_bill_delete()
  FROM PUBLIC, anon, authenticated;
```

Note on A10/A3 order in the test: after a caught exception inside a nested `BEGIN ... EXCEPTION` block the subtransaction is rolled back, so later checks still see the fixtures.

- [ ] **Step 4: Static checks (no database writes)**

Run:
```bash
grep -c "SECURITY DEFINER SET search_path = public" supabase/migrations/2026-10-09-01-po-receipts.sql   # expect 4
grep -n "REFERENCES expenses" supabase/migrations/2026-10-09-01-po-receipts.sql                        # expect no output
```
Then hand the controller the dry-run command (the controller runs it, not you):
```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"
  cat $W/supabase/migrations/2026-10-09-01-po-receipts.sql
  grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/po_receipt_test_a.sql
  echo "ROLLBACK;" ) > /tmp/pra_dry.sql
cd /Users/plfx/code/FacadeXPM/facadex-app && npx supabase db query --linked -f /tmp/pra_dry.sql
```
Expected: ERROR text containing `RESULT: po_receipt_test_a ALL PASSED`. The task is not done until the controller reports that result; fix and repeat on any other error.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-09-01-po-receipts.sql supabase/tests/po_receipt_test_a.sql
git commit -m "feat(db): receipt tables, partially_received status, deposit-to-PO link and locks (not applied)"
```

---

### Task 4: Migration 2 — create_po_deposit, receive_po_lines, split_payment (+ SQL test part B)

**Files:**
- Create: `supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql`
- Test: `supabase/tests/po_receipt_test_b.sql`

**Interfaces:**
- Consumes: Task 3 schema; `record_stock_movement(uuid,uuid,text,numeric,numeric,text,uuid,text)` (live; no date parameter, inserts `created_at = now()`; gate `is_admin_or_owner() AND has_module_access('purchase_orders')`); `_sti_finite(numeric)` (2026-10-08-01); `stock_movement_block_when_tax_invoiced` trigger (takes PO FOR SHARE).
- Produces (exact SQL signatures; Task 6 wraps them):
  - `create_po_deposit(p_po_id uuid, p_mode text, p_value numeric, p_invoice_no text, p_date date, p_payment_method text, p_status text DEFAULT 'paid') RETURNS jsonb` -> `{deposit_id, expense_id, amount, amount_no_vat, vat, pct_of_po}`. Errors: `insufficient_privilege, po_not_found, po_not_ordered, po_no_supplier, po_has_deposit, deposit_invoice_no_required, deposit_invoice_no_taken, bad_deposit_date, bad_payment_method, bad_deposit_status, bad_deposit_value, deposit_exceeds_po`.
  - `receive_po_lines(p_po_id uuid, p_line_ids uuid[], p_received_date date, p_deduction jsonb, p_expected_subtotal numeric, p_expected_vat numeric, p_stock jsonb) RETURNS jsonb` -> `{receipt_id, seq, receipt_no, expense_id, status, subtotal, vat}`. `p_deduction` = `[{deposit_id, mode:'percent'|'value', value}]`; `p_stock` = `[{po_item_id, base_qty, unit_cost}]` (one entry per received line linked to stock; empty for `stock_from_invoice` POs). Errors: `insufficient_privilege, po_not_found, po_not_receivable, po_has_deposit_applications, bad_received_date, received_date_in_future, bad_lines, line_already_received, totals_mismatch, bad_deduction, deposit_not_found, deposit_wrong_supplier, deposit_expense_needs_vat_split, deposit_exceeds_remaining, deposit_exceeds_receipt, deposit_vat_exceeds_receipt, bad_stock_plan, stock_cost_mismatch` (+ `po_tax_invoiced` from the stock trigger).
  - `split_payment(p_expense_id uuid, p_amount numeric, p_paid_date date, p_method text) RETURNS jsonb` -> `{paid_expense_id, remaining_expense_id, paid_amount, remaining_amount}`. Errors: `insufficient_privilege, expense_not_found, not_a_po_bill, bill_is_credit_note, bill_is_deposit, bill_is_cheque, bill_not_pending, bad_paid_date, bad_payment_method, bad_split_amount, bill_bad_split`.
  - private helpers `_po_totals(uuid, uuid)`, `_po_receipt_value(uuid, uuid, uuid[])` (no client EXECUTE).

Rulings encoded (beyond the spec text): `p_stock` added because the base-quantity conversion (aluminium profile / glass / unit factors, `computePoItemBaseQty`) exists only in JS; the server validates it (one entry per stock line, finite, `base_qty > 0`, and `base_qty * unit_cost` = the line's ex-VAT value within max(0.01, 1e-6 relative)) and posts stock inside the same transaction (no more non-atomic client loop); the bill is dated `po.date` (R2; the shipped RPC dates it "today", see spec defect 1); received date may be any past date but not the future; receipt number = `<po_number>-R<seq>` in the stock movement notes and bill notes; `purchase_orders.expense_id` = first non-null bill; `received_date` = latest receipt date; `create_po_deposit` only on status `ordered`, methods `transfer|check|cash`, status `paid|pending`, date not in the future; the deposit expense is NOT given `po_id` (sd_validate forbids it; the link is `supplier_deposits.po_id`); `split_payment` only for PO bills (`po_id` not null) in status `pending` without cheque; the ORIGINAL row becomes the paid part (keeps its id, so `purchase_orders.expense_id`, `po_receipts.expense_id` and tax-invoice stamps stay valid) and a NEW row is the pending remainder; the paid date is kept in `expense_splits.paid_date` and in the notes (expenses has no paid-date column).

- [ ] **Step 1: Write the failing test** (`supabase/tests/po_receipt_test_b.sql`)

```sql
-- ================================================================
-- Tests for 2026-10-09-02-po-receipt-rpcs.sql. Part B of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-01; 2026-10-09-02; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: po_receipt_test_b ALL PASSED'. Anything else = failure.
-- Concurrency cannot be tested in one session; B4 is the sequential stand-in (the PO row lock serialises real double clicks).
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_prb_owner__@example.com'; w_email TEXT := '__test_prb_worker__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID; t2_exp UUID; t2_dep UUID;
  t3_tenant UUID; t3_site UUID; t3_sup UUID; t3_cat UUID; t3_po UUID; email3 TEXT := '__test_prb_owner3__@example.com';
  poA UUID; a1 UUID; a2 UUID; poT UUID; t1 UUID; poI UUID; i1 UUID; i2 UUID; poC UUID; c1 UUID; poF UUID; f1 UUID; poS UUID; s1 UUID; poL UUID; l1 UUID; poP UUID; p1 UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  j JSONB; r RECORD; v_msg TEXT; v_cnt INT; depA UUID; depT UUID; depC UUID; e_leg UUID; d_leg UUID; e_leg2 UUID; d_leg2 UUID;
  bill1 UUID; bill2 UUID; rem1 UUID; rem2 UUID;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (w_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PRB-1__', '__prb site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__prb sup__') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__prb sup2__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__prb cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__prb item__', 'kg') RETURNING id INTO t_item;
  -- tenant 2 (isolation)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PRB-2__', '__prb site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__prb t2 sup__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__prb t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t2_tenant, 'PO-PRB-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered') RETURNING id INTO t2_po;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t2_tenant, t2_po, 'x', 1, 100, 100);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (t2_tenant, current_date, 't2 dep', t2_site, t2_cat, t2_sup, 100, 7, 107, 'transfer', 'paid') RETURNING id INTO t2_exp;
  INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no) VALUES (t2_tenant, t2_exp, 'PRB-T2') RETURNING id INTO t2_dep;
  -- tenant 3: read-only (plan expired) but module kept
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb3__', t_owner, 'expired', now() - interval '1 day') RETURNING id INTO t3_tenant;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (t3_tenant, 'purchase_orders');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email3, 'OWNER', 'approved', t3_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t3_tenant, '__PRB-3__', '__prb site3__') RETURNING id INTO t3_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t3_tenant, '__prb t3 sup__') RETURNING id INTO t3_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t3_tenant, '__prb t3 cat__') RETURNING id INTO t3_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t3_tenant, 'PO-PRB-T3', t3_site, t3_sup, t3_cat, current_date, 'ordered') RETURNING id INTO t3_po;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- poA: 60,000 (stock) + 40,000 (no stock), VAT excl. -> 107,000
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-A', t_site, t_sup, t_cat, v_bkk - 30, 'ordered') RETURNING id INTO poA;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poA, 'A1', 1, 60000, 60000, t_item, 0) RETURNING id INTO a1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poA, 'A2', 1, 40000, 40000, 1) RETURNING id INTO a2;
  -- poT: ไทย-เยอรมัน replica 206,730 + 14,471.10
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-T', t_site, t_sup, t_cat, v_bkk - 20, 'ordered') RETURNING id INTO poT;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poT, 'glass', 1, 206730, 206730) RETURNING id INTO t1;
  -- poI: VAT-inclusive 100 + 200
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, price_includes_vat) VALUES (t_tenant, 'PO-PRB-I', t_site, t_sup, t_cat, v_bkk, 'ordered', true) RETURNING id INTO poI;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poI, 'I1', 1, 100, 100, 0) RETURNING id INTO i1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poI, 'I2', 1, 200, 200, 1) RETURNING id INTO i2;
  -- poC: for deduction errors (1,000 excl.)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-C', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poC;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poC, 'C1', 1, 1000, 1000) RETURNING id INTO c1;
  -- poF: stock_from_invoice, stock line
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, stock_from_invoice) VALUES (t_tenant, 'PO-PRB-F', t_site, t_sup, t_cat, v_bkk, 'ordered', true) RETURNING id INTO poF;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, poF, 'F1', 2, 50, 100, t_item) RETURNING id INTO f1;
  -- poS: stock line for plan errors
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-S', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poS;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, poS, 'S1', 4, 25, 100, t_item) RETURNING id INTO s1;
  -- poL: legacy application (receipt_id NULL) on an ordered PO
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-L', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poL;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poL, 'L1', 1, 100, 100) RETURNING id INTO l1;
  -- poP: plain PO for the legacy RPC regression
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 100, 100) RETURNING id INTO p1;

  -- B1: create_po_deposit 30 % of poA
  j := create_po_deposit(poA, 'percent', 30, 'PRB-DEP-A', v_bkk - 25, 'transfer', 'paid');
  depA := (j->>'deposit_id')::uuid;
  IF (j->>'amount')::numeric <> 32100 OR (j->>'amount_no_vat')::numeric <> 30000 OR (j->>'vat')::numeric <> 2100 OR (j->>'pct_of_po')::numeric <> 30 THEN RAISE EXCEPTION 'B1 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = (j->>'expense_id')::uuid;
  IF r.po_id IS NOT NULL OR r.amount <> 32100 OR r.invoice_no <> 'PRB-DEP-A' OR r.status <> 'paid' OR r.date <> v_bkk - 25 OR r.supplier_id <> t_sup THEN RAISE EXCEPTION 'B1 FAIL: expense %', row_to_json(r); END IF;
  SELECT po_id, pct_of_po INTO r FROM supplier_deposits WHERE id = depA;
  IF r.po_id <> poA OR r.pct_of_po <> 30 THEN RAISE EXCEPTION 'B1 FAIL: deposit row'; END IF;

  -- B2: create_po_deposit errors
  BEGIN PERFORM create_po_deposit(poA, 'percent', 10, 'PRB-DEP-A2', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: second deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'amount', 10, 'PRB-DEP-A', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: duplicate number';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_invoice_no_taken%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'amount', 1070.01, 'PRB-X1', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: over PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_exceeds_po%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 101, 'PRB-X1', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: 101 pct';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deposit_value%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, '  ', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: blank number';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_invoice_no_required%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-X1', v_bkk + 1, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: future date';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deposit_date%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-X1', v_bkk, 'credit', 'paid'); RAISE EXCEPTION 'B2 FAIL: method';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_payment_method%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;

  -- B3: receive line A1 only, two days ago, own deposit 19,260 by value
  j := receive_po_lines(poA, ARRAY[a1], v_bkk - 2, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'mode', 'value', 'value', 19260)),
                        60000, 4200, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 1, 'unit_cost', 60000)));
  bill1 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'partially_received' OR (j->>'seq')::int <> 1 OR j->>'receipt_no' <> 'PO-PRB-A-R1' OR bill1 IS NULL THEN RAISE EXCEPTION 'B3 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = bill1;
  IF r.amount_no_vat <> 42000 OR r.vat <> 2940 OR r.amount <> 44940 OR r.po_id <> poA OR r.date <> v_bkk - 30 OR r.status <> 'pending' THEN RAISE EXCEPTION 'B3 FAIL: bill %', row_to_json(r); END IF;
  SELECT amount_no_vat, vat, receipt_id INTO r FROM po_deposit_applications WHERE deposit_id = depA;
  IF r.amount_no_vat <> 18000 OR r.vat <> 1260 OR r.receipt_id <> (j->>'receipt_id')::uuid THEN RAISE EXCEPTION 'B3 FAIL: application'; END IF;
  SELECT status, received_date, expense_id INTO r FROM purchase_orders WHERE id = poA;
  IF r.status <> 'partially_received' OR r.received_date <> v_bkk - 2 OR r.expense_id <> bill1 THEN RAISE EXCEPTION 'B3 FAIL: PO %', row_to_json(r); END IF;
  SELECT m.* INTO r FROM stock_movements m JOIN po_receipt_items pri ON pri.stock_movement_id = m.id WHERE pri.po_item_id = a1;
  IF r.quantity <> 1 OR r.unit_cost <> 60000 OR r.reference_type <> 'purchase_order' OR r.reference_id <> poA OR r.movement_type <> 'purchase_in'
     OR r.created_at <> ((v_bkk - 2) + time '12:00') AT TIME ZONE 'Asia/Bangkok' OR r.notes <> 'PO-PRB-A-R1' THEN RAISE EXCEPTION 'B3 FAIL: movement %', row_to_json(r); END IF;
  SELECT goods_subtotal, goods_vat INTO r FROM po_receipts WHERE id = (j->>'receipt_id')::uuid;
  IF r.goods_subtotal <> 60000 OR r.goods_vat <> 4200 THEN RAISE EXCEPTION 'B3 FAIL: receipt value'; END IF;

  -- B4: the same line again (double click) and a stale total
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a1], v_bkk, '[]'::jsonb, 60000, 4200, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 1, 'unit_cost', 60000))); RAISE EXCEPTION 'B4 FAIL: line received twice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'line_already_received%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2], v_bkk, '[]'::jsonb, 40000.50, 2800, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: totals';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'totals_mismatch%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2, a2], v_bkk, '[]'::jsonb, 40000, 2800, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: duplicate ids';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[t1], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: line of another PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;

  -- B5: final receipt A2, whole remaining deposit 12,840 -> deposit used up exactly
  j := receive_po_lines(poA, ARRAY[a2], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'mode', 'value', 'value', 12840)), 40000, 2800, '[]'::jsonb);
  bill2 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'received' OR (j->>'seq')::int <> 2 THEN RAISE EXCEPTION 'B5 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = bill2;
  IF r.amount_no_vat <> 28000 OR r.vat <> 1960 OR r.amount <> 29960 THEN RAISE EXCEPTION 'B5 FAIL: bill %', row_to_json(r); END IF;
  SELECT sum(amount_no_vat) AS n, sum(vat) AS v INTO r FROM po_deposit_applications WHERE deposit_id = depA;
  IF r.n <> 30000 OR r.v <> 2100 THEN RAISE EXCEPTION 'B5 FAIL: deposit not used up exactly (% / %)', r.n, r.v; END IF;
  SELECT status, received_date, expense_id INTO r FROM purchase_orders WHERE id = poA;
  IF r.status <> 'received' OR r.received_date <> v_bkk OR r.expense_id <> bill1 THEN RAISE EXCEPTION 'B5 FAIL: PO %', row_to_json(r); END IF;
  SELECT sum(goods_subtotal) AS s, sum(goods_vat) AS v INTO r FROM po_receipts WHERE po_id = poA;
  IF r.s <> 100000 OR r.v <> 7000 THEN RAISE EXCEPTION 'B5 FAIL: receipts do not add up'; END IF;

  -- B6: a received PO cannot be received again
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B6 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_receivable%' THEN RAISE EXCEPTION 'B6 FAIL: %', v_msg; END IF; END;

  -- B7: ไทย-เยอรมัน: 50 % deposit, receive all, deduct it all
  j := create_po_deposit(poT, 'percent', 50, 'PRB-2602543', v_bkk - 15, 'transfer', 'paid');
  depT := (j->>'deposit_id')::uuid;
  IF (j->>'amount')::numeric <> 110600.55 OR (j->>'amount_no_vat')::numeric <> 103365 OR (j->>'vat')::numeric <> 7235.55 THEN RAISE EXCEPTION 'B7 FAIL: deposit %', j; END IF;
  j := receive_po_lines(poT, ARRAY[t1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', depT, 'mode', 'value', 'value', 110600.55)), 206730, 14471.10, '[]'::jsonb);
  SELECT * INTO r FROM expenses WHERE id = (j->>'expense_id')::uuid;
  IF r.amount_no_vat <> 103365 OR r.vat <> 7235.55 OR r.amount <> 110600.55 OR j->>'status' <> 'received' THEN RAISE EXCEPTION 'B7 FAIL: bill %', row_to_json(r); END IF;

  -- B8: VAT-inclusive PO in two receipts adds up exactly
  j := receive_po_lines(poI, ARRAY[i1], v_bkk, '[]'::jsonb, 93.46, 6.54, '[]'::jsonb);
  j := receive_po_lines(poI, ARRAY[i2], v_bkk, '[]'::jsonb, 186.91, 13.09, '[]'::jsonb);
  SELECT sum(goods_subtotal) AS s, sum(goods_vat) AS v INTO r FROM po_receipts WHERE po_id = poI;
  IF r.s <> 280.37 OR r.v <> 19.63 THEN RAISE EXCEPTION 'B8 FAIL: % / %', r.s, r.v; END IF;

  -- B9: deduction errors (poC 1,070 incl. VAT), legacy deposit usable
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'legacy dep', t_site, t_cat, t_sup, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO e_leg;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg, 'PRB-LEG') RETURNING id INTO d_leg;
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'other sup dep', t_site, t_cat, t_sup2, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO e_leg2;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg2, 'PRB-LEG2') RETURNING id INTO d_leg2;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'value', 'value', 535.01)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: over remaining';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_exceeds_remaining%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'percent', 'value', 101)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: 101 pct';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deduction%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg2, 'mode', 'value', 'value', 10)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: wrong supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', t2_dep, 'mode', 'value', 'value', 10)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: other tenant deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_not_found%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'value', 'value', 0)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: zero';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deduction%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  -- B9b: legacy deposit (pct_of_po NULL) by percent of the receipt: 50 % of 1,070 = 535 = the whole deposit
  j := receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'percent', 'value', 50)), 1000, 70, '[]'::jsonb);
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE deposit_id = d_leg;
  IF r.amount_no_vat <> 500 OR r.vat <> 35 THEN RAISE EXCEPTION 'B9b FAIL: % / %', r.amount_no_vat, r.vat; END IF;

  -- B10: stock plan
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B10 FAIL: missing plan';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 4, 'unit_cost', 30))); RAISE EXCEPTION 'B10 FAIL: cost';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'stock_cost_mismatch%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 0, 'unit_cost', 25))); RAISE EXCEPTION 'B10 FAIL: zero qty';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', f1, 'base_qty', 2, 'unit_cost', 50))); RAISE EXCEPTION 'B10 FAIL: plan on stock_from_invoice PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  j := receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb);
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = poF;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'B10 FAIL: stock posted for a stock_from_invoice PO'; END IF;

  -- B11: received date
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk + 1, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 4, 'unit_cost', 25))); RAISE EXCEPTION 'B11 FAIL: future';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'received_date_in_future%' THEN RAISE EXCEPTION 'B11 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], NULL, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B11 FAIL: null';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_received_date%' THEN RAISE EXCEPTION 'B11 FAIL: %', v_msg; END IF; END;

  -- B16: legacy application on an ordered PO blocks the new receive
  RESET role;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat) VALUES (t_tenant, depT, poL, 0.01, 0);
  SET LOCAL role = 'authenticated';
  BEGIN PERFORM receive_po_lines(poL, ARRAY[l1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B16 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit_applications%' THEN RAISE EXCEPTION 'B16 FAIL: %', v_msg; END IF; END;

  -- B15: the legacy RPC still receives a plain ordered PO
  PERFORM receive_po_with_deposits(poP, '[]'::jsonb, 100, 7);
  IF (SELECT status FROM purchase_orders WHERE id = poP) <> 'received' THEN RAISE EXCEPTION 'B15 FAIL'; END IF;

  -- B13: split_payment on bill1 (pending 44,940)
  j := split_payment(bill1, 20000, v_bkk, 'transfer');
  rem1 := (j->>'remaining_expense_id')::uuid;
  SELECT * INTO r FROM expenses WHERE id = bill1;
  IF r.amount <> 20000 OR r.amount_no_vat <> 18691.59 OR r.vat <> 1308.41 OR r.status <> 'paid' OR r.payment_method <> 'transfer' THEN RAISE EXCEPTION 'B13 FAIL: paid part %', row_to_json(r); END IF;
  SELECT * INTO r FROM expenses WHERE id = rem1;
  IF r.amount <> 24940 OR r.amount_no_vat <> 23308.41 OR r.vat <> 1631.59 OR r.status <> 'pending' OR r.po_id <> poA OR r.date <> v_bkk - 30 THEN RAISE EXCEPTION 'B13 FAIL: remainder %', row_to_json(r); END IF;
  SELECT count(*) INTO v_cnt FROM expense_splits WHERE source_expense_id = bill1 AND new_expense_id = rem1 AND paid_amount = 20000 AND paid_date = v_bkk;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'B13 FAIL: split row'; END IF;
  j := split_payment(rem1, 4940, v_bkk, 'cash');
  rem2 := (j->>'remaining_expense_id')::uuid;
  IF (SELECT amount FROM expenses WHERE id = rem2) <> 20000 THEN RAISE EXCEPTION 'B13 FAIL: second split'; END IF;
  BEGIN PERFORM split_payment(bill1, 1, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: paid bill split';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bill_not_pending%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 20000, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: whole bill';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_split_amount%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk + 1, 'cash'); RAISE EXCEPTION 'B13 FAIL: future';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_paid_date%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk, 'credit'); RAISE EXCEPTION 'B13 FAIL: method';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_payment_method%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(e_leg, 10, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: deposit expense';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'not_a_po_bill%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM expenses WHERE id = rem2; RAISE EXCEPTION 'B13 FAIL: split part deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_split_part%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;

  -- B12: role / tenant / read-only
  BEGIN PERFORM receive_po_lines(t2_po, '{}'::uuid[], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B12 FAIL: other tenant PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_found%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || w_email || '"}', true);
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-W', v_bkk, 'cash', 'paid'); RAISE EXCEPTION 'B12 FAIL: worker deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B12 FAIL: worker receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk, 'cash'); RAISE EXCEPTION 'B12 FAIL: worker split';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || email3 || '"}', true);
  BEGIN PERFORM create_po_deposit(t3_po, 'percent', 10, 'PRB-RO', v_bkk, 'cash', 'paid'); RAISE EXCEPTION 'B12 FAIL: read-only tenant';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- B14: ACL
  RESET role;
  IF has_function_privilege('anon', 'create_po_deposit(uuid,text,numeric,text,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'split_payment(uuid,numeric,date,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'create_po_deposit(uuid,text,numeric,text,date,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'split_payment(uuid,numeric,date,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_po_totals(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_po_receipt_value(uuid,uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'B14 FAIL: function grants';
  END IF;

  RAISE EXCEPTION 'RESULT: po_receipt_test_b ALL PASSED';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Verify the functions do not exist yet (read-only)**

```sql
SELECT to_regprocedure('receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)') AS f1, to_regprocedure('split_payment(uuid,numeric,date,text)') AS f2;
```
Expected: both NULL.

- [ ] **Step 3: Write the migration** (`supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql`)

```sql
-- ============================================================
-- PO deposits / partial receipts / split payments: RPCs. Requires 2026-10-09-01.
-- Definer rights: the receipt tables and po_deposit_applications are not client-writable. Each public RPC re-checks
-- role, module, tenant_can_write() and takes the tenant from current_tenant_id(). Each call is one transaction.
-- Maths mirrored by src/lib/poReceiptMath.js and src/lib/poPaymentMath.js; this file is the authority.
-- Lock order: PO row (FOR UPDATE) -> deposits by id (FOR UPDATE OF deposit, expense) -> stock balances by item
-- (inside record_stock_movement), same direction as post/void_supplier_tax_invoice.
-- ============================================================

-- = calcPoTotals() in src/lib/poTotals.js (subtotal unrounded for VAT-exclusive, as the client).
CREATE OR REPLACE FUNCTION _po_totals(p_po_id UUID, p_tenant UUID, OUT subtotal NUMERIC, OUT vat NUMERIC, OUT total NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = p_tenant;
  IF NOT v_has THEN subtotal := v_raw; vat := 0;
  ELSIF v_incl THEN subtotal := round(round(v_raw, 2) / 1.07, 2); vat := round(round(v_raw, 2) - subtotal, 2);
  ELSE subtotal := v_raw; vat := round(v_raw * 0.07, 2);
  END IF;
  total := round(subtotal + vat, 2);
END $$;

-- = receiptValue() in src/lib/poReceiptMath.js. Final receipt (nothing outstanding after it) = PO minus earlier receipts.
CREATE OR REPLACE FUNCTION _po_receipt_value(p_po_id UUID, p_tenant UUID, p_line_ids UUID[],
  OUT subtotal NUMERIC, OUT vat NUMERIC, OUT is_final BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC; v_left INT; v_psub NUMERIC; v_pvat NUMERIC; t RECORD;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO v_left FROM purchase_order_items i
   WHERE i.po_id = p_po_id AND i.tenant_id = p_tenant AND NOT (i.id = ANY (COALESCE(p_line_ids, '{}'::uuid[])))
     AND NOT EXISTS (SELECT 1 FROM po_receipt_items r WHERE r.po_item_id = i.id);
  is_final := v_left = 0 AND cardinality(COALESCE(p_line_ids, '{}'::uuid[])) > 0;
  IF is_final THEN
    SELECT * INTO t FROM _po_totals(p_po_id, p_tenant);
    SELECT COALESCE(SUM(goods_subtotal), 0), COALESCE(SUM(goods_vat), 0) INTO v_psub, v_pvat
      FROM po_receipts WHERE po_id = p_po_id AND tenant_id = p_tenant;
    subtotal := round(round(t.subtotal, 2) - v_psub, 2);
    vat := round(t.vat - v_pvat, 2);
  ELSE
    SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items
     WHERE po_id = p_po_id AND tenant_id = p_tenant AND id = ANY (COALESCE(p_line_ids, '{}'::uuid[]));
    IF NOT v_has THEN subtotal := round(v_raw, 2); vat := 0;
    ELSIF v_incl THEN subtotal := round(round(v_raw, 2) / 1.07, 2); vat := round(round(v_raw, 2) - subtotal, 2);
    ELSE subtotal := round(v_raw, 2); vat := round(v_raw * 0.07, 2);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_po_deposit(p_po_id UUID, p_mode TEXT, p_value NUMERIC, p_invoice_no TEXT, p_date DATE,
  p_payment_method TEXT, p_status TEXT DEFAULT 'paid')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  po purchase_orders%ROWTYPE; t RECORD; v_sup_name TEXT;
  v_no TEXT := btrim(COALESCE(p_invoice_no, ''));
  v_gross NUMERIC; v_net NUMERIC; v_vat NUMERIC; v_pct NUMERIC; v_exp UUID; v_dep UUID; v_con TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status <> 'ordered' THEN RAISE EXCEPTION 'po_not_ordered'; END IF;
  IF po.supplier_id IS NULL THEN RAISE EXCEPTION 'po_no_supplier'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = po.id) THEN RAISE EXCEPTION 'po_has_deposit'; END IF;
  IF v_no = '' THEN RAISE EXCEPTION 'deposit_invoice_no_required'; END IF;
  IF p_date IS NULL OR p_date > v_today THEN RAISE EXCEPTION 'bad_deposit_date'; END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('transfer', 'check', 'cash') THEN RAISE EXCEPTION 'bad_payment_method'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('paid', 'pending') THEN RAISE EXCEPTION 'bad_deposit_status'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('percent', 'amount') OR NOT _sti_finite(p_value) OR p_value <= 0
     OR (p_mode = 'percent' AND p_value > 100) THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  SELECT * INTO t FROM _po_totals(po.id, v_tenant);
  IF t.total IS NULL OR t.total <= 0 THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  v_gross := CASE WHEN p_mode = 'percent' THEN round(p_value / 100 * t.total, 2) ELSE round(p_value, 2) END;
  IF v_gross <= 0 THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  IF v_gross > t.total + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_po'; END IF;
  v_net := CASE WHEN po.has_vat THEN round(v_gross / 1.07, 2) ELSE v_gross END;
  v_vat := round(v_gross - v_net, 2);
  v_pct := GREATEST(round(v_gross / t.total * 100, 4), 0.0001);
  SELECT name INTO v_sup_name FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
  -- the deposit expense is NOT linked by expenses.po_id (sd_validate forbids it); supplier_deposits.po_id links it
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                        payment_method, status, invoice_no, notes)
  VALUES (v_tenant, p_date, 'มัดจำใบสั่งซื้อ ' || po.po_number, po.site_id, po.category_id, po.supplier_id, v_sup_name,
          v_net, v_vat, v_gross, p_payment_method, p_status, v_no,
          'มัดจำ ' || rtrim(rtrim(v_pct::text, '0'), '.') || '% ของใบสั่งซื้อ ' || po.po_number)
  RETURNING id INTO v_exp;
  BEGIN
    INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id, pct_of_po, created_by)
    VALUES (v_tenant, v_exp, v_no, po.id, v_pct, auth.email()) RETURNING id INTO v_dep;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    RAISE EXCEPTION '%', CASE WHEN v_con = 'supplier_deposits_po_uq' THEN 'po_has_deposit' ELSE 'deposit_invoice_no_taken' END;
  END;
  RETURN jsonb_build_object('deposit_id', v_dep, 'expense_id', v_exp, 'amount', v_gross, 'amount_no_vat', v_net, 'vat', v_vat, 'pct_of_po', v_pct);
END $$;

CREATE OR REPLACE FUNCTION receive_po_lines(p_po_id UUID, p_line_ids UUID[], p_received_date DATE, p_deduction JSONB,
  p_expected_subtotal NUMERIC, p_expected_vat NUMERIC, p_stock JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  po purchase_orders%ROWTYPE; rv RECORD; d RECORD; li RECORD; sup RECORD;
  v_ids UUID[]; v_n INT; v_seq INT; v_no TEXT; v_rcpt UUID; v_exp UUID := NULL; v_status TEXT; v_at TIMESTAMPTZ; v_mid UUID;
  v_rgross NUMERIC; a JSONB; v_dep UUID; v_mode TEXT; v_val NUMERIC; v_gross NUMERIC; v_rem_gross NUMERIC;
  v_used_net NUMERIC; v_used_vat NUMERIC; v_rem_net NUMERIC; v_rem_vat NUMERIC; v_amt NUMERIC; v_dvat NUMERIC;
  v_sum_net NUMERIC := 0; v_sum_vat NUMERIC := 0; v_net NUMERIC; v_vat_pay NUMERIC;
  v_apps JSONB := '[]'::jsonb; v_seen UUID[] := '{}';
  s JSONB; v_stock JSONB := '{}'::jsonb; v_item UUID; v_bq NUMERIC; v_uc NUMERIC; v_line_net NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status NOT IN ('ordered', 'partially_received') THEN RAISE EXCEPTION 'po_not_receivable'; END IF;
  -- applications without a receipt = the PO was received the old way and later un-received by hand: never receive it again here
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = po.id AND receipt_id IS NULL) THEN RAISE EXCEPTION 'po_has_deposit_applications'; END IF;
  IF p_received_date IS NULL THEN RAISE EXCEPTION 'bad_received_date'; END IF;
  IF p_received_date > v_today THEN RAISE EXCEPTION 'received_date_in_future'; END IF;

  SELECT array_agg(DISTINCT u ORDER BY u) INTO v_ids FROM unnest(COALESCE(p_line_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(COALESCE(p_line_ids, '{}'::uuid[])) THEN RAISE EXCEPTION 'bad_lines'; END IF;
  SELECT count(*) INTO v_n FROM purchase_order_items WHERE po_id = po.id AND tenant_id = v_tenant AND id = ANY (v_ids);
  IF v_n <> cardinality(v_ids) THEN RAISE EXCEPTION 'bad_lines'; END IF;
  IF EXISTS (SELECT 1 FROM po_receipt_items WHERE po_item_id = ANY (v_ids)) THEN RAISE EXCEPTION 'line_already_received'; END IF;

  SELECT * INTO rv FROM _po_receipt_value(po.id, v_tenant, v_ids);
  IF abs(rv.subtotal - COALESCE(p_expected_subtotal, -1)) > 0.01 OR abs(rv.vat - COALESCE(p_expected_vat, -1)) > 0.01 THEN
    RAISE EXCEPTION 'totals_mismatch';
  END IF;
  v_rgross := round(rv.subtotal + rv.vat, 2);

  -- deductions: VAT-inclusive input -> net by the deposit's own ratio -> VAT by the R5 rule (= deductionFromInput)
  IF jsonb_typeof(COALESCE(p_deduction, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_deduction'; END IF;
  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_deduction, '[]'::jsonb)) ORDER BY value->>'deposit_id' COLLATE "C" LOOP
    BEGIN
      v_dep := (a->>'deposit_id')::uuid; v_mode := a->>'mode'; v_val := (a->>'value')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_deduction';
    END;
    IF v_dep IS NULL OR v_mode IS NULL OR v_mode NOT IN ('percent', 'value') OR NOT _sti_finite(v_val) OR v_val <= 0
       OR (v_mode = 'percent' AND v_val > 100) OR v_dep = ANY (v_seen) THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    v_seen := v_seen || v_dep;
    v_gross := CASE WHEN v_mode = 'percent' THEN round(v_val / 100 * v_rgross, 2) ELSE round(v_val, 2) END;
    IF v_gross <= 0 THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    SELECT sd.id, e.tenant_id AS e_tenant, e.supplier_id, e.amount, e.amount_no_vat, e.vat INTO d
      FROM supplier_deposits sd JOIN expenses e ON e.id = sd.expense_id
     WHERE sd.id = v_dep AND sd.tenant_id = v_tenant FOR UPDATE OF sd, e;
    IF NOT FOUND OR d.e_tenant IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.supplier_id IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
    IF d.amount_no_vat IS NULL OR d.vat IS NULL OR d.amount_no_vat <= 0 OR round(d.amount_no_vat + d.vat - d.amount, 2) <> 0 THEN
      RAISE EXCEPTION 'deposit_expense_needs_vat_split';
    END IF;
    SELECT COALESCE(SUM(amount_no_vat), 0), COALESCE(SUM(vat), 0) INTO v_used_net, v_used_vat FROM po_deposit_applications WHERE deposit_id = d.id;
    v_rem_net := round(d.amount_no_vat - v_used_net, 2); v_rem_vat := round(d.vat - v_used_vat, 2);
    v_rem_gross := round(v_rem_net + v_rem_vat, 2);
    IF v_gross > v_rem_gross + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_remaining'; END IF;
    IF abs(v_gross - v_rem_gross) < 0.005 THEN
      v_amt := v_rem_net; v_dvat := v_rem_vat;
    ELSE
      v_amt := LEAST(round(v_gross * d.amount_no_vat / (d.amount_no_vat + d.vat), 2), v_rem_net);
      IF abs(v_amt - v_rem_net) < 0.005 THEN v_dvat := v_rem_vat;
      ELSE v_dvat := LEAST(round(v_amt * d.vat / d.amount_no_vat, 2), v_rem_vat); END IF;
    END IF;
    IF v_amt <= 0 OR v_dvat < 0 THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    v_sum_net := v_sum_net + v_amt; v_sum_vat := v_sum_vat + v_dvat;
    v_apps := v_apps || jsonb_build_object('deposit_id', d.id, 'net', v_amt, 'vat', v_dvat);
  END LOOP;

  IF v_sum_net > rv.subtotal + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_receipt'; END IF;
  v_net := round(rv.subtotal - v_sum_net, 2); v_vat_pay := round(rv.vat - v_sum_vat, 2);
  -- same fold as receive_po_with_deposits: deductions cover the whole net -> a VAT gap of up to 0.01 per application is rounding
  IF jsonb_array_length(v_apps) > 0 AND abs(v_net) <= 0.005 AND abs(v_vat_pay) > 0.005
     AND abs(v_vat_pay) <= 0.01 * jsonb_array_length(v_apps) + 0.0001
     AND round((v_apps->(jsonb_array_length(v_apps) - 1)->>'vat')::numeric + v_vat_pay, 2) >= 0 THEN
    v_apps := jsonb_set(v_apps, ARRAY[(jsonb_array_length(v_apps) - 1)::text, 'vat'],
      to_jsonb(round((v_apps->(jsonb_array_length(v_apps) - 1)->>'vat')::numeric + v_vat_pay, 2)));
    v_sum_vat := v_sum_vat + v_vat_pay; v_vat_pay := 0;
  END IF;
  IF v_vat_pay < -0.005 THEN RAISE EXCEPTION 'deposit_vat_exceeds_receipt'; END IF;
  v_net := GREATEST(v_net, 0); v_vat_pay := GREATEST(v_vat_pay, 0);

  -- stock plan: the base-quantity conversion lives in the client (computePoItemBaseQty); validate it here
  IF jsonb_typeof(COALESCE(p_stock, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(COALESCE(p_stock, '[]'::jsonb)) LOOP
    BEGIN
      v_item := (s->>'po_item_id')::uuid; v_bq := (s->>'base_qty')::numeric; v_uc := (s->>'unit_cost')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_stock_plan';
    END;
    IF v_item IS NULL OR NOT (v_item = ANY (v_ids)) OR v_stock ? v_item::text
       OR NOT _sti_finite(v_bq) OR NOT _sti_finite(v_uc) OR v_bq <= 0 OR v_uc < 0 THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
    v_stock := v_stock || jsonb_build_object(v_item::text, jsonb_build_object('base_qty', v_bq, 'unit_cost', v_uc));
  END LOOP;
  FOR li IN SELECT id, inventory_item_id, line_total FROM purchase_order_items WHERE id = ANY (v_ids) AND tenant_id = v_tenant LOOP
    IF po.stock_from_invoice OR li.inventory_item_id IS NULL THEN
      IF v_stock ? li.id::text THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
    ELSE
      IF NOT (v_stock ? li.id::text) THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
      v_line_net := CASE WHEN po.has_vat AND po.price_includes_vat THEN li.line_total / 1.07 ELSE li.line_total END;
      IF abs((v_stock->li.id::text->>'base_qty')::numeric * (v_stock->li.id::text->>'unit_cost')::numeric - v_line_net)
         > GREATEST(0.01, abs(v_line_net) * 0.000001) THEN RAISE EXCEPTION 'stock_cost_mismatch'; END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM po_receipts WHERE po_id = po.id;
  v_no := po.po_number || '-R' || v_seq;
  v_status := CASE WHEN rv.is_final THEN 'received' ELSE 'partially_received' END;
  v_at := (p_received_date + time '12:00') AT TIME ZONE 'Asia/Bangkok';

  IF v_net > 0.005 OR v_vat_pay > 0.005 THEN
    SELECT credit_days, name INTO sup FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
    INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                          payment_method, status, notes, po_id)
    VALUES (v_tenant, po.date,                                   -- R2: the bill keeps the PO date; the received date dates the stock
            'จากใบสั่งซื้อ ' || po.po_number || CASE WHEN v_seq > 1 OR NOT rv.is_final THEN ' (รับครั้งที่ ' || v_seq || ')' ELSE '' END,
            po.site_id, po.category_id, po.supplier_id, sup.name, v_net, v_vat_pay, round(v_net + v_vat_pay, 2),
            CASE WHEN sup.credit_days IS NOT NULL THEN 'check' ELSE 'transfer' END,
            CASE WHEN sup.credit_days IS NOT NULL THEN 'awaiting_billing' ELSE 'pending' END,
            'จาก ใบสั่งซื้อ ' || po.po_number || ' รับของ ' || to_char(p_received_date, 'DD/MM/YYYY') || ' (' || v_no || ')'
              || CASE WHEN v_sum_net > 0 THEN ' (หักมัดจำ)' ELSE '' END,
            po.id)
    RETURNING id INTO v_exp;
  END IF;

  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, received_by, goods_subtotal, goods_vat, expense_id)
  VALUES (v_tenant, po.id, v_seq, p_received_date, auth.email(), rv.subtotal, rv.vat, v_exp)
  RETURNING id INTO v_rcpt;

  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by, receipt_id)
  SELECT v_tenant, (x->>'deposit_id')::uuid, po.id, (x->>'net')::numeric, (x->>'vat')::numeric, auth.email(), v_rcpt
    FROM jsonb_array_elements(v_apps) x;

  -- lines + stock, in item order (balance locks taken in a fixed order)
  FOR li IN SELECT id, quantity, line_total, inventory_item_id FROM purchase_order_items
             WHERE id = ANY (v_ids) AND tenant_id = v_tenant ORDER BY inventory_item_id NULLS LAST, id LOOP
    v_bq := NULL; v_uc := NULL; v_mid := NULL;
    IF v_stock ? li.id::text THEN
      v_bq := (v_stock->li.id::text->>'base_qty')::numeric; v_uc := (v_stock->li.id::text->>'unit_cost')::numeric;
      SELECT movement_id INTO v_mid FROM record_stock_movement(li.inventory_item_id, po.site_id, 'purchase_in', v_bq, v_uc,
                                                               'purchase_order', po.id, v_no);
      UPDATE stock_movements SET created_at = v_at WHERE id = v_mid AND tenant_id = v_tenant;
    END IF;
    INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total, base_qty, unit_cost, stock_movement_id)
    VALUES (v_tenant, v_rcpt, li.id, li.quantity, li.line_total, v_bq, v_uc, v_mid);
  END LOOP;

  PERFORM set_config('app.po_receipt_rpc', 'on', true);
  UPDATE purchase_orders
     SET status = v_status,
         received_date = GREATEST(COALESCE(received_date, p_received_date), p_received_date),
         expense_id = COALESCE(expense_id, v_exp)
   WHERE id = po.id;
  PERFORM set_config('app.po_receipt_rpc', 'off', true);

  RETURN jsonb_build_object('receipt_id', v_rcpt, 'seq', v_seq, 'receipt_no', v_no, 'expense_id', v_exp, 'status', v_status,
                            'subtotal', rv.subtotal, 'vat', rv.vat);
END $$;

CREATE OR REPLACE FUNCTION split_payment(p_expense_id UUID, p_amount NUMERIC, p_paid_date DATE, p_method TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  e expenses%ROWTYPE; v_paid NUMERIC; v_pvat NUMERIC; v_pnet NUMERIC; v_new UUID; v_split BOOLEAN;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO e FROM expenses WHERE id = p_expense_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found'; END IF;
  IF e.po_id IS NULL THEN RAISE EXCEPTION 'not_a_po_bill'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_credit_notes WHERE expense_id = e.id) THEN RAISE EXCEPTION 'bill_is_credit_note'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE expense_id = e.id) THEN RAISE EXCEPTION 'bill_is_deposit'; END IF;
  IF e.cheque_id IS NOT NULL THEN RAISE EXCEPTION 'bill_is_cheque'; END IF;
  IF e.status <> 'pending' THEN RAISE EXCEPTION 'bill_not_pending'; END IF;
  IF p_paid_date IS NULL OR p_paid_date > v_today THEN RAISE EXCEPTION 'bad_paid_date'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'check', 'cash') THEN RAISE EXCEPTION 'bad_payment_method'; END IF;
  IF NOT _sti_finite(p_amount) OR e.amount IS NULL OR e.amount <= 0 THEN RAISE EXCEPTION 'bad_split_amount'; END IF;
  v_paid := round(p_amount, 2);
  IF v_paid <= 0 OR v_paid >= round(e.amount, 2) - 0.005 THEN RAISE EXCEPTION 'bad_split_amount'; END IF;
  v_split := e.amount_no_vat IS NOT NULL AND e.vat IS NOT NULL;
  IF v_split AND round(e.amount_no_vat + e.vat - e.amount, 2) <> 0 THEN RAISE EXCEPTION 'bill_bad_split'; END IF;
  IF v_split THEN v_pvat := round(v_paid * e.vat / e.amount, 2); v_pnet := round(v_paid - v_pvat, 2); END IF;

  -- the remainder is a NEW pending row; the original row (id kept: PO / receipt / tax-invoice links stay valid) becomes the paid part
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier, supplier_id, amount, amount_no_vat, vat,
                        payment_method, status, invoice_no, notes, is_subcontract, billing_date, due_date, po_id)
  VALUES (v_tenant, e.date, e.description, e.site_id, e.category_id, e.supplier, e.supplier_id, round(e.amount - v_paid, 2),
          CASE WHEN v_split THEN round(e.amount_no_vat - v_pnet, 2) END, CASE WHEN v_split THEN round(e.vat - v_pvat, 2) END,
          e.payment_method, 'pending', e.invoice_no,
          concat_ws(' | ', NULLIF(btrim(e.notes), ''), 'ยอดคงเหลือหลังจ่ายบางส่วน ' || to_char(v_paid, 'FM999,999,999,990.00') || ' บาท (แยกบิล)'),
          e.is_subcontract, e.billing_date, e.due_date, e.po_id)
  RETURNING id INTO v_new;
  UPDATE expenses
     SET amount = v_paid,
         amount_no_vat = CASE WHEN v_split THEN v_pnet END,
         vat = CASE WHEN v_split THEN v_pvat END,
         status = 'paid', payment_method = p_method,
         notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                   'จ่ายบางส่วน ' || to_char(v_paid, 'FM999,999,999,990.00') || ' จาก ' || to_char(e.amount, 'FM999,999,999,990.00')
                   || ' บาท วันที่ ' || to_char(p_paid_date, 'DD/MM/YYYY') || ' (แยกบิล)')
   WHERE id = e.id;
  INSERT INTO expense_splits (tenant_id, source_expense_id, new_expense_id, paid_amount, paid_date, payment_method, created_by)
  VALUES (v_tenant, e.id, v_new, v_paid, p_paid_date, p_method, auth.email());
  RETURN jsonb_build_object('paid_expense_id', e.id, 'remaining_expense_id', v_new, 'paid_amount', v_paid, 'remaining_amount', round(e.amount - v_paid, 2));
END $$;

REVOKE ALL ON FUNCTION _po_totals(UUID, UUID), _po_receipt_value(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_po_deposit(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT),
  receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB), split_payment(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_po_deposit(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT),
  receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB), split_payment(UUID, NUMERIC, DATE, TEXT) TO authenticated;
```

- [ ] **Step 4: Static checks and controller dry run**

```bash
grep -c "insufficient_privilege'; END IF;" supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql   # expect 3 (one per public RPC)
grep -n "p_tenant\b" supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql | grep -v "_po_" || true  # public RPCs take no tenant argument
```
Controller dry run (you hand it over; do not run it yourself):
```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"
  cat $W/supabase/migrations/2026-10-09-01-po-receipts.sql $W/supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql
  grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/po_receipt_test_b.sql
  echo "ROLLBACK;" ) > /tmp/prb_dry.sql
cd /Users/plfx/code/FacadeXPM/facadex-app && npx supabase db query --linked -f /tmp/prb_dry.sql
```
Expected: error text containing `RESULT: po_receipt_test_b ALL PASSED`. Also re-run Task 3's dry run with BOTH migrations prepended (test A must still pass).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql supabase/tests/po_receipt_test_b.sql
git commit -m "feat(db): create_po_deposit, receive_po_lines and split_payment RPCs (not applied)"
```

---

### Task 5: Migration 3 — tax-invoice matching for POs with several bills (+ SQL test part C)

**Files:**
- Create: `supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql`
- Test: `supabase/tests/tax_invoice_multi_bill_test.sql`

**Interfaces:**
- Consumes: `post_supplier_tax_invoice(uuid, int)` and `void_supplier_tax_invoice(uuid, text)` exactly as in `supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql` lines 317-441 and 444-529; Tasks 3-4 objects.
- Produces: table `supplier_tax_invoice_expense_stamps(id, tenant_id, invoice_id, po_id, expense_id, prev_invoice_no, stamped_invoice_no)`; helpers `_sti_stamp_other_bills(uuid, uuid, text) -> int`, `_sti_unstamp_other_bills(uuid, uuid, text) -> jsonb`; post now stamps EVERY bill of each linked PO; void restores them, including bills split off after the post.

What was checked (the reason for this task): `_sti_receipt_movements` joins ALL `purchase_in` movements with `reference_type='purchase_order'` and `reference_id = PO` ordered by `created_at` — it already handles a PO received in several receipts (no change). `_po_goods_subtotal` uses the whole PO's lines — equal to the sum of receipts for a fully received PO because the final receipt absorbs rounding (Task 1/4) and R7 keeps partially received POs out (`save_supplier_tax_invoice_draft` requires `status = 'received'`, `_sti_check` blocks `po_not_received`, `useReceivedPosForSupplier` filters `received`) — no change. The ONE single-receipt assumption is in post step (c): it stamps the invoice number only on `purchase_orders.expense_id`; with several receipts (and split payments) the other bills of the PO would keep no tax-invoice number. Void step (3) likewise restores only that one bill.

- [ ] **Step 1: Write the failing test** (`supabase/tests/tax_invoice_multi_bill_test.sql`)

```sql
-- ================================================================
-- Tests for 2026-10-09-03-tax-invoice-multi-bill.sql. Part C of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-01; -02; -03; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: tax_invoice_multi_bill_test ALL PASSED'.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_timb_owner__@example.com';
  poM UUID; m1 UUID; m2 UUID; poP UUID; p1 UUID; p2 UUID; inv UUID; j JSONB; v_rev INT; bill1 UUID; bill2 UUID; rem UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date; v_msg TEXT; r RECORD; v_cnt INT;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST timb__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__TIMB-1__', '__timb site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__timb sup__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__timb cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__timb item__', 'kg') RETURNING id INTO t_item;
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-TIMB-M', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poM;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poM, 'M1', 2, 300, 600, t_item, 0) RETURNING id INTO m1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poM, 'M2', 4, 100, 400, t_item, 1) RETURNING id INTO m2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-TIMB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 10, 10) RETURNING id INTO p1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P2', 1, 10, 10) RETURNING id INTO p2;

  -- poM received in two receipts -> two bills, two purchase_in movements
  j := receive_po_lines(poM, ARRAY[m1], v_bkk - 1, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', m1, 'base_qty', 2, 'unit_cost', 300)));
  bill1 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poM, ARRAY[m2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', m2, 'base_qty', 4, 'unit_cost', 100)));
  bill2 := (j->>'expense_id')::uuid;
  -- C1: receipts add up to _po_goods_subtotal (helper is not executable by clients: check as superuser)
  RESET role;
  IF (SELECT sum(goods_subtotal) FROM po_receipts WHERE po_id = poM) <> _po_goods_subtotal(poM, t_tenant) THEN RAISE EXCEPTION 'C1 FAIL: receipts vs _po_goods_subtotal'; END IF;
  SET LOCAL role = 'authenticated';
  -- poP stays partially received
  PERFORM receive_po_lines(poP, ARRAY[p1], v_bkk, '[]'::jsonb, 10, 0.70, '[]'::jsonb);

  -- C2 (R7): a partially received PO cannot be linked
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-X', 'invoice_date', v_bkk, 'net_before_vat', 10, 'vat', 0.7), '[]'::jsonb, ARRAY[poP]);
    RAISE EXCEPTION 'C2 FAIL: partially received PO linked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'C2 FAIL: %', v_msg; END IF; END;

  -- C3: post reverses BOTH receipt movements and stamps BOTH bills
  inv := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-1', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'all', 'qty', 1, 'unit_price', 1000)), ARRAY[poM]);
  v_rev := ((preview_supplier_tax_invoice(inv))->>'revision')::int;
  j := post_supplier_tax_invoice(inv, v_rev);
  IF (j->>'receipts_reversed')::int <> 2 OR (j->>'expenses_stamped')::int <> 2 THEN RAISE EXCEPTION 'C3 FAIL: %', j; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'TIMB-1' OR (SELECT invoice_no FROM expenses WHERE id = bill2) <> 'TIMB-1' THEN RAISE EXCEPTION 'C3 FAIL: not stamped'; END IF;
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv AND expense_id = bill2;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'C3 FAIL: stamp row'; END IF;

  -- C4: split bill2 after the post (the remainder copies the stamped number), then void restores all three
  j := split_payment(bill2, 100, v_bkk, 'transfer');
  rem := (j->>'remaining_expense_id')::uuid;
  IF (SELECT invoice_no FROM expenses WHERE id = rem) <> 'TIMB-1' THEN RAISE EXCEPTION 'C4 FAIL: split did not copy the number'; END IF;
  j := void_supplier_tax_invoice(inv, 'test');
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) IS NOT NULL OR (SELECT invoice_no FROM expenses WHERE id = bill2) IS NOT NULL
     OR (SELECT invoice_no FROM expenses WHERE id = rem) IS NOT NULL THEN RAISE EXCEPTION 'C4 FAIL: not restored'; END IF;
  IF jsonb_array_length(j->'warnings') <> 0 THEN RAISE EXCEPTION 'C4 FAIL: warnings %', j; END IF;

  -- C5: ACL
  RESET role;
  IF has_function_privilege('authenticated', '_sti_stamp_other_bills(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_unstamp_other_bills(uuid,uuid,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_expense_stamps', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'supplier_tax_invoice_expense_stamps', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAIL: grants';
  END IF;

  RAISE EXCEPTION 'RESULT: tax_invoice_multi_bill_test ALL PASSED';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Verify not present (read-only)**

```sql
SELECT to_regclass('public.supplier_tax_invoice_expense_stamps') AS t;
```
Expected: NULL.

- [ ] **Step 3: Write the migration**

Build `supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql` from these parts, in this order:

(a) header, table and helpers:

```sql
-- ============================================================
-- Tax-invoice matching for POs with several bills (receipts / split payments). Requires 2026-10-08-01..02, 2026-10-09-01..02.
-- post_supplier_tax_invoice / void_supplier_tax_invoice are re-created VERBATIM from 2026-10-08-02 plus ONE line each
-- (marked "-- 2026-10-09-03"). Same signatures, same grants: the deployed client is unaffected.
-- ============================================================
CREATE TABLE supplier_tax_invoice_expense_stamps (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id         UUID NOT NULL,
  po_id              UUID NOT NULL,      -- plain copy, no FK (see 2026-10-08-01)
  expense_id         UUID NOT NULL,      -- plain copy, no FK (PostgREST ambiguity)
  prev_invoice_no    TEXT,
  stamped_invoice_no TEXT,
  CONSTRAINT stie_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stie_invoice_expense_uq UNIQUE (invoice_id, expense_id)
);
CREATE INDEX idx_stie_tenant ON supplier_tax_invoice_expense_stamps(tenant_id);
ALTER TABLE supplier_tax_invoice_expense_stamps ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON supplier_tax_invoice_expense_stamps FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON supplier_tax_invoice_expense_stamps FROM PUBLIC, anon, authenticated;
GRANT SELECT ON supplier_tax_invoice_expense_stamps TO authenticated;

-- Every bill of each linked PO other than purchase_orders.expense_id (which step (c) of post already stamps):
-- later receipts' bills and split parts. Deposit and credit-note rows are never bills.
CREATE OR REPLACE FUNCTION _sti_stamp_other_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_n INT := 0;
BEGIN
  FOR k IN SELECT e.id, e.invoice_no, e.po_id
             FROM supplier_tax_invoice_pos l
             JOIN purchase_orders p ON p.id = l.po_id AND p.tenant_id = p_tenant
             JOIN expenses e ON e.po_id = p.id AND e.tenant_id = p_tenant
            WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
              AND e.id IS DISTINCT FROM p.expense_id
              AND NOT EXISTS (SELECT 1 FROM supplier_deposits sd WHERE sd.expense_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.expense_id = e.id)
            ORDER BY e.id
            FOR UPDATE OF e LOOP
    UPDATE expenses
       SET invoice_no = p_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                     'ใบกำกับภาษี ' || p_invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(k.invoice_no), ''), '-') || ')')
     WHERE id = k.id;
    INSERT INTO supplier_tax_invoice_expense_stamps (tenant_id, invoice_id, po_id, expense_id, prev_invoice_no, stamped_invoice_no)
    VALUES (p_tenant, p_id, k.po_id, k.id, k.invoice_no, p_invoice_no);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Undo of the above, plus bills split off any stamped bill AFTER the post (split_payment copies invoice_no).
CREATE OR REPLACE FUNCTION _sti_unstamp_other_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_warn JSONB := '[]'::jsonb;
BEGIN
  FOR k IN SELECT * FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = p_id AND tenant_id = p_tenant ORDER BY expense_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || p_invoice_no)
     WHERE id = k.expense_id AND tenant_id = p_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'blocking', false, 'po_id', k.po_id); END IF;
  END LOOP;
  FOR k IN
    WITH RECURSIVE src AS (
      SELECT expense_id, prev_invoice_no, stamped_invoice_no FROM supplier_tax_invoice_pos
       WHERE invoice_id = p_id AND tenant_id = p_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
      UNION ALL
      SELECT expense_id, prev_invoice_no, stamped_invoice_no FROM supplier_tax_invoice_expense_stamps
       WHERE invoice_id = p_id AND tenant_id = p_tenant),
    d AS (
      SELECT s.new_expense_id AS expense_id, src.prev_invoice_no, src.stamped_invoice_no
        FROM expense_splits s JOIN src ON s.source_expense_id = src.expense_id WHERE s.tenant_id = p_tenant
      UNION
      SELECT s.new_expense_id, d.prev_invoice_no, d.stamped_invoice_no
        FROM expense_splits s JOIN d ON s.source_expense_id = d.expense_id WHERE s.tenant_id = p_tenant)
    SELECT * FROM d WHERE d.expense_id NOT IN (SELECT expense_id FROM src) ORDER BY expense_id
  LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || p_invoice_no)
     WHERE id = k.expense_id AND tenant_id = p_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
  END LOOP;
  RETURN v_warn;
END $$;
```

(b) post: copy lines 317-441 of `supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql` verbatim (from `CREATE OR REPLACE FUNCTION post_supplier_tax_invoice(` to its `END $$;`; do NOT copy line 316's `DROP FUNCTION`), then insert this one line directly after the `END LOOP;` that closes step (c) (the line after `END IF;` / `END IF;` of the expense stamping loop, before `v_result := jsonb_build_object(`):

```sql
  v_stamped := v_stamped + _sti_stamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03
```

(c) void: copy lines 444-529 of the same file verbatim, then insert directly after the `END LOOP;` that closes step (3) (just before `UPDATE supplier_tax_invoice_pos SET active = false`):

```sql
  v_warn := v_warn || _sti_unstamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03
```

(d) grants:

```sql
REVOKE ALL ON FUNCTION _sti_stamp_other_bills(UUID, UUID, TEXT), _sti_unstamp_other_bills(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
```

- [ ] **Step 4: Prove the copies are verbatim, then controller dry run**

```bash
F=supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql
diff <(sed -n '317,441p' supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql) \
     <(awk '/^CREATE OR REPLACE FUNCTION post_supplier_tax_invoice/,/^END \$\$;/' $F | grep -v -- '-- 2026-10-09-03')
diff <(sed -n '444,529p' supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql) \
     <(awk '/^CREATE OR REPLACE FUNCTION void_supplier_tax_invoice/,/^END \$\$;/' $F | grep -v -- '-- 2026-10-09-03')
```
Expected: both diffs print nothing. Controller dry runs (handed over, not run by you): (1) 09-01 + 09-02 + 09-03 + this test -> `RESULT: tax_invoice_multi_bill_test ALL PASSED`; (2) 09-01 + 09-02 + 09-03 + `supabase/tests/supplier_tax_invoice_test.sql` body -> `RESULT: supplier_tax_invoice_test ALL PASSED` (the regression proves single-bill POs behave exactly as before).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql supabase/tests/tax_invoice_multi_bill_test.sql
git commit -m "feat(db): tax-invoice post/void stamp and restore every bill of a PO (not applied)"
```

---

### Task 6: Hooks, RPC wrappers, error mapping, ledger summary

**Files:**
- Create: `src/lib/poReceiptErrors.js`, `src/lib/poReceiptErrors.test.js`
- Modify: `src/hooks/useSupabase.js` (add after `receivePoWithDeposits`, around line 1765)
- Modify: `scripts/tax-invoice-harness/mockPoHooks.js`, `scripts/tax-invoice-harness/mockTenant.js`

**Interfaces:**
- Consumes: `RPC_ERROR_TEXT`, `PO_DEPOSIT_LOCKED_TEXT` (`receiveDeposits.js`); `depositRemaining`, `round2` (`depositMath.js`); `fetchAllRows`.
- Produces:
  - `mapPoReceiptRpcError(err) -> string` (Thai; 40P01/deadlock -> retry text; unknown -> raw message).
  - `PO_RECEIPT_LOCKED_TEXT`, `PO_HAS_DEPOSIT_TEXT`.
  - `buildPoMoneyIndex({ receiptItems: [{po_item_id, po_receipts: {po_id}}], deposits: [{id, po_id}] }) -> Map<poId, {receivedItemIds: Set, depositId: string|null}>`.
  - `poMoneyLockText(po, index) -> ''|string`.
  - `poLedgerSummary(po, ledger) -> { lines: [{...item, received, receivedDate, receiptSeq}], receipts, deposit: {id, no, gross, pct, usedGross, remainingGross, status}|null, applications, bills, outstandingCount, legacy }`.
  - hooks: `usePoMoneyIndex() -> { data: Map|null, error, refetch }`; `usePoLedger(poId) -> { data: {receipts, deposit, applications, bills}|null, error, refetch }`.
  - wrappers (throw the Supabase error object): `createPoDeposit({ poId, mode, value, invoiceNo, date, paymentMethod, status })`, `receivePoLines({ poId, lineIds, receivedDate, deductions, subtotal, vat, stock })`, `splitPayment({ expenseId, amount, paidDate, method })` each returning the RPC's jsonb.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/poReceiptErrors.test.js
import { describe, it, expect } from 'vitest'
import { mapPoReceiptRpcError, buildPoMoneyIndex, poMoneyLockText, poLedgerSummary, PO_RECEIPT_LOCKED_TEXT, PO_HAS_DEPOSIT_TEXT } from './poReceiptErrors.js'

describe('mapPoReceiptRpcError', () => {
  it('maps every new code to Thai and never shows the raw code', () => {
    for (const code of ['line_already_received', 'po_not_receivable', 'received_date_in_future', 'bad_received_date', 'deposit_exceeds_receipt',
      'deposit_vat_exceeds_receipt', 'bad_stock_plan', 'stock_cost_mismatch', 'po_has_deposit', 'po_has_receipts', 'deposit_invoice_no_taken',
      'deposit_invoice_no_required', 'bill_not_pending', 'bad_split_amount', 'expense_is_receipt_bill', 'expense_is_split_part', 'po_status_rpc_only',
      'totals_mismatch', 'deposit_exceeds_remaining', 'po_tax_invoiced', 'insufficient_privilege']) {
      const t = mapPoReceiptRpcError({ message: code })
      expect(t, code).not.toContain(code)
      expect(t.length, code).toBeGreaterThan(5)
    }
  })
  it('longest code wins (po_has_deposit_applications vs po_has_deposit)', () => {
    expect(mapPoReceiptRpcError({ message: 'po_has_deposit_applications' })).not.toBe(PO_HAS_DEPOSIT_TEXT)
    expect(mapPoReceiptRpcError({ message: 'po_has_deposit' })).toBe(PO_HAS_DEPOSIT_TEXT)
  })
  it('deadlock -> retry text; unknown -> raw', () => {
    expect(mapPoReceiptRpcError({ code: '40P01', message: 'deadlock detected' })).toContain('ลองใหม่')
    expect(mapPoReceiptRpcError({ message: 'boom' })).toBe('boom')
  })
})

describe('buildPoMoneyIndex / poMoneyLockText', () => {
  const idx = buildPoMoneyIndex({
    receiptItems: [{ po_item_id: 'i1', po_receipts: { po_id: 'P1' } }],
    deposits: [{ id: 'd1', po_id: 'P2' }],
  })
  it('indexes receipts and deposits by PO', () => {
    expect([...idx.get('P1').receivedItemIds]).toEqual(['i1'])
    expect(idx.get('P2').depositId).toBe('d1')
    expect(idx.get('P3')).toBeUndefined()
  })
  it('lock texts', () => {
    expect(poMoneyLockText({ id: 'P1' }, idx)).toBe(PO_RECEIPT_LOCKED_TEXT)
    expect(poMoneyLockText({ id: 'P2' }, idx)).toBe(PO_HAS_DEPOSIT_TEXT)
    expect(poMoneyLockText({ id: 'P3' }, idx)).toBe('')
    expect(poMoneyLockText({ id: 'P1' }, null)).toBe('')
  })
})

describe('poLedgerSummary', () => {
  const po = { id: 'P', status: 'partially_received', received_date: '2026-10-05', purchase_order_items: [{ id: 'a', line_total: 60000 }, { id: 'b', line_total: 40000 }] }
  it('lines, receipts and deposit remaining', () => {
    const s = poLedgerSummary(po, {
      receipts: [{ id: 'r1', seq: 1, received_date: '2026-10-05', goods_subtotal: 60000, goods_vat: 4200, po_receipt_items: [{ po_item_id: 'a' }] }],
      deposit: { id: 'd', deposit_invoice_no: 'DEP', pct_of_po: 30, expenses: { amount_no_vat: 30000, vat: 2100, status: 'paid' }, po_deposit_applications: [{ amount_no_vat: 18000, vat: 1260 }] },
      applications: [], bills: [],
    })
    expect(s.lines.map(l => [l.id, l.received, l.receivedDate, l.receiptSeq])).toEqual([['a', true, '2026-10-05', 1], ['b', false, null, null]])
    expect(s.deposit).toMatchObject({ gross: 32100, usedGross: 19260, remainingGross: 12840, pct: 30 })
    expect(s.outstandingCount).toBe(1)
    expect(s.legacy).toBe(false)
  })
  it('poLedgerSummary legacy: received the old way, no receipt rows', () => {
    const s = poLedgerSummary({ ...po, status: 'received' }, { receipts: [], deposit: null, applications: [], bills: [] })
    expect(s.legacy).toBe(true)
    expect(s.lines.every(l => l.received && l.receivedDate === '2026-10-05')).toBe(true)
    expect(s.outstandingCount).toBe(0)
  })
  it('ไทย-เยอรมัน after the data fix: remaining 0', () => {
    const s = poLedgerSummary({ ...po, status: 'received' }, { receipts: [], applications: [], bills: [],
      deposit: { id: 'd', deposit_invoice_no: '2602543', pct_of_po: 50, expenses: { amount_no_vat: 103365, vat: 7235.55, status: 'paid' }, po_deposit_applications: [{ amount_no_vat: 103365, vat: 7235.55 }] } })
    expect(s.deposit).toMatchObject({ gross: 110600.55, usedGross: 110600.55, remainingGross: 0 })
  })
  it('null ledger (loading / migration missing) does not crash', () => {
    expect(poLedgerSummary(po, null).deposit).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/poReceiptErrors.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// src/lib/poReceiptErrors.js
// Thai text for the receipt / deposit / split RPCs and triggers (2026-10-09-01..02), PO money locks, and the
// pure summary behind the PO popup. Pure; no Supabase calls here.
import { RPC_ERROR_TEXT, PO_DEPOSIT_LOCKED_TEXT } from './receiveDeposits.js'
import { depositRemaining, round2 } from './depositMath.js'
import { poTaxInvoiceErrorText } from './poTaxInvoiceStatus.js'

export const PO_RECEIPT_LOCKED_TEXT = 'ใบสั่งซื้อนี้รับของแล้ว แก้ไขหรือยกเลิกไม่ได้ — แจ้งผู้ดูแลระบบ'
export const PO_HAS_DEPOSIT_TEXT = 'ใบสั่งซื้อนี้มีใบมัดจำแล้ว แก้ไขหรือยกเลิกไม่ได้ — แจ้งผู้ดูแลระบบ'

export const PO_RECEIPT_ERROR_TEXT = {
  ...RPC_ERROR_TEXT,
  po_not_receivable: 'ใบสั่งซื้อนี้รับของครบแล้วหรือยกเลิกแล้ว กรุณาเปิดใหม่',
  po_has_deposit_applications: PO_DEPOSIT_LOCKED_TEXT,
  bad_received_date: 'กรุณาเลือกวันที่รับสินค้า',
  received_date_in_future: 'วันที่รับสินค้าต้องไม่เกินวันนี้',
  bad_lines: 'รายการที่เลือกไม่ถูกต้อง กรุณาเปิดใหม่',
  line_already_received: 'บางรายการถูกรับไปแล้ว (อาจกดซ้ำหรือมีคนรับพร้อมกัน) กรุณาเปิดใหม่',
  bad_deduction: 'ยอดหักมัดจำไม่ถูกต้อง',
  deposit_exceeds_receipt: 'ยอดหักมัดจำเกินมูลค่าที่รับครั้งนี้',
  deposit_vat_exceeds_receipt: 'VAT ที่หักเกิน VAT ของการรับครั้งนี้',
  bad_stock_plan: 'ข้อมูลลงสต็อกไม่ครบหรือไม่ถูกต้อง กรุณาเปิดใหม่',
  stock_cost_mismatch: 'ต้นทุนลงสต็อกไม่ตรงกับยอดรายการ กรุณาเปิดใหม่',
  po_not_ordered: 'สร้างมัดจำได้เฉพาะใบสั่งซื้อที่สั่งแล้วและยังไม่ได้รับของ',
  po_no_supplier: 'ใบสั่งซื้อนี้ยังไม่มี Supplier',
  po_has_deposit: PO_HAS_DEPOSIT_TEXT,
  po_has_receipts: PO_RECEIPT_LOCKED_TEXT,
  po_status_rpc_only: 'เปลี่ยนสถานะเป็นรับบางส่วนได้จากปุ่มรับของเท่านั้น',
  deposit_invoice_no_required: 'กรุณากรอกเลขที่ใบเสร็จ/ใบกำกับมัดจำ',
  deposit_invoice_no_taken: 'เลขที่มัดจำนี้มีในระบบแล้ว',
  bad_deposit_date: 'วันที่จ่ายมัดจำต้องไม่เกินวันนี้',
  bad_payment_method: 'วิธีชำระไม่ถูกต้อง',
  bad_deposit_status: 'สถานะไม่ถูกต้อง',
  bad_deposit_value: 'ยอดมัดจำไม่ถูกต้อง',
  expense_not_found: 'ไม่พบรายจ่ายนี้ กรุณาเปิดใหม่',
  not_a_po_bill: 'จ่ายบางส่วนได้เฉพาะบิลจากใบสั่งซื้อ',
  bill_is_credit_note: 'รายการนี้เป็นใบลดหนี้ จ่ายบางส่วนไม่ได้',
  bill_is_deposit: 'รายการนี้เป็นมัดจำ จ่ายบางส่วนไม่ได้',
  bill_is_cheque: 'บิลนี้ผูกกับเช็คแล้ว จ่ายบางส่วนไม่ได้',
  bill_not_pending: 'จ่ายบางส่วนได้เฉพาะบิลสถานะค้างจ่าย',
  bad_paid_date: 'วันที่จ่ายต้องไม่เกินวันนี้',
  bad_split_amount: 'ยอดที่จ่ายต้องมากกว่า 0 และน้อยกว่ายอดบิล',
  bill_bad_split: 'ยอดก่อน VAT + VAT ของบิลไม่เท่ากับยอดรวม — แก้ที่หน้ารายจ่ายก่อน',
  expense_is_receipt_bill: 'ลบไม่ได้ — รายจ่ายนี้เป็นบิลรับของของใบสั่งซื้อ',
  expense_is_split_part: 'ลบไม่ได้ — รายจ่ายนี้แยกมาจากการจ่ายบางส่วน',
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้',
}

/** Thai message for an RPC / trigger error; unknown codes fall back to the raw message. */
export function mapPoReceiptRpcError(err) {
  const tax = poTaxInvoiceErrorText(err)   // po_tax_invoiced, po_stock_flag_locked, 40P01 deadlock
  if (tax) return tax
  const msg = String(err?.message || err || '')
  for (const code of Object.keys(PO_RECEIPT_ERROR_TEXT).sort((a, b) => b.length - a.length)) if (msg.includes(code)) return PO_RECEIPT_ERROR_TEXT[code]
  return msg
}

export function buildPoMoneyIndex({ receiptItems, deposits }) {
  const m = new Map()
  const get = id => { if (!m.has(id)) m.set(id, { receivedItemIds: new Set(), depositId: null }); return m.get(id) }
  for (const r of receiptItems || []) { const poId = r.po_receipts?.po_id; if (poId) get(poId).receivedItemIds.add(r.po_item_id) }
  for (const d of deposits || []) if (d.po_id) get(d.po_id).depositId = d.id
  return m
}

/** '' or why a PO's edit / cancel is locked by its receipts or its own deposit. */
export function poMoneyLockText(po, index) {
  const e = index && po ? index.get(po.id) : null
  if (!e) return ''
  if (e.receivedItemIds.size > 0) return PO_RECEIPT_LOCKED_TEXT
  if (e.depositId) return PO_HAS_DEPOSIT_TEXT
  return ''
}

export function poLedgerSummary(po, ledger) {
  const receipts = ledger?.receipts || []
  const byItem = new Map()
  for (const r of receipts) for (const it of r.po_receipt_items || []) byItem.set(it.po_item_id, r)
  const legacy = receipts.length === 0 && po.status === 'received'
  const lines = (po.purchase_order_items || []).map(it => {
    const r = byItem.get(it.id)
    return { ...it, received: legacy || !!r, receivedDate: r ? r.received_date : (legacy ? po.received_date || null : null), receiptSeq: r ? r.seq : null }
  })
  let deposit = null
  const d = ledger?.deposit
  if (d?.expenses) {
    const rem = depositRemaining(d.expenses, d.po_deposit_applications || [])
    const gross = round2(Number(d.expenses.amount_no_vat) + Number(d.expenses.vat || 0))
    const remainingGross = round2(rem.net + rem.vat)
    deposit = { id: d.id, no: d.deposit_invoice_no, gross, pct: d.pct_of_po, usedGross: round2(gross - remainingGross), remainingGross, status: d.expenses.status }
  }
  return { lines, receipts, deposit, applications: ledger?.applications || [], bills: ledger?.bills || [], outstandingCount: lines.filter(l => !l.received).length, legacy }
}
```

Add to `src/hooks/useSupabase.js` (directly after `receivePoWithDeposits`; add `buildPoMoneyIndex` to the imports at the top: `import { buildPoMoneyIndex } from '../lib/poReceiptErrors.js'`):

```js
// ── PO receipts / PO deposits / split payments (2026-10-09-01..02) ─────────
// Tables are SELECT-only for clients; writes are RPCs. Embeds name their constraint.
// Before the migration the tables are missing: data stays null (+ error) and the PO page hides the new actions.

/** Map<po_id, {receivedItemIds:Set, depositId}> for the whole tenant (list row menu + edit locks). */
export function usePoMoneyIndex() {
  return useQuery(async () => {
    const receiptItems = await fetchAllRows(() => supabase.from('po_receipt_items')
      .select('id, po_item_id, po_receipts!po_receipt_items_receipt_fk(po_id)').order('id'))
    const deposits = await fetchAllRows(() => supabase.from('supplier_deposits')
      .select('id, po_id').not('po_id', 'is', null).order('id'))
    return buildPoMoneyIndex({ receiptItems, deposits })
  }, [])
}

/** One PO's receipts, own deposit (with all its applications), applications to this PO, bills. */
export function usePoLedger(poId) {
  return useQuery(async () => {
    if (!poId) return null
    const [rc, dp, ap, bl] = await Promise.all([
      supabase.from('po_receipts')
        .select('id, seq, received_date, received_by, goods_subtotal, goods_vat, expense_id, po_receipt_items!po_receipt_items_receipt_fk(po_item_id)')
        .eq('po_id', poId).order('seq'),
      supabase.from('supplier_deposits')
        .select('id, deposit_invoice_no, pct_of_po, po_id, expenses!supplier_deposits_expense_id_fkey(id, date, amount, amount_no_vat, vat, status), po_deposit_applications!po_deposit_applications_deposit_id_fkey(amount_no_vat, vat, po_id, receipt_id)')
        .eq('po_id', poId).maybeSingle(),
      supabase.from('po_deposit_applications')
        .select('id, amount_no_vat, vat, receipt_id, deposit_id, supplier_deposits!po_deposit_applications_deposit_id_fkey(deposit_invoice_no)')
        .eq('po_id', poId).order('created_at'),
      supabase.from('expenses')
        .select('id, date, amount, amount_no_vat, vat, status, invoice_no, notes, created_at')
        .eq('po_id', poId).order('created_at'),
    ])
    for (const r of [rc, dp, ap, bl]) if (r.error) throw r.error
    return { receipts: rc.data || [], deposit: dp.data || null, applications: ap.data || [], bills: bl.data || [] }
  }, [poId])
}

export async function createPoDeposit({ poId, mode, value, invoiceNo, date, paymentMethod, status }) {
  const { data, error } = await supabase.rpc('create_po_deposit', {
    p_po_id: poId, p_mode: mode, p_value: Number(value), p_invoice_no: invoiceNo, p_date: date, p_payment_method: paymentMethod, p_status: status,
  })
  if (error) throw error
  return data
}

export async function receivePoLines({ poId, lineIds, receivedDate, deductions, subtotal, vat, stock }) {
  const { data, error } = await supabase.rpc('receive_po_lines', {
    p_po_id: poId, p_line_ids: lineIds, p_received_date: receivedDate, p_deduction: deductions || [],
    p_expected_subtotal: subtotal, p_expected_vat: vat, p_stock: stock || [],
  })
  if (error) throw error
  return data
}

export async function splitPayment({ expenseId, amount, paidDate, method }) {
  const { data, error } = await supabase.rpc('split_payment', { p_expense_id: expenseId, p_amount: Number(amount), p_paid_date: paidDate, p_method: method })
  if (error) throw error
  return data
}
```

Append to `scripts/tax-invoice-harness/mockPoHooks.js`:

```js
// ── 2026-10-09 PO receipts (Task 6). W.__money: [[poId, {receivedItemIds:[...], depositId}]] or null (= not ready);
// W.__ledger: {[poId]: {receipts, deposit, applications, bills}}; W.__deposits: useSupplierDeposits rows;
// W.__wrapperError: thrown by the RPC wrappers; every wrapper call is logged as ['rpc', name, args].
export const usePoMoneyIndex = () => useQuery(() => delay(() => (W.__money === null ? null
  : new Map((W.__money || []).map(([k, v]) => [k, { receivedItemIds: new Set(v.receivedItemIds || []), depositId: v.depositId || null }])))), [W.__moneyVersion])
export const usePoLedger = (poId) => useQuery(() => delay(() => (W.__ledger || {})[poId] || { receipts: [], deposit: null, applications: [], bills: [] }), [poId, W.__ledgerVersion])
const wrapper = (name, result) => async (args) => {
  W.__log.push(['rpc', name, JSON.stringify(args)])
  if (W.__wrapperDelay) await new Promise(r => setTimeout(r, W.__wrapperDelay))
  if (W.__wrapperError) throw W.__wrapperError
  return typeof result === 'function' ? result(args) : result
}
export const createPoDeposit = wrapper('create_po_deposit', () => W.__depositResult || { deposit_id: 'dnew', expense_id: 'enew', amount: 0, amount_no_vat: 0, vat: 0, pct_of_po: 0 })
export const receivePoLines = wrapper('receive_po_lines', () => W.__receiveResult || { receipt_id: 'r1', seq: 1, receipt_no: 'PO-X-R1', expense_id: 'exp1', status: 'received' })
```
and change the existing `useSupplierDeposits` mock line to `export const useSupplierDeposits = () => useQuery(() => delay(() => W.__deposits || []))`.

Change `scripts/tax-invoice-harness/mockTenant.js` to:

```js
export const useTenant = () => ({ tenant: { id: 't1', company_name: 'Test Co' }, loading: false, hasModuleAccess: k => !(window.__noModules || []).includes(k) })
```

- [ ] **Step 4: Run tests, build and the existing harness**

```bash
npx vitest run src/lib/poReceiptErrors.test.js && npx vitest run
npx vite build --outDir "$TMPDIR/po-build" --emptyOutDir
node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs
```
Expected: vitest PASS; vite build succeeds (no unresolved import); harness ends `ALL PASS` (nothing visible changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/poReceiptErrors.js src/lib/poReceiptErrors.test.js src/hooks/useSupabase.js scripts/tax-invoice-harness/mockPoHooks.js scripts/tax-invoice-harness/mockTenant.js
git commit -m "feat: hooks, RPC wrappers and Thai error mapping for PO receipts, deposits and split payments"
```

---

### Task 7: PO list row (📄 + ⋯), PO popup with lines/receipts/deposit/bills, document actions

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx` (imports lines 9 and 34-36; `PO_STATUSES`/`PO_STATUS_LABELS` lines 59-60; `PODetailModal` lines 410-475; `PODocumentModal` lines 480-595; state lines 757-765; `handleSave` lines 866-869; `handleCancel` lines 917-922; row cell lines 1137-1171; modal renders lines 1187-1189)
- Modify: `src/index.css` (after line 438)
- Modify: `scripts/tax-invoice-harness/runPo.mjs`, `scripts/tax-invoice-harness/README.md`

**Interfaces:**
- Consumes: `usePoMoneyIndex`, `usePoLedger` (Task 6), `poMoneyLockText`, `poLedgerSummary`, `mapPoReceiptRpcError` (Task 6), `RowActionsMenu`.
- Produces: page state `receiveRow` (set by the menu; Task 9 renders the new dialog for it), `depositPo` (Task 8 renders the dialog), `docRow = { po, action: null|'print'|'pdf'|'jpg' }`; `moneyIndex` + `refetchMoney` in the page scope; `PODetailModal` prop `onViewDocument(po)`.

Rulings: "ดู PO" inside the popup CLOSES the popup and opens the document modal (no stacked Modals); the menu document actions open the document modal and run the action after 400 ms (images loaded); print uses the existing `.printable-document` print CSS; a non-editing role sees 📄 and only the document actions; partially received POs get no swap/credit-note actions (as today these are for `received` only); while the money index is still loading or missing the receive item is visible but disabled with "กำลังโหลดข้อมูลการรับของ…".

- [ ] **Step 1: Write the failing harness scenarios** — in `scripts/tax-invoice-harness/runPo.mjs`:

Add helpers after `const row = ...`:

```js
const openMenu = async re => { await row(re).getByTitle('เพิ่มเติม').click(); await wait(150) }
const menuItem = name => page.getByText(name, { exact: true })
const closeMenu = async () => { await page.mouse.click(2, 2); await wait(100) }
```

Replace the row-button uses in sections 1-5:
- `ok('edit enabled on an ordered PO', ...)` becomes:
```js
await openMenu(/PO-E/)
ok('edit enabled on an ordered PO', (await menuItem('✏️ แก้ไข').getAttribute('title')) === null)
await closeMenu()
```
- the linked-PO edit check becomes:
```js
await openMenu(/PO-E/)
ok('linked ordered PO: edit disabled with explanation', (await menuItem('✏️ แก้ไข').getAttribute('title')) === 'ใบสั่งซื้อนี้ผูกกับใบกำกับภาษี INV-2 แก้ไขไม่ได้')
await closeMenu()
await openMenu(/PO-C/)
ok('unlinked ordered PO: edit enabled', (await menuItem('✏️ แก้ไข').getAttribute('title')) === null)
await closeMenu()
```
- `row(/PO-A/).getByRole('button').last().click()` -> `openMenu(/PO-A/)` (same for PO-B).
- `row(/PO-A/).getByRole('button', { name: '👁️' })` -> `row(/PO-A/).getByRole('button', { name: '📄' })`.
- every `row(/PO-C|D/).getByRole('button', { name: '✅ รับของแล้ว' }).click()` -> `await openMenu(/PO-C/); await menuItem('📦 รับของ').click()` (PO-D likewise).

Append a new section before the final error check:

```js
console.log('=== 7 row layout, popup, document actions, locks')
await set('__links', null)
await page.evaluate(() => {
  window.__data.pos.push(
    { ...window.__data.pos[2], id: 'G', po_number: 'PO-G', status: 'partially_received', purchase_order_items: [{ id: 'g1', description: 'เหล็ก', quantity: 1, unit: 'kg', unit_price: 60000, discount_pct: 0, line_total: 60000, inventory_item_id: 'I1' }, { id: 'g2', description: 'กระจก', quantity: 1, unit: 'แผ่น', unit_price: 40000, discount_pct: 0, line_total: 40000, inventory_item_id: null }] },
    { ...window.__data.pos[2], id: 'H', po_number: 'PO-H', status: 'ordered' },
    { ...window.__data.pos[0], id: 'L', po_number: 'PO-L', status: 'received', received_date: '2026-10-01' })
  window.__money = [['G', { receivedItemIds: ['g1'], depositId: 'dG' }], ['H', { receivedItemIds: [], depositId: 'dH' }]]
  window.__ledger = { G: {
    receipts: [{ id: 'rG', seq: 1, received_date: '2026-10-05', goods_subtotal: 60000, goods_vat: 4200, expense_id: 'bG', po_receipt_items: [{ po_item_id: 'g1' }] }],
    deposit: { id: 'dG', deposit_invoice_no: 'DEP-G', pct_of_po: 30, expenses: { amount_no_vat: 30000, vat: 2100, status: 'paid' }, po_deposit_applications: [{ amount_no_vat: 18000, vat: 1260 }] },
    applications: [{ id: 'aG', amount_no_vat: 18000, vat: 1260, receipt_id: 'rG', supplier_deposits: { deposit_invoice_no: 'DEP-G' } }],
    bills: [{ id: 'bG', date: '2026-10-02', amount: 44940, amount_no_vat: 42000, vat: 2940, status: 'pending', invoice_no: null }] } }
})
await render()
t = await row(/PO-G/).innerText()
ok('row has only 📄 and ⋯ (no old buttons)', (await row(/PO-G/).getByRole('button').count()) === 2 && !t.includes('รับของแล้ว') && !t.includes('👁️'), t)
ok('partially received label', t.includes('รับบางส่วน'))
await openMenu(/PO-G/)
ok('receive offered for a partially received PO', await menuItem('📦 รับของ').isVisible())
ok('no create-deposit for partially received', !(await page.getByText('💰 สร้างใบจ่ายมัดจำ').count()))
let allDoc = true
for (const n of ['👁️ ดูตัวอย่างก่อนพิมพ์', '🖨️ พิมพ์', '📄 ดาวน์โหลด PDF', '🖼️ ดาวน์โหลด JPEG']) allDoc = allDoc && await menuItem(n).isVisible()
ok('document actions in menu', allDoc)
await closeMenu()
await openMenu(/PO-H/)
ok('PO with deposit: create deposit disabled with reason', (await menuItem('💰 สร้างใบจ่ายมัดจำ').getAttribute('title')) === 'ใบสั่งซื้อนี้มีใบมัดจำแล้ว')
ok('PO with deposit: edit and cancel locked', (await menuItem('✏️ แก้ไข').getAttribute('title'))?.includes('มีใบมัดจำแล้ว') && (await menuItem('🗑️ ยกเลิกใบสั่งซื้อ').getAttribute('title'))?.includes('มีใบมัดจำแล้ว'))
await closeMenu()
await row(/PO-G/).getByRole('button', { name: '📄' }).click(); await wait(500)
t = await page.locator('.modal').innerText()
ok('popup: lines ordered / received / outstanding', t.includes('รับแล้ว') && t.includes('ค้างรับ') && t.includes('R1'), t)
ok('popup: deposit remaining 12,840.00', t.includes('DEP-G') && t.includes('12,840.00'), t)
ok('popup: bill listed', t.includes('44,940.00'), t)
ok('popup: ดู PO button and attachments', (await page.getByRole('button', { name: '📄 ดู PO' }).count()) === 1 && t.includes('ไฟล์แนบ'))
await page.getByRole('button', { name: '📄 ดู PO' }).click(); await wait(400)
ok('ดู PO swaps to the document modal (one modal)', (await page.locator('.modal').count()) === 1 && (await page.locator('.modal').innerText()).includes('ใบสั่งซื้อ') && (await page.locator('.printable-document').count()) === 1)
await page.getByRole('button', { name: 'ปิด' }).click(); await wait(200)
await row(/PO-L/).getByRole('button', { name: '📄' }).click(); await wait(500)
t = await page.locator('.modal').innerText()
ok('legacy received PO popup: all lines received, no outstanding', t.includes('รับแล้ว') && !t.includes('ค้างรับ'), t)
await page.getByRole('button', { name: 'ปิด' }).click(); await wait(200)
await set('__role', 'WORKER'); await render()
await openMenu(/PO-C/)
ok('non-admin: menu has document actions only', (await page.getByText('📦 รับของ').count()) === 0 && (await page.getByText('✏️ แก้ไข').count()) === 0 && await menuItem('🖨️ พิมพ์').isVisible())
await closeMenu(); await set('__role', 'OWNER')
await set('__money', null); await render()
await openMenu(/PO-C/)
ok('money index not ready: receive disabled with loading title', (await menuItem('📦 รับของ').getAttribute('title')) === 'กำลังโหลดข้อมูลการรับของ…')
await closeMenu(); await set('__money', [])
await page.setViewportSize({ width: 375, height: 740 }); await render()
const box = await row(/PO-C/).getByTitle('เพิ่มเติม').boundingBox()
ok('mobile: ⋯ reachable inside the viewport width (table scrolls)', !!box)
await page.setViewportSize({ width: 1280, height: 800 })
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs`
Expected: FAIL lines (old buttons still on the row; no menu items yet).

- [ ] **Step 3: Implement**

(a) imports (line 9) add `usePoMoneyIndex, usePoLedger`; add `import { poMoneyLockText, poLedgerSummary, mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'`.

(b) statuses (lines 59-60):

```js
const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled']
const PO_STATUS_LABELS = { draft: '📝 ร่าง (รอเติมข้อมูล)', ordered: '📦 สั่งแล้ว', partially_received: '🚚 รับบางส่วน', received: '✅ รับของแล้ว', cancelled: '✕ ยกเลิก' }
const BILL_STATUS_LABELS = { awaiting_billing: '🧾 รอวางบิล', pending: '⏳ ค้างจ่าย', check_issued: '📄 ออกเช็ค', check_cleared: '🏦 เช็คผ่าน', paid: '✅ จ่ายแล้ว' }
```

(c) `src/index.css` after line 438:

```css
.badge-po-partially_received { background: rgba(234,179,8,0.15); color: var(--yellow); }
```

(d) replace `PODetailModal` (lines 410-475) with:

```jsx
function PODetailModal({ po, tenantId, onClose, taxBadge, onViewDocument }) {
  const items = po.purchase_order_items || []
  const { subtotal, vat, total } = calcPoTotals(items, po.has_vat, po.price_includes_vat)
  const { data: ledger } = usePoLedger(po.id)          // null while loading or before the migration: sections hide
  const s = poLedgerSummary(po, ledger)
  const cell = { padding: '4px 6px', borderBottom: '1px solid var(--border)' }
  return (
    <Modal title={`ใบสั่งซื้อ ${po.po_number}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge badge-po-${po.status}`}>{PO_STATUS_LABELS[po.status] || po.status}</span>
          {taxBadge?.kind && <span className={`badge ${TAX_BADGE_CLASS[taxBadge.kind]}`}>{taxBadge.text}</span>}
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(po.date)}</span>
        </div>
        <div className="form-grid-2" style={{ fontSize: 13 }}>
          <div><strong>ไซท์งาน:</strong> {po.sites?.name || '—'}</div>
          <div><strong>Supplier:</strong> {po.suppliers?.name || '—'}</div>
        </div>
        {po.ordered_by && <div style={{ fontSize: 13 }}><strong>ชื่อผู้สั่ง:</strong> {po.ordered_by}</div>}
        {po.notes && <div style={{ fontSize: 13 }}><strong>หมายเหตุ:</strong> {po.notes}</div>}
        <div>
          <label className="label">รายการสินค้า</label>
          <div className="table-wrap">
            <table style={{ fontSize: 12.5 }}>
              <thead><tr><th>รายการ</th><th>สั่ง</th><th>รับ</th><th style={{ textAlign: 'right' }}>มูลค่า</th></tr></thead>
              <tbody>
                {s.lines.map(it => (
                  <tr key={it.id}>
                    <td style={cell}>
                      {it.description}
                      {it.aluminum_profiles?.name && <div style={{ fontSize: 11, color: 'var(--text3)' }}>หน้าตัด {it.aluminum_profiles.name} ยาว {it.rod_length_m} ม.</div>}
                      {it.glass_width_m && it.glass_height_m && <div style={{ fontSize: 11, color: 'var(--text3)' }}>ขนาด {it.glass_width_m}×{it.glass_height_m} ม.</div>}
                    </td>
                    <td style={cell}>{it.quantity} {it.unit || ''}</td>
                    <td style={cell}>{it.received
                      ? <span style={{ color: 'var(--green)' }}>✓ รับแล้ว {it.receivedDate ? fmtDate(it.receivedDate) : ''}{it.receiptSeq ? ` (R${it.receiptSeq})` : ''}</span>
                      : <span style={{ color: 'var(--yellow)' }}>ค้างรับ</span>}</td>
                    <td style={{ ...cell, textAlign: 'right' }} className="font-mono">{fmt(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
            <div>รวมก่อน VAT: <span className="font-mono">{fmt(subtotal)}</span></div>
            {po.has_vat && <div>VAT (7%): <span className="font-mono">{fmt(vat)}</span></div>}
            <div style={{ fontWeight: 700 }}>รวมสุทธิ: <span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(total)}</span></div>
          </div>
        </div>
        {s.receipts.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <label className="label">การรับของ</label>
            {s.receipts.map(r => (
              <div key={r.id}>R{r.seq} · {fmtDate(r.received_date)} · ก่อน VAT <span className="font-mono">{fmt(r.goods_subtotal)}</span> · VAT <span className="font-mono">{fmt(r.goods_vat)}</span></div>
            ))}
          </div>
        )}
        {s.deposit && (
          <div style={{ fontSize: 13 }}>
            <label className="label">มัดจำ</label>
            <div>{s.deposit.no} · <span className="font-mono">{fmt(s.deposit.gross)}</span>{s.deposit.pct ? ` (${Number(s.deposit.pct)}% ของใบสั่งซื้อ)` : ''}</div>
            <div>ใช้แล้ว <span className="font-mono">{fmt(s.deposit.usedGross)}</span> · <strong>คงเหลือ <span className="font-mono">{fmt(s.deposit.remainingGross)}</span></strong></div>
          </div>
        )}
        {s.applications.length > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
            {s.applications.map(a => (
              <div key={a.id}>หักมัดจำ {a.supplier_deposits?.deposit_invoice_no || ''}: ก่อน VAT <span className="font-mono">{fmt(a.amount_no_vat)}</span> · VAT <span className="font-mono">{fmt(a.vat)}</span></div>
            ))}
          </div>
        )}
        {s.bills.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <label className="label">บิล</label>
            {s.bills.map(b => (
              <div key={b.id}>{fmtDate(b.date)} · <span className="font-mono">{fmt(b.amount)}</span> · {BILL_STATUS_LABELS[b.status] || b.status}{b.invoice_no ? ` · #${b.invoice_no}` : ''}</div>
            ))}
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 8 }}>
          <div><button type="button" className="btn btn-sm btn-ghost" onClick={() => onViewDocument(po)}>📄 ดู PO</button></div>
          {tenantId && <AttachmentsSection table="purchase_order_attachments" bucket="po-attachments" foreignKey="po_id" entityId={po.id} tenantId={tenantId} />}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
```

(e) `PODocumentModal`: signature `function PODocumentModal({ po, tenant, onClose, autoAction = null })`; give the document div `className="printable-document"` (keep its id and style); add after the hooks:

```js
  const fileBase = `${po.po_number}${po.sites?.name ? '-' + po.sites.name : ''}`
  useEffect(() => {
    if (!autoAction) return
    const t = setTimeout(() => {          // let the logo / signature images load first
      if (autoAction === 'pdf') downloadPDF(`po-doc-${po.id}`, `${fileBase}.pdf`)
      else if (autoAction === 'jpg') downloadJPG(`po-doc-${po.id}`, `${fileBase}.jpg`)
      else if (autoAction === 'print') window.print()
    }, 400)
    return () => clearTimeout(t)
  }, [autoAction]) // eslint-disable-line react-hooks/exhaustive-deps
```
and in its footer add `<button className="btn btn-ghost" onClick={() => window.print()}>🖨️ พิมพ์</button>` before the JPG button, using `fileBase` in the existing two download buttons.

(f) page state/hooks (after line 765):

```js
  const [depositPo, setDepositPo] = useState(null)
  const { data: moneyIndex, refetch: refetchMoney } = usePoMoneyIndex()
```
and change `const refetchAll = () => { refetch(); refetchLinks() }` to `const refetchAll = () => { refetch(); refetchLinks(); refetchMoney() }`.

(g) `handleSave` lock (replace line 868): `const lockedText = editRow ? (poEditLockedText(editRow, taxInvoiceLinks) || poMoneyLockText(editRow, moneyIndex)) : ''`, and the catch's alert becomes `alert('Error: ' + mapPoReceiptRpcError(e))`.

(h) `handleCancel` error branch becomes: `else alert(mapPoReceiptRpcError(error))`.

(i) the row actions cell (lines 1137-1171) becomes:

```jsx
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        <button className="btn btn-sm btn-ghost" title="ดูใบสั่งซื้อ / เอกสาร" onClick={() => setDetailRow(po)}>📄</button>
                        <RowActionsMenu items={poMenuItems(po)} />
                      </div>
                    </td>
```
and define inside the component, before `if (showAdd)`:

```js
  const openCreditNote = (po) => {
    setCreditNotePrefill({
      supplier_id: po.supplier_id, site_id: po.site_id, po_id: po.id, category_id: po.category_id,
      vatEnabled: po.has_vat !== false, priceIncludesVat: !!po.price_includes_vat, original_expense_id: po.expense_id || null,
      items: (po.purchase_order_items || []).map(it => {
        const invItem = it.inventory_item_id ? (allInventoryItems || []).find(i => i.id === it.inventory_item_id) : null
        const profile = it.aluminum_profile_id ? (allAluminumProfiles || []).find(p => p.id === it.aluminum_profile_id) : null
        const factor = it.inventory_item_id ? (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit) : null
        return poItemToCreditLine(it, invItem ? { ...computePoItemBaseQty(it, invItem, profile, factor), baseUnit: invItem.base_unit } : null)
      }),
    })
    navigateTo('supplier_credit_notes', {})
  }

  const poMenuItems = (po) => {
    const lock = poEditLockedText(po, taxInvoiceLinks) || poMoneyLockText(po, moneyIndex)
    const items = []
    if (canEdit && (po.status === 'ordered' || po.status === 'partially_received')) {
      items.push(moneyIndex
        ? { label: '📦 รับของ', onClick: () => setReceiveRow(po) }
        : { label: '📦 รับของ', disabled: true, disabledTitle: 'กำลังโหลดข้อมูลการรับของ…', onClick: () => {} })
    }
    if (canEdit && po.status === 'ordered' && moneyIndex) {
      items.push(moneyIndex.get(po.id)?.depositId
        ? { label: '💰 สร้างใบจ่ายมัดจำ', disabled: true, disabledTitle: 'ใบสั่งซื้อนี้มีใบมัดจำแล้ว', onClick: () => {} }
        : { label: '💰 สร้างใบจ่ายมัดจำ', onClick: () => setDepositPo(po) })
    }
    if (canEdit && (po.status === 'ordered' || po.status === 'draft')) {
      items.push({ label: '✏️ แก้ไข', disabled: !!lock, disabledTitle: lock || undefined, onClick: () => { clearDraft(ADD_FORM_OPEN_KEY); setEditRow(po); setShowAdd(true) } })
      items.push({ label: '🗑️ ยกเลิกใบสั่งซื้อ', danger: true, disabled: !!lock, disabledTitle: lock || undefined, onClick: () => setDeleteId(po.id) })
    }
    items.push({ label: '👁️ ดูตัวอย่างก่อนพิมพ์', onClick: () => setDocRow({ po, action: null }) })
    items.push({ label: '🖨️ พิมพ์', onClick: () => setDocRow({ po, action: 'print' }) })
    items.push({ label: '📄 ดาวน์โหลด PDF', onClick: () => setDocRow({ po, action: 'pdf' }) })
    items.push({ label: '🖼️ ดาวน์โหลด JPEG', onClick: () => setDocRow({ po, action: 'jpg' }) })
    if (canEdit && po.status === 'received') {
      if (po.expense_id && !taxInvoiceLinks?.get(po.id)) items.push({ label: '🔄 สลับใบกำกับภาษี', onClick: () => setSwapInvoiceRow(po) })
      items.push({ label: '↩️ สร้างใบลดหนี้', onClick: () => openCreditNote(po) })
    }
    return items
  }
```
(remove the now-unused `editLocked` const in the row map and the `TrashIcon, PencilIcon` import if nothing else uses them).

(j) modal renders (lines 1187-1189):

```jsx
      {docRow && <PODocumentModal po={docRow.po} autoAction={docRow.action} tenant={tenant} onClose={() => setDocRow(null)} />}

      {detailRow && <PODetailModal po={detailRow} taxBadge={poTaxInvoiceBadge(detailRow, taxInvoiceLinks)} tenantId={tenant?.id}
        onClose={() => setDetailRow(null)}
        onViewDocument={po => { setDetailRow(null); setDocRow({ po, action: null }) }} />}
```

- [ ] **Step 4: Run harness and tests**

```bash
node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs   # alone; expect ALL PASS
npx vitest run
npx vite build --outDir "$TMPDIR/po-build" --emptyOutDir
```
Add one line to `scripts/tax-invoice-harness/README.md` PO section: "Section 7: row layout (📄 + ⋯), popup ledger, document actions, money locks; mocks `__money`, `__ledger`."

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseOrders.jsx src/index.css scripts/tax-invoice-harness/runPo.mjs scripts/tax-invoice-harness/README.md
git commit -m "feat: PO row with 📄 popup and ⋯ menu; popup shows lines, receipts, deposit remaining and bills"
```

---

### Task 8: Create-deposit dialog (สร้างใบจ่ายมัดจำ)

**Files:**
- Create: `src/components/CreatePoDepositModal.jsx`
- Modify: `src/pages/PurchaseOrders.jsx` (render for `depositPo`, next to the other modals)
- Modify: `scripts/tax-invoice-harness/runPo.mjs`

**Interfaces:**
- Consumes: `depositFromPo`, `DEPOSIT_INPUT_TEXT` (Task 2); `createPoDeposit` (Task 6); `mapPoReceiptRpcError` (Task 6); `calcPoTotals`; `bangkokTodayIso`.
- Produces: `<CreatePoDepositModal po onDone(result) onClose />`.

- [ ] **Step 1: Write the failing harness scenarios** (append to `runPo.mjs` before the final error check)

```js
console.log('=== 8 create deposit')
await set('__money', []); await set('__wrapperError', null); await render()
await openMenu(/PO-C/); await menuItem('💰 สร้างใบจ่ายมัดจำ').click(); await wait(400)
let m = page.locator('.modal')
ok('dialog shows PO total 1,070.00', (await m.innerText()).includes('1,070.00'))
const confirmDep = page.getByRole('button', { name: '✅ สร้างใบมัดจำ' })
ok('confirm disabled while empty', await confirmDep.isDisabled())
await m.getByLabel('ยอด', { exact: true }).fill('50')
ok('50 % preview 535.00 = 500.00 + 35.00', (await m.innerText()).includes('535.00') && (await m.innerText()).includes('500.00') && (await m.innerText()).includes('35.00'))
ok('still disabled without number', await confirmDep.isDisabled())
await m.getByLabel('เลขที่ใบเสร็จ/ใบกำกับมัดจำ').fill('DEP-C')
await m.getByLabel('ยอด', { exact: true }).fill('101')
ok('101 % shows error and disables', (await m.innerText()).includes('ไม่เกิน 100') && await confirmDep.isDisabled())
await m.getByText('จำนวนเงิน (รวม VAT)').click(); await m.getByLabel('ยอด', { exact: true }).fill('2000')
ok('amount over PO total shows error', (await m.innerText()).includes('เกินยอดใบสั่งซื้อ') && await confirmDep.isDisabled())
await m.getByLabel('ยอด', { exact: true }).fill('535')
await set('__wrapperDelay', 300)
await confirmDep.click(); await wait(50)
ok('busy: confirm disabled during the call (no double submit)', await confirmDep.isDisabled())
await wait(500); await set('__wrapperDelay', 0)
L = await log()
const depCall = L.filter(x => x[1] === 'create_po_deposit')
ok('one RPC call with amount mode', depCall.length === 1 && JSON.parse(depCall[0][2]).mode === 'amount' && JSON.parse(depCall[0][2]).invoiceNo === 'DEP-C', JSON.stringify(L))
ok('dialog closed, toast shown', (await page.locator('.modal').count()) === 0 && (await text()).includes('สร้างใบมัดจำแล้ว'))
await render()
await set('__wrapperError', { message: 'deposit_invoice_no_taken' })
await openMenu(/PO-C/); await menuItem('💰 สร้างใบจ่ายมัดจำ').click(); await wait(400)
m = page.locator('.modal')
await m.getByLabel('ยอด', { exact: true }).fill('10'); await m.getByLabel('เลขที่ใบเสร็จ/ใบกำกับมัดจำ').fill('DEP-C')
await page.getByRole('button', { name: '✅ สร้างใบมัดจำ' }).click(); await wait(300)
ok('error shown in Thai inside the dialog, dialog stays open', (await m.innerText()).includes('เลขที่มัดจำนี้มีในระบบแล้ว') && (await page.locator('.modal').count()) === 1)
await set('__wrapperError', null)
await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click(); await wait(200)
```

- [ ] **Step 2: Run harness — expect FAIL** (`node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs`).

- [ ] **Step 3: Implement**

```jsx
// src/components/CreatePoDepositModal.jsx
// สร้างใบจ่ายมัดจำจากใบสั่งซื้อ: percent of the PO total or an amount (both incl. VAT); VAT split follows the PO.
// create_po_deposit is the authority; depositFromPo shows the same numbers first.
import { useState } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { createPoDeposit } from '../hooks/useSupabase.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { depositFromPo, DEPOSIT_INPUT_TEXT } from '../lib/poPaymentMath.js'
import { mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

export default function CreatePoDepositModal({ po, onDone, onClose }) {
  const t = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat)
  const today = bangkokTodayIso()
  const [mode, setMode] = useState('percent')
  const [value, setValue] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [date, setDate] = useState(today)
  const [method, setMethod] = useState('transfer')
  const [status, setStatus] = useState('paid')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const calc = depositFromPo({ mode, value, poTotal: t.total, hasVat: po.has_vat })
  const canSave = !busy && !calc.code && invoiceNo.trim() !== '' && !!date && date <= today

  const save = async () => {
    if (!canSave) return
    setBusy(true); setError('')
    try {
      const res = await createPoDeposit({ poId: po.id, mode, value, invoiceNo: invoiceNo.trim(), date, paymentMethod: method, status })
      onDone(res)
    } catch (e) {
      setError(mapPoReceiptRpcError(e)); setBusy(false)
    }
  }

  return (
    <Modal title={`สร้างใบจ่ายมัดจำ — ${po.po_number}`} onClose={() => { if (!busy) onClose() }} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{po.suppliers?.name || '—'} · ยอดใบสั่งซื้อ <span className="font-mono">{fmt(t.total)}</span> บาท (รวม VAT)</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="dep-mode" checked={mode === 'percent'} onChange={() => setMode('percent')} /> เปอร์เซ็นต์ของใบสั่งซื้อ
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="dep-mode" checked={mode === 'amount'} onChange={() => setMode('amount')} /> จำนวนเงิน (รวม VAT)
          </label>
        </div>
        <div>
          <label className="label" htmlFor="dep-value">ยอด</label>
          <input id="dep-value" aria-label="ยอด" className="input font-mono" type="number" min="0" step="0.01" value={value} onChange={e => setValue(e.target.value)}
            placeholder={mode === 'percent' ? 'เช่น 50' : 'เช่น 110600.55'} />
          {value !== '' && calc.code && <div style={{ color: 'var(--red)', marginTop: 4 }}>{DEPOSIT_INPUT_TEXT[calc.code]}</div>}
          {!calc.code && (
            <div style={{ marginTop: 4, color: 'var(--text2)' }}>
              มัดจำ <span className="font-mono">{fmt(calc.gross)}</span> = ก่อน VAT <span className="font-mono">{fmt(calc.net)}</span> + VAT <span className="font-mono">{fmt(calc.vat)}</span> ({calc.pctOfPo}% ของใบสั่งซื้อ)
            </div>
          )}
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="dep-no">เลขที่ใบเสร็จ/ใบกำกับมัดจำ ★</label>
            <input id="dep-no" aria-label="เลขที่ใบเสร็จ/ใบกำกับมัดจำ" className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="dep-date">วันที่จ่ายมัดจำ ★</label>
            <input id="dep-date" type="date" className="input" max={today} value={date} onChange={e => setDate(e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">วิธีชำระ</label>
            <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="transfer">โอนเงิน</option><option value="check">เช็ค</option><option value="cash">เงินสด</option>
            </select>
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="paid">✅ จ่ายแล้ว</option><option value="pending">⏳ ค้างจ่าย</option>
            </select>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>มัดจำจะถูกบันทึกเป็นรายจ่ายรายการแรกของใบสั่งซื้อนี้ และหักได้ตอนรับของ</div>
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{busy ? '⏳...' : '✅ สร้างใบมัดจำ'}</button>
      </div>
    </Modal>
  )
}
```

In `PurchaseOrders.jsx`: `import CreatePoDepositModal from '../components/CreatePoDepositModal.jsx'` and render next to the other modals:

```jsx
      {depositPo && (
        <CreatePoDepositModal po={depositPo} onClose={() => setDepositPo(null)}
          onDone={async res => {
            await auditLog('expenses', res.expense_id, 'INSERT', null, { po_id: depositPo.id, via: 'create_po_deposit', deposit_id: res.deposit_id, amount: res.amount })
            setDepositPo(null); refetchAll(); showToast('สร้างใบมัดจำแล้ว ' + fmt(res.amount) + ' บาท')
          }} />
      )}
```

- [ ] **Step 4: Run harness (alone) + vitest + build** — expect `ALL PASS`, green, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/CreatePoDepositModal.jsx src/pages/PurchaseOrders.jsx scripts/tax-invoice-harness/runPo.mjs
git commit -m "feat: create a deposit from a PO (percent or amount, VAT split from the PO)"
```

---

### Task 9: Receive dialog (รับทั้งหมด / รับบางรายการ, received date, deduction, bill preview)

**Files:**
- Create: `src/components/ReceivePoLinesModal.jsx`
- Modify: `src/pages/PurchaseOrders.jsx` (`receiveStockPlan` lines 928-955; delete `handleReceive` lines 957-1009 and the old receive `ConfirmDialog` lines 1191-1244; remove now-unused imports `ReceiveDepositBlock`, `mapReceiveRpcError`, `canConfirmReceive`, `receivePoWithDeposits`, `receiveTotals`, `depositSel` state + effect)
- Modify: `scripts/tax-invoice-harness/runPo.mjs` (sections 3-5 now drive the new dialog; new section 9)

**Interfaces:**
- Consumes: `usePoLedger`, `useSupplierDeposits`, `receivePoLines` (Task 6); `openDeposits` (`receiveDeposits.js`); `receiptValue`, `outstandingItems`, `defaultDeduction`, `computeReceiveDeductions`, `DEDUCTION_INPUT_TEXT` (Task 1); `mapPoReceiptRpcError`; `computeWeightedAverageCost`.
- Produces: `<ReceivePoLinesModal po stockPlanFor(po, lineIds) stockBalances onDone(result) onClose />`; `receiveStockPlan(po, lineIds?)` now returns `[{ poItemId, inventoryItemId, name, baseUnit, baseQty, unitCostPerBase, unconverted }]` filtered to `lineIds` when given.

Rulings: the dialog stays open on an RPC error and shows the Thai message (the RPC is atomic, nothing was saved); confirm is disabled while ledger/deposits load, while busy, with no line chosen, with a future/blank date, with any deduction error, and when a chosen stock line would post a base quantity <= 0; the PO's own deposit is pre-ticked with the R4 default and follows the chosen lines until the user edits it; other open deposits of the supplier are listed unticked (R6).

- [ ] **Step 1: Write the failing harness scenarios**

Update sections 3-5 of `runPo.mjs`: after `menuItem('📦 รับของ').click()` the dialog is `.modal`; its confirm button is `page.getByRole('button', { name: '✅ ยืนยันรับของ' })`; assertions change as follows: section 3 expects `L.filter(x => x[1] === 'receive_po_lines').length === 1` and NO `record_stock_movement` client call (stock is posted by the RPC) and the call's `stock` array has one entry for item line; section 4 (flagged PO) expects the note text and `JSON.parse(call[2]).stock.length === 0`; section 5's injected errors move from `__rpcError` to `__wrapperError` and are asserted INSIDE the still-open dialog (`(await page.locator('.modal').innerText()).includes(...)`) instead of `alerts`.

Append section 9:

```js
console.log('=== 9 receive dialog: all / some lines, date, deduction, preview')
await set('__wrapperError', null)
await page.evaluate(() => {
  window.__deposits = [{ id: 'dG', deposit_invoice_no: 'DEP-G', expense: { id: 'eG', supplier_id: '11111111-1111-1111-1111-111111111111', amount: 32100, amount_no_vat: 30000, vat: 2100 }, applications: [] }]
  window.__money = [['G', { receivedItemIds: [], depositId: 'dG' }]]
  window.__ledger = { G: { receipts: [], deposit: { id: 'dG', deposit_invoice_no: 'DEP-G', pct_of_po: 30, expenses: { amount_no_vat: 30000, vat: 2100, status: 'paid' }, po_deposit_applications: [] }, applications: [], bills: [] } }
  const g = window.__data.pos.find(p => p.id === 'G'); g.status = 'ordered'
})
await render()
await openMenu(/PO-G/); await menuItem('📦 รับของ').click(); await wait(500)
m = page.locator('.modal')
const confirmRcv = page.getByRole('button', { name: '✅ ยืนยันรับของ' })
t = await m.innerText()
ok('receive all: whole PO 107,000.00', t.includes('107,000.00'), t)
ok('own deposit pre-ticked with the whole remaining (final receipt): 32,100.00', (await m.getByLabel('ยอดหัก DEP-G').inputValue()) === '32100')
ok('bill preview 70,000.00 + 4,900.00 = 74,900.00', t.includes('บิลที่จะสร้าง') && t.includes('74,900.00'), t)
await m.getByText('รับบางรายการ').click(); await wait(100)
ok('some lines: nothing chosen -> confirm disabled', await confirmRcv.isDisabled())
await m.getByLabel('เหล็ก', { exact: true }).check(); await wait(100)
t = await m.innerText()
ok('one line: value 64,200.00, default deduction 19,260 (30 %)', t.includes('64,200.00') && (await m.getByLabel('ยอดหัก DEP-G').inputValue()) === '19260', t)
ok('preview 44,940.00 and remaining after shown', t.includes('44,940.00'), t)
await m.getByLabel('ยอดหัก DEP-G').fill('99999'); await wait(100)
ok('too large deduction: Thai error, confirm disabled', (await m.innerText()).includes('เกินยอดมัดจำคงเหลือ') && await confirmRcv.isDisabled())
await m.getByRole('button', { name: '%' }).click(); await m.getByLabel('ยอดหัก DEP-G').fill('30'); await wait(100)
ok('percent mode 30 % -> 19,260.00', (await m.innerText()).includes('19,260.00'))
const dateBox = m.getByLabel('วันที่รับสินค้า')
await dateBox.fill('2099-01-01'); await wait(100)
ok('future date disables confirm', await confirmRcv.isDisabled())
await dateBox.fill('2026-10-01'); await wait(100)
await set('__wrapperDelay', 300)
await confirmRcv.click(); await wait(50)
ok('confirm disabled while busy', await confirmRcv.isDisabled())
await wait(500); await set('__wrapperDelay', 0)
L = await log()
const rc = L.filter(x => x[1] === 'receive_po_lines')
const args = rc.length ? JSON.parse(rc[0][2]) : {}
ok('one RPC call with the chosen line, date, percent deduction and stock plan',
  rc.length === 1 && args.lineIds.length === 1 && args.receivedDate === '2026-10-01' && args.deductions[0].mode === 'percent' && args.deductions[0].value === 30
  && args.subtotal === 60000 && args.vat === 4200 && args.stock.length === 1 && args.stock[0].base_qty > 0, JSON.stringify(args))
ok('dialog closed with toast incl. receipt number', (await page.locator('.modal').count()) === 0 && (await text()).includes('PO-X-R1'))
await page.setViewportSize({ width: 375, height: 740 }); await render()
await openMenu(/PO-G/); await menuItem('📦 รับของ').click(); await wait(500)
const cb = await page.getByRole('button', { name: '✅ ยืนยันรับของ' }).boundingBox()
ok('mobile 375px: confirm button reachable', !!cb && cb.x + cb.width <= 375 + 1, JSON.stringify(cb))
await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click(); await wait(200)
await page.setViewportSize({ width: 1280, height: 800 })
```

- [ ] **Step 2: Run harness — expect FAIL.**

- [ ] **Step 3: Implement**

`receiveStockPlan` in `PurchaseOrders.jsx` becomes:

```js
  const receiveStockPlan = (po, lineIds) => {
    if (!po) return []
    const only = lineIds ? new Set(lineIds) : null
    return (po.purchase_order_items || [])
      .filter(it => it.inventory_item_id && (!only || only.has(it.id)))
      .map(it => {
        const invItem = (allInventoryItems || []).find(i => i.id === it.inventory_item_id)
        const profile = it.aluminum_profile_id ? (allAluminumProfiles || []).find(p => p.id === it.aluminum_profile_id) : null
        const factor = (unitFactors || []).find(f => f.inventory_item_id === it.inventory_item_id && f.unit_name === it.unit)
        const { baseQty, unconverted } = computePoItemBaseQty(it, invItem, profile, factor)
        const netLinePrice = it.unit_price * (1 - (it.discount_pct || 0) / 100)
        let unitCostPerBase = baseQty > 0 ? (it.quantity * netLinePrice) / baseQty : netLinePrice
        if (po.has_vat && po.price_includes_vat) unitCostPerBase = unitCostPerBase / (1 + VAT_RATE)
        return { poItemId: it.id, inventoryItemId: it.inventory_item_id, name: invItem?.name || it.description, baseUnit: invItem?.base_unit || it.unit, baseQty, unitCostPerBase, unconverted }
      })
  }
```
(keep the two explanatory comments from the old body). Replace the old receive `ConfirmDialog` render with:

```jsx
      {receiveRow && (
        <ReceivePoLinesModal po={receiveRow} stockPlanFor={receiveStockPlan} stockBalances={stockBalances}
          onClose={() => setReceiveRow(null)}
          onDone={async res => {
            const po = receiveRow
            if (res.expense_id) await auditLog('expenses', res.expense_id, 'INSERT', null, { po_id: po.id, via: 'receive_po_lines', receipt_no: res.receipt_no })
            await auditLog('purchase_orders', po.id, 'UPDATE', null, { via: 'receive_po_lines', status: res.status, receipt_no: res.receipt_no, receipt_id: res.receipt_id, expense_id: res.expense_id })
            setReceiveRow(null); refetchAll(); refetchInventoryItems()
            showToast(`รับของแล้ว (${res.receipt_no}) ` + (res.expense_id ? 'สร้างบิลแล้ว' : 'หักมัดจำครบ ไม่สร้างบิล') + (po.stock_from_invoice ? ' · สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษี' : ''))
          }} />
      )}
```

```jsx
// src/components/ReceivePoLinesModal.jsx
// รับของ: receive all / some lines (whole lines, R1), received date (dates the stock, R2), deposit deduction
// (percent | value, VAT-inclusive, R4/R5) and the bill preview. receive_po_lines is the authority and does
// everything (bill, deduction, stock, status) in one transaction.
import { useState, useMemo } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { usePoLedger, useSupplierDeposits, receivePoLines } from '../hooks/useSupabase.js'
import { openDeposits } from '../lib/receiveDeposits.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { round2 } from '../lib/depositMath.js'
import { computeWeightedAverageCost } from '../lib/inventoryCost.js'
import { receiptValue, outstandingItems, defaultDeduction, computeReceiveDeductions, DEDUCTION_INPUT_TEXT } from '../lib/poReceiptMath.js'
import { mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

export default function ReceivePoLinesModal({ po, stockPlanFor, stockBalances, onDone, onClose }) {
  const today = bangkokTodayIso()
  const { data: ledger, error: ledgerError } = usePoLedger(po.id)
  const { data: depRows, error: depError } = useSupplierDeposits(po.supplier_id)
  const [mode, setMode] = useState('all')
  const [picked, setPicked] = useState(() => new Set())
  const [receivedDate, setReceivedDate] = useState(today)
  const [sel, setSel] = useState({})        // user edits only: {[depositId]: {checked, mode, value}}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loaded = ledger != null && (depRows != null || depError != null)
  const receivedIds = useMemo(() => new Set((ledger?.receipts || []).flatMap(r => (r.po_receipt_items || []).map(i => i.po_item_id))), [ledger])
  const outstanding = useMemo(() => outstandingItems(po.purchase_order_items, receivedIds), [po, receivedIds])
  const lineIds = mode === 'all' ? outstanding.map(i => i.id) : outstanding.filter(i => picked.has(i.id)).map(i => i.id)
  const lineKey = lineIds.join(',')
  const receipt = useMemo(() => receiptValue({
    items: po.purchase_order_items, hasVat: po.has_vat, priceIncludesVat: po.price_includes_vat,
    lineIds, receivedItemIds: receivedIds, priorReceipts: ledger?.receipts || [],
  }), [po, lineKey, receivedIds, ledger]) // eslint-disable-line react-hooks/exhaustive-deps
  const ownId = ledger?.deposit?.id || null
  const deposits = useMemo(() => {
    const rows = depError ? [] : openDeposits(depRows)
    return [...rows].sort((a, b) => (a.id === ownId ? -1 : b.id === ownId ? 1 : 0))
  }, [depRows, depError, ownId])
  const poTotal = calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat).total

  // the own deposit follows the chosen lines with the R4 default until the user edits it
  const selection = useMemo(() => {
    const out = { ...sel }
    const own = deposits.find(d => d.id === ownId)
    if (own && !sel[own.id] && lineIds.length) {
      const v = defaultDeduction({ own: true, depositGross: round2(Number(own.expense.amount_no_vat) + Number(own.expense.vat)), poTotal,
        remaining: own.remaining, receiptTotal: receipt.total, isFinal: receipt.isFinal })
      out[own.id] = { checked: v !== '', mode: 'value', value: v }
    }
    return out
  }, [sel, deposits, ownId, lineKey, receipt, poTotal]) // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => computeReceiveDeductions({ deposits, supplierId: po.supplier_id, selection, receipt }), [deposits, po.supplier_id, selection, receipt])
  const stock = po.stock_from_invoice ? [] : stockPlanFor(po, lineIds)
  const stockBad = stock.some(s => !(s.baseQty > 0))
  const canConfirm = loaded && !ledgerError && !busy && lineIds.length > 0 && result.valid && !stockBad && !!receivedDate && receivedDate <= today

  const covered = id => deposits.reduce((s, d) => (d.id !== id && result.lines[d.id] ? s + result.lines[d.id].gross : s), 0)
  const toggle = (d, checked) => setSel(prev => ({ ...prev, [d.id]: {
    checked, mode: prev[d.id]?.mode || 'value',
    value: checked ? (prev[d.id]?.value || defaultDeduction({ own: d.id === ownId, depositGross: round2(Number(d.expense.amount_no_vat) + Number(d.expense.vat)),
      poTotal, remaining: d.remaining, receiptTotal: receipt.total, isFinal: receipt.isFinal, alreadyCovered: covered(d.id) })) : (prev[d.id]?.value ?? ''),
  } }))
  const edit = (d, patch) => setSel(prev => ({ ...prev, [d.id]: { ...(selection[d.id] || { checked: true, mode: 'value', value: '' }), checked: true, ...patch } }))

  const confirm = async () => {
    if (!canConfirm) return
    setBusy(true); setError('')
    try {
      const res = await receivePoLines({
        poId: po.id, lineIds, receivedDate, deductions: result.deductions, subtotal: receipt.subtotal, vat: receipt.vat,
        stock: stock.map(s => ({ po_item_id: s.poItemId, base_qty: s.baseQty, unit_cost: s.unitCostPerBase })),
      })
      onDone(res)
    } catch (e) {
      setError(mapPoReceiptRpcError(e)); setBusy(false)
    }
  }

  const { plan } = result
  return (
    <Modal title={`รับของ — ${po.po_number}`} onClose={() => { if (!busy) onClose() }} maxWidth={620}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{po.suppliers?.name || '—'} · ยอดใบสั่งซื้อ <span className="font-mono">{fmt(poTotal)}</span> · รับแล้ว {receivedIds.size}/{(po.purchase_order_items || []).length} รายการ</div>
        {!loaded && <div style={{ color: 'var(--text3)' }}>⏳ กำลังโหลด...</div>}
        {ledgerError && <div style={{ color: 'var(--red)' }}>โหลดข้อมูลการรับของไม่สำเร็จ — ปิดแล้วเปิดใหม่</div>}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="rcv-mode" checked={mode === 'all'} onChange={() => setMode('all')} /> รับทั้งหมด ({outstanding.length} รายการ)
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="rcv-mode" checked={mode === 'some'} onChange={() => setMode('some')} /> รับบางรายการ
          </label>
        </div>
        {mode === 'some' && (
          <div style={{ display: 'grid', gap: 4 }}>
            {outstanding.map(it => (
              <label key={it.id} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" aria-label={it.description} checked={picked.has(it.id)}
                  onChange={e => setPicked(prev => { const n = new Set(prev); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n })} />
                <span style={{ flex: 1 }}>{it.description} ({it.quantity} {it.unit || ''})</span>
                <span className="font-mono">{fmt(it.line_total)}</span>
              </label>
            ))}
          </div>
        )}
        <div style={{ maxWidth: 220 }}>
          <label className="label" htmlFor="rcv-date">วันที่รับสินค้า ★</label>
          <input id="rcv-date" aria-label="วันที่รับสินค้า" type="date" className="input" max={today} value={receivedDate} onChange={e => setReceivedDate(e.target.value)} />
          {receivedDate > today && <div style={{ color: 'var(--red)', marginTop: 2 }}>วันที่รับสินค้าต้องไม่เกินวันนี้</div>}
        </div>
        <div>
          มูลค่ารับครั้งนี้: ก่อน VAT <span className="font-mono">{fmt(receipt.subtotal)}</span> · VAT <span className="font-mono">{fmt(receipt.vat)}</span> · รวม <span className="font-mono">{fmt(receipt.total)}</span>
          {receipt.isFinal && receivedIds.size > 0 && <span style={{ color: 'var(--text3)' }}> (ครั้งสุดท้าย — ปัดเศษให้ครบยอดใบสั่งซื้อ)</span>}
        </div>
        {deposits.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <strong>หักมัดจำ</strong>
            {deposits.map(d => {
              const s = selection[d.id] || {}
              const err = result.errors[d.id]
              const remGross = round2(Number(d.remaining.net) + Number(d.remaining.vat))
              return (
                <div key={d.id} style={{ marginTop: 6 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!s.checked} onChange={e => toggle(d, e.target.checked)} />
                    <span>{d.deposit_invoice_no || 'มัดจำ'}{d.id === ownId ? ' (มัดจำของใบสั่งซื้อนี้)' : ''} · คงเหลือ <span className="font-mono">{fmt(remGross)}</span></span>
                  </label>
                  {s.checked && (
                    <div style={{ marginLeft: 22, marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button type="button" className={`btn btn-sm ${s.mode === 'value' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => edit(d, { mode: 'value' })}>บาท</button>
                      <button type="button" className={`btn btn-sm ${s.mode === 'percent' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => edit(d, { mode: 'percent' })}>%</button>
                      <input className="input font-mono" type="number" min="0" step="0.01" style={{ width: 150 }} aria-label={`ยอดหัก ${d.deposit_invoice_no || 'มัดจำ'}`}
                        value={s.value ?? ''} onChange={e => edit(d, { value: e.target.value })} />
                      <span>{s.mode === 'percent' ? '% ของมูลค่ารับครั้งนี้ (รวม VAT)' : 'บาท (รวม VAT)'}</span>
                      {result.lines[d.id] && (
                        <span style={{ color: 'var(--text3)' }}>หัก <span className="font-mono">{fmt(result.lines[d.id].gross)}</span> = ก่อน VAT {fmt(result.lines[d.id].net)} + VAT {fmt(result.lines[d.id].vat)} · เหลือหลังหัก {fmt(round2(remGross - result.lines[d.id].gross))}</span>
                      )}
                      {err && <div style={{ color: 'var(--red)', width: '100%' }}>{DEDUCTION_INPUT_TEXT[err] || err}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div style={{ fontWeight: 600 }}>
          {(plan.overNet || plan.overVat)
            ? <span style={{ color: 'var(--red)' }}>{plan.overVat && !plan.overNet ? 'VAT ที่หักเกิน VAT ของการรับครั้งนี้' : 'ยอดหักเกินมูลค่าที่รับครั้งนี้'}</span>
            : plan.createExpense
              ? <>บิลที่จะสร้าง: ก่อน VAT <span className="font-mono">{fmt(plan.netToPay)}</span> · VAT <span className="font-mono">{fmt(plan.vatToPay)}</span> · ยอดชำระ <span className="font-mono">{fmt(plan.total)}</span></>
              : 'ไม่สร้างบิล (หักครบ)'}
        </div>
        {po.stock_from_invoice && <div style={{ color: '#b45309' }}>📦 ไม่ลงสต็อกตอนรับของ — สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษีผู้ขาย</div>}
        {!po.stock_from_invoice && stock.length > 0 && (
          <div style={{ fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <strong>จะบันทึกเข้าสต็อก (วันที่ {receivedDate}):</strong>
            {stock.map(p => {
              if (!(p.baseQty > 0)) return <div key={p.poItemId} style={{ marginTop: 4, color: 'var(--red)' }}>⚠️ {p.name}: จำนวนลงสต็อกเป็น 0 — แก้รายการก่อนรับของ</div>
              if (p.unconverted) return <div key={p.poItemId} style={{ marginTop: 4, color: 'var(--red)' }}>⚠️ {p.name}: ไม่พบข้อมูลหน้าตัด/ขนาดที่ต้องใช้แปลงหน่วย — จะบันทึกเป็น {fmt(p.baseQty)} {p.baseUnit} (อาจไม่ถูกต้อง) กรุณาตรวจสอบก่อนยืนยัน</div>
              const bal = (stockBalances || []).find(b => b.inventory_item_id === p.inventoryItemId && b.site_id === po.site_id)
              const oldQty = bal?.quantity_on_hand || 0
              const newWac = computeWeightedAverageCost(oldQty, bal?.weighted_average_cost || 0, p.baseQty, p.unitCostPerBase)
              return <div key={p.poItemId} style={{ marginTop: 4 }}>📦 {p.name}: +{fmt(p.baseQty)} {p.baseUnit} → คงเหลือ {fmt(oldQty + p.baseQty)} {p.baseUnit} @ เฉลี่ย {fmt(newWac)}/{p.baseUnit}</div>
            })}
          </div>
        )}
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={confirm}>{busy ? '⏳...' : '✅ ยืนยันรับของ'}</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 4: Run harness (alone) + vitest + build** — `ALL PASS`, green, OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/ReceivePoLinesModal.jsx src/pages/PurchaseOrders.jsx scripts/tax-invoice-harness/runPo.mjs
git commit -m "feat: receive dialog with all/some lines, received date, per-receipt deposit deduction and bill preview"
```

---

### Task 10: Expenses — จ่ายบางส่วน (split payment) and delete/reconcile messages

**Files:**
- Create: `src/components/SplitPaymentModal.jsx`
- Create: `scripts/tax-invoice-harness/buildExp.mjs`, `entryExp.jsx`, `mockExpHooks.js`, `runExp.mjs`
- Modify: `src/pages/Expenses.jsx` (imports lines 12-14; `mapPoRevertError` line 66; state lines 387-388; `handleDelete` lines 510-532; actions cell lines 760-768; reconcile dialog lines 835-860; render the new modal)
- Modify: `scripts/tax-invoice-harness/README.md`

**Interfaces:**
- Consumes: `splitPaymentAmounts`, `SPLIT_INPUT_TEXT` (Task 2); `splitPayment`, `mapPoReceiptRpcError`, `PO_RECEIPT_LOCKED_TEXT` (Task 6).
- Produces: `<SplitPaymentModal expense onDone(result) onClose />`; Expenses row action `💸 จ่ายบางส่วน` shown when `canEdit && e.po_id && e.status === 'pending' && !e.cheque_id && !isCnExpense(e.id) && !depositOf(e.id) && Number(e.amount) > 0 && hasModuleAccess('purchase_orders')`.

Rulings: a credit supplier's bill starts `awaiting_billing`; R3 limits splitting to `pending`, so the user first switches it to ค้างจ่าย (the action is hidden until then, with no extra hint); the reconcile dialog after deleting a PO bill also checks `po_receipts` for the PO and shows the receipt lock text instead of offering un-receive.

- [ ] **Step 1: Write the failing harness** (new files)

`scripts/tax-invoice-harness/buildExp.mjs` — copy of `buildPo.mjs` with `entryPoints: [H + 'entryExp.jsx']`, `OUT = path.join(tmpdir(), 'exp-harness-out.js')`, and `hooks/useSupabase.js` resolved to `H + 'mockExpHooks.js'` (all other resolve rules identical).

`scripts/tax-invoice-harness/entryExp.jsx` — copy of `entryPo.jsx` importing `Page from 'SRC/pages/Expenses.jsx'`.

`scripts/tax-invoice-harness/mockExpHooks.js`:

```js
// Expenses page mocks (see README.md). W.__exp: expense rows (expenses_view shape); wrapper calls logged in W.__log.
import { useState, useEffect, useCallback, useMemo } from 'react'
const W = window
W.__log = W.__log || []
function useQuery(fn, deps = []) {
  const [data, setData] = useState(null); const [error, setError] = useState(null)
  const f = useCallback(async () => { try { setData(await fn()) } catch (e) { setError(e.message) } }, deps) // eslint-disable-line
  useEffect(() => { f() }, [f])
  return { data, loading: data == null, error, refetch: f }
}
const delay = (v, ms = 20) => new Promise(r => setTimeout(() => r(typeof v === 'function' ? v() : v), ms))
export const useExpenses = () => useQuery(() => delay(() => W.__exp || []), [W.__expVersion])
export const useSites = () => useQuery(() => delay([]))
export const useCategories = () => useQuery(() => delay([]))
export const useSuppliers = () => useQuery(() => delay([]))
export const useCheques = () => useQuery(() => delay([]))
export const useCreditNoteExpenseIds = () => useQuery(() => delay(() => new Set(W.__cnIds || [])))
export const useSupplierCreditNotes = () => useQuery(() => delay([]))
export function useDepositMap() { const m = useMemo(() => new Map(W.__depMap || []), []); return { data: m, refetch: () => {} } }
export const registerSupplierDeposit = async () => {}
export const splitPayment = async (args) => {
  W.__log.push(['rpc', 'split_payment', JSON.stringify(args)])
  if (W.__wrapperDelay) await new Promise(r => setTimeout(r, W.__wrapperDelay))
  if (W.__wrapperError) throw W.__wrapperError
  return { paid_expense_id: args.expenseId, remaining_expense_id: 'enew', paid_amount: Number(args.amount), remaining_amount: 1 }
}
```
If esbuild reports another missing export from `useSupabase.js` (imported by a component Expenses renders), add it here as `export const <name> = () => useQuery(() => delay([]))` (hooks) or `async () => {}` (actions) — never import the real module.

`scripts/tax-invoice-harness/runExp.mjs` (same skeleton as `runPo.mjs`: launch, block network, inject CSS + bundle from `exp-harness-out.js`, `ok()`, `PAGEERROR` counting, `ALL PASS`/exit code):

```js
// Expenses page scenarios. Run alone: node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'exp-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
const mk = (id, o = {}) => ({ id, date: today, description: 'จากใบสั่งซื้อ PO-1', site_name: 'Site A', category_name: 'วัสดุ', supplier: 'Sup', amount: 44940, amount_no_vat: 42000, vat: 2940, payment_method: 'transfer', status: 'pending', po_id: 'P1', cheque_id: null, invoice_no: null, ...o })
const rows = [
  mk('B1'),                                            // PO bill, pending -> split offered
  mk('B2', { status: 'awaiting_billing' }),            // awaiting billing -> not offered
  mk('B3', { po_id: null, description: 'ค่าน้ำ' }),     // not a PO bill -> not offered
  mk('B4', { cheque_id: 'c1', status: 'pending' }),   // cheque-linked -> not offered
  mk('B5', { status: 'paid' }),                        // paid -> not offered
]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(d => { window.__exp = d }, rows)
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
const wait = ms => page.waitForTimeout(ms)
const render = async () => { await page.evaluate(() => { window.__log = []; window.__render() }); await wait(600) }
const row = re => page.getByRole('row', { name: re })
const log = () => page.evaluate(() => window.__log)

console.log('=== 1 who gets จ่ายบางส่วน')
await render()
const has = async id => (await page.getByRole('row').filter({ has: page.locator(`text=${id === 'B3' ? 'ค่าน้ำ' : 'จากใบสั่งซื้อ'}`) }).count()) >= 0
const splitBtns = page.getByRole('button', { name: '💸 จ่ายบางส่วน' })
ok('only the pending PO bill offers split', (await splitBtns.count()) === 1)

console.log('=== 2 split dialog maths, guards, call')
await splitBtns.first().click(); await wait(300)
const m = page.locator('.modal')
const go = page.getByRole('button', { name: '✅ บันทึกการจ่ายบางส่วน' })
ok('dialog shows bill 44,940.00', (await m.innerText()).includes('44,940.00'))
ok('disabled while empty', await go.isDisabled())
await m.getByLabel('ยอดที่จ่ายครั้งนี้').fill('44940')
ok('whole bill refused', (await m.innerText()).includes('น้อยกว่ายอดบิล') && await go.isDisabled())
await m.getByLabel('ยอดที่จ่ายครั้งนี้').fill('20000')
let t = await m.innerText()
ok('preview paid 20,000.00 (VAT 1,308.41) and remaining 24,940.00 (VAT 1,631.59)', t.includes('1,308.41') && t.includes('24,940.00') && t.includes('1,631.59'), t)
await m.getByLabel('วันที่จ่าย').fill('2099-01-01')
ok('future paid date disables', await go.isDisabled())
await m.getByLabel('วันที่จ่าย').fill(today)
await page.evaluate(() => { window.__wrapperDelay = 300 })
await go.click(); await wait(50)
ok('busy: disabled during the call', await go.isDisabled())
await wait(500); await page.evaluate(() => { window.__wrapperDelay = 0 })
const L = await log()
const c = L.filter(x => x[1] === 'split_payment')
ok('one call with amount and date', c.length === 1 && JSON.parse(c[0][2]).amount === '20000' && JSON.parse(c[0][2]).paidDate === today, JSON.stringify(L))
ok('closed with toast', (await page.locator('.modal').count()) === 0 && (await page.locator('body').innerText()).includes('แยกบิลแล้ว'))

console.log('=== 3 server error stays in the dialog, in Thai')
await render()
await page.evaluate(() => { window.__wrapperError = { message: 'bill_not_pending' } })
await page.getByRole('button', { name: '💸 จ่ายบางส่วน' }).first().click(); await wait(300)
await page.locator('.modal').getByLabel('ยอดที่จ่ายครั้งนี้').fill('100')
await page.getByRole('button', { name: '✅ บันทึกการจ่ายบางส่วน' }).click(); await wait(300)
ok('Thai error, dialog open', (await page.locator('.modal').innerText()).includes('ค้างจ่าย') && !(await page.locator('.modal').innerText()).includes('bill_not_pending'))
await page.evaluate(() => { window.__wrapperError = null })
await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click(); await wait(200)

console.log('=== 4 mobile')
await page.setViewportSize({ width: 375, height: 740 }); await render()
await page.getByRole('button', { name: '💸 จ่ายบางส่วน' }).first().click(); await wait(300)
const bb = await page.getByRole('button', { name: '✅ บันทึกการจ่ายบางส่วน' }).boundingBox()
ok('confirm reachable at 375px', !!bb && bb.x + bb.width <= 376, JSON.stringify(bb))

const errs = await page.evaluate(() => window.__errors)
ok('no React errors', errs.length === 0, errs.join('\n'))
await browser.close()
console.log(fails ? `FAILED ${fails}` : 'ALL PASS')
process.exit(fails ? 1 : 0)
```
(Remove the unused `has` helper if your linter flags it.)

- [ ] **Step 2: Run — expect FAIL** (`node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs`).

- [ ] **Step 3: Implement**

```jsx
// src/components/SplitPaymentModal.jsx
// จ่ายบางส่วน (R3): the paid amount becomes this bill (status จ่ายแล้ว), the rest a new pending bill with the same
// invoice number and PO. split_payment is the authority; splitPaymentAmounts shows the same numbers first.
import { useState } from 'react'
import { Modal } from './Modal.jsx'
import { fmt } from '../lib/supabase.js'
import { splitPayment } from '../hooks/useSupabase.js'
import { splitPaymentAmounts, SPLIT_INPUT_TEXT } from '../lib/poPaymentMath.js'
import { mapPoReceiptRpcError } from '../lib/poReceiptErrors.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

export default function SplitPaymentModal({ expense, onDone, onClose }) {
  const today = bangkokTodayIso()
  const [amount, setAmount] = useState('')
  const [paidDate, setPaidDate] = useState(today)
  const [method, setMethod] = useState('transfer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const calc = splitPaymentAmounts(expense, amount)
  const canSave = !busy && amount !== '' && !calc.code && !!paidDate && paidDate <= today

  const save = async () => {
    if (!canSave) return
    setBusy(true); setError('')
    try { onDone(await splitPayment({ expenseId: expense.id, amount, paidDate, method })) }
    catch (e) { setError(mapPoReceiptRpcError(e)); setBusy(false) }
  }

  return (
    <Modal title="จ่ายบางส่วน (แยกบิล)" onClose={() => { if (!busy) onClose() }} maxWidth={440}>
      <div className="modal-body" style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div>{expense.description}{expense.invoice_no ? ` · #${expense.invoice_no}` : ''}</div>
        <div>ยอดบิล <span className="font-mono" style={{ color: 'var(--red)', fontWeight: 700 }}>{fmt(expense.amount)}</span> บาท</div>
        <div>
          <label className="label" htmlFor="sp-amt">ยอดที่จ่ายครั้งนี้ ★</label>
          <input id="sp-amt" aria-label="ยอดที่จ่ายครั้งนี้" className="input font-mono" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
          {amount !== '' && calc.code && <div style={{ color: 'var(--red)', marginTop: 4 }}>{SPLIT_INPUT_TEXT[calc.code]}</div>}
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="sp-date">วันที่จ่าย ★</label>
            <input id="sp-date" aria-label="วันที่จ่าย" type="date" className="input" max={today} value={paidDate} onChange={e => setPaidDate(e.target.value)} />
          </div>
          <div>
            <label className="label">วิธีชำระ</label>
            <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="transfer">โอนเงิน</option><option value="check">เช็ค</option><option value="cash">เงินสด</option>
            </select>
          </div>
        </div>
        {!calc.code && amount !== '' && (
          <div style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '8px 12px' }}>
            <div>จ่ายแล้ว <span className="font-mono">{fmt(calc.paid.amount)}</span>{calc.paid.vat != null && <> (ก่อน VAT {fmt(calc.paid.net)} · VAT {fmt(calc.paid.vat)})</>}</div>
            <div>คงค้าง (บิลใหม่) <span className="font-mono">{fmt(calc.rest.amount)}</span>{calc.rest.vat != null && <> (ก่อน VAT {fmt(calc.rest.net)} · VAT {fmt(calc.rest.vat)})</>}</div>
          </div>
        )}
        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{busy ? '⏳...' : '✅ บันทึกการจ่ายบางส่วน'}</button>
      </div>
    </Modal>
  )
}
```

`Expenses.jsx` changes:
- imports: `import SplitPaymentModal from '../components/SplitPaymentModal.jsx'` and `import { mapPoReceiptRpcError, PO_RECEIPT_LOCKED_TEXT } from '../lib/poReceiptErrors.js'`.
- line 66: `const mapPoRevertError = err => mapPoReceiptRpcError(err)` (it already covers `po_has_deposit_applications`, `po_has_receipts`, `po_has_deposit`).
- state: replace `const [reconcileLocked, setReconcileLocked] = useState(false)` with `const [reconcileLocked, setReconcileLocked] = useState('')   // '' = may un-receive; else the reason it cannot` and add `const [splitRow, setSplitRow] = useState(null)`.
- `handleDelete`: at the top of the `if (error)` branch add
  ```js
      const msg = String(error.message || '')
      if (msg.includes('expense_is_receipt_bill') || msg.includes('expense_is_split_part')) { alert(mapPoReceiptRpcError(error)); setDeleteId(null); return }
  ```
  and replace the reconcile block with:
  ```js
    if (row?.po_id) {
      let locked = ''
      const { count, error: appErr } = await supabase.from('po_deposit_applications').select('id', { count: 'exact', head: true }).eq('po_id', row.po_id)
      if (!appErr && (count || 0) > 0) locked = PO_DEPOSIT_LOCKED_TEXT
      const { count: rc, error: rcErr } = await supabase.from('po_receipts').select('id', { count: 'exact', head: true }).eq('po_id', row.po_id)
      if (!rcErr && (rc || 0) > 0) locked = PO_RECEIPT_LOCKED_TEXT    // table missing before the migration: rcErr, ignored
      setReconcileLocked(locked)
      setReconcilePoId(row.po_id)
    }
  ```
- reconcile dialog: `{reconcileLocked ? <p style={{ color: 'var(--text2)' }}>{reconcileLocked}</p> : <p ...existing text...</p>}` and the close button `onClick={() => { setReconcilePoId(null); setReconcileLocked('') }}` (the `!reconcileLocked` conditions stay valid with a string).
- actions cell (inside the `!isDepositLocked(e.id)` branch, before the edit button):
  ```jsx
                        {e.po_id && e.status === 'pending' && !e.cheque_id && !depositOf(e.id) && Number(e.amount) > 0 && hasModuleAccess('purchase_orders') && (
                          <button className="btn btn-sm btn-ghost" onClick={() => setSplitRow(e)}>💸 จ่ายบางส่วน</button>
                        )}
  ```
- render next to `DepositRegisterModal`:
  ```jsx
      {splitRow && (
        <SplitPaymentModal expense={splitRow} onClose={() => setSplitRow(null)}
          onDone={async res => {
            await auditLog('expenses', res.paid_expense_id, 'UPDATE', { amount: splitRow.amount, status: splitRow.status }, { amount: res.paid_amount, status: 'paid', via: 'split_payment' })
            await auditLog('expenses', res.remaining_expense_id, 'INSERT', null, { amount: res.remaining_amount, split_from: res.paid_expense_id })
            setSplitRow(null); refetch(); showToast('แยกบิลแล้ว — จ่าย ' + fmt(res.paid_amount) + ' คงค้าง ' + fmt(res.remaining_amount) + ' บาท')
          }} />
      )}
  ```

Add to the README: an "Expenses page scenarios" section with the run command and the mocks (`__exp`, `__cnIds`, `__depMap`, `__wrapperError`, `__wrapperDelay`).

- [ ] **Step 4: Run both harnesses (one after the other, never in parallel) + vitest + build**

```bash
node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs
node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs
npx vitest run && npx vite build --outDir "$TMPDIR/po-build" --emptyOutDir
```
Expected: both `ALL PASS`, vitest green, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/SplitPaymentModal.jsx src/pages/Expenses.jsx scripts/tax-invoice-harness/buildExp.mjs scripts/tax-invoice-harness/entryExp.jsx scripts/tax-invoice-harness/mockExpHooks.js scripts/tax-invoice-harness/runExp.mjs scripts/tax-invoice-harness/README.md
git commit -m "feat: pay part of a PO bill by splitting it (จ่ายบางส่วน); clear messages for receipt-bill deletes"
```

---

### Task 11: ไทย-เยอรมัน data fix (standalone, owner-approved, NOT part of the release)

**Files:**
- Create: `supabase/datafix/2026-10-09-thai-german-po2610-038.sql`

**Interfaces:**
- Consumes: live rows read 2026-10-07 (read-only): tenant `1b9affc4-2136-4ed1-b168-a36e6624e743`; PO `de73ede3-4a2f-48a4-a5e1-3c0f31c39854` (`PO2610-038`, received 2026-10-06, VAT excl., lines sum 206,730.00, `expense_id` = bill); supplier `3dcc6336-47b3-4fad-8be3-c3a2126ed773` (บริษัท ไทย-เยอรมันสเปเชียลตี้กลาส จำกัด); deposit expense `a9811a5e-83a3-4c06-aef5-129d85779b08` (24 Jul, invoice 2602543, 103,365.00 + 7,235.55 = 110,600.55, paid, `po_id` NULL, not registered); bill `c69b0dcb-4d78-466c-b4c2-62c4c0802a15` (invoice 2603202, 206,730.00 + 14,471.10 = 221,201.10, paid). Note: the same tenant has ANOTHER expense with invoice 2602543 (a 45-baht toll, 2025-01-31), so the script works by id only. Requires 2026-10-09-01 applied (uses `supplier_deposits.po_id`, `pct_of_po`).
- Produces: deposit registered with `po_id` = the PO and `pct_of_po` = 50; one application 103,365.00 + 7,235.55 (no receipt; legacy); bill = 103,365.00 + 7,235.55 = 110,600.55. PO stock, status and dates untouched.

- [ ] **Step 1: Re-read the live state (read-only) and confirm it still matches the Interfaces block**

```sql
SELECT po.po_number, po.status, po.expense_id, (SELECT sum(line_total) FROM purchase_order_items WHERE po_id = po.id) AS raw,
       (SELECT count(*) FROM supplier_deposits WHERE expense_id = 'a9811a5e-83a3-4c06-aef5-129d85779b08') AS dep_registered,
       (SELECT count(*) FROM po_deposit_applications WHERE po_id = po.id) AS apps,
       (SELECT count(*) FROM supplier_tax_invoice_pos WHERE po_id = po.id) AS tax_links,
       (SELECT row_to_json(e) FROM (SELECT amount, amount_no_vat, vat, invoice_no, status FROM expenses WHERE id = 'c69b0dcb-4d78-466c-b4c2-62c4c0802a15') e) AS bill
  FROM purchase_orders po WHERE po.id = 'de73ede3-4a2f-48a4-a5e1-3c0f31c39854';
```
Expected: `PO2610-038 | received | c69b0dcb-... | 206730 | 0 | 0 | 0 | {"amount":221201.10, ...,"invoice_no":"2603202"}`. If anything differs, STOP and report; do not adapt the script silently.

- [ ] **Step 2: Write the script**

```sql
-- ============================================================
-- ONE-OFF DATA FIX — ไทย-เยอรมัน PO2610-038 (owner-approved separately; NOT part of the code release).
-- What: register deposit 2602543 (expense a9811a5e..., 110,600.55 = 103,365.00 + 7,235.55, paid 24 Jul) for PO2610-038,
--       record its application to the PO (103,365.00 + 7,235.55), and reduce bill 2603202 (c69b0dcb...) from
--       221,201.10 to 110,600.55 = 103,365.00 + 7,235.55. Stock, PO status and dates are not touched.
-- When: AFTER 2026-10-09-01 is applied (uses supplier_deposits.po_id / pct_of_po).
-- Safety: every precondition is checked; any surprise -> RAISE 'ABORT ...' and nothing changes.
--         Idempotent: if the fix is already fully in place it only reports 'ALREADY APPLIED'.
-- Dry run first: run this file with the last line changed to ROLLBACK; (see the handoff), then for real with COMMIT;.
-- Run as the database owner from the main checkout: npx supabase db query --linked -f <this file>
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  c_tenant CONSTANT UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  c_po     CONSTANT UUID := 'de73ede3-4a2f-48a4-a5e1-3c0f31c39854';
  c_sup    CONSTANT UUID := '3dcc6336-47b3-4fad-8be3-c3a2126ed773';
  c_dep_e  CONSTANT UUID := 'a9811a5e-83a3-4c06-aef5-129d85779b08';
  c_bill   CONSTANT UUID := 'c69b0dcb-4d78-466c-b4c2-62c4c0802a15';
  po RECORD; de RECORD; bill RECORD; v_dep UUID; app RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'supplier_deposits' AND column_name = 'po_id') THEN
    RAISE EXCEPTION 'ABORT: apply migration 2026-10-09-01 first';
  END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = c_po FOR UPDATE;
  IF NOT FOUND OR po.tenant_id <> c_tenant OR po.po_number <> 'PO2610-038' OR po.supplier_id <> c_sup OR po.status <> 'received'
     OR po.expense_id IS DISTINCT FROM c_bill OR NOT po.has_vat OR po.price_includes_vat THEN
    RAISE EXCEPTION 'ABORT: PO state unexpected %', row_to_json(po);
  END IF;
  IF (SELECT sum(line_total) FROM purchase_order_items WHERE po_id = c_po) <> 206730 THEN RAISE EXCEPTION 'ABORT: PO lines changed'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = c_po AND active) THEN RAISE EXCEPTION 'ABORT: PO is linked to a tax invoice'; END IF;
  SELECT * INTO de FROM expenses WHERE id = c_dep_e FOR UPDATE;
  IF NOT FOUND OR de.tenant_id <> c_tenant OR de.supplier_id <> c_sup OR de.invoice_no <> '2602543' OR de.po_id IS NOT NULL
     OR de.amount <> 110600.55 OR de.amount_no_vat <> 103365 OR de.vat <> 7235.55 THEN
    RAISE EXCEPTION 'ABORT: deposit expense unexpected %', row_to_json(de);
  END IF;
  SELECT * INTO bill FROM expenses WHERE id = c_bill FOR UPDATE;
  IF NOT FOUND OR bill.tenant_id <> c_tenant OR bill.po_id IS DISTINCT FROM c_po OR bill.invoice_no <> '2603202' THEN
    RAISE EXCEPTION 'ABORT: bill unexpected %', row_to_json(bill);
  END IF;

  -- already done?
  SELECT id INTO v_dep FROM supplier_deposits WHERE expense_id = c_dep_e;
  IF v_dep IS NOT NULL THEN
    SELECT sum(amount_no_vat) AS n, sum(vat) AS v, count(*) AS c INTO app FROM po_deposit_applications WHERE deposit_id = v_dep AND po_id = c_po;
    IF (SELECT po_id FROM supplier_deposits WHERE id = v_dep) = c_po AND app.c = 1 AND app.n = 103365 AND app.v = 7235.55
       AND bill.amount = 110600.55 AND bill.amount_no_vat = 103365 AND bill.vat = 7235.55 THEN
      RAISE NOTICE 'ALREADY APPLIED — nothing changed';
      RETURN;
    END IF;
    RAISE EXCEPTION 'ABORT: partial state (deposit registered but not as expected) — investigate by hand';
  END IF;
  IF bill.amount <> 221201.10 OR bill.amount_no_vat <> 206730 OR bill.vat <> 14471.10 THEN RAISE EXCEPTION 'ABORT: bill amounts changed %', row_to_json(bill); END IF;
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = c_po) THEN RAISE EXCEPTION 'ABORT: PO already has deductions'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = c_po)
     OR EXISTS (SELECT 1 FROM supplier_deposits WHERE tenant_id = c_tenant AND lower(btrim(deposit_invoice_no)) = '2602543') THEN
    RAISE EXCEPTION 'ABORT: another deposit already uses this PO or number';
  END IF;

  INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id, pct_of_po, created_by)
  VALUES (c_tenant, c_dep_e, '2602543', c_po, 50, 'datafix 2026-10-09 (owner-approved)') RETURNING id INTO v_dep;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by)
  VALUES (c_tenant, v_dep, c_po, 103365.00, 7235.55, 'datafix 2026-10-09 (owner-approved)');
  UPDATE expenses
     SET amount_no_vat = 103365.00, vat = 7235.55, amount = 110600.55,
         notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'แก้ไข 2026-10-09: หักมัดจำ 2602543 (103,365.00 + 7,235.55) จากยอดเดิม 221,201.10')
   WHERE id = c_bill;
  RAISE NOTICE 'APPLIED: deposit %, application 103,365.00 + 7,235.55, bill 2603202 = 110,600.55', v_dep;
END $$;
COMMIT;
```

- [ ] **Step 3: Static check**

```bash
grep -c "RAISE EXCEPTION 'ABORT" supabase/datafix/2026-10-09-thai-german-po2610-038.sql   # expect >= 9
tail -1 supabase/datafix/2026-10-09-thai-german-po2610-038.sql                            # expect COMMIT;
```
Do NOT run it. Its dry run (with `ROLLBACK;`) and real run are owner steps in Task 12's handoff.

- [ ] **Step 4: Commit**

```bash
git add supabase/datafix/2026-10-09-thai-german-po2610-038.sql
git commit -m "chore(datafix): guarded idempotent fix for ไทย-เยอรมัน PO2610-038 deposit 2602543 (owner-run, not applied)"
```

---

### Task 12: Whole-branch verification and owner handoff

**Files:**
- Create: `docs/superpowers/plans/2026-10-09-po-deposit-partial-receipt-handoff.md`

**Interfaces:**
- Consumes: everything above.
- Produces: an owner handoff with the exact release order, dry-run commands, ACL checks and a live verification checklist.

- [ ] **Step 1: Run everything locally**

```bash
npx vitest run
npx vite build --outDir "$TMPDIR/po-build" --emptyOutDir
node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs
node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs
node scripts/tax-invoice-harness/build.mjs && node scripts/tax-invoice-harness/run.mjs     # tax-invoice page regression
```
Expected: all green / `ALL PASS` (harnesses run one at a time).

- [ ] **Step 2: Controller dry runs (rolled back) — every one must report its RESULT text**

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
M="$W/supabase/migrations/2026-10-09-01-po-receipts.sql $W/supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql $W/supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql"
for T in po_receipt_test_a po_receipt_test_b tax_invoice_multi_bill_test supplier_tax_invoice_test po_deposit_test supplier_credit_notes_test; do
  ( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"; cat $M
    grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/$T.sql
    echo "ROLLBACK;" ) > /tmp/dry_$T.sql
done
cd /Users/plfx/code/FacadeXPM/facadex-app
for T in po_receipt_test_a po_receipt_test_b tax_invoice_multi_bill_test supplier_tax_invoice_test po_deposit_test supplier_credit_notes_test; do
  echo "== $T"; npx supabase db query --linked -f /tmp/dry_$T.sql 2>&1 | tail -3
done
```
Expected: the first four print an error containing `RESULT: <name> ALL PASSED`; `po_deposit_test` prints the row `ALL PO DEPOSIT TESTS PASSED`; `supplier_credit_notes_test` prints its own pass marker (read its header for the exact text). Then confirm nothing persisted:

```sql
SELECT to_regclass('public.po_receipts') AS t1, to_regclass('public.supplier_tax_invoice_expense_stamps') AS t2,
       to_regprocedure('receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)') AS f,
       (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_deposits' AND column_name='po_id') AS c;
```
Expected: all NULL.

- [ ] **Step 3: Whole-branch review**

Ask the strongest available reviewer model to review `git diff main...HEAD` against the spec, this plan's Global Constraints and Review Focus. Specific asks: lock order and the `app.po_receipt_rpc` flag (can any client path set it? PostgREST exposes only the `public` schema); every new SECURITY DEFINER function's gate and grants; the client/server rounding mirrors (`receiptValue` vs `_po_receipt_value`, `deductionFromInput` vs the loop in `receive_po_lines`, `depositFromPo` vs `create_po_deposit`, `splitPaymentAmounts` vs `split_payment`); that the old client keeps working after each migration alone; PostgREST embed ambiguity of the new FKs (`supplier_deposits_po_fk`, `pda_receipt_fk`, `po_receipt_items_*`). Fix every Critical/Important finding before the handoff.

- [ ] **Step 4: Write the handoff** (`docs/superpowers/plans/2026-10-09-po-deposit-partial-receipt-handoff.md`) with exactly these sections:

1. **สิ่งที่สร้างเสร็จ** — one line per migration, RPC, dialog, harness; "nothing applied, nothing deployed, nothing pushed".
2. **ลำดับการปล่อย (REQUIRED ORDER)** —
   - Step 1 dry runs: the Step 2 loop above (quiet time; `lock_timeout` makes it give up instead of freezing the app; success looks like an ERROR containing `RESULT: ... ALL PASSED`), plus the "nothing persisted" query.
   - Step 2 apply, one file per transaction, in order 09-01, 09-02, 09-03:
     ```bash
     cd /Users/plfx/code/FacadeXPM/facadex-app
     W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
     for F in 2026-10-09-01-po-receipts 2026-10-09-02-po-receipt-rpcs 2026-10-09-03-tax-invoice-multi-bill; do
       ( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"; cat $W/supabase/migrations/$F.sql; echo "COMMIT;" ) > /tmp/apply_$F.sql
     done
     npx supabase db query --linked -f /tmp/apply_2026-10-09-01-po-receipts.sql      # must succeed before the next
     npx supabase db query --linked -f /tmp/apply_2026-10-09-02-po-receipt-rpcs.sql
     npx supabase db query --linked -f /tmp/apply_2026-10-09-03-tax-invoice-multi-bill.sql
     ```
     Each file alone keeps the deployed (old) client working: 09-01 only adds a status value, tables, columns and triggers that allow the legacy receive; 09-02 only adds functions; 09-03 re-creates post/void with the same signatures.
   - Step 3 `NOTIFY pgrst, 'reload schema';`
   - Step 4 ACL checks (every row must match):
     ```sql
     -- (a) tables: authenticated SELECT only, no anon
     SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name IN ('po_receipts','po_receipt_items','expense_splits','supplier_tax_invoice_expense_stamps')
        AND grantee IN ('anon','authenticated') GROUP BY 1,2 ORDER BY 1,2;      -- expect 4 rows: authenticated | SELECT
     -- (b) RLS on
     SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('po_receipts','po_receipt_items','expense_splits','supplier_tax_invoice_expense_stamps');  -- all true
     -- (c) functions
     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec, p.prosecdef
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname IN ('create_po_deposit','receive_po_lines','split_payment','_po_totals','_po_receipt_value','sd_validate_po','po_block_when_receipted',
                          'poi_block_when_receipted','expenses_block_receipt_bill_delete','_sti_stamp_other_bills','_sti_unstamp_other_bills',
                          'post_supplier_tax_invoice','void_supplier_tax_invoice','receive_po_with_deposits');
     -- expect anon_exec = false everywhere; auth_exec = true ONLY for create_po_deposit, receive_po_lines, split_payment,
     -- post_/void_supplier_tax_invoice, receive_po_with_deposits; every _helper and trigger function auth_exec = false.
     -- (d) triggers exist (4 rows)
     SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
       ('sd_validate_po_trg','po_block_when_receipted_trg','poi_block_when_receipted_trg','expenses_block_receipt_bill_delete_trg');
     -- (e) status CHECK lists partially_received
     SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'purchase_orders_status_check';
     ```
     If any check fails: stop, do not deploy, send the output.
   - Step 5 deploy the web app with the `chang-ship` skill (build + `wrangler deploy` from a branch that contains everything live; check the bundle points to CHANG, not Tokyo). Never deploy before Steps 2-4.
   - Step 6 data fix (owner decision): dry run first —
     ```bash
     sed 's/^COMMIT;$/ROLLBACK;/' $W/supabase/datafix/2026-10-09-thai-german-po2610-038.sql > /tmp/tg_dry.sql
     npx supabase db query --linked -f /tmp/tg_dry.sql      # expect NOTICE/no error; nothing persists
     npx supabase db query --linked -f $W/supabase/datafix/2026-10-09-thai-german-po2610-038.sql   # real run
     ```
     (`supabase db query` hides NOTICEs; verify with the query in section 3 instead.)
3. **ตรวจหลังปล่อย (live verification checklist)** —
   - ไทย-เยอรมัน (after Step 6): PO2610-038 📄 popup shows deposit 2602543 · 110,600.55 (50% ของใบสั่งซื้อ) · ใช้แล้ว 110,600.55 · คงเหลือ 0.00; lines all "รับแล้ว 06/10/2026"; bills: 110,600.55. Read-only check:
     ```sql
     SELECT e.invoice_no, e.amount, e.amount_no_vat, e.vat FROM expenses e WHERE e.id IN ('a9811a5e-83a3-4c06-aef5-129d85779b08','c69b0dcb-4d78-466c-b4c2-62c4c0802a15');
     SELECT sd.deposit_invoice_no, sd.po_id, sd.pct_of_po, a.amount_no_vat, a.vat FROM supplier_deposits sd JOIN po_deposit_applications a ON a.deposit_id = sd.id
      WHERE sd.expense_id = 'a9811a5e-83a3-4c06-aef5-129d85779b08';   -- expect 2602543 | de73ede3-... | 50 | 103365.00 | 7235.55
     ```
   - Partial receipt scenario on the next real multi-line PO (or a clearly named test PO, knowing receipts cannot be deleted from the app): ⋯ → 💰 สร้างใบจ่ายมัดจำ 30% → check the deposit expense on Expenses; ⋯ → 📦 รับของ → รับบางรายการ, tick one line, set yesterday's date → preview shows the 30% deduction and the bill → confirm → status 🚚 รับบางส่วน, popup shows R1, deposit remaining, the bill dated the PO date; Inventory → ประวัติการเคลื่อนไหว shows the movement dated yesterday with note `<PO>-R1`; receive the rest → whole remaining deposit pre-filled, status ✅ รับของแล้ว, deposit remaining 0.00; Expenses → 💸 จ่ายบางส่วน on the pending bill → paid part + new pending remainder with the same invoice no.
   - Old paths still fine: a plain PO received in one go (no deposit) creates one bill as before; credit note and สลับใบกำกับภาษี still in ⋯ for received POs; a fully received multi-receipt PO can be linked on ใบกำกับภาษีผู้ขาย and posting stamps all its bills; a partially received PO is not offered there.
   - Mobile (phone width): 📄 and ⋯ reachable; receive dialog confirm reachable.
4. **ข้อจำกัดที่รู้ (known limits)** — no un-receive / no deleting receipt bills or split parts from the app (admin SQL only); one deposit per PO from the PO (old "ลงทะเบียนเป็นมัดจำ" still allows more); whole lines only; a split remainder created after a tax-invoice post gets the invoice number and void restores it; credit-supplier bills must be switched from รอวางบิล to ค้างจ่าย before splitting; stock unit conversion still computed in the browser and validated by the server.
5. **Rollback plan** — the code can be reverted by redeploying the previous build; the migrations are additive: if 09-02/09-03 must be withdrawn, re-apply `2026-10-08-02`'s post/void definitions and `DROP FUNCTION create_po_deposit(...)`, `receive_po_lines(...)`, `split_payment(...)` only while no receipt rows exist (`SELECT count(*) FROM po_receipts` = 0).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-po-deposit-partial-receipt-handoff.md
git commit -m "docs: handoff for PO deposits and partial receipts (release order, dry runs, ACL checks, live checklist)"
```

---

## Spec coverage map

| Spec item | Task |
|---|---|
| §1 steps 1-6, R4/R5 deduction (percent/value, remaining visible) | 1, 4, 9 |
| §2 create deposit (percent/amount, VAT from PO, number, method) | 2, 4, 8 |
| §2 receive all / some lines, received date, bill preview | 1, 4, 9 |
| §2 one bill per receipt net of deduction, stock dated received date | 4 |
| §2/§4 `partially_received`, PO popup lines/receipts/deposits/balance | 3, 6, 7 |
| §2/R3 split partial payment | 2, 4, 10 |
| §4 data model (receipts, deposit link, application receipt_id) | 3 |
| §5 three RPCs, security, error codes, rolled-back tests | 4, 6 |
| §6 row 📄 + ⋯, ดู PO inside popup, document actions, locks visible-disabled | 7 |
| §7 atomic actions, totals guard, edit/cancel refused by trigger | 3, 4, 7 |
| R6 old deposits selectable | 9 (Review Focus 5) |
| R7 tax-invoice interplay | 5 |
| §8 ไทย-เยอรมัน correction | 11 |
| §9 testing (vitest, SQL, render harness, whole-branch review, dry run) | 1-12 |
