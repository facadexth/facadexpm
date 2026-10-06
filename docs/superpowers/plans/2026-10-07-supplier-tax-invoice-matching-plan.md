# Supplier Tax Invoice Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new document, ใบกำกับภาษีผู้ขาย (supplier tax invoice). It links many received POs to one consolidated supplier invoice. Posting it reverses the POs' stock receipts, posts the invoice's own lines as stock, and stamps the invoice number on the POs' expenses without changing any amount. The whole post is one atomic step, and void undoes it exactly.

**Architecture:** Four new tables. Clients can only SELECT them. Every write goes through SECURITY DEFINER RPCs: save draft, delete draft, preview, post and void. `post` and `preview` both run one private check function (`_sti_check`) and the same ordered movement queries, so the preview always shows what post will do. A private helper `_stock_receipt_reversal` writes a new movement type `receipt_reversal` using the exact weighted-average inverse. Invoice lines are posted through the existing `record_stock_movement`. A pure JS module mirrors the math for the UI and vitest. A new page under รายจ่าย holds the UI. PurchaseOrders.jsx gets a "stock from invoice" flag and badges.

**Tech Stack:** React 18 + Vite, Supabase (Postgres plpgsql RPC + RLS, PostgREST), vitest. Thai UI.

**Spec:** `docs/superpowers/specs/2026-10-06-supplier-tax-invoice-matching-design.md` (approved by the owner: "อนุมัติ").

## Global Constraints

Every task's requirements include this section.

**Owner rulings on the spec's open items (verbatim intent):**
- R1 Tolerance: an invoice-vs-PO difference passes when `|diff| ≤ min(1% × base, 5 baht)`. The base is Σ PO goods value (ex-VAT). JS: `Math.min(Math.abs(base) * 0.01, 5)`. SQL: `LEAST(abs(base) * 0.01, 5)`. Add a satang slack of `0.005` to the comparison. Note this is the *smaller* of the two, unlike the old swap's `max`. A bigger difference is allowed only with a typed reason (`match_note`), per the spec's default.
- R2 Negative stock after a reversal: **allow, but warn.** It is never an exception. It is reported in the preview, in the post result and in the confirm dialog. This also applies to void.
- R3 "Stock from invoice" is decided **at PO creation** (`purchase_orders.stock_from_invoice`). A flagged PO posts no stock when it is received.
- R4 Sequencing: this feature builds **after** the PO deposit deduction feature (`feat/po-deposit-deduction`, plan `docs/superpowers/plans/2026-10-06-po-deposit-deduction-plan.md`). Execute in a worktree branched from that feature's final tip (after its Task 7 handoff), or from `main` after it is merged. Do not start Task 8 of this plan while anyone is still editing `src/pages/PurchaseOrders.jsx` for the deposit feature.

**Owner's standing requirement: "no errors".** Correctness outranks speed:
- Stock math: reversing then re-posting must net to the right quantity **and** weighted-average cost (WAC). Post → void must return every touched balance to its pre-post quantity and WAC. Compare after `round(…, 6)`, except where a balance crossed ≤ 0, which is documented below.
- Every state change is atomic (one plpgsql call) and idempotent by status: a second post raises `not_draft` and a second void raises `not_posted`. A failure writes nothing.
- Every new SECURITY DEFINER function does three things. It sets `SET search_path = public`. It re-checks `is_admin_or_owner() AND has_module_access('purchase_orders')`, plus `tenant_can_write()` when it writes. It scopes every read and write with `tenant_id = current_tenant_id()`.
- Grants: `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;` then an explicit `GRANT EXECUTE … TO authenticated;` for the five public RPCs. Private helpers (names starting with `_`) and trigger functions get `REVOKE ALL … FROM PUBLIC, anon, authenticated;` and no grant. Supabase's default privileges grant EXECUTE to `anon`/`authenticated` directly, so revoking from PUBLIC alone is not enough.
- Tables: `REVOKE ALL … FROM anon, authenticated;` then `GRANT SELECT … TO authenticated;`. Clients get no INSERT/UPDATE/DELETE.
- Every list read in the client goes through `fetchAllRows` (`src/lib/fetchAllRows.js`) with a stable `.order(...)`, because of the 1000-row PostgREST cap.
- No `upsert` is used in this feature. If one is ever added, `onConflict` must name the table's real unique index exactly. The only `ON CONFLICT` here is `(inventory_item_id, site_id)`, which is the real `UNIQUE` on `inventory_stock_balances`.
- PostgREST embeds always name the constraint explicitly (`suppliers!sti_supplier_fk(...)`), using the constraint names declared in Task 2.
- New tables avoid FKs that could make PostgREST see a second path between two tables that already relate. So `supplier_tax_invoice_pos.expense_id` and `supplier_tax_invoice_reversals.po_id` / `inventory_item_id` / `site_id` are plain UUIDs with no FK. Integrity for them is enforced by the RPCs.
- Views freeze their `x.*` column list. Do NOT add columns to `expenses` (`expenses_view` freezes). This plan creates no view. Task 2 Step 1 checks whether any view selects `purchase_orders.*`. If one does, that view must be re-created in the same migration after the new column is added.
- **Migrations are applied only by the owner.** Implementers write `.sql` files and never apply or run them. Implementers may only run read-only `SELECT`/catalog queries, from the main checkout: `cd /Users/plfx/code/FacadeXPM/facadex-app && python3 "SCAN DOCS/kc-yk-work/dbq.py" <out.json> "<SELECT …>"`, then read `<out.json>`. Use a scratchpad path for `<out.json>`. This is the live production database: SELECT only, no DDL, no DML, no RPC calls.
- SQL tests are transaction scripts under `supabase/tests/`. They run as `authenticated` on a scratch tenant, and every negative check sits in a nested `BEGIN … EXCEPTION` block. They end with `RAISE EXCEPTION 'RESULT: …'` inside the `DO` block, so nothing persists even under an autocommit runner, plus an outer `ROLLBACK`. Implementers write them and never run them. The header says `!!! NOT RUN against any database !!!`.
- JS tests: `npx vitest run`, which must stay all green. Before every commit run `npx vitest run` and `npm run build`.
- Thai UI strings. Money is rounded with `round2` imported from `src/lib/depositMath.js`; do not define a new one. Follow the surrounding code style.
- Commit trailers: use the attribution lines from the controller's current session reminder. At plan time they are:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Upq692foSk71qFm1jPANAh`.
- Movement `notes` written by this feature must never start with `PI-` or `PO-`. `Inventory.jsx` `isProductionRef` treats `/^P[IO]-/` notes as finished-goods production.

**Rulings this plan makes where the spec was silent or ambiguous** (listed so reviewers can check them):
- A1 The reversal source is the PO's **actual** receipt movements (`stock_movements` with `movement_type='purchase_in'`, `reference_type='purchase_order'`, `reference_id=<po id>`), not the PO's items and not the flag. A partly posted receipt, a non-stock PO, or a flagged PO received by a stale client all reverse exactly what is really there.
- A2 WAC inverse: if `q − r > 0`, the new WAC is `max((q·w − r·c)/(q − r), 0)`. If `q − r ≤ 0`, the WAC is unchanged (the spec's "balance reaches 0" rule, extended to negative balances). WAC is never negative.
- A3 Void order is the reverse of post: first re-post the reversed PO receipts as `purchase_in` (at their original cost), then remove the invoice lines with `receipt_reversal`. This keeps stock higher during the void.
- A4 Movement dating: movements written by **post** (invoice lines and receipt reversals) get `created_at = invoice_date 12:00 Asia/Bangkok`, so the stock reports put them in the invoice month. Movements written by **void** use `now()`.
- A5 "A PO belongs to at most one non-void invoice" is enforced by an `active` flag on the link plus a partial unique index `(po_id) WHERE active`. Drafts also hold their POs. Void clears `active`. The spec's literal `po_id UNIQUE` would stop a voided PO from being linked again.
- A6 Expense stamping keeps the previous `invoice_no` on the link row. Void restores it **only** if the expense still shows the stamped number; otherwise it warns `expense_changed`. Notes are appended and never stripped: post adds `ใบกำกับภาษี <no> (เลขเดิม: <old|->)`, and void adds `ยกเลิกใบกำกับภาษี <no>`.
- A7 All client writes go through RPCs, including the draft save, which is atomic: header, lines and links in one call. This is stricter than the spec's "client may only create drafts".
- A8 Invoice lines are ex-VAT. The server computes `amount = round(qty × unit_price × (1 − discount_pct/100), 2)` and `base_unit_cost = amount / base_qty`. The client sends `base_qty` only. There is no VAT-inclusive mode.
- A9 A second blocking check: Σ line amounts must equal `net_before_vat` within the same tolerance (base = net). Otherwise `lines_total_mismatch`, with no override.
- A10 The PO proposal uses the PO `date` month (the order month), not `received_date`.
- A11 Warnings that never block: a PO with a confirmed credit note (`po_has_credit_note`), a PO outside the invoice month, a PO with deposit applications, a PO with no expense, and a flagged PO whose stock was nevertheless received.
- A12 `invoice_date` cannot be in the future (Bangkok date).
- A13 Invoice numbers are unique per `(tenant, supplier, lower(btrim(invoice_no)))` among non-void invoices.
- A14 Once a PO is linked to a **posted** invoice, it is locked by trigger: no change to `status`, `supplier_id`, `site_id`, `has_vat`, `price_includes_vat`, `stock_from_invoice`, and no change to its items (`po_tax_invoiced`). `stock_from_invoice` cannot change once a PO is `received` (`po_stock_flag_locked`).
- A15 A line's base quantity is pre-filled with the PO conversion (`computePoItemBaseQty`). When the line's unit differs from the item's base unit and no unit factor exists, or an aluminium/glass item has no dimensions, the line is marked "unconverted" and the user must type the base quantity.

## Review Focus

These are the five failure modes most likely to hurt a real user that the spec implies but does not test. Each has a pinning test in the task that owns the code.

1. **Stock already consumed between PO receipt and invoice** (COGS deductions, site transfers). The reversal drives the balance negative. Post must still succeed, report the negative row, and keep WAC sane; void must restore the original quantity and WAC. Pinned by SQL test T12 (Task 3) and vitest `simulateStock` negative case (Task 1).
2. **Double click / two tabs / post-then-void race.** The second call must fail with `not_draft`/`not_posted` and write nothing. The UI must disable buttons while busy and must not re-run a stale preview. Pinned by SQL T6/T10 (Task 3) and the stale-preview guard test `previewIsCurrent` (Task 1).
3. **A PO's receipt that does not match its items:** a half-posted client loop, a non-stock PO, a flagged PO received anyway by an old cached bundle. Reversal must follow real movements. Pinned by SQL T14/T14b (Task 3).
4. **Deposit-covered PO** (expense smaller than goods value, or `expense_id` NULL). The match must use goods value, and stamping must skip cleanly. Pinned by SQL T13 (Task 3) and vitest `evaluateMatch` deposit case (Task 1).
5. **Deploy before or after the migration.** Old pages must keep working when the new tables are missing (PO list, receive, Inventory ledger). The new `receipt_reversal` rows must be counted as stock **out** in every report. Pinned by vitest `computeStockLedgerReport` receipt_reversal test (Task 4), the hook tolerance test (Task 5), and Task 8 Step 6.

---

## File Structure

- Create `src/lib/poTotals.js` (+ `.test.js`): `poLineTotal`, `calcPoTotals`, moved verbatim from `PurchaseOrders.jsx` (it becomes the importer in Task 8).
- Create `src/lib/supplierTaxInvoice.js` (+ `.test.js`): pure math, mirroring the SQL helpers; also proposal, line base, error text.
- Create `supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql`: tables, RLS, grants, `stock_from_invoice`, widened movement type CHECK, PO lock triggers, private math/stock helpers.
- Create `supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql`: `_sti_*` plan/check helpers, `save_…_draft`, `delete_…_draft`, `preview_…`, `post_…`, `void_…`.
- Create `supabase/tests/supplier_tax_invoice_test.sql`: Task 2 writes part A, Task 3 writes the rest.
- Modify `src/lib/inventoryCost.js` (+ test): `receipt_reversal` direction and reference labels. Modify `src/pages/Inventory.jsx`: labels.
- Modify `src/hooks/useSupabase.js`: hooks and RPC wrappers.
- Create `src/components/SupplierTaxInvoiceForm.jsx`: header, scan, PO picker and lines editor.
- Create `src/components/TaxInvoicePreview.jsx`: preview table and the confirm overlay.
- Create `src/pages/SupplierTaxInvoices.jsx`: list, draft/post/void flows. Modify `src/App.jsx`: nav and route.
- Modify `src/pages/PurchaseOrders.jsx`: flag, receive skip, badges, swap hidden for linked POs, import `calcPoTotals`.
- Create `docs/superpowers/plans/2026-10-08-supplier-tax-invoice-handoff.md` (Task 9).

## Re-check points against the PO deposit feature (R4)

This plan consumes these deposit interfaces. If any of them changes before this plan runs, re-check the named place.

| Deposit interface (as of commit `08a7615`) | Used here | Re-check if it changes |
|---|---|---|
| `receive_po_with_deposits(p_po_id UUID, p_applications JSONB, p_expected_subtotal NUMERIC, p_expected_vat NUMERIC) RETURNS UUID` (expense id or NULL), `supabase/migrations/2026-10-07-02-…sql` lines 33-39 (subtotal formula) | `_po_goods_subtotal` copies the subtotal formula; SQL test fixtures receive POs through this RPC | Task 2 `_po_goods_subtotal` + Task 3 T13; Task 8 `handleReceive` |
| `supplier_deposits(id, expense_id, deposit_invoice_no, …)`, `po_deposit_applications(deposit_id, po_id, amount_no_vat, vat, tenant_id)` | `_sti_check` warning `po_has_deposit`; PO picker label | Task 3 `_sti_check`; Task 6 picker |
| `expenses_block_deposit_edit` trigger (blocks amount/supplier/po_id edits only) | Post/void update `expenses.invoice_no` and `notes` only | Task 3 stamping: if the trigger ever locks `invoice_no`/`notes`, stamping breaks |
| `src/lib/depositMath.js` `round2` | all JS money rounding | Task 1 |
| `useSupplierDeposits(supplierId)` → `{ data: [{ id, expense_id, deposit_invoice_no, expense, applications: [{amount_no_vat, vat, po_id}] }], loading, error, refetch }` | PO picker "หักมัดจำ X" per PO | Task 6 |
| `useDepositMap()` returns `{ data: Map, refetch }` (**not** the Map itself) | not consumed; if a later change uses it, destructure `const { data: depositMap } = useDepositMap()` | — |
| `handleReceive` in `PurchaseOrders.jsx` (deposit Task 5 final form: RPC first, then the client-side `record_stock_movement` loop over `receiveStockPlan(receiveRow)`) | Task 8 wraps that loop in `if (!receiveRow.stock_from_invoice)` | Task 8 Step 3: re-read the final `handleReceive` before editing |

---

### Task 1: Pure logic: PO totals and tax-invoice math

**Files:**
- Create: `src/lib/poTotals.js`, `src/lib/poTotals.test.js`
- Create: `src/lib/supplierTaxInvoice.js`, `src/lib/supplierTaxInvoice.test.js`

**Interfaces:**
- Consumes: `round2` from `src/lib/depositMath.js`; `computePoItemBaseQty(it, invItem, profile, factor)` from `src/lib/inventoryCost.js`; `VAT_RATE` from `src/lib/invoiceCalc.js` (0.07).
- Produces:
  - `poLineTotal(item) → number`, `calcPoTotals(items, hasVat, priceIncludesVat) → { subtotal, vat, total }` (identical to `PurchaseOrders.jsx:65-86`).
  - `matchTolerance(base) → number`, `withinTolerance(diff, base) → boolean`
  - `lineAmount({ qty, unit_price, discount_pct }) → number`
  - `evaluateMatch({ netBeforeVat, poSubtotals: number[], lineAmounts: number[] }) → { poSum, diff, tolerance, matchOk, linesSum, linesDiff, linesOk }`
  - `wacAfterIn(q, w, a, c)`, `wacAfterReversal(q, w, r, c) → number`
  - `simulateStock({ balances: {'item|site': {qty, wac}}, lines: [{inventory_item_id, site_id, base_qty, base_unit_cost}], reversals: [{inventory_item_id, site_id, quantity, unit_cost}] }) → [{ inventory_item_id, site_id, beforeQty, beforeWac, addQty, removeQty, afterQty, afterWac, negative }]`
  - `proposePos({ pos, supplierId, invoiceDate, activeLinks: Map<po_id,{invoice_id, invoice_no}>, invoiceId }) → { proposed, outsideMonth, linkedElsewhere: [{po, link}] }`
  - `lineBase(line, invItem, factor) → { baseQty: number|null, unconverted: boolean }`
  - `formSignature(form) → string`, `previewIsCurrent(preview, form) → boolean`
  - `CHECK_TEXT: Record<code, string>`, `mapTaxInvoiceRpcError(err) → string`

- [ ] **Step 1: Write the failing tests** in `src/lib/poTotals.test.js`

```js
import { describe, it, expect } from 'vitest'
import { calcPoTotals, poLineTotal } from './poTotals.js'

describe('calcPoTotals (moved verbatim from PurchaseOrders.jsx)', () => {
  it('VAT exclusive', () => {
    expect(calcPoTotals([{ line_total: 1000 }], true, false)).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('VAT inclusive backs VAT out', () => {
    expect(calcPoTotals([{ line_total: 1070 }], true, true)).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('no VAT', () => {
    expect(calcPoTotals([{ line_total: 500 }], false, false)).toEqual({ subtotal: 500, vat: 0, total: 500 })
  })
  it('falls back to quantity x price x discount when line_total is missing', () => {
    expect(poLineTotal({ quantity: '2', unit_price: '100', discount_pct: '10' })).toBe(180)
    expect(calcPoTotals([{ quantity: 2, unit_price: 100, discount_pct: 10 }], false, false).subtotal).toBe(180)
  })
})
```

and `src/lib/supplierTaxInvoice.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  matchTolerance, withinTolerance, lineAmount, evaluateMatch, wacAfterIn, wacAfterReversal,
  simulateStock, proposePos, lineBase, formSignature, previewIsCurrent, mapTaxInvoiceRpcError, CHECK_TEXT,
} from './supplierTaxInvoice.js'

describe('tolerance = min(1%, 5 baht)  (owner ruling R1)', () => {
  it('caps at 5 baht for large bases', () => { expect(matchTolerance(2000)).toBe(5) })
  it('is 1% for small bases', () => { expect(matchTolerance(100)).toBe(1) })
  it('zero base needs an exact match', () => { expect(matchTolerance(0)).toBe(0) })
  it('boundary: 5.00 passes, 5.01 fails on 2000', () => {
    expect(withinTolerance(5, 2000)).toBe(true)
    expect(withinTolerance(-5, 2000)).toBe(true)
    expect(withinTolerance(5.01, 2000)).toBe(false)
  })
  it('boundary: 1.00 passes, 1.01 fails on 100', () => {
    expect(withinTolerance(1, 100)).toBe(true)
    expect(withinTolerance(1.01, 100)).toBe(false)
  })
})

describe('lineAmount', () => {
  it('qty x price x (1 - discount), 2dp', () => {
    expect(lineAmount({ qty: 12, unit_price: 90 })).toBe(1080)
    expect(lineAmount({ qty: 3, unit_price: 33.333, discount_pct: 0 })).toBe(100)
    expect(lineAmount({ qty: 2, unit_price: 100, discount_pct: 10 })).toBe(180)
  })
})

describe('evaluateMatch compares goods value, not expenses', () => {
  it('two POs, exact', () => {
    const r = evaluateMatch({ netBeforeVat: 2000, poSubtotals: [1000, 1000], lineAmounts: [1080, 920] })
    expect(r).toMatchObject({ poSum: 2000, diff: 0, matchOk: true, linesSum: 2000, linesOk: true })
  })
  it('deposit-covered PO still matches on goods value (expense would be 0)', () => {
    const r = evaluateMatch({ netBeforeVat: 500, poSubtotals: [500], lineAmounts: [500] })
    expect(r.matchOk).toBe(true)
  })
  it('flags a large difference and a lines/net mismatch', () => {
    const r = evaluateMatch({ netBeforeVat: 500, poSubtotals: [2000], lineAmounts: [400] })
    expect(r.diff).toBe(-1500)
    expect(r.matchOk).toBe(false)
    expect(r.linesOk).toBe(false)
  })
})

describe('WAC math mirrors SQL _sti_wac_after_in / _sti_wac_after_reversal', () => {
  it('in: same as record_stock_movement purchase_in', () => {
    expect(wacAfterIn(6, 100, 12, 90)).toBeCloseTo(1680 / 18, 10)
    expect(wacAfterIn(0, 0, 10, 100)).toBe(100)
    expect(wacAfterIn(-10, 50, 10, 100)).toBe(0) // new qty 0 -> 0, like the SQL
  })
  it('reversal: exact inverse', () => {
    expect(wacAfterReversal(18, 1680 / 18, 10, 100)).toBeCloseTo(85, 10)
  })
  it('reversal to zero or below keeps WAC', () => {
    expect(wacAfterReversal(10, 100, 10, 100)).toBe(100)
    expect(wacAfterReversal(7, 100, 20, 100)).toBe(100)
  })
  it('reversal never yields a negative WAC', () => {
    expect(wacAfterReversal(10, 10, 5, 100)).toBe(0)
  })
  it('in then reversal then re-post then remove = identity', () => {
    let q = 6, w = 100
    w = wacAfterIn(q, w, 12, 90); q += 12
    w = wacAfterReversal(q, w, 10, 100); q -= 10
    expect(q).toBe(8); expect(w).toBeCloseTo(85, 9)
    // void: re-post receipt first, then remove the invoice line (ruling A3)
    w = wacAfterIn(q, w, 10, 100); q += 10
    w = wacAfterReversal(q, w, 12, 90); q -= 12
    expect(q).toBe(6); expect(w).toBeCloseTo(100, 9)
  })
})

describe('simulateStock (same scenario as SQL T4/T5)', () => {
  it('invoice items differ from PO items; lines first, then reversals', () => {
    const rows = simulateStock({
      balances: { 'X|S1': { qty: 6, wac: 100 }, 'Y|S1': { qty: 5, wac: 200 } },
      lines: [
        { inventory_item_id: 'X', site_id: 'S1', base_qty: 12, base_unit_cost: 90 },
        { inventory_item_id: 'Y', site_id: 'S1', base_qty: 4, base_unit_cost: 230 },
      ],
      reversals: [
        { inventory_item_id: 'X', site_id: 'S1', quantity: 10, unit_cost: 100 },
        { inventory_item_id: 'Y', site_id: 'S1', quantity: 5, unit_cost: 200 },
      ],
    })
    const x = rows.find(r => r.inventory_item_id === 'X')
    const y = rows.find(r => r.inventory_item_id === 'Y')
    expect(x).toMatchObject({ beforeQty: 6, addQty: 12, removeQty: 10, afterQty: 8, negative: false })
    expect(x.afterWac).toBeCloseTo(85, 9)
    expect(y.afterQty).toBe(4); expect(y.afterWac).toBeCloseTo(230, 9)
  })
  it('consumed stock: reversal below zero is reported, WAC kept (SQL T12)', () => {
    const [r] = simulateStock({
      balances: { 'X|S2': { qty: 2, wac: 100 } },
      lines: [{ inventory_item_id: 'X', site_id: 'S2', base_qty: 5, base_unit_cost: 100 }],
      reversals: [{ inventory_item_id: 'X', site_id: 'S2', quantity: 20, unit_cost: 100 }],
    })
    expect(r).toMatchObject({ beforeQty: 2, afterQty: -13, afterWac: 100, negative: true })
  })
  it('unknown balance starts at 0/0', () => {
    const [r] = simulateStock({ balances: {}, lines: [{ inventory_item_id: 'Z', site_id: 'S1', base_qty: 3, base_unit_cost: 50 }], reversals: [] })
    expect(r).toMatchObject({ beforeQty: 0, afterQty: 3, afterWac: 50 })
  })
})

describe('proposePos (PO date month, ruling A10)', () => {
  const pos = [
    { id: 'p1', supplier_id: 'A', status: 'received', date: '2026-09-03' },
    { id: 'p2', supplier_id: 'A', status: 'received', date: '2026-09-28' },
    { id: 'p3', supplier_id: 'A', status: 'received', date: '2026-08-30' },
    { id: 'p4', supplier_id: 'A', status: 'ordered',  date: '2026-09-10' },
    { id: 'p5', supplier_id: 'B', status: 'received', date: '2026-09-10' },
    { id: 'p6', supplier_id: 'A', status: 'received', date: '2026-09-15' },
  ]
  const activeLinks = new Map([['p6', { invoice_id: 'other', invoice_no: 'INV-9' }]])
  it('proposes same-supplier received POs of the month not linked elsewhere', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '2026-09-30', activeLinks, invoiceId: 'mine' })
    expect(r.proposed.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.outsideMonth.map(p => p.id)).toEqual(['p3'])
    expect(r.linkedElsewhere.map(x => x.po.id)).toEqual(['p6'])
  })
  it('a PO linked to THIS invoice is not "elsewhere"', () => {
    const r = proposePos({ pos, supplierId: 'A', invoiceDate: '2026-09-30', activeLinks, invoiceId: 'other' })
    expect(r.proposed.map(p => p.id)).toContain('p6')
  })
  it('tolerates null inputs', () => {
    expect(proposePos({ pos: null, supplierId: 'A', invoiceDate: '', activeLinks: null })).toEqual({ proposed: [], outsideMonth: [], linkedElsewhere: [] })
  })
})

describe('lineBase (ruling A15)', () => {
  const kgItem = { id: 'X', base_unit: 'kg', unit_conversion_mode: 'none' }
  it('same unit as base -> qty', () => {
    expect(lineBase({ qty: 12, unit: 'kg' }, kgItem, null)).toEqual({ baseQty: 12, unconverted: false })
  })
  it('alternate unit with a factor converts', () => {
    expect(lineBase({ qty: 2, unit: 'มัด' }, kgItem, { factor_to_base: 25 })).toEqual({ baseQty: 50, unconverted: false })
  })
  it('alternate unit without a factor is unconverted (user must type it)', () => {
    expect(lineBase({ qty: 2, unit: 'เส้น' }, kgItem, null).unconverted).toBe(true)
  })
  it('aluminium profile item invoiced in kg is converted 1:1', () => {
    expect(lineBase({ qty: 30, unit: 'kg' }, { base_unit: 'kg', unit_conversion_mode: 'aluminum_profile' }, null)).toEqual({ baseQty: 30, unconverted: false })
  })
  it('aluminium profile item invoiced in เส้น is unconverted', () => {
    expect(lineBase({ qty: 5, unit: 'เส้น' }, { base_unit: 'kg', unit_conversion_mode: 'aluminum_profile' }, null).unconverted).toBe(true)
  })
  it('no stock item -> null', () => {
    expect(lineBase({ qty: 1, unit: 'งาน' }, null, null)).toEqual({ baseQty: null, unconverted: false })
  })
})

describe('stale preview guard (Review Focus 2)', () => {
  const form = { supplier_id: 'A', invoice_no: 'X1', invoice_date: '2026-09-30', net_before_vat: '2000', vat: '140', match_note: '', lines: [{ description: 'a', qty: '1', unit_price: '2000' }], po_ids: ['p2', 'p1'] }
  it('same form -> current; order of po_ids does not matter', () => {
    const preview = { signature: formSignature(form) }
    expect(previewIsCurrent(preview, { ...form, po_ids: ['p1', 'p2'] })).toBe(true)
  })
  it('any edit invalidates the preview', () => {
    const preview = { signature: formSignature(form) }
    expect(previewIsCurrent(preview, { ...form, net_before_vat: '2001' })).toBe(false)
    expect(previewIsCurrent(null, form)).toBe(false)
  })
})

describe('error text', () => {
  it('maps RPC codes, longest code first', () => {
    expect(mapTaxInvoiceRpcError({ message: 'not_draft' })).toBe(CHECK_TEXT.not_draft)
    expect(mapTaxInvoiceRpcError({ message: 'match_note_required' })).toBe(CHECK_TEXT.match_note_required)
    expect(mapTaxInvoiceRpcError({ message: 'po_tax_invoiced' })).toMatch(/ใบกำกับ/)
  })
  it('maps unique violations by constraint name', () => {
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "sti_invoice_no_active_uq"' })).toMatch(/เลขที่ใบกำกับนี้มีอยู่แล้ว/)
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "stip_po_active_uq"' })).toBe(CHECK_TEXT.po_linked_elsewhere)
  })
  it('falls back to the raw message', () => {
    expect(mapTaxInvoiceRpcError({ message: 'boom' })).toBe('boom')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run src/lib/poTotals.test.js src/lib/supplierTaxInvoice.test.js`
Expected: FAIL with "Failed to resolve import './poTotals.js'" and "./supplierTaxInvoice.js".

- [ ] **Step 3: Implement `src/lib/poTotals.js`** by copying the logic of `PurchaseOrders.jsx` `lineTotal` (line ~59) and `calcPoTotals` (line ~73) exactly. Do not change the arithmetic; the SQL `_po_goods_subtotal` and the receive RPC mirror it.

```js
// PO line / totals math. Moved verbatim from PurchaseOrders.jsx (which imports it from Task 8 on).
// Mirrored server-side by receive_po_with_deposits and _po_goods_subtotal -- change all three together.
import { VAT_RATE } from './invoiceCalc.js'

export function poLineTotal(item) {
  const gross = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
  const discountPct = parseFloat(item.discount_pct) || 0
  return gross * (1 - discountPct / 100)
}

/** priceIncludesVat: the entered prices ARE the grand total; subtotal = total / 1.07. */
export function calcPoTotals(items, hasVat, priceIncludesVat) {
  const rawTotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : poLineTotal(it)), 0)
  if (!hasVat) return { subtotal: rawTotal, vat: 0, total: rawTotal }
  if (priceIncludesVat) {
    const total = Math.round(rawTotal * 100) / 100
    const subtotal = Math.round((total / (1 + VAT_RATE)) * 100) / 100
    const vat = Math.round((total - subtotal) * 100) / 100
    return { subtotal, vat, total }
  }
  const subtotal = rawTotal
  const vat = Math.round(subtotal * VAT_RATE * 100) / 100
  const total = Math.round((subtotal + vat) * 100) / 100
  return { subtotal, vat, total }
}
```
Check first that `src/lib/invoiceCalc.js` exports `VAT_RATE = 0.07` (`grep -n "export const VAT_RATE" src/lib/invoiceCalc.js`). If it does not, define `const VAT_RATE = 0.07` locally instead.

- [ ] **Step 4: Implement `src/lib/supplierTaxInvoice.js`**

```js
// ============================================================
// Supplier tax invoice (ใบกำกับภาษีผู้ขาย) -- pure logic.
// Mirrors supabase/migrations/2026-10-08-01/02 (_sti_tolerance, _sti_wac_after_in,
// _sti_wac_after_reversal, _sti_check). The RPCs are the authority; this is preview/UI.
// ============================================================
import { round2 } from './depositMath.js'
import { computePoItemBaseQty } from './inventoryCost.js'

const EPS = 0.005

/** Owner ruling R1: the smaller of 1% of the base or 5 baht. */
export function matchTolerance(base) {
  return Math.min(Math.abs(Number(base) || 0) * 0.01, 5)
}
export function withinTolerance(diff, base) {
  return Math.abs(Number(diff) || 0) <= matchTolerance(base) + EPS
}

/** Ex-VAT line amount (ruling A8); the server recomputes and stores the same value. */
export function lineAmount({ qty, unit_price, discount_pct }) {
  const q = Number(qty) || 0, p = Number(unit_price) || 0, d = Number(discount_pct) || 0
  return round2(q * p * (1 - d / 100))
}

export function evaluateMatch({ netBeforeVat, poSubtotals, lineAmounts }) {
  const net = round2(Number(netBeforeVat) || 0)
  const poSum = round2((poSubtotals || []).reduce((s, x) => s + (Number(x) || 0), 0))
  const linesSum = round2((lineAmounts || []).reduce((s, x) => s + (Number(x) || 0), 0))
  const diff = round2(net - poSum)
  const linesDiff = round2(linesSum - net)
  return {
    poSum, diff, tolerance: matchTolerance(poSum), matchOk: withinTolerance(diff, poSum),
    linesSum, linesDiff, linesOk: withinTolerance(linesDiff, net),
  }
}

/** = record_stock_movement purchase_in (new qty 0 -> WAC 0). */
export function wacAfterIn(q, w, a, c) {
  const n = q + a
  return n === 0 ? 0 : (q * w + a * (Number(c) || 0)) / n
}
/** Exact inverse of a receipt (ruling A2). Balance <= 0 keeps WAC; never negative. */
export function wacAfterReversal(q, w, r, c) {
  const n = q - r
  if (n <= 0) return w
  return Math.max((q * w - r * (Number(c) || 0)) / n, 0)
}

/** Same order as the RPC: all invoice lines first, then the PO receipt reversals. */
export function simulateStock({ balances, lines, reversals }) {
  const state = new Map()
  const get = (item, site) => {
    const k = `${item}|${site}`
    if (!state.has(k)) {
      const b = (balances || {})[k] || { qty: 0, wac: 0 }
      const qty = Number(b.qty) || 0, wac = Number(b.wac) || 0
      state.set(k, { inventory_item_id: item, site_id: site, beforeQty: qty, beforeWac: wac, addQty: 0, removeQty: 0, qty, wac })
    }
    return state.get(k)
  }
  for (const l of lines || []) {
    const s = get(l.inventory_item_id, l.site_id), a = Number(l.base_qty) || 0
    s.wac = wacAfterIn(s.qty, s.wac, a, l.base_unit_cost); s.qty += a; s.addQty += a
  }
  for (const r of reversals || []) {
    const s = get(r.inventory_item_id, r.site_id), q = Number(r.quantity) || 0
    s.wac = wacAfterReversal(s.qty, s.wac, q, r.unit_cost); s.qty -= q; s.removeQty += q
  }
  return [...state.values()].map(s => ({
    inventory_item_id: s.inventory_item_id, site_id: s.site_id, beforeQty: s.beforeQty, beforeWac: s.beforeWac,
    addQty: s.addQty, removeQty: s.removeQty, afterQty: s.qty, afterWac: s.wac, negative: s.qty < -1e-9,
  }))
}

const monthOf = d => String(d || '').slice(0, 7)

/** Ruling A10: propose by the PO's own date month. */
export function proposePos({ pos, supplierId, invoiceDate, activeLinks, invoiceId }) {
  const month = monthOf(invoiceDate)
  const elsewhere = po => {
    const l = activeLinks?.get?.(po.id)
    return l && l.invoice_id !== invoiceId ? l : null
  }
  const eligible = (pos || []).filter(po => po.supplier_id === supplierId && po.status === 'received')
  return {
    proposed: eligible.filter(po => monthOf(po.date) === month && !elsewhere(po)),
    outsideMonth: eligible.filter(po => monthOf(po.date) !== month && !elsewhere(po)),
    linkedElsewhere: eligible.filter(po => elsewhere(po)).map(po => ({ po, link: elsewhere(po) })),
  }
}

const normUnit = u => String(u || '').trim().toLowerCase()

/** Ruling A15. factor = the inventory_item_unit_factors row for (item, line.unit) or null. */
export function lineBase(line, invItem, factor) {
  if (!invItem) return { baseQty: null, unconverted: false }
  const qty = Number(line.qty) || 0
  if (line.unit && invItem.base_unit && normUnit(line.unit) === normUnit(invItem.base_unit)) return { baseQty: qty, unconverted: false }
  const r = computePoItemBaseQty({ quantity: qty, unit: line.unit }, invItem, null, factor || null)
  const special = invItem.unit_conversion_mode === 'aluminum_profile' || invItem.unit_conversion_mode === 'glass_dimension'
  const unitMismatch = !special && !factor && !!line.unit && !!invItem.base_unit
  return { baseQty: r.baseQty, unconverted: r.unconverted || unitMismatch }
}

/** Stable signature of everything the server preview depends on. */
export function formSignature(form) {
  const f = form || {}
  return JSON.stringify({
    s: f.supplier_id || '', n: String(f.invoice_no || '').trim(), d: f.invoice_date || '',
    net: String(f.net_before_vat ?? ''), vat: String(f.vat ?? ''), note: String(f.match_note || '').trim(),
    lines: (f.lines || []).map(l => [l.description, l.qty, l.unit, l.unit_price, l.discount_pct, l.inventory_item_id || '', l.site_id || '', l.base_qty ?? '']),
    pos: [...(f.po_ids || [])].sort(),
  })
}
export function previewIsCurrent(preview, form) {
  return !!preview && preview.signature === formSignature(form)
}

export const CHECK_TEXT = {
  invoice_not_found: 'ไม่พบใบกำกับภาษี',
  not_draft: 'ใบกำกับนี้ไม่ใช่ฉบับร่างแล้ว (บันทึกหรือยกเลิกไปแล้ว)',
  not_posted: 'ใบกำกับนี้ยังไม่ได้บันทึก หรือถูกยกเลิกไปแล้ว',
  no_items: 'ยังไม่มีรายการในใบกำกับ',
  no_pos: 'ยังไม่ได้เลือกใบสั่งซื้อ',
  invoice_date_in_future: 'วันที่ใบกำกับอยู่ในอนาคต',
  po_not_found: 'ไม่พบใบสั่งซื้อ',
  po_wrong_supplier: 'ใบสั่งซื้อเป็นของซัพพลายเออร์อื่น',
  po_not_received: 'ใบสั่งซื้อยังไม่ได้รับของ',
  po_linked_elsewhere: 'ใบสั่งซื้อนี้ผูกกับใบกำกับอื่นอยู่แล้ว',
  po_already_reversed: 'สต็อกของใบสั่งซื้อนี้ถูกกลับรายการโดยใบกำกับอื่นแล้ว',
  stock_line_invalid: 'รายการสต็อกไม่ถูกต้อง (สินค้าหรือไซท์งาน)',
  lines_total_mismatch: 'ผลรวมรายการไม่ตรงกับยอดก่อน VAT ของใบกำกับ',
  match_note_required: 'ยอดใบกำกับต่างจากมูลค่าสินค้าในใบสั่งซื้อเกินเกณฑ์ — ต้องกรอกเหตุผล',
  match_outside_tolerance: 'ยอดต่างจากใบสั่งซื้อเกินเกณฑ์ (กรอกเหตุผลแล้ว)',
  po_has_credit_note: 'ใบสั่งซื้อนี้มีใบลดหนี้ — ตรวจว่าใบกำกับหักของที่คืนแล้วหรือยัง',
  po_no_receipt_movements: 'ใบสั่งซื้อนี้ไม่มีการลงสต็อกตอนรับของ (ไม่มีสต็อกให้กลับรายการ)',
  po_stock_from_invoice: 'ใบสั่งซื้อนี้ตั้งให้สต็อกเข้าจากใบกำกับ (ไม่ต้องกลับรายการ)',
  po_stock_flag_but_received_stock: 'ตั้งให้สต็อกเข้าจากใบกำกับ แต่มีการลงสต็อกตอนรับของ — จะถูกกลับรายการ',
  po_outside_month: 'ใบสั่งซื้อนอกเดือนของใบกำกับ',
  po_has_deposit: 'ใบสั่งซื้อนี้หักมัดจำ (เทียบด้วยมูลค่าสินค้า ไม่ใช่ยอดรายจ่าย)',
  po_no_expense: 'ใบสั่งซื้อนี้ไม่มีรายจ่าย (หักมัดจำครบ) — ไม่มีรายจ่ายให้ประทับเลขที่',
  expense_changed: 'เลขที่ใบกำกับในรายจ่ายถูกแก้หลังบันทึก — ไม่ได้คืนเลขเดิม',
}

const RPC_TEXT = {
  ...CHECK_TEXT,
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้ (หรือแพ็กเกจหมดอายุ)',
  void_reason_required: 'กรุณากรอกเหตุผลที่ยกเลิก',
  bad_header: 'ข้อมูลหัวใบกำกับไม่ครบหรือไม่ถูกต้อง',
  bad_item: 'ข้อมูลรายการไม่ถูกต้อง',
  stock_line_incomplete: 'รายการที่ผูกสต็อกต้องมีไซท์งานและจำนวนในหน่วยหลักมากกว่า 0',
  po_not_eligible: 'ใบสั่งซื้อที่เลือกใช้ไม่ได้ (ซัพพลายเออร์อื่น หรือยังไม่รับของ)',
  cross_tenant_reference: 'ข้อมูลอ้างอิงไม่ถูกต้อง',
  po_tax_invoiced: 'ใบสั่งซื้อนี้ผูกกับใบกำกับภาษีที่บันทึกแล้ว — ยกเลิกใบกำกับก่อนจึงจะแก้ได้',
  po_stock_flag_locked: 'เปลี่ยน "สต็อกเข้าจากใบกำกับ" หลังรับของไม่ได้',
}
const CODES_LONGEST_FIRST = Object.keys(RPC_TEXT).sort((a, b) => b.length - a.length)

export function mapTaxInvoiceRpcError(err) {
  const msg = String(err?.message || err || '')
  if (err?.code === '23505' || msg.includes('duplicate key')) {
    if (msg.includes('sti_invoice_no_active_uq')) return 'เลขที่ใบกำกับนี้มีอยู่แล้วสำหรับซัพพลายเออร์นี้'
    if (msg.includes('stip_po_active_uq')) return CHECK_TEXT.po_linked_elsewhere
  }
  for (const code of CODES_LONGEST_FIRST) if (msg.includes(code)) return RPC_TEXT[code]
  return msg
}
```

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npx vitest run src/lib/poTotals.test.js src/lib/supplierTaxInvoice.test.js`
Expected: PASS (all). Then run `npx vitest run` (whole suite green) and `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/poTotals.js src/lib/poTotals.test.js src/lib/supplierTaxInvoice.js src/lib/supplierTaxInvoice.test.js
git commit -m "feat: supplier tax invoice math (tolerance, WAC inverse, stock preview, PO proposal)"
```
(Add the two trailer lines from Global Constraints to every commit message.)

---

### Task 2: Migration 1: schema, locks, private stock helpers (+ SQL test part A)

**Files:**
- Create: `supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql`
- Create: `supabase/tests/supplier_tax_invoice_test.sql` (part A only)

**Interfaces:**
- Consumes: `record_stock_movement` (current definition in `2026-10-06-01-supplier-credit-notes.sql:154-255`); `receive_po_with_deposits` subtotal formula (`2026-10-07-02…sql:33-39`); `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access(text)`, `tenant_can_write()`.
- Produces (exact names; Task 3 relies on them):
  - Tables `supplier_tax_invoices`, `supplier_tax_invoice_items`, `supplier_tax_invoice_pos`, `supplier_tax_invoice_reversals` with constraint names `sti_supplier_fk`, `stii_invoice_fk`, `stii_item_fk`, `stii_site_fk`, `stip_invoice_fk`, `stip_po_fk`, `stir_invoice_fk`, `stir_source_fk`, `stir_reversal_fk`, `stir_restored_fk`; unique indexes `sti_invoice_no_active_uq`, `stip_po_active_uq`, constraint `stip_invoice_po_uq`.
  - Column `purchase_orders.stock_from_invoice BOOLEAN NOT NULL DEFAULT false`.
  - Movement type `receipt_reversal`.
  - `_sti_tolerance(NUMERIC) → NUMERIC`, `_sti_wac_after_in(q, w, a, c NUMERIC) → NUMERIC`, `_sti_wac_after_reversal(q, w, r, c NUMERIC) → NUMERIC`, `_po_goods_subtotal(p_po_id UUID, p_tenant UUID) → NUMERIC`, `_po_tax_invoiced(p_po_id UUID) → BOOLEAN`, `_stock_receipt_reversal(p_tenant UUID, p_item UUID, p_site UUID, p_qty NUMERIC, p_unit_cost NUMERIC, p_reference_type TEXT, p_reference_id UUID, p_notes TEXT, p_at TIMESTAMPTZ) → TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)`.
  - Error strings: `po_tax_invoiced`, `po_stock_flag_locked`.

- [ ] **Step 1: Read-only checks** (main checkout; SELECT only; write each result to the scratchpad and read it). Record the answers in the task report.

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q1.json "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'stock_movements_movement_type_check'"
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q2.json "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('purchase_orders','purchase_order_items','stock_movements','inventory_stock_balances','expenses') ORDER BY table_name, ordinal_position"
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q3.json "SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.expenses'::regclass,'public.purchase_orders'::regclass,'public.purchase_order_items'::regclass,'public.stock_movements'::regclass)"
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q4.json "SELECT viewname FROM pg_views WHERE schemaname='public' AND definition ILIKE '%purchase_orders%'"
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q5.json "SELECT to_regclass('public.supplier_deposits') AS deposits, to_regprocedure('public.receive_po_with_deposits(uuid,jsonb,numeric,numeric)') AS receive_rpc, to_regclass('public.supplier_credit_notes') AS credit_notes"
python3 "SCAN DOCS/kc-yk-work/dbq.py" $SCRATCH/q6.json "SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND (prosrc ILIKE '%sale_out%' OR prosrc ILIKE '%purchase_return%' OR prosrc ILIKE '%movement_type%')"
```
Expected and what to do:
- q1 lists exactly `purchase_in, transfer_in, transfer_out, sale_out, sale_reversal, adjustment, purchase_return`. If it lists more, keep every listed type in the new CHECK and add `receipt_reversal`.
- q2: `purchase_orders` has `date`, `status`, `supplier_id`, `site_id`, `expense_id`, `has_vat`, `price_includes_vat`, `po_number`. `stock_movements.created_at` exists. If `po_number` is not `text`/`character varying`, cast it with `::text` in Task 3.
- q3: note every trigger on these tables in the report. If a trigger on `expenses` blocks updates to `invoice_no` or `notes`, STOP and report, because Task 3's stamping would fail. If `stock_movements` has an UPDATE-blocking trigger, STOP and report, because Task 3 updates `created_at`.
- q4: if any view selects `purchase_orders.*` / `po.*`, add a `CREATE OR REPLACE VIEW` of it (exact current definition from `pg_get_viewdef`) **after** the `ALTER TABLE` in this migration, and say so in the report.
- q5: the deposit and credit-note objects exist live. If not, the migration header must state that 2026-10-07-01/02 must be applied first.
- q6: list each function in the report. Any function that sums or classifies movement types must treat `receipt_reversal` as stock out. Include each such function in Task 4's scope; if it is SQL, report it to the controller rather than editing it in this task.

- [ ] **Step 2: Write SQL test part A** in `supabase/tests/supplier_tax_invoice_test.sql`. Write the whole file skeleton now; Task 3 inserts its tests at the marked line. Fixture column lists follow `supabase/tests/po_deposit_test.sql`.

```sql
-- ================================================================
-- Tests for supplier tax invoice matching (migrations 2026-10-08-01 / -02).
--
-- !!! NOT RUN against any database !!!
-- Written without applying anything. Fixture column lists follow
-- supabase/tests/po_deposit_test.sql and may need a tweak on first run.
-- Run only where 2026-10-06-01..03, 2026-10-07-01..02 and 2026-10-08-01..02 are applied.
-- Success ends with: ERROR: RESULT: supplier_tax_invoice_test ALL PASSED
-- (the RAISE rolls everything back). Any other error text = a failure.
-- ================================================================
BEGIN;

DO $$
DECLARE
  t_owner UUID; t_tenant UUID; s1 UUID; s2 UUID; sa UUID; sb UUID; t_cat UUID; x UUID; y UUID;
  email TEXT := '__test_sti_owner__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID; t2_inv UUID;
  po1 UUID; po2 UUID; po3 UUID; po4 UUID; po5 UUID; po6 UUID; po7 UUID;
  e1 UUID; e2 UUID; e1_amt NUMERIC; e1_net NUMERIC; e1_vat NUMERIC; e2_amt NUMERIC; e1_prev TEXT;
  inv1 UUID; inv2 UUID; inv3 UUID; inv4 UUID; inv5 UUID; inv6 UUID; inv7 UUID; tmp UUID;
  d_exp UUID; d_dep UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_j JSONB; v_q NUMERIC; v_w NUMERIC; v_cnt INT; v_msg TEXT; v_state TEXT; v_txt TEXT;
BEGIN
  -- ── fixtures (as the connecting superuser) ──
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT sti__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__STI-1__', '__sti site 1__') RETURNING id INTO s1;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__STI-2__', '__sti site 2__') RETURNING id INTO s2;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__sti supplier A__') RETURNING id INTO sa;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__sti supplier B__') RETURNING id INTO sb;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__sti cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti X__', 'kg') RETURNING id INTO x;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti Y__', 'แผ่น') RETURNING id INTO y;

  -- second tenant (cross-tenant checks)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT sti2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__STI2-1__', '__sti2 site__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__sti2 supplier__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__sti2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t2_tenant, 'PO-STI-T2', t2_site, t2_sup, t2_cat, v_bkk, 'received', false, false) RETURNING id INTO t2_po;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
  VALUES (t2_tenant, t2_sup, 'T2-INV', v_bkk, 0, 0, 0) RETURNING id INTO t2_inv;

  -- ── Part A: helpers (run as superuser; they are not granted to clients) ──
  IF _sti_tolerance(2000) <> 5 OR _sti_tolerance(100) <> 1 OR _sti_tolerance(0) <> 0 THEN
    RAISE EXCEPTION 'A1 FAIL: tolerance % % %', _sti_tolerance(2000), _sti_tolerance(100), _sti_tolerance(0);
  END IF;
  IF round(_sti_wac_after_in(6, 100, 12, 90), 6) <> round(1680::numeric / 18, 6) OR _sti_wac_after_in(-10, 50, 10, 100) <> 0 THEN
    RAISE EXCEPTION 'A2 FAIL: wac_after_in';
  END IF;
  IF round(_sti_wac_after_reversal(18, 1680::numeric / 18, 10, 100), 6) <> 85
     OR _sti_wac_after_reversal(10, 100, 10, 100) <> 100
     OR _sti_wac_after_reversal(7, 100, 20, 100) <> 100
     OR _sti_wac_after_reversal(10, 10, 5, 100) <> 0 THEN
    RAISE EXCEPTION 'A3 FAIL: wac_after_reversal';
  END IF;
  RAISE NOTICE 'Part A helpers: PASSED';

  -- PO fixtures (superuser, explicit tenant): all supplier A, PO date = today (Bangkok)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-1', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po1, 'X', 10, 100, 1000, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-2', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po2, 'Y', 5, 200, 1000, y);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-3', s2, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po3, 'X', 20, 100, 2000, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-4', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po4;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po4, 'X', 5, 100, 500, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-5', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po5;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po5, 'Y', 3, 200, 600, y);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-6', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po6;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po6, 'misc', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-7', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po7;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po7, 'Y', 2, 200, 400, y);

  IF _po_goods_subtotal(po1, t_tenant) <> 1000 OR _po_goods_subtotal(po1, t2_tenant) IS NOT NULL THEN
    RAISE EXCEPTION 'A4 FAIL: _po_goods_subtotal';
  END IF;
  RAISE NOTICE 'Part A PO subtotal: PASSED';

  -- ── act as the tenant owner ──
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- A5: helpers are NOT callable by clients
  BEGIN
    PERFORM _stock_receipt_reversal(t_tenant, x, s1, 1, 1, 'x', NULL, NULL, now());
    RAISE EXCEPTION 'A5 FAIL: client could call _stock_receipt_reversal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM _sti_wac_after_in(1, 1, 1, 1);
    RAISE EXCEPTION 'A5 FAIL: client could call _sti_wac_after_in';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A6: tables are read-only for clients
  BEGIN
    INSERT INTO supplier_tax_invoices (supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
    VALUES (sa, 'FORGED', v_bkk, 0, 0, 0);
    RAISE EXCEPTION 'A6 FAIL: client insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A7: the client cannot see the other tenant's invoice
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoices WHERE id = t2_inv;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'A7 FAIL: cross-tenant row visible'; END IF;
  RAISE NOTICE 'Part A grants/RLS: PASSED';

  -- ── Part B (Task 3) goes here ──

  RESET role;
  RAISE EXCEPTION 'RESULT: supplier_tax_invoice_test ALL PASSED';
END $$;

ROLLBACK;
```

- [ ] **Step 3: Write the migration** `supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql`:

```sql
-- ============================================================
-- Supplier tax invoice matching (ใบกำกับภาษีผู้ขาย): schema, locks, private helpers.
-- Spec: docs/superpowers/specs/2026-10-06-supplier-tax-invoice-matching-design.md
-- Plan: docs/superpowers/plans/2026-10-07-supplier-tax-invoice-matching-plan.md
-- Requires (apply first): 2026-10-06-01..03 (credit notes, purchase_return),
--                         2026-10-07-01..02 (supplier deposits, receive_po_with_deposits).
-- Additive, except the widened stock_movements type CHECK.
-- No column on expenses (expenses_view e.* freezes). No view created.
-- Clients get SELECT only; all writes go through 2026-10-08-02's RPCs.
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS stock_from_invoice BOOLEAN NOT NULL DEFAULT false;
-- (If Task 2 Step 1 q4 found a view on purchase_orders.*, re-create it here.)

CREATE TABLE supplier_tax_invoices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id    UUID NOT NULL,
  invoice_no     TEXT NOT NULL CHECK (btrim(invoice_no) <> ''),
  invoice_date   DATE NOT NULL,
  net_before_vat NUMERIC NOT NULL CHECK (net_before_vat >= 0),
  vat            NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  grand_total    NUMERIC NOT NULL CHECK (grand_total >= 0),
  match_diff     NUMERIC,
  match_note     TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  post_result    JSONB,
  void_reason    TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by      TEXT,
  posted_at      TIMESTAMPTZ,
  voided_by      TEXT,
  voided_at      TIMESTAMPTZ,
  CONSTRAINT sti_total_sum_check CHECK (round(net_before_vat + vat - grand_total, 2) = 0),
  CONSTRAINT sti_supplier_fk FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX sti_invoice_no_active_uq ON supplier_tax_invoices (tenant_id, supplier_id, lower(btrim(invoice_no))) WHERE status <> 'void';
CREATE INDEX idx_sti_tenant ON supplier_tax_invoices(tenant_id);
CREATE INDEX idx_sti_supplier ON supplier_tax_invoices(supplier_id);

CREATE TABLE supplier_tax_invoice_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id        UUID NOT NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  description       TEXT NOT NULL CHECK (btrim(description) <> ''),
  qty               NUMERIC NOT NULL CHECK (qty > 0),
  unit              TEXT,
  unit_price        NUMERIC NOT NULL CHECK (unit_price >= 0),
  discount_pct      NUMERIC NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  amount            NUMERIC NOT NULL CHECK (amount >= 0),
  inventory_item_id UUID,
  site_id           UUID,
  base_qty          NUMERIC,
  base_unit_cost    NUMERIC,
  CONSTRAINT stii_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stii_item_fk FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT,
  CONSTRAINT stii_site_fk FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  CONSTRAINT stii_stock_fields_check CHECK (
    (inventory_item_id IS NULL AND site_id IS NULL AND base_qty IS NULL AND base_unit_cost IS NULL)
    OR (inventory_item_id IS NOT NULL AND site_id IS NOT NULL AND base_qty > 0 AND base_unit_cost >= 0))
);
CREATE INDEX idx_stii_invoice ON supplier_tax_invoice_items(invoice_id);
CREATE INDEX idx_stii_tenant ON supplier_tax_invoice_items(tenant_id);

-- expense_id has NO foreign key on purpose (PostgREST would see a second
-- purchase_orders<->expenses path through this table). The RPCs own its integrity.
CREATE TABLE supplier_tax_invoice_pos (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id         UUID NOT NULL,
  po_id              UUID NOT NULL,
  active             BOOLEAN NOT NULL DEFAULT true,
  po_subtotal        NUMERIC,
  expense_id         UUID,
  prev_invoice_no    TEXT,
  stamped_invoice_no TEXT,
  CONSTRAINT stip_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stip_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  CONSTRAINT stip_invoice_po_uq UNIQUE (invoice_id, po_id)
);
-- Ruling A5: a PO belongs to at most one non-void invoice (drafts included).
CREATE UNIQUE INDEX stip_po_active_uq ON supplier_tax_invoice_pos (po_id) WHERE active;
CREATE INDEX idx_stip_tenant ON supplier_tax_invoice_pos(tenant_id);

-- What post reversed, so void can restore it. po_id/item/site are plain copies (no FK, see above).
CREATE TABLE supplier_tax_invoice_reversals (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                  BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id           UUID NOT NULL,
  po_id                UUID NOT NULL,
  source_movement_id   UUID NOT NULL,
  reversal_movement_id UUID NOT NULL,
  restored_movement_id UUID,
  inventory_item_id    UUID NOT NULL,
  site_id              UUID NOT NULL,
  quantity             NUMERIC NOT NULL CHECK (quantity > 0),
  unit_cost            NUMERIC NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stir_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT stir_source_fk FOREIGN KEY (source_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT stir_reversal_fk FOREIGN KEY (reversal_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT stir_restored_fk FOREIGN KEY (restored_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT
);
CREATE INDEX idx_stir_invoice ON supplier_tax_invoice_reversals(invoice_id);
CREATE INDEX idx_stir_po ON supplier_tax_invoice_reversals(po_id);
CREATE INDEX idx_stir_tenant ON supplier_tax_invoice_reversals(tenant_id);

ALTER TABLE supplier_tax_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_pos ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read ON supplier_tax_invoices FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_items FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_pos FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_reversals FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

REVOKE ALL ON supplier_tax_invoices, supplier_tax_invoice_items, supplier_tax_invoice_pos, supplier_tax_invoice_reversals FROM anon, authenticated;
GRANT SELECT ON supplier_tax_invoices, supplier_tax_invoice_items, supplier_tax_invoice_pos, supplier_tax_invoice_reversals TO authenticated;

-- New movement type (keep every type q1 listed; add receipt_reversal).
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment', 'purchase_return', 'receipt_reversal'));

-- ── pure math (mirrored in src/lib/supplierTaxInvoice.js) ──
CREATE OR REPLACE FUNCTION _sti_tolerance(p_base NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT LEAST(abs(COALESCE(p_base, 0)) * 0.01, 5)
$$;

-- = record_stock_movement purchase_in: new qty 0 -> 0.
CREATE OR REPLACE FUNCTION _sti_wac_after_in(q NUMERIC, w NUMERIC, a NUMERIC, c NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN q + a = 0 THEN 0 ELSE (q * w + a * COALESCE(c, 0)) / (q + a) END
$$;

-- Exact inverse of a receipt (ruling A2): balance <= 0 keeps WAC; never negative.
CREATE OR REPLACE FUNCTION _sti_wac_after_reversal(q NUMERIC, w NUMERIC, r NUMERIC, c NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN q - r <= 0 THEN w ELSE GREATEST((q * w - r * COALESCE(c, 0)) / (q - r), 0) END
$$;

-- PO goods value ex-VAT. MUST equal receive_po_with_deposits' v_sub (2026-10-07-02 lines 33-39)
-- and calcPoTotals().subtotal in src/lib/poTotals.js. NULL when the PO is not the tenant's.
CREATE OR REPLACE FUNCTION _po_goods_subtotal(p_po_id UUID, p_tenant UUID) RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has_vat BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has_vat, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = p_tenant;
  IF NOT v_has_vat THEN RETURN v_raw;
  ELSIF v_incl THEN RETURN round(round(v_raw, 2) / 1.07, 2);
  ELSE RETURN v_raw;
  END IF;
END $$;

-- True when the PO is linked to a POSTED invoice.
CREATE OR REPLACE FUNCTION _po_tax_invoiced(p_po_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos l JOIN supplier_tax_invoices i ON i.id = l.invoice_id
                  WHERE l.po_id = p_po_id AND l.active AND i.status = 'posted')
$$;

-- The only writer of receipt_reversal movements. Called only from the definer RPCs.
CREATE OR REPLACE FUNCTION _stock_receipt_reversal(
  p_tenant UUID, p_item UUID, p_site UUID, p_qty NUMERIC, p_unit_cost NUMERIC,
  p_reference_type TEXT, p_reference_id UUID, p_notes TEXT, p_at TIMESTAMPTZ
) RETURNS TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old_qty NUMERIC; v_old_wac NUMERIC; v_new_qty NUMERIC; v_new_wac NUMERIC; v_id UUID;
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM current_tenant_id() THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_item AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
    FROM inventory_stock_balances WHERE inventory_item_id = p_item AND site_id = p_site FOR UPDATE;
  IF NOT FOUND THEN v_old_qty := 0; v_old_wac := 0; END IF;
  v_new_qty := v_old_qty - p_qty;
  v_new_wac := _sti_wac_after_reversal(v_old_qty, v_old_wac, p_qty, p_unit_cost);

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes, created_by, created_at)
  VALUES (p_tenant, p_item, p_site, 'receipt_reversal', p_qty, COALESCE(p_unit_cost, 0),
          p_reference_type, p_reference_id, p_notes, auth.email(), COALESCE(p_at, now()))
  RETURNING id INTO v_id;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (p_tenant, p_item, p_site, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_id, v_new_qty, v_new_wac;
END $$;

-- ── locks (ruling A14) ──
CREATE OR REPLACE FUNCTION po_block_when_tax_invoiced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
      OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.has_vat IS DISTINCT FROM OLD.has_vat
      OR NEW.price_includes_vat IS DISTINCT FROM OLD.price_includes_vat
      OR NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice)
     AND _po_tax_invoiced(OLD.id) THEN
    RAISE EXCEPTION 'po_tax_invoiced';
  END IF;
  IF OLD.status = 'received' AND NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice THEN
    RAISE EXCEPTION 'po_stock_flag_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_block_when_tax_invoiced_trg BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION po_block_when_tax_invoiced();

CREATE OR REPLACE FUNCTION poi_block_when_tax_invoiced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF _po_tax_invoiced(NEW.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF _po_tax_invoiced(OLD.po_id) OR _po_tax_invoiced(NEW.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN NEW;
  ELSE
    IF _po_tax_invoiced(OLD.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN OLD;
  END IF;
END $$;
CREATE TRIGGER poi_block_when_tax_invoiced_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION poi_block_when_tax_invoiced();

REVOKE ALL ON FUNCTION _sti_tolerance(NUMERIC), _sti_wac_after_in(NUMERIC, NUMERIC, NUMERIC, NUMERIC),
  _sti_wac_after_reversal(NUMERIC, NUMERIC, NUMERIC, NUMERIC), _po_goods_subtotal(UUID, UUID), _po_tax_invoiced(UUID),
  _stock_receipt_reversal(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, UUID, TEXT, TIMESTAMPTZ),
  po_block_when_tax_invoiced(), poi_block_when_tax_invoiced()
  FROM PUBLIC, anon, authenticated;
```

- [ ] **Step 4: Static checks** (no database):
  - `grep -c "SECURITY DEFINER" supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql` → 5 (`_po_goods_subtotal`, `_po_tax_invoiced`, `_stock_receipt_reversal`, two trigger functions). Each of those names, plus the three IMMUTABLE helpers, appears in the final `REVOKE` statement. Check with `grep -o "FUNCTION [a-z_]*(" <file> | sort -u` against the REVOKE text.
  - `grep -n "expenses" <file>` shows no `ALTER TABLE expenses`.
  - Re-read the movement-type CHECK against the q1 result.
  - Do NOT apply the migration and do NOT run the test file.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql supabase/tests/supplier_tax_invoice_test.sql
git commit -m "feat(db): supplier tax invoice tables, PO locks, receipt_reversal helper"
```

---

### Task 3: Migration 2: RPCs (+ SQL test part B)

**Files:**
- Create: `supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql`
- Modify: `supabase/tests/supplier_tax_invoice_test.sql` (replace the `-- ── Part B (Task 3) goes here ──` line)

**Interfaces:**
- Consumes: everything Task 2 produces; `record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT)`; tables `supplier_credit_notes(po_id, status, tenant_id)` and `po_deposit_applications(po_id, tenant_id)`.
- Produces (client-callable, granted to `authenticated`):
  - `save_supplier_tax_invoice_draft(p_id UUID, p_header JSONB, p_items JSONB, p_po_ids UUID[]) RETURNS UUID`. `p_id` is NULL for a new draft. `p_header` = `{supplier_id, invoice_no, invoice_date 'YYYY-MM-DD', net_before_vat, vat, match_note}`. `p_items` = `[{description, qty, unit, unit_price, discount_pct, inventory_item_id|null, site_id|null, base_qty|null}]`.
  - `delete_supplier_tax_invoice_draft(p_id UUID) RETURNS VOID`
  - `preview_supplier_tax_invoice(p_id UUID) RETURNS JSONB` = `{checks: [{code, blocking, po_id, detail}], po_sum, diff, tolerance, lines_sum, rows: [{inventory_item_id, site_id, item_name, base_unit, site_name, before_qty, before_wac, add_qty, remove_qty, after_qty, after_wac, negative}]}`
  - `post_supplier_tax_invoice(p_id UUID) RETURNS JSONB` = `{lines_posted, receipts_reversed, expenses_stamped, po_sum, diff, checks, negative: [{inventory_item_id, site_id, item_name, site_name, qty}]}` (also stored in `post_result`).
  - `void_supplier_tax_invoice(p_id UUID, p_reason TEXT) RETURNS JSONB` = `{warnings: [{code, po_id}], negative: [...]}`
  - Errors: `insufficient_privilege`, `invoice_not_found`, `not_draft`, `not_posted`, `void_reason_required`, `bad_header`, `bad_item`, `stock_line_incomplete`, `invoice_date_in_future`, `cross_tenant_reference`, `po_not_eligible`, `po_linked_elsewhere`, plus any blocking check code (see `_sti_check`), plus `23505` on `sti_invoice_no_active_uq` / `stip_po_active_uq`.
- Private: `_sti_stock_lines(UUID, UUID)`, `_sti_receipt_movements(UUID, UUID)`, `_sti_check(UUID, UUID) RETURNS JSONB`, `_sti_touched_keys(UUID, UUID)`.

- [ ] **Step 1: Write SQL test part B** first (it is the spec of the RPCs). Paste it in place of the marker in `supabase/tests/supplier_tax_invoice_test.sql`:

```sql
  -- receive POs the way the app does: RPC, then the client's record_stock_movement loop
  PERFORM receive_po_with_deposits(po1, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(x, s1, 'purchase_in', 10, 100, 'purchase_order', po1, NULL);
  PERFORM receive_po_with_deposits(po2, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 5, 200, 'purchase_order', po2, NULL);
  PERFORM record_stock_movement(x, s1, 'sale_out', 4, 100, 'invoice', NULL, NULL);       -- COGS consumed 4
  SELECT expense_id INTO e1 FROM purchase_orders WHERE id = po1;
  SELECT expense_id INTO e2 FROM purchase_orders WHERE id = po2;
  SELECT amount, amount_no_vat, vat, invoice_no INTO e1_amt, e1_net, e1_vat, e1_prev FROM expenses WHERE id = e1;
  SELECT amount INTO e2_amt FROM expenses WHERE id = e2;

  -- T2: save a draft (2 POs, invoice items differ from PO items)
  inv1 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-001', 'invoice_date', v_bkk, 'net_before_vat', 2000, 'vat', 140),
    jsonb_build_array(
      jsonb_build_object('description', 'อลู X', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', x, 'site_id', s1, 'base_qty', 12),
      jsonb_build_object('description', 'กระจก Y', 'qty', 4, 'unit', 'แผ่น', 'unit_price', 230, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 4)),
    ARRAY[po1, po2]);
  IF (SELECT grand_total FROM supplier_tax_invoices WHERE id = inv1) <> 2140
     OR (SELECT count(*) FROM supplier_tax_invoice_pos WHERE invoice_id = inv1 AND active) <> 2
     OR (SELECT amount FROM supplier_tax_invoice_items WHERE invoice_id = inv1 AND inventory_item_id = x) <> 1080
     OR (SELECT base_unit_cost FROM supplier_tax_invoice_items WHERE invoice_id = inv1 AND inventory_item_id = y) <> 230 THEN
    RAISE EXCEPTION 'T2 FAIL: draft not saved as expected';
  END IF;
  RAISE NOTICE 'T2 (save draft): PASSED';

  -- T3: a PO cannot be in two non-void invoices
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-002', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
      '[]'::jsonb, ARRAY[po1]);
    RAISE EXCEPTION 'T3 FAIL: PO linked twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_linked_elsewhere%' THEN RAISE EXCEPTION 'T3 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoices WHERE invoice_no = 'STI-002') THEN RAISE EXCEPTION 'T3 FAIL: half-saved draft'; END IF;
  RAISE NOTICE 'T3 (PO linked twice rejected): PASSED';

  -- T4: preview = exactly what post will do (same numbers as vitest simulateStock)
  v_j := preview_supplier_tax_invoice(inv1);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T4 FAIL: unexpected blocking check %', v_j->'checks';
  END IF;
  SELECT (r->>'after_qty')::numeric, round((r->>'after_wac')::numeric, 6) INTO v_q, v_w
    FROM jsonb_array_elements(v_j->'rows') r WHERE (r->>'inventory_item_id')::uuid = x;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T4 FAIL: X preview % @ %', v_q, v_w; END IF;
  IF (v_j->>'po_sum')::numeric <> 2000 OR (v_j->>'diff')::numeric <> 0 THEN RAISE EXCEPTION 'T4 FAIL: match %', v_j; END IF;
  RAISE NOTICE 'T4 (preview): PASSED';

  -- T5: post: lines first, then reversals; expenses stamped, amounts unchanged; dated invoice date
  v_j := post_supplier_tax_invoice(inv1);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T5 FAIL: X % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 4 OR v_w <> 230 THEN RAISE EXCEPTION 'T5 FAIL: Y % @ %', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'purchase_in';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % invoice movements', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % reversal movements', v_cnt; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1
              AND (created_at AT TIME ZONE 'Asia/Bangkok')::date <> v_bkk) THEN
    RAISE EXCEPTION 'T5 FAIL: movement not dated on the invoice date';
  END IF;
  IF (SELECT count(*) FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1) <> 2 THEN RAISE EXCEPTION 'T5 FAIL: reversal rows'; END IF;
  IF NOT EXISTS (SELECT 1 FROM expenses WHERE id = e1 AND invoice_no = 'STI-001' AND amount = e1_amt AND amount_no_vat = e1_net AND vat = e1_vat)
     OR NOT EXISTS (SELECT 1 FROM expenses WHERE id = e2 AND invoice_no = 'STI-001' AND amount = e2_amt) THEN
    RAISE EXCEPTION 'T5 FAIL: expense stamp/amount';
  END IF;
  IF (SELECT status FROM supplier_tax_invoices WHERE id = inv1) <> 'posted' OR (v_j->>'receipts_reversed')::int <> 2 THEN
    RAISE EXCEPTION 'T5 FAIL: status/result %', v_j;
  END IF;
  RAISE NOTICE 'T5 (post): PASSED';

  -- T6: second post -> not_draft, nothing written
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = inv1;
  BEGIN
    PERFORM post_supplier_tax_invoice(inv1);
    RAISE EXCEPTION 'T6 FAIL: posted twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_draft%' THEN RAISE EXCEPTION 'T6 FAIL: got %', v_msg; END IF;
  END;
  IF (SELECT count(*) FROM stock_movements WHERE reference_id = inv1) <> v_cnt THEN RAISE EXCEPTION 'T6 FAIL: extra movements'; END IF;
  RAISE NOTICE 'T6 (idempotent post): PASSED';

  -- T7: a PO linked to a posted invoice is locked (header and items)
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = po1;
    RAISE EXCEPTION 'T7 FAIL: PO status changed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T7 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    UPDATE purchase_order_items SET unit_price = 1 WHERE po_id = po1;
    RAISE EXCEPTION 'T7 FAIL: PO item changed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T7 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T7 (PO lock): PASSED';

  -- T8: the client cannot forge the posted state
  BEGIN
    UPDATE supplier_tax_invoices SET status = 'draft' WHERE id = inv1;
    RAISE EXCEPTION 'T8 FAIL: client update allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1;
    RAISE EXCEPTION 'T8 FAIL: client delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'T8 (no forging): PASSED';

  -- T9: void restores balances/WAC exactly and the expenses' invoice numbers
  BEGIN
    PERFORM void_supplier_tax_invoice(inv1, '  ');
    RAISE EXCEPTION 'T9 FAIL: void without reason';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'void_reason_required%' THEN RAISE EXCEPTION 'T9 FAIL: got %', v_msg; END IF;
  END;
  v_j := void_supplier_tax_invoice(inv1, 'ทดสอบ');
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 6 OR v_w <> 100 THEN RAISE EXCEPTION 'T9 FAIL: X % @ % (want 6 @ 100)', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 5 OR v_w <> 200 THEN RAISE EXCEPTION 'T9 FAIL: Y % @ % (want 5 @ 200)', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = e1) IS DISTINCT FROM e1_prev
     OR (SELECT notes FROM expenses WHERE id = e1) NOT LIKE '%ยกเลิกใบกำกับภาษี STI-001%'
     OR (SELECT amount FROM expenses WHERE id = e1) <> e1_amt THEN
    RAISE EXCEPTION 'T9 FAIL: expense not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = inv1 AND active)
     OR (SELECT status FROM supplier_tax_invoices WHERE id = inv1) <> 'void'
     OR EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1 AND restored_movement_id IS NULL) THEN
    RAISE EXCEPTION 'T9 FAIL: links/status/restored ids';
  END IF;
  RAISE NOTICE 'T9 (void restores): PASSED';

  -- T10: void twice / post a void -> refused
  BEGIN
    PERFORM void_supplier_tax_invoice(inv1, 'again');
    RAISE EXCEPTION 'T10 FAIL: voided twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_posted%' THEN RAISE EXCEPTION 'T10 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM post_supplier_tax_invoice(inv1);
    RAISE EXCEPTION 'T10 FAIL: posted a void';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_draft%' THEN RAISE EXCEPTION 'T10 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T10 (idempotent void): PASSED';

  -- T11: after void, the number and the PO are free again; draft delete works
  tmp := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', ' sti-001 ', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    '[]'::jsonb, ARRAY[po1]);
  PERFORM delete_supplier_tax_invoice_draft(tmp);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoices WHERE id = tmp) OR EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = tmp) THEN
    RAISE EXCEPTION 'T11 FAIL: draft not deleted';
  END IF;
  RAISE NOTICE 'T11 (reuse after void, delete draft): PASSED';

  -- T12: consumed stock -> negative balance allowed and reported; match note needed; void restores
  PERFORM receive_po_with_deposits(po3, '[]'::jsonb, 2000, 140);
  PERFORM record_stock_movement(x, s2, 'purchase_in', 20, 100, 'purchase_order', po3, NULL);
  PERFORM record_stock_movement(x, s2, 'sale_out', 18, 100, 'invoice', NULL, NULL);       -- 2 left
  inv2 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NEG', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s2, 'base_qty', 5)),
    ARRAY[po3]);
  BEGIN
    PERFORM post_supplier_tax_invoice(inv2);
    RAISE EXCEPTION 'T12 FAIL: posted without match note';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'match_note_required%' THEN RAISE EXCEPTION 'T12 FAIL: got %', v_msg; END IF;
  END;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2) <> 2
     OR EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = inv2) THEN
    RAISE EXCEPTION 'T12 FAIL: failed post wrote something';
  END IF;
  PERFORM save_supplier_tax_invoice_draft(inv2,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NEG', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35, 'match_note', 'ส่งของไม่ครบ'),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s2, 'base_qty', 5)),
    ARRAY[po3]);
  v_j := post_supplier_tax_invoice(inv2);
  IF jsonb_array_length(v_j->'negative') <> 1 OR ((v_j->'negative'->0)->>'qty')::numeric <> -13 THEN
    RAISE EXCEPTION 'T12 FAIL: negative not reported %', v_j;
  END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2;
  IF v_q <> -13 OR v_w <> 100 THEN RAISE EXCEPTION 'T12 FAIL: % @ %', v_q, v_w; END IF;
  IF (SELECT match_diff FROM supplier_tax_invoices WHERE id = inv2) <> -1500 THEN RAISE EXCEPTION 'T12 FAIL: match_diff'; END IF;
  PERFORM void_supplier_tax_invoice(inv2, 'ทดสอบ');
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2;
  IF v_q <> 2 OR v_w <> 100 THEN RAISE EXCEPTION 'T12 FAIL: void -> % @ %', v_q, v_w; END IF;
  RAISE NOTICE 'T12 (negative allowed + reported, void restores): PASSED';

  -- T13: deposit-covered PO (no expense): match on goods value, stamping skipped with a warning
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'มัดจำ', s1, t_cat, sa, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO d_exp;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (d_exp, 'AI-STI-1') RETURNING id INTO d_dep;
  IF receive_po_with_deposits(po4, jsonb_build_array(jsonb_build_object('deposit_id', d_dep, 'amount_no_vat', 500)), 500, 35) IS NOT NULL THEN
    RAISE EXCEPTION 'T13 FAIL: deposit fixture created an expense';
  END IF;
  PERFORM record_stock_movement(x, s1, 'purchase_in', 5, 100, 'purchase_order', po4, NULL);
  inv3 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-DEP', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s1, 'base_qty', 5)),
    ARRAY[po4]);
  v_j := post_supplier_tax_invoice(inv3);
  IF (v_j->>'diff')::numeric <> 0 OR (v_j->>'expenses_stamped')::int <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_no_expense')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_has_deposit') THEN
    RAISE EXCEPTION 'T13 FAIL: %', v_j;
  END IF;
  PERFORM void_supplier_tax_invoice(inv3, 'ทดสอบ');
  RAISE NOTICE 'T13 (deposit-covered PO): PASSED';

  -- T14: stock_from_invoice PO: no receipt movement -> nothing reversed; flag locked once posted / received
  PERFORM receive_po_with_deposits(po5, '[]'::jsonb, 600, 42);       -- the app skips the stock loop for this PO
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;   -- 5
  inv4 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-FLAG', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42),
    jsonb_build_array(jsonb_build_object('description', 'Y', 'qty', 3, 'unit', 'แผ่น', 'unit_price', 200, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 3)),
    ARRAY[po5]);
  v_j := preview_supplier_tax_invoice(inv4);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_stock_from_invoice') THEN
    RAISE EXCEPTION 'T14 FAIL: flag check missing %', v_j->'checks';
  END IF;
  PERFORM post_supplier_tax_invoice(inv4);
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1) <> v_q + 3
     OR EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv4) THEN
    RAISE EXCEPTION 'T14 FAIL: flagged PO stock';
  END IF;
  BEGIN
    UPDATE purchase_orders SET stock_from_invoice = false WHERE id = po5;
    RAISE EXCEPTION 'T14 FAIL: flag changed on a posted-linked PO';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T14 FAIL: got %', v_msg; END IF;
  END;
  PERFORM receive_po_with_deposits(po6, '[]'::jsonb, 100, 7);
  BEGIN
    UPDATE purchase_orders SET stock_from_invoice = false WHERE id = po6;
    RAISE EXCEPTION 'T14 FAIL: flag changed after receive';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_stock_flag_locked%' THEN RAISE EXCEPTION 'T14 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T14 (stock_from_invoice): PASSED';

  -- T14b: flagged PO received by a stale client (stock posted anyway) -> the real movement is reversed
  PERFORM receive_po_with_deposits(po7, '[]'::jsonb, 400, 28);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 2, 200, 'purchase_order', po7, NULL);
  inv5 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-STALE', 'invoice_date', v_bkk, 'net_before_vat', 400, 'vat', 28),
    jsonb_build_array(jsonb_build_object('description', 'Y', 'qty', 2, 'unit', 'แผ่น', 'unit_price', 200, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 2)),
    ARRAY[po7]);
  v_j := preview_supplier_tax_invoice(inv5);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_stock_flag_but_received_stock') THEN
    RAISE EXCEPTION 'T14b FAIL: %', v_j->'checks';
  END IF;
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  PERFORM post_supplier_tax_invoice(inv5);
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1) <> v_q
     OR (SELECT count(*) FROM supplier_tax_invoice_reversals WHERE invoice_id = inv5) <> 1 THEN
    RAISE EXCEPTION 'T14b FAIL: stale receipt not reversed';
  END IF;
  RAISE NOTICE 'T14b (stale-client receipt reversed): PASSED';

  -- T15: lines must add up to net (ruling A9, no override)
  inv6 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70, 'match_note', 'x'),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 900)),
    ARRAY[po1]);
  BEGIN
    PERFORM post_supplier_tax_invoice(inv6);
    RAISE EXCEPTION 'T15 FAIL: posted with lines != net';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'lines_total_mismatch%' THEN RAISE EXCEPTION 'T15 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T15 (lines_total_mismatch): PASSED';

  -- T16: tolerance boundary on PO1 (subtotal 1000 -> tol 5): 1005.00 passes, 1005.02 needs a note
  PERFORM save_supplier_tax_invoice_draft(inv6,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1005, 'vat', 70.35),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1005)), ARRAY[po1]);
  v_j := preview_supplier_tax_invoice(inv6);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE (e->>'blocking')::boolean) THEN RAISE EXCEPTION 'T16 FAIL: 5.00 blocked %', v_j->'checks'; END IF;
  PERFORM save_supplier_tax_invoice_draft(inv6,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1005.02, 'vat', 70.35),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1005.02)), ARRAY[po1]);
  v_j := preview_supplier_tax_invoice(inv6);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'match_note_required') THEN RAISE EXCEPTION 'T16 FAIL: 5.02 passed'; END IF;
  PERFORM delete_supplier_tax_invoice_draft(inv6);
  RAISE NOTICE 'T16 (tolerance boundary): PASSED';

  -- T17: future date, cross-tenant PO, other tenant's invoice
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-FUT', 'invoice_date', v_bkk + 1, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
    RAISE EXCEPTION 'T17 FAIL: future date accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_date_in_future%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-X', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, ARRAY[t2_po]);
    RAISE EXCEPTION 'T17 FAIL: other tenant PO linked';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM post_supplier_tax_invoice(t2_inv);
    RAISE EXCEPTION 'T17 FAIL: posted another tenant invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_not_found%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T17 (date/cross-tenant): PASSED';

  -- T18: expired tenant cannot write
  inv7 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-EXP', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1000)), ARRAY[po1]);
  RESET role;
  UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = t_tenant;
  SET LOCAL role = 'authenticated';
  BEGIN
    PERFORM post_supplier_tax_invoice(inv7);
    RAISE EXCEPTION 'T18 FAIL: expired tenant posted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T18 FAIL: got %', v_msg; END IF;
  END;
  RESET role;
  UPDATE tenants SET trial_ends_at = now() + interval '14 days' WHERE id = t_tenant;
  SET LOCAL role = 'authenticated';
  RAISE NOTICE 'T18 (tenant_can_write): PASSED';
```
Note for whoever runs it: an expired trial may also turn off `has_module_access` (it depends on `trial_ends_at`). Either way the RPC must raise `insufficient_privilege`, which is what T18 checks.

- [ ] **Step 2: Write the migration** `supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql`:

```sql
-- ============================================================
-- Supplier tax invoice RPCs. Requires 2026-10-08-01.
-- Definer rights: the four tables are SELECT-only for clients. Each public RPC
-- re-checks role, module and tenant (and tenant_can_write() when it writes).
-- preview and post share _sti_check / _sti_stock_lines / _sti_receipt_movements
-- so the preview always shows what post will do. Each plpgsql call is atomic.
-- ============================================================

-- Stock lines in posting order.
CREATE OR REPLACE FUNCTION _sti_stock_lines(p_id UUID, p_tenant UUID)
RETURNS TABLE(line_id UUID, inventory_item_id UUID, site_id UUID, base_qty NUMERIC, base_unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.inventory_item_id, i.site_id, i.base_qty, i.base_unit_cost
    FROM supplier_tax_invoice_items i
   WHERE i.invoice_id = p_id AND i.tenant_id = p_tenant AND i.inventory_item_id IS NOT NULL
   ORDER BY i.sort_order, i.id
$$;

-- The linked POs' real receipt movements (ruling A1), in reversal order.
CREATE OR REPLACE FUNCTION _sti_receipt_movements(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.po_number::text, m.id, m.inventory_item_id, m.site_id, m.quantity, COALESCE(m.unit_cost, 0)
    FROM supplier_tax_invoice_pos l
    JOIN purchase_orders p ON p.id = l.po_id AND p.tenant_id = p_tenant
    JOIN stock_movements m ON m.tenant_id = p_tenant AND m.reference_type = 'purchase_order'
                          AND m.reference_id = p.id AND m.movement_type = 'purchase_in'
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
   ORDER BY p.id, m.created_at, m.id
$$;

-- Every (item, site) the post would touch, in lock order.
CREATE OR REPLACE FUNCTION _sti_touched_keys(p_id UUID, p_tenant UUID)
RETURNS TABLE(inventory_item_id UUID, site_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT k.inventory_item_id, k.site_id FROM (
    SELECT s.inventory_item_id, s.site_id FROM _sti_stock_lines(p_id, p_tenant) s
    UNION ALL
    SELECT r.inventory_item_id, r.site_id FROM _sti_receipt_movements(p_id, p_tenant) r) k
  ORDER BY 1, 2
$$;

-- Single source of truth for blocking checks and warnings (order = priority).
-- Returns {checks:[{code, blocking, po_id, detail}], po_sum, diff, tolerance, lines_sum}.
CREATE OR REPLACE FUNCTION _sti_check(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv supplier_tax_invoices%ROWTYPE;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  c JSONB := '[]'::jsonb;
  p RECORD;
  v_posum NUMERIC := 0; v_lines NUMERIC; v_diff NUMERIC; v_npos INT := 0;
  v_has_moves BOOLEAN;
BEGIN
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('checks', jsonb_build_array(jsonb_build_object('code', 'invoice_not_found', 'blocking', true)));
  END IF;
  IF inv.status <> 'draft' THEN c := c || jsonb_build_object('code', 'not_draft', 'blocking', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_items', 'blocking', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_pos', 'blocking', true);
  END IF;
  IF inv.invoice_date > v_today THEN c := c || jsonb_build_object('code', 'invoice_date_in_future', 'blocking', true); END IF;

  FOR p IN
    SELECT l.po_id AS link_po, po.id, po.supplier_id, po.status, po.date AS po_date, po.stock_from_invoice, po.expense_id
      FROM supplier_tax_invoice_pos l
      LEFT JOIN purchase_orders po ON po.id = l.po_id AND po.tenant_id = p_tenant
     WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
     ORDER BY l.po_id
  LOOP
    IF p.id IS NULL THEN
      c := c || jsonb_build_object('code', 'po_not_found', 'blocking', true, 'po_id', p.link_po);
      CONTINUE;
    END IF;
    v_npos := v_npos + 1;
    IF p.supplier_id IS DISTINCT FROM inv.supplier_id THEN c := c || jsonb_build_object('code', 'po_wrong_supplier', 'blocking', true, 'po_id', p.id); END IF;
    IF p.status <> 'received' THEN c := c || jsonb_build_object('code', 'po_not_received', 'blocking', true, 'po_id', p.id); END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos o WHERE o.po_id = p.id AND o.active AND o.invoice_id <> p_id) THEN
      c := c || jsonb_build_object('code', 'po_linked_elsewhere', 'blocking', true, 'po_id', p.id);
    END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals r JOIN supplier_tax_invoices i ON i.id = r.invoice_id
                WHERE r.po_id = p.id AND i.status = 'posted' AND i.id <> p_id) THEN
      c := c || jsonb_build_object('code', 'po_already_reversed', 'blocking', true, 'po_id', p.id);
    END IF;
    -- warnings (never block)
    IF EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.po_id = p.id AND cn.tenant_id = p_tenant AND cn.status = 'confirmed') THEN
      c := c || jsonb_build_object('code', 'po_has_credit_note', 'blocking', false, 'po_id', p.id);
    END IF;
    v_has_moves := EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = p_tenant AND m.reference_type = 'purchase_order'
                             AND m.reference_id = p.id AND m.movement_type = 'purchase_in');
    IF NOT v_has_moves THEN
      c := c || jsonb_build_object('code', CASE WHEN p.stock_from_invoice THEN 'po_stock_from_invoice' ELSE 'po_no_receipt_movements' END,
                                   'blocking', false, 'po_id', p.id);
    ELSIF p.stock_from_invoice THEN
      c := c || jsonb_build_object('code', 'po_stock_flag_but_received_stock', 'blocking', false, 'po_id', p.id);
    END IF;
    IF date_trunc('month', p.po_date) <> date_trunc('month', inv.invoice_date) THEN
      c := c || jsonb_build_object('code', 'po_outside_month', 'blocking', false, 'po_id', p.id);
    END IF;
    IF EXISTS (SELECT 1 FROM po_deposit_applications a WHERE a.po_id = p.id AND a.tenant_id = p_tenant) THEN
      c := c || jsonb_build_object('code', 'po_has_deposit', 'blocking', false, 'po_id', p.id);
    END IF;
    IF p.expense_id IS NULL THEN c := c || jsonb_build_object('code', 'po_no_expense', 'blocking', false, 'po_id', p.id); END IF;
    v_posum := v_posum + COALESCE(_po_goods_subtotal(p.id, p_tenant), 0);
  END LOOP;

  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_items i
              WHERE i.invoice_id = p_id AND i.inventory_item_id IS NOT NULL
                AND (NOT EXISTS (SELECT 1 FROM inventory_items x WHERE x.id = i.inventory_item_id AND x.tenant_id = p_tenant)
                     OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = i.site_id AND s.tenant_id = p_tenant))) THEN
    c := c || jsonb_build_object('code', 'stock_line_invalid', 'blocking', true);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_lines FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant;
  IF abs(v_lines - inv.net_before_vat) > _sti_tolerance(inv.net_before_vat) + 0.005 THEN
    c := c || jsonb_build_object('code', 'lines_total_mismatch', 'blocking', true, 'detail', round(v_lines, 2)::text);
  END IF;

  v_posum := round(v_posum, 2);
  v_diff := round(inv.net_before_vat - v_posum, 2);
  IF v_npos > 0 AND abs(v_diff) > _sti_tolerance(v_posum) + 0.005 THEN
    IF COALESCE(btrim(inv.match_note), '') = '' THEN
      c := c || jsonb_build_object('code', 'match_note_required', 'blocking', true, 'detail', v_diff::text);
    ELSE
      c := c || jsonb_build_object('code', 'match_outside_tolerance', 'blocking', false, 'detail', v_diff::text);
    END IF;
  END IF;

  RETURN jsonb_build_object('checks', c, 'po_sum', v_posum, 'diff', v_diff, 'tolerance', _sti_tolerance(v_posum), 'lines_sum', round(v_lines, 2));
END $$;

-- ── save / delete draft (atomic; ruling A7, A8) ──
CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_draft(p_id UUID, p_header JSONB, p_items JSONB, p_po_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_id UUID := p_id;
  v_sup UUID; v_no TEXT; v_date DATE; v_net NUMERIC; v_vat NUMERIC; v_note TEXT; v_status TEXT;
  it JSONB; ord BIGINT;
  v_desc TEXT; v_qty NUMERIC; v_price NUMERIC; v_disc NUMERIC; v_amt NUMERIC; v_item UUID; v_site UUID; v_base NUMERIC;
  v_po UUID; v_psup UUID; v_pstatus TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  BEGIN
    v_sup  := (p_header->>'supplier_id')::uuid;
    v_no   := btrim(p_header->>'invoice_no');
    v_date := (p_header->>'invoice_date')::date;
    v_net  := round((p_header->>'net_before_vat')::numeric, 2);
    v_vat  := round(COALESCE((p_header->>'vat')::numeric, 0), 2);
    v_note := NULLIF(btrim(p_header->>'match_note'), '');
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_header';
  END;
  IF v_sup IS NULL OR COALESCE(v_no, '') = '' OR v_date IS NULL OR v_net IS NULL OR v_net < 0 OR v_vat < 0 THEN RAISE EXCEPTION 'bad_header'; END IF;
  IF v_date > v_today THEN RAISE EXCEPTION 'invoice_date_in_future'; END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_sup AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
  IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_item'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total, match_note, created_by)
    VALUES (v_tenant, v_sup, v_no, v_date, v_net, v_vat, round(v_net + v_vat, 2), v_note, auth.email())
    RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM supplier_tax_invoices WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
    UPDATE supplier_tax_invoices
       SET supplier_id = v_sup, invoice_no = v_no, invoice_date = v_date, net_before_vat = v_net, vat = v_vat,
           grand_total = round(v_net + v_vat, 2), match_note = v_note
     WHERE id = v_id;
    DELETE FROM supplier_tax_invoice_items WHERE invoice_id = v_id;
    DELETE FROM supplier_tax_invoice_pos WHERE invoice_id = v_id;
  END IF;

  FOR it, ord IN SELECT value, ordinality FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY LOOP
    BEGIN
      v_desc  := btrim(it->>'description');
      v_qty   := (it->>'qty')::numeric;
      v_price := COALESCE((it->>'unit_price')::numeric, 0);
      v_disc  := COALESCE((it->>'discount_pct')::numeric, 0);
      v_item  := NULLIF(it->>'inventory_item_id', '')::uuid;
      v_site  := NULLIF(it->>'site_id', '')::uuid;
      v_base  := NULLIF(it->>'base_qty', '')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_item';
    END;
    IF COALESCE(v_desc, '') = '' OR v_qty IS NULL OR v_qty <= 0 OR v_price < 0 OR v_disc < 0 OR v_disc > 100 THEN RAISE EXCEPTION 'bad_item'; END IF;
    v_amt := round(v_qty * v_price * (1 - v_disc / 100), 2);
    IF v_item IS NULL THEN
      v_site := NULL; v_base := NULL;
    ELSE
      IF v_site IS NULL OR v_base IS NULL OR v_base <= 0 THEN RAISE EXCEPTION 'stock_line_incomplete'; END IF;
      IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = v_item AND tenant_id = v_tenant)
         OR NOT EXISTS (SELECT 1 FROM sites WHERE id = v_site AND tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'cross_tenant_reference';
      END IF;
    END IF;
    INSERT INTO supplier_tax_invoice_items (tenant_id, invoice_id, sort_order, description, qty, unit, unit_price, discount_pct,
                                            amount, inventory_item_id, site_id, base_qty, base_unit_cost)
    VALUES (v_tenant, v_id, ord, v_desc, v_qty, NULLIF(btrim(it->>'unit'), ''), v_price, v_disc,
            v_amt, v_item, v_site, v_base, CASE WHEN v_item IS NULL THEN NULL ELSE v_amt / v_base END);
  END LOOP;

  FOR v_po IN SELECT DISTINCT u FROM unnest(COALESCE(p_po_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL ORDER BY u LOOP
    SELECT supplier_id, status INTO v_psup, v_pstatus FROM purchase_orders WHERE id = v_po AND tenant_id = v_tenant;
    IF NOT FOUND OR v_psup IS DISTINCT FROM v_sup OR v_pstatus <> 'received' THEN RAISE EXCEPTION 'po_not_eligible'; END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = v_po AND active AND invoice_id <> v_id) THEN
      RAISE EXCEPTION 'po_linked_elsewhere';
    END IF;
    INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (v_tenant, v_id, v_po);
  END LOOP;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION delete_supplier_tax_invoice_draft(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant UUID := current_tenant_id(); v_status TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT status INTO v_status FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  DELETE FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant;   -- items + links cascade
END $$;

-- ── preview (read-only; simulates post with the same helpers and order) ──
CREATE OR REPLACE FUNCTION preview_supplier_tax_invoice(p_id UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_chk JSONB; v_state JSONB := '{}'::jsonb; v_rows JSONB;
  r RECORD; k TEXT; st JSONB; q NUMERIC; w NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  v_chk := _sti_check(p_id, v_tenant);
  IF (v_chk->'checks'->0->>'code') = 'invoice_not_found' THEN RETURN v_chk || jsonb_build_object('rows', '[]'::jsonb); END IF;

  FOR r IN SELECT * FROM _sti_touched_keys(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text;
    SELECT quantity_on_hand, weighted_average_cost INTO q, w FROM inventory_stock_balances
     WHERE inventory_item_id = r.inventory_item_id AND site_id = r.site_id;
    IF NOT FOUND THEN q := 0; w := 0; END IF;
    v_state := v_state || jsonb_build_object(k, jsonb_build_object('item', r.inventory_item_id, 'site', r.site_id,
      'before_qty', q, 'before_wac', w, 'add_qty', 0, 'remove_qty', 0, 'qty', q, 'wac', w));
  END LOOP;

  FOR r IN SELECT * FROM _sti_stock_lines(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text; st := v_state->k;
    q := (st->>'qty')::numeric; w := (st->>'wac')::numeric;
    st := st || jsonb_build_object('wac', _sti_wac_after_in(q, w, r.base_qty, r.base_unit_cost),
                                   'qty', q + r.base_qty, 'add_qty', (st->>'add_qty')::numeric + r.base_qty);
    v_state := v_state || jsonb_build_object(k, st);
  END LOOP;

  FOR r IN SELECT * FROM _sti_receipt_movements(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text; st := v_state->k;
    q := (st->>'qty')::numeric; w := (st->>'wac')::numeric;
    st := st || jsonb_build_object('wac', _sti_wac_after_reversal(q, w, r.quantity, r.unit_cost),
                                   'qty', q - r.quantity, 'remove_qty', (st->>'remove_qty')::numeric + r.quantity);
    v_state := v_state || jsonb_build_object(k, st);
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'inventory_item_id', t.val->'item', 'site_id', t.val->'site', 'item_name', ii.name, 'base_unit', ii.base_unit, 'site_name', s.name,
           'before_qty', t.val->'before_qty', 'before_wac', t.val->'before_wac', 'add_qty', t.val->'add_qty', 'remove_qty', t.val->'remove_qty',
           'after_qty', t.val->'qty', 'after_wac', t.val->'wac', 'negative', (t.val->>'qty')::numeric < 0)
         ORDER BY ii.name, s.name), '[]'::jsonb)
    INTO v_rows
    FROM jsonb_each(v_state) AS t(key, val)
    JOIN inventory_items ii ON ii.id = (t.val->>'item')::uuid AND ii.tenant_id = v_tenant
    JOIN sites s ON s.id = (t.val->>'site')::uuid AND s.tenant_id = v_tenant;

  RETURN v_chk || jsonb_build_object('rows', v_rows);
END $$;

-- Negative balances among the touched keys (post and void report them; ruling R2).
CREATE OR REPLACE FUNCTION _sti_negatives(p_tenant UUID, p_keys JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('inventory_item_id', b.inventory_item_id, 'site_id', b.site_id,
           'item_name', ii.name, 'site_name', s.name, 'qty', b.quantity_on_hand) ORDER BY ii.name, s.name), '[]'::jsonb)
    FROM inventory_stock_balances b
    JOIN inventory_items ii ON ii.id = b.inventory_item_id
    JOIN sites s ON s.id = b.site_id
   WHERE b.tenant_id = p_tenant AND b.quantity_on_hand < 0
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
$$;

-- ── post (spec steps 1-5) ──
CREATE OR REPLACE FUNCTION post_supplier_tax_invoice(p_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_chk JSONB; v_block TEXT; v_keys JSONB; v_result JSONB;
  v_at TIMESTAMPTZ;
  l RECORD; r RECORD; k RECORD; mv RECORD; rv RECORD;
  v_prev TEXT; v_sub NUMERIC;
  v_lines INT := 0; v_revs INT := 0; v_stamped INT := 0;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;

  -- fixed lock order: invoice -> POs by id -> balances by (item, site)
  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', t.inventory_item_id, 'site', t.site_id)), '[]'::jsonb)
    INTO v_keys FROM _sti_touched_keys(p_id, v_tenant) t;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  v_chk := _sti_check(p_id, v_tenant);
  SELECT t.e->>'code' INTO v_block
    FROM jsonb_array_elements(v_chk->'checks') WITH ORDINALITY AS t(e, ord)
   WHERE (t.e->>'blocking')::boolean ORDER BY t.ord LIMIT 1;
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block; END IF;

  v_at := (inv.invoice_date + time '12:00') AT TIME ZONE 'Asia/Bangkok';   -- ruling A4

  -- (a) invoice lines first, so the common case never dips below zero
  FOR l IN SELECT * FROM _sti_stock_lines(p_id, v_tenant) LOOP
    SELECT * INTO mv FROM record_stock_movement(l.inventory_item_id, l.site_id, 'purchase_in', l.base_qty, l.base_unit_cost,
                                                'supplier_tax_invoice', p_id, 'ใบกำกับ ' || inv.invoice_no);
    UPDATE stock_movements SET created_at = v_at WHERE id = mv.movement_id;
    v_lines := v_lines + 1;
  END LOOP;

  -- (b) reverse the linked POs' real receipts at their original cost
  FOR r IN SELECT * FROM _sti_receipt_movements(p_id, v_tenant) LOOP
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost,
      'supplier_tax_invoice', p_id, 'กลับรายการรับเข้า ' || r.po_number || ' (ใบกำกับ ' || inv.invoice_no || ')', v_at);
    INSERT INTO supplier_tax_invoice_reversals (tenant_id, invoice_id, po_id, source_movement_id, reversal_movement_id,
                                                inventory_item_id, site_id, quantity, unit_cost)
    VALUES (v_tenant, p_id, r.po_id, r.movement_id, rv.movement_id, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost);
    v_revs := v_revs + 1;
  END LOOP;

  -- (c) stamp the invoice number on each PO's expense; amounts untouched (ruling A6)
  FOR k IN SELECT l2.id AS link_id, p.id AS po_id, p.expense_id
             FROM supplier_tax_invoice_pos l2 JOIN purchase_orders p ON p.id = l2.po_id AND p.tenant_id = v_tenant
            WHERE l2.invoice_id = p_id ORDER BY p.id LOOP
    v_sub := _po_goods_subtotal(k.po_id, v_tenant);
    UPDATE supplier_tax_invoice_pos SET po_subtotal = v_sub WHERE id = k.link_id;
    IF k.expense_id IS NOT NULL THEN
      SELECT invoice_no INTO v_prev FROM expenses WHERE id = k.expense_id AND tenant_id = v_tenant FOR UPDATE;
      IF FOUND THEN
        UPDATE expenses
           SET invoice_no = inv.invoice_no,
               notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                         'ใบกำกับภาษี ' || inv.invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(v_prev), ''), '-') || ')')
         WHERE id = k.expense_id AND tenant_id = v_tenant;
        UPDATE supplier_tax_invoice_pos
           SET expense_id = k.expense_id, prev_invoice_no = v_prev, stamped_invoice_no = inv.invoice_no
         WHERE id = k.link_id;
        v_stamped := v_stamped + 1;
      END IF;
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'lines_posted', v_lines, 'receipts_reversed', v_revs, 'expenses_stamped', v_stamped,
    'po_sum', v_chk->'po_sum', 'diff', v_chk->'diff', 'checks', v_chk->'checks',
    'negative', _sti_negatives(v_tenant, v_keys));
  UPDATE supplier_tax_invoices
     SET status = 'posted', posted_at = now(), posted_by = auth.email(), match_diff = (v_chk->>'diff')::numeric, post_result = v_result
   WHERE id = p_id;
  RETURN v_result;
END $$;

-- ── void: exact undo in reverse order (ruling A3) ──
CREATE OR REPLACE FUNCTION void_supplier_tax_invoice(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_keys JSONB; v_warn JSONB := '[]'::jsonb;
  r RECORD; m RECORD; k RECORD; mv RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'void_reason_required'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;

  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', x.inventory_item_id, 'site', x.site_id)), '[]'::jsonb) INTO v_keys
    FROM (SELECT inventory_item_id, site_id FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant
          UNION
          SELECT inventory_item_id, site_id FROM stock_movements
           WHERE tenant_id = v_tenant AND reference_type = 'supplier_tax_invoice' AND reference_id = p_id AND movement_type = 'purchase_in') x;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  -- (1) put the PO receipts back at their original cost, newest reversal first
  FOR r IN SELECT * FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant ORDER BY seq DESC LOOP
    SELECT * INTO mv FROM record_stock_movement(r.inventory_item_id, r.site_id, 'purchase_in', r.quantity, r.unit_cost,
                                                'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no || ' (คืนรับเข้าใบสั่งซื้อ)');
    UPDATE supplier_tax_invoice_reversals SET restored_movement_id = mv.movement_id WHERE id = r.id;
  END LOOP;

  -- (2) take the invoice lines back out (exact inverse)
  FOR m IN SELECT id, inventory_item_id, site_id, quantity, unit_cost FROM stock_movements
            WHERE tenant_id = v_tenant AND reference_type = 'supplier_tax_invoice' AND reference_id = p_id AND movement_type = 'purchase_in'
            ORDER BY created_at DESC, id DESC LOOP
    PERFORM _stock_receipt_reversal(v_tenant, m.inventory_item_id, m.site_id, m.quantity, m.unit_cost,
                                    'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no, now());
  END LOOP;

  -- (3) restore expense numbers only where still ours (ruling A6)
  FOR k IN SELECT * FROM supplier_tax_invoice_pos
            WHERE invoice_id = p_id AND tenant_id = v_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
            ORDER BY po_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || inv.invoice_no)
     WHERE id = k.expense_id AND tenant_id = v_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'po_id', k.po_id); END IF;
  END LOOP;

  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoices
     SET status = 'void', voided_at = now(), voided_by = auth.email(), void_reason = btrim(p_reason)
   WHERE id = p_id;
  RETURN jsonb_build_object('warnings', v_warn, 'negative', _sti_negatives(v_tenant, v_keys));
END $$;

REVOKE ALL ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), delete_supplier_tax_invoice_draft(UUID),
  preview_supplier_tax_invoice(UUID), post_supplier_tax_invoice(UUID), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), delete_supplier_tax_invoice_draft(UUID),
  preview_supplier_tax_invoice(UUID), post_supplier_tax_invoice(UUID), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION _sti_stock_lines(UUID, UUID), _sti_receipt_movements(UUID, UUID), _sti_touched_keys(UUID, UUID),
  _sti_check(UUID, UUID), _sti_negatives(UUID, JSONB) FROM PUBLIC, anon, authenticated;
```

Notes for the implementer:
- `po_number`: if q2 showed it is not text, the `::text` cast covers it.
- The `invoice_not_found` short-circuit in preview depends on `_sti_check` returning that code first, which it does.
- `void` re-posts receipts through `record_stock_movement` `purchase_in`. Do not use a custom writer there: the inverse of `_sti_wac_after_reversal` is exactly the purchase_in formula.

- [ ] **Step 3: Static checks** (no database):
  - `grep -c "SECURITY DEFINER" supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql` = 10. Every one of those 10 function names appears in a `REVOKE` line; the 5 public ones also appear in the `GRANT`.
  - Every public RPC body contains `is_admin_or_owner() AND has_module_access('purchase_orders')`, and the 4 writers also contain `tenant_can_write()`. Check: `grep -n "tenant_can_write" <file>` → 4 hits (save, delete, post, void).
  - Every `FROM supplier_tax_invoice*`, `FROM purchase_orders` and `FROM stock_movements` query filters by `tenant_id` or joins through a tenant-filtered row. Read each and list any exception in the report.
  - No `notes` string starts with `P`. Check: `grep -n "'P[IO]-" <file>` → no hits.
  - The SQL test file has no `Part B (Task 3) goes here` marker left and ends with `RAISE EXCEPTION 'RESULT: …'` then `ROLLBACK;`.
  - Do NOT apply or run anything.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql supabase/tests/supplier_tax_invoice_test.sql
git commit -m "feat(db): supplier tax invoice RPCs (draft, preview, atomic post, exact void) and SQL tests"
```

---

### Task 4: Stock ledger understands `receipt_reversal` and the new references

**Files:**
- Modify: `src/lib/inventoryCost.js` (`computeStockLedgerReport` `direction` ~line 249; `resolveMovementReference` ~line 45)
- Modify: `src/lib/inventoryCost.test.js`
- Modify: `src/pages/Inventory.jsx` (`MOVEMENT_TYPE_LABELS` ~line 35; the tax-report generic label map ~line 521)

**Interfaces:**
- Consumes: movement rows `{movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_at, inventory_item_id}`.
- Produces: `receipt_reversal` is direction `'out'`. `resolveMovementReference` returns `notes || 'ใบกำกับภาษีผู้ขาย'` for `supplier_tax_invoice`, and `notes || 'ยกเลิกใบกำกับภาษีผู้ขาย'` for `supplier_tax_invoice_void`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/inventoryCost.test.js`; match the import style already at the top of that file):

```js
describe('receipt_reversal (supplier tax invoice)', () => {
  const items = [{ id: 'X', code: 'X1', name: 'X', base_unit: 'kg', item_kind: 'raw_material', category_id: null }]
  const mv = (type, qty, cost, at, extra = {}) => ({ inventory_item_id: 'X', movement_type: type, quantity: qty, unit_cost: cost, created_at: at, ...extra })
  it('counts receipt_reversal as stock OUT at its stored cost', () => {
    const [row] = computeStockLedgerReport({
      movements: [
        mv('purchase_in', 10, 100, '2026-09-01T03:00:00Z', { reference_type: 'purchase_order' }),
        mv('purchase_in', 12, 90, '2026-09-30T05:00:00Z', { reference_type: 'supplier_tax_invoice', notes: 'ใบกำกับ INV-1' }),
        mv('receipt_reversal', 10, 100, '2026-09-30T05:00:00Z', { reference_type: 'supplier_tax_invoice' }),
      ],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(row.inQty).toBe(22)
    expect(row.outQty).toBe(10)
    expect(row.closingQty).toBe(12)
    expect(row.closingValue).toBe(1080)
  })
  it('labels the new references from notes, with a fallback', () => {
    expect(resolveMovementReference({ reference_type: 'supplier_tax_invoice', notes: 'ใบกำกับ INV-1' })).toBe('ใบกำกับ INV-1')
    expect(resolveMovementReference({ reference_type: 'supplier_tax_invoice' })).toBe('ใบกำกับภาษีผู้ขาย')
    expect(resolveMovementReference({ reference_type: 'supplier_tax_invoice_void' })).toBe('ยกเลิกใบกำกับภาษีผู้ขาย')
  })
})
```
If `item_kind` values or the filter signature differ, read the existing `computeStockLedgerReport` tests in the same file and copy their fixture shape. Keep the asserted numbers.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/lib/inventoryCost.test.js`. Expected: FAIL. Today `receipt_reversal` falls into the adjustment branch and counts as **in** (outQty 0), and the labels return the raw `reference_type`.

- [ ] **Step 3: Implement.** In `computeStockLedgerReport`:

```js
    if (m.movement_type === 'transfer_out' || m.movement_type === 'sale_out' || m.movement_type === 'purchase_return' || m.movement_type === 'receipt_reversal') return 'out'
```
Update the JSDoc comment above `direction` to mention `receipt_reversal`. In `resolveMovementReference`, before the final `return`:

```js
  if (reference_type === 'supplier_tax_invoice') return movement.notes || 'ใบกำกับภาษีผู้ขาย'
  if (reference_type === 'supplier_tax_invoice_void') return movement.notes || 'ยกเลิกใบกำกับภาษีผู้ขาย'
```
In `src/pages/Inventory.jsx` add `receipt_reversal: '↩️ กลับรายการรับเข้า (ใบกำกับภาษี)'` to `MOVEMENT_TYPE_LABELS`, and `receipt_reversal: '↩️ กลับรายการรับเข้า'` to the generic tax-report label map near line 521.

- [ ] **Step 4: Sweep for other classifiers.** Run `grep -rn "sale_out\|purchase_return" src supabase/functions | grep -v test`. Every place that decides in/out or sums by movement type must treat `receipt_reversal` as out. Fix each JS hit in this task. List any SQL function from Task 2 Step 1 q6 in the report as "needs the controller's decision"; do not write a migration for it here.

- [ ] **Step 5: Run the tests and confirm they pass.** Run `npx vitest run` (all green) and `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js src/pages/Inventory.jsx
git commit -m "feat: stock ledger counts receipt_reversal as out and labels tax-invoice movements"
```

---

### Task 5: Hooks and RPC wrappers

**Files:**
- Modify: `src/hooks/useSupabase.js` (new section at the end: `// ── Supplier tax invoices (ใบกำกับภาษีผู้ขาย) ──`)
- Create: `src/lib/taxInvoiceLinks.js` + `src/lib/taxInvoiceLinks.test.js` (the pure part of the links hook)

**Interfaces:**
- Consumes: `useQuery`, `fetchAllRows`, constraint names from Task 2.
- Produces:
  - `useSupplierTaxInvoices({ supplierId, status })` → `{ data: rows|null, loading, error, refetch }`. Each row is `{...invoice, suppliers: {name, supplier_number}, supplier_tax_invoice_items: [...], supplier_tax_invoice_pos: [{id, po_id, active, po_subtotal, expense_id, prev_invoice_no, stamped_invoice_no, purchase_orders: {id, po_number, date, site_id, supplier_id, status}}]}`.
  - `useActiveTaxInvoiceLinks()` → `{ data: Map<po_id, {invoice_id, invoice_no, status}> | null, error, refetch }`; `data === null` means loading **or** the table is missing (feature not ready).
  - `buildActiveLinkMap(rows) → Map` (pure, in `taxInvoiceLinks.js`).
  - `saveSupplierTaxInvoiceDraft(id|null, header, items, poIds) → uuid`, `deleteSupplierTaxInvoiceDraft(id)`, `previewSupplierTaxInvoice(id) → json`, `postSupplierTaxInvoice(id) → json`, `voidSupplierTaxInvoice(id, reason) → json`. All of them throw the Supabase error object.

- [ ] **Step 1: Write the failing test** `src/lib/taxInvoiceLinks.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildActiveLinkMap } from './taxInvoiceLinks.js'

describe('buildActiveLinkMap', () => {
  it('maps po_id -> invoice, skipping rows without an embedded invoice', () => {
    const m = buildActiveLinkMap([
      { po_id: 'p1', invoice_id: 'i1', supplier_tax_invoices: { invoice_no: 'INV-1', status: 'posted' } },
      { po_id: 'p2', invoice_id: 'i2', supplier_tax_invoices: null },
    ])
    expect(m.get('p1')).toEqual({ invoice_id: 'i1', invoice_no: 'INV-1', status: 'posted' })
    expect(m.get('p2')).toEqual({ invoice_id: 'i2', invoice_no: '', status: '' })
  })
  it('null/undefined rows -> empty map (table missing before the migration)', () => {
    expect(buildActiveLinkMap(null).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `npx vitest run src/lib/taxInvoiceLinks.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/taxInvoiceLinks.js`:

```js
/** Map<po_id, {invoice_id, invoice_no, status}> from active supplier_tax_invoice_pos rows. */
export function buildActiveLinkMap(rows) {
  const m = new Map()
  for (const r of rows || []) {
    m.set(r.po_id, { invoice_id: r.invoice_id, invoice_no: r.supplier_tax_invoices?.invoice_no || '', status: r.supplier_tax_invoices?.status || '' })
  }
  return m
}
```
and append to `src/hooks/useSupabase.js` (add `import { buildActiveLinkMap } from '../lib/taxInvoiceLinks.js'` at the top with the other lib imports):

```js
// ── Supplier tax invoices (ใบกำกับภาษีผู้ขาย) ─────────────────
// Tables are SELECT-only for clients; every write is an RPC (see 2026-10-08-02).
// Embeds name the constraint explicitly (ambiguous-embed trap).

export function useSupplierTaxInvoices(filters = {}) {
  return useQuery(async () => fetchAllRows(() => {
    let q = supabase.from('supplier_tax_invoices')
      .select('*, suppliers!sti_supplier_fk(name, supplier_number), supplier_tax_invoice_items!stii_invoice_fk(*), supplier_tax_invoice_pos!stip_invoice_fk(id, po_id, active, po_subtotal, expense_id, prev_invoice_no, stamped_invoice_no, purchase_orders!stip_po_fk(id, po_number, date, site_id, supplier_id, status))')
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status) q = q.eq('status', filters.status)
    return q
  }), [JSON.stringify(filters)])
}

/** data: Map<po_id,{invoice_id, invoice_no, status}>, or null while loading / before the migration. */
export function useActiveTaxInvoiceLinks() {
  const { data, error, refetch } = useQuery(async () => fetchAllRows(() => supabase
    .from('supplier_tax_invoice_pos')
    .select('po_id, invoice_id, supplier_tax_invoices!stip_invoice_fk(invoice_no, status)')
    .eq('active', true)
    .order('id')), [])
  const map = useMemo(() => (data ? buildActiveLinkMap(data) : null), [data])
  return { data: map, error, refetch }
}

async function rpcOrThrow(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data
}
export const saveSupplierTaxInvoiceDraft = (id, header, items, poIds) =>
  rpcOrThrow('save_supplier_tax_invoice_draft', { p_id: id || null, p_header: header, p_items: items, p_po_ids: poIds })
export const deleteSupplierTaxInvoiceDraft = id => rpcOrThrow('delete_supplier_tax_invoice_draft', { p_id: id })
export const previewSupplierTaxInvoice = id => rpcOrThrow('preview_supplier_tax_invoice', { p_id: id })
export const postSupplierTaxInvoice = id => rpcOrThrow('post_supplier_tax_invoice', { p_id: id })
export const voidSupplierTaxInvoice = (id, reason) => rpcOrThrow('void_supplier_tax_invoice', { p_id: id, p_reason: reason })
```
(`useMemo` is already imported at the top of `useSupabase.js`; check it.)

- [ ] **Step 4: Run the tests.** `npx vitest run` (all green) and `npm run build`. These hooks cannot be verified live before the migration; say so in the report and do not claim the embeds work. The Task 9 handoff lists the post-migration embed check for the owner.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/lib/taxInvoiceLinks.js src/lib/taxInvoiceLinks.test.js
git commit -m "feat: supplier tax invoice hooks and RPC wrappers"
```

---

### Task 6: Invoice form: header, scan, PO picker, lines

**Files:**
- Create: `src/components/SupplierTaxInvoiceForm.jsx`
- Create: `src/lib/taxInvoiceForm.js` + `src/lib/taxInvoiceForm.test.js` (pure form ⇄ RPC payload mapping)

**Interfaces:**
- Consumes: Task 1 (`lineAmount`, `evaluateMatch`, `proposePos`, `lineBase`, `formSignature`), `calcPoTotals` (`src/lib/poTotals.js`), Task 5 hooks. Existing: `usePurchaseOrders`, `useSuppliers`, `useSites`, `useCategories`, `useInventoryItems`, `useAllInventoryItems`, `useInventoryItemUnitFactors`, `useSupplierDocumentExamples`, `extractPoDocument`, `useSupplierDeposits` (deposit feature), `fileToExtractionPayload` (`src/lib/poDocumentExtraction.js`), `SearchableSelect`, `QuickAddSelect`, `ScanNotice`, `ScanDocPreview`, `round2`.
- Produces:
  - `emptyTaxInvoiceForm(today) → form`, `formFromInvoice(row) → form`, `toRpcPayload(form) → { header, items, poIds }`, `validateFormForSave(form) → string[]` (Thai messages; empty = OK), all in `taxInvoiceForm.js`.
  - `<SupplierTaxInvoiceForm initial={form} invoiceId={uuid|null} busy={bool} onSaveDraft={form => Promise} onPreview={form => Promise} onCancel />`. The form owns its state, and calls `onSaveDraft(form)` / `onPreview(form)` with the current form.
  - The form shape: `{ supplier_id, invoice_no, invoice_date, net_before_vat, vat, match_note, lines: [{ key, description, qty, unit, unit_price, discount_pct, inventory_item_id, site_id, base_qty, base_manual }], po_ids: [] }`.

- [ ] **Step 1: Write the failing tests** `src/lib/taxInvoiceForm.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { emptyTaxInvoiceForm, formFromInvoice, toRpcPayload, validateFormForSave } from './taxInvoiceForm.js'

describe('taxInvoiceForm', () => {
  it('empty form uses the given date', () => {
    expect(emptyTaxInvoiceForm('2026-10-07')).toMatchObject({ invoice_date: '2026-10-07', lines: [], po_ids: [] })
  })
  it('payload: non-stock lines drop site/base; numbers are numbers', () => {
    const f = { ...emptyTaxInvoiceForm('2026-09-30'), supplier_id: 'A', invoice_no: ' INV-1 ', net_before_vat: '2000', vat: '140',
      lines: [
        { key: 1, description: 'X', qty: '12', unit: 'kg', unit_price: '90', discount_pct: '', inventory_item_id: 'X', site_id: 'S1', base_qty: '12' },
        { key: 2, description: 'ค่าขนส่ง', qty: '1', unit: '', unit_price: '920', discount_pct: '0', inventory_item_id: '', site_id: 'S1', base_qty: '5' },
      ], po_ids: ['p1'] }
    const { header, items, poIds } = toRpcPayload(f)
    expect(header).toEqual({ supplier_id: 'A', invoice_no: 'INV-1', invoice_date: '2026-09-30', net_before_vat: 2000, vat: 140, match_note: '' })
    expect(items[0]).toEqual({ description: 'X', qty: 12, unit: 'kg', unit_price: 90, discount_pct: 0, inventory_item_id: 'X', site_id: 'S1', base_qty: 12 })
    expect(items[1]).toEqual({ description: 'ค่าขนส่ง', qty: 1, unit: '', unit_price: 920, discount_pct: 0, inventory_item_id: null, site_id: null, base_qty: null })
    expect(poIds).toEqual(['p1'])
  })
  it('round-trips a saved invoice row', () => {
    const row = { supplier_id: 'A', invoice_no: 'INV-1', invoice_date: '2026-09-30', net_before_vat: 2000, vat: 140, match_note: null,
      supplier_tax_invoice_items: [{ sort_order: 2, description: 'b', qty: 1, unit: null, unit_price: 5, discount_pct: 0, inventory_item_id: null, site_id: null, base_qty: null },
                                   { sort_order: 1, description: 'a', qty: 2, unit: 'kg', unit_price: 3, discount_pct: 0, inventory_item_id: 'X', site_id: 'S', base_qty: 2 }],
      supplier_tax_invoice_pos: [{ po_id: 'p1', active: true }] }
    const f = formFromInvoice(row)
    expect(f.lines.map(l => l.description)).toEqual(['a', 'b'])
    expect(f.po_ids).toEqual(['p1'])
    expect(f.lines[0].base_manual).toBe(true)
  })
  it('validation messages', () => {
    const f = emptyTaxInvoiceForm('2026-09-30')
    expect(validateFormForSave(f)).toEqual(expect.arrayContaining(['เลือกซัพพลายเออร์', 'กรอกเลขที่ใบกำกับ', 'กรอกยอดก่อน VAT']))
    const g = { ...f, supplier_id: 'A', invoice_no: 'X', net_before_vat: '10', lines: [{ key: 1, description: 'x', qty: '1', unit_price: '10', inventory_item_id: 'X', site_id: '', base_qty: '' }] }
    expect(validateFormForSave(g)).toEqual(['รายการที่ 1: เลือกไซท์งาน และกรอกจำนวนในหน่วยหลัก'])
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/lib/taxInvoiceForm.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/taxInvoiceForm.js`:

```js
let keySeq = 0
const nextKey = () => ++keySeq
const num = v => (v === '' || v == null ? null : Number(v))

export const emptyLine = () => ({ key: nextKey(), description: '', qty: '1', unit: '', unit_price: '', discount_pct: '0', inventory_item_id: '', site_id: '', base_qty: '', base_manual: false })

export function emptyTaxInvoiceForm(today) {
  return { supplier_id: '', invoice_no: '', invoice_date: today, net_before_vat: '', vat: '', match_note: '', lines: [], po_ids: [] }
}

export function formFromInvoice(row) {
  return {
    supplier_id: row.supplier_id, invoice_no: row.invoice_no, invoice_date: row.invoice_date,
    net_before_vat: String(row.net_before_vat ?? ''), vat: String(row.vat ?? ''), match_note: row.match_note || '',
    lines: [...(row.supplier_tax_invoice_items || [])].sort((a, b) => a.sort_order - b.sort_order).map(i => ({
      key: nextKey(), description: i.description, qty: String(i.qty), unit: i.unit || '', unit_price: String(i.unit_price),
      discount_pct: String(i.discount_pct ?? 0), inventory_item_id: i.inventory_item_id || '', site_id: i.site_id || '',
      base_qty: i.base_qty != null ? String(i.base_qty) : '', base_manual: i.base_qty != null,
    })),
    po_ids: (row.supplier_tax_invoice_pos || []).filter(l => l.active).map(l => l.po_id),
  }
}

export function toRpcPayload(form) {
  return {
    header: {
      supplier_id: form.supplier_id, invoice_no: String(form.invoice_no || '').trim(), invoice_date: form.invoice_date,
      net_before_vat: num(form.net_before_vat), vat: num(form.vat) ?? 0, match_note: String(form.match_note || '').trim(),
    },
    items: (form.lines || []).map(l => {
      const stock = !!l.inventory_item_id
      return {
        description: String(l.description || '').trim(), qty: num(l.qty), unit: String(l.unit || '').trim(),
        unit_price: num(l.unit_price) ?? 0, discount_pct: num(l.discount_pct) ?? 0,
        inventory_item_id: stock ? l.inventory_item_id : null, site_id: stock ? (l.site_id || null) : null,
        base_qty: stock ? num(l.base_qty) : null,
      }
    }),
    poIds: [...(form.po_ids || [])],
  }
}

export function validateFormForSave(form) {
  const errs = []
  if (!form.supplier_id) errs.push('เลือกซัพพลายเออร์')
  if (!String(form.invoice_no || '').trim()) errs.push('กรอกเลขที่ใบกำกับ')
  if (!form.invoice_date) errs.push('กรอกวันที่ใบกำกับ')
  if (form.net_before_vat === '' || !(Number(form.net_before_vat) >= 0)) errs.push('กรอกยอดก่อน VAT')
  ;(form.lines || []).forEach((l, i) => {
    if (!String(l.description || '').trim() || !(Number(l.qty) > 0)) errs.push(`รายการที่ ${i + 1}: กรอกรายละเอียดและจำนวนมากกว่า 0`)
    else if (l.inventory_item_id && (!l.site_id || !(Number(l.base_qty) > 0))) errs.push(`รายการที่ ${i + 1}: เลือกไซท์งาน และกรอกจำนวนในหน่วยหลัก`)
  })
  return errs
}
```

- [ ] **Step 4: Build the component** `src/components/SupplierTaxInvoiceForm.jsx`. Follow `SupplierCreditNotes.jsx`'s `CreditNoteForm` for layout and classes (`modal-body`, `label`, `input`, `btn`). Required behaviour:

```jsx
import { useEffect, useMemo, useState } from 'react'
import { usePurchaseOrders, useSuppliers, useSites, useCategories, useInventoryItems, useAllInventoryItems,
  useInventoryItemUnitFactors, useSupplierDocumentExamples, extractPoDocument, useSupplierDeposits,
  useActiveTaxInvoiceLinks } from '../hooks/useSupabase.js'
import { fileToExtractionPayload } from '../lib/poDocumentExtraction.js'
import { calcPoTotals } from '../lib/poTotals.js'
import { round2 } from '../lib/depositMath.js'
import { lineAmount, evaluateMatch, proposePos, lineBase } from '../lib/supplierTaxInvoice.js'
import { emptyLine, validateFormForSave } from '../lib/taxInvoiceForm.js'
import { fmt } from '../lib/supabase.js'
import SearchableSelect from './SearchableSelect.jsx'
import QuickAddSelect from './QuickAddSelect.jsx'
import ScanNotice from './ScanNotice.jsx'
import ScanDocPreview from './ScanDocPreview.jsx'

export default function SupplierTaxInvoiceForm({ initial, invoiceId, busy, onSaveDraft, onPreview, onCancel }) {
  const [form, setForm] = useState(initial)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setLine = (key, patch) => setForm(f => ({ ...f, lines: f.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) }))

  const { data: suppliers } = useSuppliers()
  const { data: sites } = useSites()
  const { data: categories } = useCategories()
  const { data: inventoryItems, refetch: refetchItems } = useInventoryItems()
  const { data: allItems } = useAllInventoryItems()
  const { data: unitFactors } = useInventoryItemUnitFactors()
  const { data: links } = useActiveTaxInvoiceLinks()
  const { data: supplierPos } = usePurchaseOrders(form.supplier_id ? { supplierId: form.supplier_id, status: 'received' } : { supplierId: '__none__' })
  const { data: deposits } = useSupplierDeposits(form.supplier_id || undefined)
  const { data: examples } = useSupplierDocumentExamples(form.supplier_id || null)

  const itemById = useMemo(() => new Map((allItems || []).map(i => [i.id, i])), [allItems])
  const factorFor = (itemId, unit) => (unitFactors || []).find(f => f.inventory_item_id === itemId && f.unit_name === unit) || null

  const proposal = useMemo(() => proposePos({ pos: supplierPos, supplierId: form.supplier_id, invoiceDate: form.invoice_date, activeLinks: links, invoiceId }),
    [supplierPos, form.supplier_id, form.invoice_date, links, invoiceId])
  const poById = useMemo(() => new Map((supplierPos || []).map(p => [p.id, p])), [supplierPos])
  const poSubtotal = po => calcPoTotals(po.purchase_order_items, po.has_vat, po.price_includes_vat).subtotal
  const depositOnPo = poId => round2((deposits || []).flatMap(d => d.applications || []).filter(a => a.po_id === poId)
    .reduce((s, a) => s + Number(a.amount_no_vat || 0), 0))

  // First time a supplier + month is chosen on a NEW invoice: pre-tick the proposal (once).
  const [autoTicked, setAutoTicked] = useState(!!invoiceId)
  useEffect(() => {
    if (autoTicked || !supplierPos || !links || !form.supplier_id) return
    set('po_ids', proposal.proposed.map(p => p.id)); setAutoTicked(true)
  }, [autoTicked, supplierPos, links, form.supplier_id, proposal])

  const selectedPos = form.po_ids.map(id => poById.get(id)).filter(Boolean)
  const match = evaluateMatch({
    netBeforeVat: form.net_before_vat, poSubtotals: selectedPos.map(poSubtotal), lineAmounts: form.lines.map(lineAmount),
  })
  const unlinkedInMonth = proposal.proposed.filter(p => !form.po_ids.includes(p.id))
  const commonSite = selectedPos.length && selectedPos.every(p => p.site_id === selectedPos[0].site_id) ? selectedPos[0].site_id : ''

  // Base quantity: recompute from the conversion unless the user typed it (base_manual).
  const updateLineItem = (l, patch) => {
    const next = { ...l, ...patch }
    if (!next.inventory_item_id) return setLine(l.key, { ...patch, site_id: '', base_qty: '', base_manual: false })
    if (!next.site_id && commonSite) next.site_id = commonSite
    if (!next.base_manual) {
      const r = lineBase(next, itemById.get(next.inventory_item_id), factorFor(next.inventory_item_id, next.unit))
      next.base_qty = r.unconverted || r.baseQty == null ? '' : String(r.baseQty)
    }
    setLine(l.key, next)
  }
  // ... scan handler, JSX (below)
}
```
JSX requirements (Thai labels exactly as written):
- **Header** (grid of 2 columns on desktop): `ซัพพลายเออร์ ★` (SearchableSelect; changing it clears `po_ids` and sets `autoTicked` back to `false` when `invoiceId` is null); `เลขที่ใบกำกับภาษี ★`; `วันที่ใบกำกับ ★` (`<input type="date" max={today}>`); `ยอดก่อน VAT ★`; `VAT` (when the user leaves VAT empty, pre-fill `round2(net × 0.07)`; editable); read-only `ยอดรวม {fmt(round2(net + vat))}`.
- **Scan** (optional, same pattern as `SwapTaxInvoiceModal`, `PurchaseOrders.jsx:598-619`): file input `อัปโหลดรูป/PDF ใบกำกับภาษี (ไม่บังคับ)`. On success, fill `invoice_no` from `reference_no_guess` (only if empty), `invoice_date` from `document_date_guess` (only if empty and not in the future), and **replace** `lines` with `line_items.map(it => ({ ...emptyLine(), description: it.description, qty: String(it.quantity), unit: it.unit || '', unit_price: String(it.unit_price), discount_pct: String(it.discount_pct || 0) }))`. If `net_before_vat` is empty, set it to `round2(Σ lineAmount)`. Show `ScanNotice` on error and `ScanDocPreview` for the file. Never post anything from the scan.
- **PO picker** (`ใบสั่งซื้อที่รวมอยู่ในใบกำกับนี้`): a checkbox list of `proposal.proposed` (selected ones ticked), then a collapsible `ใบสั่งซื้อนอกเดือน ({n})` list of `proposal.outsideMonth` with an amber `นอกเดือน` badge, then the disabled `proposal.linkedElsewhere` rows showing `ผูกกับใบกำกับ {link.invoice_no}`. Each row shows `{po_number} · {fmtDate(date)} · {site name}`, `มูลค่าสินค้า {fmt(poSubtotal)}`, `รายจ่าย {fmt(po.expenses?.amount_no_vat ?? 0)}` (or `ไม่มีรายจ่าย` when `po.expense_id` is null), a `หักมัดจำ {fmt(depositOnPo)}` badge when it is > 0, and an `สต็อกเข้าจากใบกำกับ` badge when `po.stock_from_invoice`.
- **Unlinked in month** (always visible when non-empty, amber box): `ใบสั่งซื้อของซัพพลายเออร์นี้ในเดือนนี้ที่ยังไม่ได้รวม: {po_numbers joined ", "}`. This means nothing is silently left out (spec).
- **Running match bar**: `มูลค่าสินค้าใบสั่งซื้อ {fmt(match.poSum)} · ใบกำกับก่อน VAT {fmt(net)} · ต่าง {fmt(match.diff)} (เกณฑ์ ±{fmt(match.tolerance)})`. Green when `match.matchOk`, red otherwise. When red, show a required textarea `เหตุผลที่ยอดไม่ตรง ★` bound to `match_note`.
- **Lines table**: `รายละเอียด`, `จำนวน`, `หน่วย`, `ราคา/หน่วย`, `ส่วนลด %`, `จำนวนเงิน` (read-only `fmt(lineAmount(l))`), `ผูกสต็อก` (QuickAddSelect exactly as `PurchaseOrders.jsx:146-156`, placeholder `— ไม่ใช่สต็อก —`, `onCreated` → `refetchItems()` then `updateLineItem(l, { inventory_item_id: newId })`), and for stock lines only: `ไซท์งาน ★` (SearchableSelect of sites) and `จำนวนในหน่วยหลัก ({base_unit}) ★`. Typing in that field sets `base_manual: true`. When `lineBase(...).unconverted` and `!base_manual`, show amber text `แปลงหน่วยอัตโนมัติไม่ได้ — กรอกจำนวนในหน่วยหลักเอง`. Changing qty, unit or item calls `updateLineItem`. Show `+ เพิ่มรายการ` and a per-line `ลบ` button. Under the table: `รวมรายการ {fmt(match.linesSum)}`, red with `ไม่ตรงกับยอดก่อน VAT` when `!match.linesOk`.
- **Footer**: `ยกเลิก` (onCancel), `💾 บันทึกร่าง` and `👁️ ตรวจสอบก่อนบันทึก`. Both buttons first run `validateFormForSave(form)`; if it returns errors, `alert` them joined by newlines and stop. Otherwise call `onSaveDraft(form)` / `onPreview(form)`. Disable both while `busy`.
- The form never writes to Supabase itself. Both actions go through the page (Task 7).

- [ ] **Step 5: Verify.** `npx vitest run` (all green) and `npm run build`. Run `npm run dev` only if the migration happens to be live; otherwise state plainly that the UI was not exercised.

- [ ] **Step 6: Commit**

```bash
git add src/components/SupplierTaxInvoiceForm.jsx src/lib/taxInvoiceForm.js src/lib/taxInvoiceForm.test.js
git commit -m "feat: supplier tax invoice form (scan, month PO picker, line mapping)"
```

---

### Task 7: Page: list, preview, post, void, navigation

**Files:**
- Create: `src/components/TaxInvoicePreview.jsx`
- Create: `src/pages/SupplierTaxInvoices.jsx`
- Modify: `src/App.jsx` (lazy import near line 33; nav entry after `supplier_credit_notes` at line 74; `case` near line 381)

**Interfaces:**
- Consumes: Task 5 wrappers and hooks; Task 6 form and `toRpcPayload`/`formFromInvoice`/`emptyTaxInvoiceForm`; Task 1 `CHECK_TEXT`, `mapTaxInvoiceRpcError`, `formSignature`, `previewIsCurrent`; `useUserRole`, `canEditPage`, `Modal`, `ConfirmDialog`, `RowActionsMenu`.
- Produces: page id `supplier_tax_invoices`. `<TaxInvoicePreview preview={json} />`. `<PostConfirmOverlay summary onConfirm onCancel busy />` (plain overlay, not `<Modal>`, because it opens over the form modal; see `SupplierCreditNotes.jsx:108-161`).

- [ ] **Step 1: Write the failing test** for the confirm text builder. Add to `src/lib/supplierTaxInvoice.test.js`, and add `postSummaryLines` to the module's exports:

```js
import { postSummaryLines } from './supplierTaxInvoice.js'
describe('postSummaryLines (confirm dialog text)', () => {
  it('lists stock in, reversals, negatives, expense stamping and the undo rule', () => {
    const lines = postSummaryLines({
      invoiceNo: 'INV-1', stockLineCount: 2, poCount: 2,
      preview: { rows: [{ item_name: 'X', site_name: 'S2', after_qty: -13, base_unit: 'kg', negative: true }],
                 checks: [{ code: 'po_outside_month', blocking: false }] },
    })
    expect(lines).toEqual([
      'เพิ่มสต็อกจากใบกำกับ 2 รายการ',
      'กลับรายการรับเข้าสต็อกของใบสั่งซื้อ 2 ใบ',
      '⚠️ สต็อกจะติดลบ: X @ S2 = -13 kg',
      '⚠️ ' + 'ใบสั่งซื้อนอกเดือนของใบกำกับ',
      'รายจ่ายของใบสั่งซื้อไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ INV-1',
      'แก้ไขภายหลังไม่ได้ — ย้อนกลับได้ด้วย "ยกเลิกใบกำกับ" เท่านั้น',
    ])
  })
})
```
Run `npx vitest run src/lib/supplierTaxInvoice.test.js` and confirm it FAILS ("postSummaryLines is not a function").

- [ ] **Step 2: Implement `postSummaryLines`** in `src/lib/supplierTaxInvoice.js`:

```js
/** Text for the post confirm dialog. Warnings are de-duplicated by code. */
export function postSummaryLines({ invoiceNo, stockLineCount, poCount, preview }) {
  const out = [`เพิ่มสต็อกจากใบกำกับ ${stockLineCount} รายการ`, `กลับรายการรับเข้าสต็อกของใบสั่งซื้อ ${poCount} ใบ`]
  for (const r of preview?.rows || []) if (r.negative) out.push(`⚠️ สต็อกจะติดลบ: ${r.item_name} @ ${r.site_name} = ${Number(r.after_qty)} ${r.base_unit || ''}`.trim())
  const seen = new Set()
  for (const c of preview?.checks || []) {
    if (c.blocking || seen.has(c.code)) continue
    seen.add(c.code); out.push('⚠️ ' + (CHECK_TEXT[c.code] || c.code))
  }
  out.push(`รายจ่ายของใบสั่งซื้อไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ ${invoiceNo}`)
  out.push('แก้ไขภายหลังไม่ได้ — ย้อนกลับได้ด้วย "ยกเลิกใบกำกับ" เท่านั้น')
  return out
}
```
Run the test and confirm it PASSES.

- [ ] **Step 3: `TaxInvoicePreview.jsx`.** Render `preview.checks`: blocking ones red, the rest amber, with text from `CHECK_TEXT[code]`, plus the PO number when `po_id` is present (pass a `poNumberById` map prop). Then a table: `สินค้า`, `ไซท์งาน`, `คงเหลือก่อน`, `+ จากใบกำกับ`, `− กลับรายการใบสั่งซื้อ`, `คงเหลือหลัง`, `ต้นทุนเฉลี่ยหลัง`. Quantities use `fmt`; `after_qty < 0` is shown red and bold. Then `มูลค่าสินค้าใบสั่งซื้อ {po_sum} · ต่าง {diff} (เกณฑ์ ±{tolerance})`. Also export `PostConfirmOverlay({ lines, busy, onConfirm, onCancel })`: copy `CreditNoteConfirmDialog`'s overlay markup and Escape handling, title `ยืนยันบันทึกใบกำกับภาษี — โปรดตรวจสอบ`, body = `<ul>` of `lines`, buttons `ยกเลิก` and `✅ ยืนยันบันทึก` (`btn-danger`, disabled while `busy`).

- [ ] **Step 4: The page** `src/pages/SupplierTaxInvoices.jsx`. Core logic:

```jsx
export default function SupplierTaxInvoices() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'purchase_orders')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const { data: invoices, loading, error, refetch } = useSupplierTaxInvoices({ supplierId: supplierFilter, status: statusFilter })
  const [editing, setEditing] = useState(null)        // { id|null, form }
  const [formKey, setFormKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)        // { id, signature, data }
  const [confirm, setConfirm] = useState(null)        // { id, lines }
  const [viewRow, setViewRow] = useState(null)
  const [voidRow, setVoidRow] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [deleteId, setDeleteId] = useState(null)
  const today = bangkokTodayIso()                      // from src/lib/photoUpload.js; check the export name first

  const saveDraft = async form => {
    const { header, items, poIds } = toRpcPayload(form)
    const id = await saveSupplierTaxInvoiceDraft(editing?.id || null, header, items, poIds)
    setEditing(e => ({ ...e, id }))                    // later saves update the same draft
    return id
  }
  const handleSaveDraft = async form => {
    if (busy) return
    setBusy(true)
    try { await saveDraft(form); refetch(); alert('บันทึกร่างแล้ว') }
    catch (e) { alert(mapTaxInvoiceRpcError(e)) }
    finally { setBusy(false) }
  }
  const handlePreview = async form => {
    if (busy) return
    setBusy(true)
    try {
      const id = await saveDraft(form)
      const data = await previewSupplierTaxInvoice(id)
      setPreview({ id, signature: formSignature(form), data, form })
      refetch()
    } catch (e) { alert(mapTaxInvoiceRpcError(e)) }
    finally { setBusy(false) }
  }
  const askPost = () => {
    if (!preview || !previewIsCurrent(preview, preview.form)) return
    if ((preview.data.checks || []).some(c => c.blocking)) return
    const stockLineCount = preview.form.lines.filter(l => l.inventory_item_id).length
    setConfirm({ id: preview.id, lines: postSummaryLines({ invoiceNo: preview.form.invoice_no.trim(), stockLineCount, poCount: preview.form.po_ids.length, preview: preview.data }) })
  }
  const doPost = async () => {
    if (busy || !confirm) return
    setBusy(true)
    try {
      const result = await postSupplierTaxInvoice(confirm.id)
      setConfirm(null); setPreview(null); setEditing(null); refetch()
      const neg = (result?.negative || []).map(n => `${n.item_name} @ ${n.site_name} = ${n.qty}`)
      alert(`บันทึกใบกำกับแล้ว: เพิ่มสต็อก ${result.lines_posted} รายการ · กลับรายการ ${result.receipts_reversed} รายการ · ประทับเลขที่ในรายจ่าย ${result.expenses_stamped} รายการ` + (neg.length ? `\n⚠️ สต็อกติดลบ:\n${neg.join('\n')}` : ''))
    } catch (e) {
      setConfirm(null); refetch()
      alert(mapTaxInvoiceRpcError(e))                  // nothing was written: the RPC is atomic
    } finally { setBusy(false) }
  }
  const doVoid = async () => {
    if (busy || !voidRow) return
    if (!voidReason.trim()) { alert('กรุณากรอกเหตุผลที่ยกเลิก'); return }
    setBusy(true)
    try {
      const r = await voidSupplierTaxInvoice(voidRow.id, voidReason.trim())
      setVoidRow(null); setVoidReason(''); refetch()
      const warn = (r?.warnings || []).map(w => CHECK_TEXT[w.code] || w.code)
      const neg = (r?.negative || []).map(n => `${n.item_name} @ ${n.site_name} = ${n.qty}`)
      alert('ยกเลิกใบกำกับแล้ว' + (warn.length ? '\n⚠️ ' + warn.join('\n⚠️ ') : '') + (neg.length ? `\n⚠️ สต็อกติดลบ:\n${neg.join('\n')}` : ''))
    } catch (e) { setVoidRow(null); refetch(); alert(mapTaxInvoiceRpcError(e)) }
    finally { setBusy(false) }
  }
  // ... deleteDraft via deleteSupplierTaxInvoiceDraft(deleteId) with the same busy/alert/refetch pattern
}
```
JSX requirements:
- Toolbar exactly like `SupplierCreditNotes.jsx:535-549`: `+ เพิ่มใบกำกับภาษีผู้ขาย` (only when `canEdit`), a supplier filter, and a status filter (`📝 ร่าง`, `✅ บันทึกแล้ว`, `🚫 ยกเลิก`).
- `{error && …}` shows `โหลดข้อมูลไม่สำเร็จ: {error}`. Before the migration this is the visible state; the page must not crash.
- Table: `เลขที่`, `วันที่`, `ซัพพลายเออร์`, `ก่อน VAT`, `ใบสั่งซื้อ` (count of active links, or all links for void rows), `ต่าง` (`match_diff`, red when outside tolerance), `สถานะ`, actions. Row actions via `RowActionsMenu`: drafts get `✏️ แก้ไข` (opens the form with `formFromInvoice(row)`) and `🗑️ ลบ`; posted rows get `👁️ ดูรายละเอียด` and `🚫 ยกเลิกใบกำกับ`; void rows get `👁️ ดูรายละเอียด`.
- Form modal: `<Modal title={editing.id ? 'แก้ไขใบกำกับภาษีผู้ขาย' : 'เพิ่มใบกำกับภาษีผู้ขาย'} maxWidth={980}>` containing `<SupplierTaxInvoiceForm key={formKey} …/>`. Below the form inside the same modal, when `preview` is set for this draft, render `<TaxInvoicePreview preview={preview.data} />` and a button `✅ บันทึกใบกำกับ (ลงสต็อก)`. The button is disabled when `busy`, when any check is blocking, or when the form changed since the preview. Detect a change by passing `onChange` from the form, or by keeping the latest form in a ref, and comparing with `previewIsCurrent(preview, latestForm)`. When stale, show `ข้อมูลเปลี่ยนแล้ว — กด "ตรวจสอบก่อนบันทึก" อีกครั้ง`. Add an `onChange={f => latestFormRef.current = f}` prop to the form (call it from a `useEffect` on `form`) for this.
- `confirm` renders `<PostConfirmOverlay>` (plain overlay; the form `<Modal>` stays open beneath it).
- The view modal for posted/void rows shows: header fields; lines with base qty and site; linked POs with `po_subtotal` and the stamped expense numbers; `post_result.checks` through `CHECK_TEXT`; `post_result.negative`; for void rows, `void_reason`, `voided_at` and `voided_by`.
- The void dialog uses `<Modal title="ยกเลิกใบกำกับภาษี">`. Text: `สต็อกจะกลับเป็นเหมือนก่อนบันทึก (รับเข้าจากใบสั่งซื้อกลับมา และนำรายการของใบกำกับออก) และรายจ่ายจะกลับเป็นเลขที่ใบกำกับเดิม`. Required reason textarea; buttons `ยกเลิก` and `🚫 ยืนยันยกเลิกใบกำกับ` (`btn-danger`, disabled while `busy`).
- Delete-draft: `ConfirmDialog` `ลบใบกำกับฉบับร่าง`.

- [ ] **Step 5: Navigation.** In `src/App.jsx`:

```js
const SupplierTaxInvoices = lazy(() => import('./pages/SupplierTaxInvoices.jsx'))
// in the 💸 รายจ่าย children, right after supplier_credit_notes:
{ id: 'supplier_tax_invoices', label: '🧾 ใบกำกับภาษีผู้ขาย', minRole: 'ADMIN', module: 'purchase_orders', permKey: 'purchase_orders' },
// in the switch:
case 'supplier_tax_invoices': return <SupplierTaxInvoices {...props} />
```
Check whether `src/lib/permissions.js` or `src/lib/manualLinks.js` enumerates page ids (`grep -n "supplier_credit_notes" src/lib/*.js`). If it does, add `supplier_tax_invoices` beside every occurrence with the same values.

- [ ] **Step 6: Verify.** `npx vitest run` (all green) and `npm run build`. State that the post, void and preview flows are not live-verified until the owner applies the migrations.

- [ ] **Step 7: Commit**

```bash
git add src/components/TaxInvoicePreview.jsx src/pages/SupplierTaxInvoices.jsx src/App.jsx src/lib/supplierTaxInvoice.js src/lib/supplierTaxInvoice.test.js
git commit -m "feat: supplier tax invoice page with preview, confirm-to-post and void"
```

---

### Task 8: PurchaseOrders.jsx: "stock from invoice" flag, receive skip, badges

**Precondition (R4):** the deposit feature's edits to `PurchaseOrders.jsx` are finished and committed. Run `git log --oneline -5 -- src/pages/PurchaseOrders.jsx`; there must be no uncommitted changes to the file (`git status --short src/pages/PurchaseOrders.jsx`). If either fails, STOP and report to the controller.

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`
- Create: `src/lib/poTaxInvoiceStatus.js` + `src/lib/poTaxInvoiceStatus.test.js`

**Interfaces:**
- Consumes: `calcPoTotals`, `poLineTotal` (`src/lib/poTotals.js`); `useActiveTaxInvoiceLinks()` (Task 5); `mapTaxInvoiceRpcError` (Task 1); the final `handleReceive` from the deposit feature.
- Produces: `poTaxInvoiceBadge(po, linksMap|null) → { kind: 'linked'|'awaiting'|null, text }` and `buildPoPayloadFlag(form, editRow) → {} | { stock_from_invoice: boolean }`.

- [ ] **Step 1: Write the failing tests** `src/lib/poTaxInvoiceStatus.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { poTaxInvoiceBadge, buildPoPayloadFlag } from './poTaxInvoiceStatus.js'

describe('poTaxInvoiceBadge', () => {
  const links = new Map([['p1', { invoice_id: 'i1', invoice_no: 'INV-1', status: 'posted' }], ['p3', { invoice_id: 'i3', invoice_no: 'INV-3', status: 'draft' }]])
  it('linked PO shows the invoice number (draft says so)', () => {
    expect(poTaxInvoiceBadge({ id: 'p1', status: 'received' }, links)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-1' })
    expect(poTaxInvoiceBadge({ id: 'p3', status: 'received' }, links)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-3 (ร่าง)' })
  })
  it('received flagged PO without an invoice is awaiting stock', () => {
    expect(poTaxInvoiceBadge({ id: 'p2', status: 'received', stock_from_invoice: true }, links)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ (สต็อกยังไม่เข้า)' })
  })
  it('no links map (feature not ready) -> no badge', () => {
    expect(poTaxInvoiceBadge({ id: 'p1', status: 'received', stock_from_invoice: true }, null)).toEqual({ kind: null, text: '' })
  })
})

describe('buildPoPayloadFlag (deploy-order safe)', () => {
  it('new PO: send the flag only when ticked', () => {
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, null)).toEqual({})
    expect(buildPoPayloadFlag({ stock_from_invoice: true }, null)).toEqual({ stock_from_invoice: true })
  })
  it('edit: send it when the column exists on the row', () => {
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, { stock_from_invoice: true })).toEqual({ stock_from_invoice: false })
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, { id: 'x' })).toEqual({})
  })
})
```
Run `npx vitest run src/lib/poTaxInvoiceStatus.test.js` and confirm it FAILS.

- [ ] **Step 2: Implement** `src/lib/poTaxInvoiceStatus.js`:

```js
export function poTaxInvoiceBadge(po, links) {
  if (!links || !po) return { kind: null, text: '' }
  const l = links.get(po.id)
  if (l) return { kind: 'linked', text: `ใบกำกับ ${l.invoice_no}${l.status === 'draft' ? ' (ร่าง)' : ''}` }
  if (po.status === 'received' && po.stock_from_invoice) return { kind: 'awaiting', text: 'รอใบกำกับ (สต็อกยังไม่เข้า)' }
  return { kind: null, text: '' }
}

/** Only send stock_from_invoice when it is safe: ticked on a new PO, or the column is known on the edited row. */
export function buildPoPayloadFlag(form, editRow) {
  if (editRow && Object.prototype.hasOwnProperty.call(editRow, 'stock_from_invoice')) return { stock_from_invoice: !!form.stock_from_invoice }
  if (!editRow && form.stock_from_invoice) return { stock_from_invoice: true }
  return {}
}
```
Run the test and confirm it PASSES.

- [ ] **Step 3: Re-read the current `handleReceive`, `receiveStockPlan`, the receive confirm dialog, the PO form (`EMPTY_FORM`, `editFormInitial`, the VAT checkboxes), the row actions (swap button), and the PO detail.** The deposit feature may have moved them. Use the current code, not the line numbers in this plan.

- [ ] **Step 4: Edit `PurchaseOrders.jsx`:**
  1. Delete the local `lineTotal`, `VAT_RATE` (only if nothing else in the file uses it; `receiveStockPlan` uses `VAT_RATE`, so import `VAT_RATE` from `../lib/invoiceCalc.js` instead) and `calcPoTotals`. Add `import { calcPoTotals, poLineTotal } from '../lib/poTotals.js'` and replace `lineTotal(` with `poLineTotal(`. Behaviour must be identical.
  2. `EMPTY_FORM` gets `stock_from_invoice: false`; `editFormInitial` gets `stock_from_invoice: !!editRow.stock_from_invoice`.
  3. In the form, next to the VAT checkboxes, add a checkbox `📦 สต็อกเข้าตอนบันทึกใบกำกับภาษี (รับของแล้วไม่ลงสต็อก)` with the hint `ใช้กับซัพพลายเออร์ที่ออกใบกำกับรวมรายเดือนและรายการไม่ตรงกับใบสั่งซื้อ`. Render it only when `taxInvoiceLinks !== null` (the feature is live, so the column exists). Disable it when the edited PO's status is `received`.
  4. `handleSave`: `Object.assign(poPayload, buildPoPayloadFlag(form, editRow))`. In its `catch`, use `alert('Error: ' + mapTaxInvoiceRpcError(e))` so `po_tax_invoiced` and `po_stock_flag_locked` read in Thai. Do the same in `handleCancel`'s error branch.
  5. `handleReceive`: wrap the stock-posting loop as `if (!receiveRow.stock_from_invoice) { …existing loop unchanged… }`. Keep everything else, including the deposit RPC call and the hardened `catch` text. The toast adds ` · สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษี` when the flag is set.
  6. In the receive confirm dialog, where the stock preview from `receiveStockPlan` is shown: when `receiveRow.stock_from_invoice`, show `ไม่ลงสต็อกตอนรับของ — สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษีผู้ขาย` instead of the stock lines.
  7. `const { data: taxInvoiceLinks } = useActiveTaxInvoiceLinks()`. In the list row (next to the status badge) and in the PO detail header, render `poTaxInvoiceBadge(po, taxInvoiceLinks)`: `linked` as a blue `badge`, `awaiting` as an amber `badge`.
  8. Hide the `SwapTaxInvoiceModal` action for a PO whose `taxInvoiceLinks?.get(po.id)` exists. The old single-PO swap stays for every other PO (spec).

- [ ] **Step 5: Verify.** Run `npx vitest run` (all green) and `npm run build`. Then confirm by reading the diff: a PO **without** the flag goes through exactly the same receive path as before (same RPC args, same `record_stock_movement` calls), and the PO insert payload for a new unflagged PO is byte-for-byte the same keys as before. Say what was not live-verified.

- [ ] **Step 6: Deploy-order check (Review Focus 5).** With the migration NOT applied, reason through each in the report: PO list renders (the links hook errors, so `data` is null and no badges show); the add-PO form hides the flag checkbox; receive behaves as today; the Inventory ledger still renders. If any of these needs a live check, list it for the owner in Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/pages/PurchaseOrders.jsx src/lib/poTaxInvoiceStatus.js src/lib/poTaxInvoiceStatus.test.js
git commit -m "feat: PO stock-from-invoice flag, receive skips stock, tax invoice badges"
```

---

### Task 9: Whole-branch verification and owner handoff (no new feature code)

**Files:**
- Create: `docs/superpowers/plans/2026-10-08-supplier-tax-invoice-handoff.md`

- [ ] **Step 1:** Run `npx vitest run` and `npm run build`; record the counts. Run `grep -rn "SECURITY DEFINER" supabase/migrations/2026-10-08-0*.sql | wc -l` (expect 15). Then cross-check that each function has its REVOKE (and its GRANT for the five public RPCs).

- [ ] **Step 2: Write the handoff** with these sections:
  - **Apply order (owner only):** `2026-10-07-01`, `2026-10-07-02` (deposits, if not yet live), then `2026-10-08-01`, then `2026-10-08-02`. Dry-run each first inside `BEGIN; \i file; ROLLBACK;` (or the owner's usual dry-run), then apply with `npx supabase db query --linked -f <file>`. A migration is live the moment it runs.
  - **SQL test:** after applying, run `supabase/tests/supplier_tax_invoice_test.sql`. Success = the error text `RESULT: supplier_tax_invoice_test ALL PASSED`; any other error = failure (copy the message). Fixture columns may need a tweak on first run.
  - **Post-apply checks (owner, read-only):** (1) `SELECT proname, proacl FROM pg_proc WHERE proname LIKE '%supplier_tax_invoice%' OR proname LIKE '\_sti\_%' OR proname IN ('_stock_receipt_reversal','_po_goods_subtotal','_po_tax_invoiced')`: no `anon=X`, and the `_` helpers have no `authenticated=X`. (2) Open the PO list, the Expenses page, the Inventory stock card and the new page in the app; any PostgREST "more than one relationship" error (PGRST201) means an embed needs the explicit constraint name. (3) `NOTIFY pgrst, 'reload schema'` if the new tables do not appear.
  - **Deploy order:** the app code is safe before or after the migration (Task 8 Step 6). The recommended order is migration first, then `npm run deploy`, because the ledger's `receipt_reversal` handling must be live before the first invoice is posted.
  - **Live verification by the owner (spec):** one real monthly invoice from ช.เจริญกลาส. Before posting: compare the preview rows with the Inventory balances. After posting: stock card shows `ใบกำกับ …` in-lines and `กลับรายการรับเข้า …` out-lines dated the invoice date; expenses show the invoice number with unchanged amounts; balances match the preview. Optionally void once and confirm the balances return, then re-post.
  - **Verified vs not:** vitest results; SQL test written but not run; no UI flow exercised live.
  - **Known limits:** receipt movements are still posted by the client after `receive_po_with_deposits` (not atomic; unchanged by this feature); when a balance crosses ≤ 0 during post or void, WAC is kept rather than mathematically restored (ruling A2), so post → void is exact only when no balance crosses zero; `stock_movements` remains client-writable under its existing RLS policy (pre-existing, out of scope); `useInventoryItemUnitFactors` is not paginated (pre-existing).
  - **Rulings A1-A15** copied from this plan, so the owner can object to any.

- [ ] **Step 3: Commit** the handoff file. Do not merge, push or deploy.

```bash
git add docs/superpowers/plans/2026-10-08-supplier-tax-invoice-handoff.md
git commit -m "docs: supplier tax invoice handoff (apply order, tests, live checks)"
```

---

## Self-review notes (done while writing)

- **Spec coverage:**

  | Spec item | Where |
  |---|---|
  | Data model (4 tables) | T2 |
  | Unique invoice no | T2 `sti_invoice_no_active_uq` |
  | PO in at most one invoice | T2 `stip_po_active_uq`, A5 |
  | Reversals table | T2 |
  | RLS/locks/grants/tenant checks | T2/T3 |
  | Match rule and tolerance | T1/T3 (R1) |
  | Month proposal + "not linked" list | T1 `proposePos` / T6 |
  | Post steps 1-5 with lines-before-reversals order and the exact WAC inverse | T3 / T2 helper |
  | Negative allowed and flagged | T3 / R2 |
  | Stamping without amount change | T3 |
  | Preview RPC | T3 |
  | Void | T3 |
  | UI flow (supplier → header/scan → POs → map lines → preview → warning dialog → post; undo = void) | T6/T7 |
  | PO list/detail "ใบกำกับ <no>" | T8 |
  | Old swap kept | T8 |
  | Tests: vitest list | T1/T4/T5/T6/T8 |
  | Tests: SQL list (2 POs/different items, no error when stock suffices, below-zero allowed, PO twice rejected, second post, void restores, amounts unchanged, cross-tenant, no forging) | T3 T2-T17 |
  | Owner live verification | T9 |
  | Flag at PO creation (R3) | T2/T8 |

- **Type consistency:** `formSignature`/`previewIsCurrent` are used in T7 as defined in T1. Hooks and wrappers are named the same in T5/T6/T7/T8. The RPC JSON keys (`checks`, `rows`, `po_sum`, `diff`, `tolerance`, `negative`, `lines_posted`, `receipts_reversed`, `expenses_stamped`, `warnings`) are the same in T3 SQL, the T3 tests and the T7 UI.
- **Review Focus:** each of the five lines has a pinning test in the owning task.
