# Supplier Tax Invoice per Delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PO be set to "one supplier tax invoice per delivery" (remembered per supplier), so each received lot (`po_receipts` row) can be linked to its own tax invoice, now or later, with that lot's stock replaced by the invoice's lines, while `'po'` mode stays byte-for-byte as live today.

**Architecture:** Two additive migrations. `2026-10-09-04` adds `purchase_orders.tax_invoice_mode`, `suppliers.default_tax_invoice_mode`, the link table `supplier_tax_invoice_receipts` and two guard triggers. `2026-10-09-05` renames today's `_sti_check` / `_sti_receipt_movements` bodies VERBATIM to `_sti_check_po` / `_sti_receipt_movements_po`, adds `_sti_check_delivery` / `_sti_receipt_movements_delivery`, turns the original names into dispatchers (by link kind), adds `save_supplier_tax_invoice_receipt_draft` and `_sti_stamp_receipt_bills`, and re-creates `save_supplier_tax_invoice_draft`, `post_supplier_tax_invoice`, `void_supplier_tax_invoice` verbatim from their LATEST definitions plus 2 marked lines each (built by a script, proved by a scripted diff). The web gets a pure helper module (vitest first), fail-soft hooks, and UI on the PO form, the ⋯ menu, the receive dialog, the PO popup, the supplier page and the supplier tax invoice page.

**Tech Stack:** React 18 + Vite, Supabase (Postgres 15, PostgREST, plpgsql SECURITY DEFINER RPCs), vitest, Playwright harnesses in `scripts/tax-invoice-harness`.

**Spec:** `docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md` (owner decisions in section 7 are binding). Background: `docs/superpowers/specs/2026-10-06-supplier-tax-invoice-matching-design.md`, `docs/superpowers/specs/2026-10-07-po-deposit-and-partial-receipt-design.md`.

## Global Constraints

- **Production database.** Migrations are applied ONLY by the owner, by typing `! npx supabase db query --linked --workdir /Users/plfx/code/FacadeXPM/facadex-app -f <absolute path of the file>` (the auto-mode classifier blocks Claude from applying). Implementers and reviewers NEVER run SQL against any database (not even SELECTs through the CLI); the controller runs rolled-back dry runs only and may run read-only SELECTs through the Supabase MCP `execute_sql` (project `kntspldhvcjeaubtqtkn`). A migration is live the instant it commits; an unpushed branch is not "safe".
- **Apply order: `2026-10-09-04` and `2026-10-09-05` go live in ONE step.** The controller builds one file `BEGIN; <04>; <05>; COMMIT;` and the owner applies that single file (Task 11). The web readiness flag is keyed on `delivery_tax_invoice_ready()`, a function created by `-05`, so the web offers nothing new until BOTH are live. Web deploy strictly AFTER the combined apply (the web stays safe before it: it just shows nothing new).
- **Implementers run no SQL of any kind.** Every "prove it does not exist yet" query, baseline run and dry run in this plan is a controller step with the exact query and expected result; the implementer waits for the controller's report.
- **Dry run shape (controller only):** one transaction that always rolls back: `BEGIN; SET LOCAL lock_timeout='5s'; <every pending migration of this plan, in order>; <ONE test body with its own BEGIN;/ROLLBACK; lines stripped>; ROLLBACK;`. One test per run. Live already has `2026-10-08-01..04` and `2026-10-09-01..03` (verified read-only 2026-10-08: every live function body md5-matches the repo files), so "pending" = `2026-10-09-04` (+ `2026-10-09-05` once it exists). After `-05` exists the controller also re-runs, each in its own dry run with both new migrations prepended: `supplier_tax_invoice_test.sql`, `tax_invoice_multi_bill_test.sql`, `po_receipt_test_a.sql`, `po_receipt_test_b.sql`, `po_deposit_test.sql`, `supplier_credit_notes_test.sql`. Before that, the controller runs each of those six WITHOUT the new migrations once (baseline): a test that already fails on the baseline is reported to the owner and is not this branch's bug.
- **Every SECURITY DEFINER function:** `SET search_path = public`; `REVOKE ALL ... FROM PUBLIC, anon` (helpers: also `authenticated`); `GRANT EXECUTE ... TO authenticated` only for client RPCs; tenant from `current_tenant_id()`, never a parameter; role gate `is_admin_or_owner() AND has_module_access('purchase_orders')` and `tenant_can_write()` on every writer.
- **Additive only.** New FKs are named (`stirc_invoice_fk`, `stirc_receipt_fk`). No FK to `expenses` from a new table, and no FK to `purchase_orders` from the new link table (`po_id` is a plain copy): a second `purchase_orders <-> supplier_tax_invoices` path would make existing many-to-many embeds ambiguous. No new view; no view selects `purchase_orders.*` or `suppliers.*` (checked live 2026-10-08; `expenses_view` lists columns).
- **`'po'` mode is byte-for-byte unchanged** except the marked lines (each ends with the comment `-- 2026-10-09-05`). Function bodies are copied by the Task 4 builder script from the LATEST definitions (`_sti_check`, `_sti_receipt_movements`, `save_supplier_tax_invoice_draft` from `2026-10-08-02`; `post_supplier_tax_invoice`, `void_supplier_tax_invoice` from `2026-10-09-03`), and Task 4 proves them with `diff`.
- **Lock order** everywhere: invoice row -> PO rows by id (FOR UPDATE) -> stock balances by (item, site) -> expenses by id. Same as `receive_po_lines` (PO first), `split_payment` (PO FOR SHARE then bill), post and void.
- **Web is safe before OR after the migration.** Every new read fails soft (`isMissingRelationError`, `isMissingColumnError`, new `isMissingEmbedError`) to "feature not ready" and the page behaves exactly as today; new writes are offered only when ready.
- **Lessons to build tests for:** copy bodies verbatim and diff-prove them; a `split_payment` child created after a post is restored by void (created_at >= posted_at); tests assert exact restored values with NON-NULL prior invoice numbers; never select expenses by invoice number (an unrelated expense with the same number must stay untouched); clients cannot write the link table (SELECT-only grant); every new `RAISE EXCEPTION '<code>'` has Thai text (the repo tests grep the migrations: `src/lib/supplierTaxInvoiceCodes.test.js`, `src/lib/poReceiptErrors.test.js`); every embed from `purchase_orders`/`po_receipts`/`supplier_tax_invoices` names its constraint; `RowActionsMenu` items are `{label, onClick, disabled?, disabledTitle?, danger?}`; `Modal`/`ConfirmDialog` `onClose`/`onCancel` returns `false` while busy; list reads use `fetchAllRows` with a stable `.order('id')` (PostgREST 1000-row cap).
- **Thai UI copy** is given verbatim in the tasks. No emoji beyond those already used by the page.
- **Task flow:** one implementer subagent per task, then a reviewer. SQL tasks end with a "hand to controller" dry-run step. UI tasks add Playwright scenarios (real `src/index.css`, also at 375 px width). Harness runs: one at a time (`node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs`, `node scripts/tax-invoice-harness/build.mjs && node scripts/tax-invoice-harness/run.mjs`).
- **Git:** plain separate commands (`git add <files>` then `git commit -m ...`), never compound; do not push; do not deploy. Commit trailer lines are given by the controller.

## Review Focus

1. **A receipt whose draft invoice is deleted, or re-saved as a PO-linked draft** -> the receipt must go back to "รอใบกำกับ" (no orphan active link). Pinned: Task 4 test B3 (4-arg save drops receipt links; delete cascades), Task 1 `receiptsAwaitingInvoice`.
2. **Changing a supplier's default after POs exist** -> existing POs keep their own mode; only NEW POs pre-select it. Pinned: Task 3 test A3b, Task 6 harness "supplier default only pre-selects new POs".
3. **The same tax-invoice number on an unrelated expense of the same supplier** -> post and void never touch it (selection is by receipt -> bill id, never by number). Pinned: Task 4 tests B7/B9 (`x_exp`).
4. **A lot's bill split before and after the post, then the invoice voided** -> every part (pre-post child, post-post child) gets its exact previous number back, the other invoice's bill is untouched. Pinned: Task 4 tests B7/B9 (`c3`, `g2`, `bill1`).
5. **Opening the hand-off for a lot whose PO is "stock from invoice" (no base quantity stored) or double-clicking confirm in the receive dialog** -> the form opens with the base quantity converted from the item (or asks for it), never crashes; one click = one receipt and one navigation. Pinned: Task 1 `formForReceipt` tests, Task 7 harness "double click = one navigation", Task 8 harness "prefill without base".

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/deliveryTaxInvoiceText.js` (new) | Thai text for every new code; leaf module (no imports). |
| `src/lib/deliveryTaxInvoice.js` (new) | Pure: match rule with both VAT bases, eligibility, picker rows, awaiting list, mode defaults/payloads/locks, badges, form prefill from a receipt, list match base. |
| `src/lib/deliveryTaxInvoice.test.js` (new) | vitest for the above. |
| `src/lib/taxInvoiceForm.js`, `src/lib/supplierTaxInvoice.js`, `src/lib/poReceiptErrors.js`, `src/lib/taxInvoiceLinks.js` (modify) | `link_kind`/`receipt_ids` in the form model, signature, PO proposal filter, receive routing, embed-missing helper, RPC args, error maps. |
| `supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql` (new) | Columns, link table, RLS/grants, guard triggers. |
| `supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql` (new) | Verbatim copies (+marked lines), dispatchers, delivery check/movements, receipt draft RPC, stamping helper, grants. |
| `supabase/tests/delivery_tax_invoice_test_a.sql`, `..._test_b.sql` (new) | Rolled-back SQL tests. |
| `src/hooks/useSupabase.js` (modify) | `useDeliveryTaxInvoiceReady`, `useDeliveryReceipts`, `useActiveReceiptTaxInvoiceLinks`, `saveSupplierTaxInvoiceReceiptDraft`, receipt-link embed with fallback. |
| `src/pages/PurchaseOrders.jsx`, `src/components/ReceivePoLinesModal.jsx`, `src/pages/Suppliers.jsx` (modify) | Mode choice, ⋯ mode switch, receive checkbox + hand-off, per-receipt badges. |
| `src/components/SupplierTaxInvoiceForm.jsx`, `src/pages/SupplierTaxInvoices.jsx`, `src/components/TaxInvoicePreview.jsx` (modify) | Switch PO / delivery, receipt picker, hand-off, awaiting list, list/view. |
| `scripts/tax-invoice-harness/*` (modify) | Mocks + scenarios. |
| `public/manual/index.html` (modify) | One new subsection (h4 "7.") + one corrected bullet. |

---

### Task 1: Pure delivery helpers and Thai text (vitest)

**Files:**
- Create: `src/lib/deliveryTaxInvoiceText.js`, `src/lib/deliveryTaxInvoice.js`
- Test: `src/lib/deliveryTaxInvoice.test.js`

**Interfaces:**
- Consumes: `round2` (`./depositMath.js`), `matchTolerance`, `withinTolerance` (`./supplierTaxInvoice.js`), `emptyLine` (`./taxInvoiceForm.js`), `exVatUnitPrice(unitPrice, pricesIncludeVat)` (`./poDocumentExtraction.js`).
- Produces (later tasks rely on these exact names):
  - text: `PO_MODE_LOCKED_TEXT`, `RECEIVE_DELIVERY_DISCOUNT_TEXT`, `DELIVERY_NOT_READY_TEXT`, `HANDOFF_RECEIPT_NOT_FOUND_TEXT`, `DELIVERY_CHECK_TEXT` (object), `DELIVERY_RPC_TEXT` (object).
  - `receiptLabel(poNumber, seq) -> 'PO-1-R2'`
  - `evaluateDeliveryMatch({ netBeforeVat, grandTotal, receipts, lineAmounts }) -> { invalid, sum, sumIncl, diffExcl, diffIncl, basis: 'excl'|'incl'|'none', diff, tolerance, matchOk, linesSum, linesOk }`
  - `buildActiveReceiptLinkMap(rows) -> Map<receipt_id, {invoice_id, invoice_no, status}>`
  - `receiptEligibility(receipt, { supplierId, links, invoiceId }) -> 'ok'|'wrong_supplier'|'not_delivery'|'linked_elsewhere'`
  - `receiptPickerRows({ receipts, supplierId, links, invoiceId }) -> { available: receipt[], linkedElsewhere: {receipt, link}[] }`
  - `receiptsAwaitingInvoice(receipts, links) -> null | { supplierId, rows }[]`
  - `receiptTaxInvoiceStatus(receiptId, links) -> { kind: null|'linked'|'awaiting', text, invoiceId? }`
  - `defaultTaxInvoiceMode(supplier) -> 'po'|'delivery'`
  - `poModePayload(form, editRow, ready) -> {} | { tax_invoice_mode }`, `supplierModePayload(form, editItem, ready) -> {} | { default_tax_invoice_mode }`
  - `poModeLockedText(po, moneyIndex, poLinks) -> '' | PO_MODE_LOCKED_TEXT`
  - `deliveryPoBadge(po, moneyIndex, receiptLinks) -> { kind: null|'awaiting'|'linked'|'delivery', text }`
  - `formForReceipt(receipt, today) -> tax-invoice form object (link_kind 'delivery')`
  - `poModeForSupplier(form, supplier) -> 'po'|'delivery'`, `poDeliveryDiscountWarning(form, lineTotalOf) -> ''|text`, `splitDeliveryPoIds(poIds, poRows) -> { keep, delivery }`
  - text also: `NO_RECEIPTS_TEXT`, `DELIVERY_PO_IN_PO_INVOICE_TEXT`, `PO_DELIVERY_DISCOUNT_SAVE_TEXT`; `DELIVERY_RPC_TEXT.no_receipts`
  - `invoiceMatchBase(row) -> number`, `linkKindOf(row) -> 'po'|'delivery'`
  - Receipt row shape (from Task 5's `useDeliveryReceipts`): `{ id, po_id, seq, received_date, goods_subtotal, goods_vat, expense_id, purchase_orders: { id, po_number, supplier_id, site_id, tax_invoice_mode, stock_from_invoice, has_vat, price_includes_vat }, po_receipt_items: [{ id, po_item_id, quantity, line_total, base_qty, unit_cost, stock_movement_id, purchase_order_items: { description, unit, quantity, unit_price, discount_pct, line_total, inventory_item_id } }] }`.

- [ ] **Step 1: Write the failing test** — `src/lib/deliveryTaxInvoice.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  receiptLabel, evaluateDeliveryMatch, buildActiveReceiptLinkMap, receiptEligibility, receiptPickerRows,
  receiptsAwaitingInvoice, receiptTaxInvoiceStatus, defaultTaxInvoiceMode, poModePayload, supplierModePayload,
  poModeLockedText, deliveryPoBadge, formForReceipt, invoiceMatchBase, linkKindOf,
  poModeForSupplier, poDeliveryDiscountWarning, splitDeliveryPoIds,
} from './deliveryTaxInvoice.js'
import { PO_MODE_LOCKED_TEXT, DELIVERY_CHECK_TEXT, DELIVERY_RPC_TEXT, RECEIVE_DELIVERY_DISCOUNT_TEXT, PO_DELIVERY_DISCOUNT_SAVE_TEXT } from './deliveryTaxInvoiceText.js'

const po = (o = {}) => ({ id: 'P1', po_number: 'PO-1', supplier_id: 'S', site_id: 'SITE', tax_invoice_mode: 'delivery', stock_from_invoice: false, has_vat: true, price_includes_vat: false, ...o })
const rc = (id, o = {}, p = {}) => ({ id, po_id: 'P1', seq: 1, received_date: '2026-10-05', goods_subtotal: 600, goods_vat: 42, expense_id: 'e' + id, purchase_orders: po(p), po_receipt_items: [], ...o })
const links = entries => new Map(entries)

describe('texts', () => {
  it('every code has Thai text', () => {
    for (const t of [...Object.values(DELIVERY_CHECK_TEXT), ...Object.values(DELIVERY_RPC_TEXT), PO_MODE_LOCKED_TEXT, RECEIVE_DELIVERY_DISCOUNT_TEXT]) {
      expect(t).toMatch(/[฀-๿]/)
    }
    for (const c of ['po_mode_locked', 'po_delivery_needs_receipt', 'receipt_not_eligible', 'receipt_linked_elsewhere', 'invoice_mixed_links', 'po_is_delivery_mode']) expect(DELIVERY_RPC_TEXT[c], c).toBeTruthy()
    for (const c of ['receipt_not_found', 'receipt_wrong_supplier', 'receipt_po_not_delivery', 'receipt_linked_elsewhere', 'receipt_already_reversed', 'receipt_stock_from_invoice', 'receipt_no_stock_movements', 'receipt_outside_month', 'receipt_has_deposit', 'receipt_no_expense', 'match_vat_inclusive', 'invoice_mixed_links', 'po_is_delivery_mode']) expect(DELIVERY_CHECK_TEXT[c], c).toBeTruthy()
  })
})

describe('receiptLabel', () => {
  it('PO number + -R + seq', () => {
    expect(receiptLabel('PO2610-038', 2)).toBe('PO2610-038-R2')
    expect(receiptLabel(null, 1)).toBe('?-R1')
  })
})

describe('evaluateDeliveryMatch (mirror of _sti_check_delivery)', () => {
  it('excl basis within tolerance', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: '600', grandTotal: 642, receipts: [rc('a')], lineAmounts: [600] })
    expect(m).toMatchObject({ invalid: false, sum: 600, sumIncl: 642, diffExcl: 0, diffIncl: 0, basis: 'excl', matchOk: true, diff: 0, tolerance: 5, linesOk: true })
  })
  it('VAT-inclusive basis when the net is off but the total matches (SQL test B7 numbers)', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: 1390, grandTotal: 1498,
      receipts: [rc('a', { goods_subtotal: 400, goods_vat: 28 }), rc('b', { goods_subtotal: 1000, goods_vat: 70 })], lineAmounts: [390, 1000] })
    expect(m).toMatchObject({ sum: 1400, sumIncl: 1498, diffExcl: -10, diffIncl: 0, basis: 'incl', matchOk: true, diff: 0, tolerance: 5, linesOk: true })
  })
  it('neither basis: no match, diff = excl diff (SQL test B14 numbers)', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: 200, grandTotal: 214, receipts: [rc('a', { goods_subtotal: 300, goods_vat: 21 })], lineAmounts: [200] })
    expect(m).toMatchObject({ basis: 'none', matchOk: false, diff: -100, diffExcl: -100, diffIncl: -107 })
  })
  it('tolerance = min(1% of base, 5): edge passes, one satang beyond fails', () => {
    const r = [rc('a', { goods_subtotal: 100, goods_vat: 7 })]
    expect(evaluateDeliveryMatch({ netBeforeVat: 101, grandTotal: 108, receipts: r, lineAmounts: [101] }).basis).toBe('excl')
    expect(evaluateDeliveryMatch({ netBeforeVat: 101.02, grandTotal: 999, receipts: r, lineAmounts: [101.02] }).basis).toBe('none')
  })
  it('blank / non-finite -> invalid, never a match', () => {
    expect(evaluateDeliveryMatch({ netBeforeVat: '', grandTotal: 0, receipts: [rc('a')], lineAmounts: [] }).invalid).toBe(true)
    const bad = evaluateDeliveryMatch({ netBeforeVat: 600, grandTotal: 642, receipts: [rc('a', { goods_subtotal: 'NaN' })], lineAmounts: [] })
    expect(bad.invalid).toBe(true); expect(bad.matchOk).toBe(false)
  })
})

describe('buildActiveReceiptLinkMap', () => {
  it('active rows only; missing embed -> empty texts; null -> empty map', () => {
    const m = buildActiveReceiptLinkMap([
      { receipt_id: 'r1', invoice_id: 'i1', active: true, supplier_tax_invoices: { invoice_no: 'INV-1', status: 'draft' } },
      { receipt_id: 'r2', invoice_id: 'i0', active: false, supplier_tax_invoices: { invoice_no: 'OLD', status: 'void' } },
      { receipt_id: 'r3', invoice_id: 'i3', supplier_tax_invoices: null },
    ])
    expect(m.get('r1')).toEqual({ invoice_id: 'i1', invoice_no: 'INV-1', status: 'draft' })
    expect(m.has('r2')).toBe(false)
    expect(m.get('r3')).toEqual({ invoice_id: 'i3', invoice_no: '', status: '' })
    expect(buildActiveReceiptLinkMap(null).size).toBe(0)
  })
})

describe('eligibility / picker / awaiting', () => {
  const L = links([['r2', { invoice_id: 'other', invoice_no: 'INV-9', status: 'posted' }], ['r3', { invoice_id: 'mine', invoice_no: 'INV-1', status: 'draft' }]])
  const rows = [
    rc('r1', { received_date: '2026-10-07' }), rc('r2', { received_date: '2026-10-01' }), rc('r3', { received_date: '2026-10-03' }),
    rc('r4', {}, { supplier_id: 'OTHER' }), rc('r5', {}, { tax_invoice_mode: 'po' }),
  ]
  it('receiptEligibility', () => {
    expect(receiptEligibility(rows[0], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('ok')
    expect(receiptEligibility(rows[1], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('linked_elsewhere')
    expect(receiptEligibility(rows[2], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('ok')   // linked to THIS invoice
    expect(receiptEligibility(rows[3], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('wrong_supplier')
    expect(receiptEligibility(rows[4], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('not_delivery')
  })
  it('receiptPickerRows: oldest first, other supplier and po-mode left out', () => {
    const p = receiptPickerRows({ receipts: rows, supplierId: 'S', links: L, invoiceId: 'mine' })
    expect(p.available.map(r => r.id)).toEqual(['r3', 'r1'])
    expect(p.linkedElsewhere.map(x => [x.receipt.id, x.link.invoice_no])).toEqual([['r2', 'INV-9']])
  })
  it('receiptsAwaitingInvoice: null until loaded; no link at all (drafts count as linked); per supplier, oldest first', () => {
    expect(receiptsAwaitingInvoice(null, L)).toBeNull()
    expect(receiptsAwaitingInvoice(rows, null)).toBeNull()
    const g = receiptsAwaitingInvoice([...rows, rc('r6', { received_date: '2026-09-30' }, { supplier_id: 'S2' })], L)
    expect(g.map(x => x.supplierId)).toEqual(['S2', 'OTHER', 'S'])   // by each group's oldest lot: 09-30, 10-05, 10-07
    expect(g.find(x => x.supplierId === 'S').rows.map(r => r.id)).toEqual(['r1'])
  })
  it('receiptTaxInvoiceStatus', () => {
    expect(receiptTaxInvoiceStatus('r3', L)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-1 (ร่าง)', invoiceId: 'mine' })
    expect(receiptTaxInvoiceStatus('r2', L).text).toBe('ใบกำกับ INV-9')
    expect(receiptTaxInvoiceStatus('r1', L)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ' })
    expect(receiptTaxInvoiceStatus('r1', null)).toEqual({ kind: null, text: '' })
  })
})

describe('mode defaults, payloads, locks, badges', () => {
  it('defaultTaxInvoiceMode', () => {
    expect(defaultTaxInvoiceMode({ default_tax_invoice_mode: 'delivery' })).toBe('delivery')
    expect(defaultTaxInvoiceMode({})).toBe('po')
    expect(defaultTaxInvoiceMode(null)).toBe('po')
  })
  it('poModePayload: never sends the column when it may not exist', () => {
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, true)).toEqual({ tax_invoice_mode: 'delivery' })
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, false)).toEqual({})
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, null)).toEqual({})
    expect(poModePayload({ tax_invoice_mode: 'x' }, { id: 'P', tax_invoice_mode: 'delivery' }, true)).toEqual({ tax_invoice_mode: 'po' })
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, { id: 'P' }, true)).toEqual({})
  })
  it('supplierModePayload', () => {
    expect(supplierModePayload({ default_tax_invoice_mode: 'delivery' }, null, true)).toEqual({ default_tax_invoice_mode: 'delivery' })
    expect(supplierModePayload({ default_tax_invoice_mode: 'delivery' }, null, false)).toEqual({})
    expect(supplierModePayload({ default_tax_invoice_mode: 'po' }, { id: 'S', default_tax_invoice_mode: 'delivery' }, false)).toEqual({ default_tax_invoice_mode: 'po' })
    expect(supplierModePayload({}, { id: 'S' }, true)).toEqual({})
  })
  it('poModeLockedText: ordered/draft without receipts or active PO link only', () => {
    const idx = new Map([['P2', { receiptIds: new Set(['r1']) }]])
    expect(poModeLockedText({ id: 'P1', status: 'ordered' }, idx, new Map())).toBe('')
    expect(poModeLockedText({ id: 'P1', status: 'draft' }, null, null)).toBe('')
    expect(poModeLockedText({ id: 'P2', status: 'ordered' }, idx, null)).toBe(PO_MODE_LOCKED_TEXT)
    expect(poModeLockedText({ id: 'P1', status: 'received' }, idx, null)).toBe(PO_MODE_LOCKED_TEXT)
    expect(poModeLockedText({ id: 'P1', status: 'ordered' }, idx, new Map([['P1', {}]]))).toBe(PO_MODE_LOCKED_TEXT)
  })
  it('deliveryPoBadge', () => {
    const idx = new Map([['P1', { receiptIds: new Set(['r1', 'r2']) }]])
    const L = new Map([['r1', { invoice_id: 'i', invoice_no: 'INV', status: 'posted' }]])
    expect(deliveryPoBadge(po(), idx, L)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ 1 ล็อต' })
    expect(deliveryPoBadge(po(), idx, new Map([...L, ['r2', {}]]))).toEqual({ kind: 'linked', text: 'ใบกำกับครบ 2 ล็อต' })
    expect(deliveryPoBadge(po({ id: 'P9' }), idx, L)).toEqual({ kind: 'delivery', text: 'ใบกำกับต่อการส่งของ' })
    expect(deliveryPoBadge(po({ tax_invoice_mode: 'po' }), idx, L)).toEqual({ kind: null, text: '' })
    expect(deliveryPoBadge(po(), null, L)).toEqual({ kind: null, text: '' })
  })
})

describe('PO form mode helpers', () => {
  it('poModeForSupplier: hand-picked wins (survives draft restore); unknown supplier -> po', () => {
    expect(poModeForSupplier({ tax_invoice_mode: 'po' }, { default_tax_invoice_mode: 'delivery' })).toBe('delivery')
    expect(poModeForSupplier({ tax_invoice_mode: 'po', tax_invoice_mode_touched: true }, { default_tax_invoice_mode: 'delivery' })).toBe('po')
    expect(poModeForSupplier({ tax_invoice_mode: 'delivery' }, undefined)).toBe('po')
  })
  it('poDeliveryDiscountWarning', () => {
    const lt = it => Number(it.quantity) * Number(it.unit_price)
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'delivery', items: [{ description: 'a', quantity: 1, unit_price: 10 }, { description: 'ส่วนลด', quantity: 1, unit_price: -5 }] }, lt)).toBe(PO_DELIVERY_DISCOUNT_SAVE_TEXT)
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'po', items: [{ description: 'ส่วนลด', quantity: 1, unit_price: -5 }] }, lt)).toBe('')
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'delivery', items: [{ description: '', quantity: 1, unit_price: -5 }] }, lt)).toBe('')
  })
  it('splitDeliveryPoIds: stale delivery POs separated from a PO-kind selection', () => {
    expect(splitDeliveryPoIds(['a', 'b', 'z'], [{ id: 'a' }, { id: 'b', tax_invoice_mode: 'delivery' }])).toEqual({ keep: ['a', 'z'], delivery: ['b'] })
    expect(splitDeliveryPoIds(['a'], null)).toEqual({ keep: ['a'], delivery: [] })
  })
})

describe('formForReceipt (hand-off prefill)', () => {
  const item = (o = {}) => ({ description: 'เหล็ก', unit: 'kg', quantity: 2, unit_price: 321, discount_pct: 0, line_total: 642, inventory_item_id: 'I1', ...o })
  it('VAT-inclusive PO: unit price ex-VAT; stored base quantity kept as typed; net/VAT/date from the receipt', () => {
    const f = formForReceipt(rc('r1', { goods_subtotal: 600, goods_vat: 42, received_date: '2026-10-04',
      po_receipt_items: [{ quantity: 2, base_qty: 2, purchase_order_items: item() }] }, { price_includes_vat: true }), '2026-10-08')
    expect(f).toMatchObject({ supplier_id: 'S', link_kind: 'delivery', receipt_ids: ['r1'], po_ids: [], net_before_vat: '600', vat: '42', invoice_date: '2026-10-04', invoice_no: '' })
    expect(f.lines[0]).toMatchObject({ description: 'เหล็ก', qty: '2', unit: 'kg', unit_price: '300', inventory_item_id: 'I1', site_id: 'SITE', base_qty: '2', base_manual: true })
  })
  it('no stored base (PO "stock from invoice"): base left empty and NOT manual (the form converts it)', () => {
    const f = formForReceipt(rc('r1', { po_receipt_items: [{ quantity: 2, base_qty: null, purchase_order_items: item() }] }, { stock_from_invoice: true }), '2026-10-08')
    expect(f.lines[0]).toMatchObject({ inventory_item_id: 'I1', site_id: 'SITE', base_qty: '', base_manual: false })
  })
  it('non-stock line: no item, no site', () => {
    const f = formForReceipt(rc('r1', { po_receipt_items: [{ quantity: 1, purchase_order_items: item({ inventory_item_id: null }) }] }), '2026-10-08')
    expect(f.lines[0]).toMatchObject({ inventory_item_id: '', site_id: '', base_qty: '' })
  })
})

describe('list helpers', () => {
  it('invoiceMatchBase / linkKindOf', () => {
    const d = { status: 'posted', post_result: { checks: [] }, supplier_tax_invoice_receipts: [{ active: true, goods_subtotal: 400, goods_vat: 28 }, { active: true, goods_subtotal: 1000, goods_vat: 70 }] }
    expect(linkKindOf(d)).toBe('delivery')
    expect(invoiceMatchBase(d)).toBe(1400)
    expect(invoiceMatchBase({ ...d, post_result: { checks: [{ code: 'match_vat_inclusive' }] } })).toBe(1498)
    const p = { status: 'posted', supplier_tax_invoice_pos: [{ active: true, po_subtotal: 1000 }, { active: false, po_subtotal: 5 }] }
    expect(linkKindOf(p)).toBe('po')
    expect(invoiceMatchBase(p)).toBe(1000)
    expect(invoiceMatchBase({ ...p, status: 'void' })).toBe(1005)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run src/lib/deliveryTaxInvoice.test.js`
Expected: FAIL (`Failed to resolve import "./deliveryTaxInvoice.js"`).

- [ ] **Step 3: Implement** — `src/lib/deliveryTaxInvoiceText.js`:

```js
// Thai text for the per-delivery tax invoice codes (migrations 2026-10-09-04 / -05).
// Leaf module: NO imports (supplierTaxInvoice.js and poReceiptErrors.js both spread these maps).

export const PO_MODE_LOCKED_TEXT = 'เปลี่ยนวิธีออกใบกำกับภาษีไม่ได้ — ใบสั่งซื้อนี้รับของหรือผูกใบกำกับแล้ว'
export const RECEIVE_DELIVERY_DISCOUNT_TEXT = 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของมีรายการส่วนลด (ยอดติดลบ) รับของทีละล็อตไม่ได้ — เปลี่ยนเป็นใบกำกับต่อใบสั่งซื้อก่อนรับของ'
export const DELIVERY_NOT_READY_TEXT = 'ใบกำกับต่อการส่งของยังไม่พร้อมใช้งาน'
export const HANDOFF_RECEIPT_NOT_FOUND_TEXT = 'ไม่พบการรับของนี้ในรายการ — เปิดจากหน้าใบกำกับภาษีผู้ขาย (ใบรับของที่รอใบกำกับ) แทน'
export const NO_RECEIPTS_TEXT = 'ยังไม่ได้เลือกการส่งของ (ล็อต) — เลือกอย่างน้อย 1 ล็อต'
export const DELIVERY_PO_IN_PO_INVOICE_TEXT = 'ใบสั่งซื้อนี้ตั้งเป็นใบกำกับต่อการส่งของ จึงผูกทั้งใบไม่ได้ — เอาออก แล้วเลือก "ผูกกับ: การส่งของ"'
export const PO_DELIVERY_DISCOUNT_SAVE_TEXT = 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของที่มีรายการส่วนลด (ยอดติดลบ) จะรับของไม่ได้ — ต้องการบันทึกต่อหรือไม่? (แนะนำเลือก "1 ใบต่อใบสั่งซื้อ")'

const LINKED_ELSEWHERE = 'การรับของนี้ผูกกับใบกำกับอื่นอยู่แล้ว'
const MIXED = 'ใบกำกับหนึ่งใบผูกได้แบบเดียว: ใบสั่งซื้อ หรือ การส่งของ — ไม่ผสมกัน'
const PO_IS_DELIVERY = 'ใบสั่งซื้อนี้ตั้งเป็นใบกำกับต่อการส่งของ — เลือก "ผูกกับ: การส่งของ" แทน'

export const DELIVERY_CHECK_TEXT = {
  receipt_not_found: 'ไม่พบการรับของ',
  receipt_wrong_supplier: 'การรับของเป็นของซัพพลายเออร์อื่น',
  receipt_po_not_delivery: 'ใบสั่งซื้อของการรับของนี้ไม่ได้ตั้งเป็นใบกำกับต่อการส่งของ',
  receipt_linked_elsewhere: LINKED_ELSEWHERE,
  receipt_already_reversed: 'สต็อกของการรับของนี้ถูกกลับรายการโดยใบกำกับอื่นแล้ว',
  receipt_stock_from_invoice: 'ใบสั่งซื้อนี้ตั้งให้สต็อกเข้าจากใบกำกับ (ล็อตนี้ไม่มีสต็อกให้กลับรายการ)',
  receipt_no_stock_movements: 'การรับของนี้ไม่มีรายการเข้าสต็อกให้กลับรายการ — สต็อกจะเพิ่มจากรายการในใบกำกับเท่านั้น',
  receipt_outside_month: 'การรับของอยู่นอกเดือนของใบกำกับ',
  receipt_has_deposit: 'การรับของนี้หักมัดจำ (เทียบด้วยมูลค่าสินค้า ไม่ใช่ยอดบิล)',
  receipt_no_expense: 'การรับของนี้ไม่มีบิล (หักมัดจำครบ) — ไม่มีรายจ่ายให้ประทับเลขที่',
  match_vat_inclusive: 'ยอดตรงเมื่อเทียบแบบรวม VAT (ยอดรวมใบกำกับ กับ มูลค่าที่รับรวม VAT)',
  invoice_mixed_links: MIXED,
  po_is_delivery_mode: PO_IS_DELIVERY,
}

export const DELIVERY_RPC_TEXT = {
  po_mode_locked: PO_MODE_LOCKED_TEXT,
  po_delivery_needs_receipt: 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของ ต้องรับของผ่านเมนู "รับของ" (ทีละล็อต) เท่านั้น',
  receipt_not_eligible: 'การรับของที่เลือกใช้ไม่ได้ (ซัพพลายเออร์อื่น หรือใบสั่งซื้อไม่ได้ตั้งเป็นใบกำกับต่อการส่งของ)',
  receipt_linked_elsewhere: LINKED_ELSEWHERE,
  invoice_mixed_links: MIXED,
  po_is_delivery_mode: PO_IS_DELIVERY,
  no_receipts: NO_RECEIPTS_TEXT,
}
```

`src/lib/deliveryTaxInvoice.js`:

```js
// ============================================================
// Supplier tax invoice per delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ) -- pure logic.
// Mirrors supabase/migrations/2026-10-09-05 (_sti_check_delivery match rule; save_supplier_tax_invoice_receipt_draft
// eligibility). The RPCs are the authority; this is preview / UI only.
// Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md
// ============================================================
import { round2 } from './depositMath.js'
import { matchTolerance, withinTolerance } from './supplierTaxInvoice.js'
import { emptyLine } from './taxInvoiceForm.js'
import { exVatUnitPrice } from './poDocumentExtraction.js'
import { PO_MODE_LOCKED_TEXT, PO_DELIVERY_DISCOUNT_SAVE_TEXT } from './deliveryTaxInvoiceText.js'

const finite = v => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v))
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)
const mode = v => (v === 'delivery' ? 'delivery' : 'po')

export const receiptLabel = (poNumber, seq) => `${poNumber || '?'}-R${seq}`

/** Invoice net vs Σ goods_subtotal; if that fails, invoice total vs Σ(goods_subtotal + goods_vat). Same tolerance as today. */
export function evaluateDeliveryMatch({ netBeforeVat, grandTotal, receipts, lineAmounts }) {
  const rs = receipts || []
  const valid = finite(netBeforeVat) && finite(grandTotal) && (lineAmounts || []).every(finite)
    && rs.every(r => finite(r.goods_subtotal) && finite(r.goods_vat ?? 0))
  if (!valid) {
    return { invalid: true, sum: NaN, sumIncl: NaN, diffExcl: NaN, diffIncl: NaN, basis: 'none', diff: NaN, tolerance: NaN, matchOk: false, linesSum: NaN, linesOk: false }
  }
  const net = round2(Number(netBeforeVat)), total = round2(Number(grandTotal))
  const sum = round2(rs.reduce((s, r) => s + Number(r.goods_subtotal), 0))
  const sumIncl = round2(rs.reduce((s, r) => s + Number(r.goods_subtotal) + Number(r.goods_vat || 0), 0))
  const diffExcl = round2(net - sum), diffIncl = round2(total - sumIncl)
  const linesSum = round2((lineAmounts || []).reduce((s, x) => s + Number(x), 0))
  let basis = 'none', diff = diffExcl, tolerance = matchTolerance(sum)
  if (withinTolerance(diffExcl, sum)) basis = 'excl'
  else if (withinTolerance(diffIncl, sumIncl)) { basis = 'incl'; diff = diffIncl; tolerance = matchTolerance(sumIncl) }
  return { invalid: false, sum, sumIncl, diffExcl, diffIncl, basis, diff, tolerance, matchOk: basis !== 'none', linesSum, linesOk: withinTolerance(round2(linesSum - net), net) }
}

/** Map<receipt_id, {invoice_id, invoice_no, status}> from active supplier_tax_invoice_receipts rows. */
export function buildActiveReceiptLinkMap(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (r.active === false) continue
    m.set(r.receipt_id, { invoice_id: r.invoice_id, invoice_no: r.supplier_tax_invoices?.invoice_no || '', status: r.supplier_tax_invoices?.status || '' })
  }
  return m
}

export function receiptEligibility(receipt, { supplierId, links, invoiceId } = {}) {
  const p = receipt?.purchase_orders
  if (!p || p.supplier_id !== supplierId) return 'wrong_supplier'
  if (p.tax_invoice_mode !== 'delivery') return 'not_delivery'
  const l = links?.get?.(receipt.id)
  if (l && l.invoice_id !== invoiceId) return 'linked_elsewhere'
  return 'ok'
}

const byOldest = (a, b) => String(a.received_date || '').localeCompare(String(b.received_date || ''))
  || String(a.purchase_orders?.po_number || '').localeCompare(String(b.purchase_orders?.po_number || ''))
  || (Number(a.seq) || 0) - (Number(b.seq) || 0)

export function receiptPickerRows({ receipts, supplierId, links, invoiceId }) {
  const sorted = [...(receipts || [])].sort(byOldest)
  const opts = { supplierId, links, invoiceId }
  return {
    available: sorted.filter(r => receiptEligibility(r, opts) === 'ok'),
    linkedElsewhere: sorted.filter(r => receiptEligibility(r, opts) === 'linked_elsewhere').map(r => ({ receipt: r, link: links.get(r.id) })),
  }
}

/** "รอใบกำกับ": a delivery PO's receipt with NO active link (a draft link counts as linked). null until both are loaded. */
export function receiptsAwaitingInvoice(receipts, links) {
  if (!receipts || !links) return null
  const groups = new Map()
  for (const r of [...receipts].sort(byOldest)) {
    if (r.purchase_orders?.tax_invoice_mode !== 'delivery' || links.has(r.id)) continue
    const k = r.purchase_orders.supplier_id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  return [...groups.entries()].map(([supplierId, rows]) => ({ supplierId, rows }))
    .sort((a, b) => byOldest(a.rows[0], b.rows[0]))
}

export function receiptTaxInvoiceStatus(receiptId, links) {
  if (!links) return { kind: null, text: '' }
  const l = links.get(receiptId)
  if (l) return { kind: 'linked', text: `ใบกำกับ ${l.invoice_no}${l.status === 'draft' ? ' (ร่าง)' : ''}`, invoiceId: l.invoice_id }
  return { kind: 'awaiting', text: 'รอใบกำกับ' }
}

export const defaultTaxInvoiceMode = supplier => mode(supplier?.default_tax_invoice_mode)

/** PO form: the mode after a supplier pick / readiness change. A hand-picked mode (form.tax_invoice_mode_touched, kept in
 *  the form state so it survives the useDraftForm restore) always wins; a supplier not in the list yet (just created
 *  inline) has the column default 'po'. */
export const poModeForSupplier = (form, supplier) => (form?.tax_invoice_mode_touched ? mode(form.tax_invoice_mode) : defaultTaxInvoiceMode(supplier))

/** '' or the save-time warning for a delivery PO with a discount (negative) line: such a PO cannot be received lot by lot. */
export function poDeliveryDiscountWarning(form, lineTotalOf) {
  if (mode(form?.tax_invoice_mode) !== 'delivery') return ''
  return (form.items || []).some(it => String(it.description || '').trim() && Number(lineTotalOf(it)) < 0) ? PO_DELIVERY_DISCOUNT_SAVE_TEXT : ''
}

/** The tax-invoice form's PO-kind selection minus delivery-mode POs (stale drafts): { keep, delivery } id lists. */
export function splitDeliveryPoIds(poIds, poRows) {
  const byId = new Map((poRows || []).map(p => [p.id, p]))
  const delivery = (poIds || []).filter(id => byId.get(id)?.tax_invoice_mode === 'delivery')
  return { keep: (poIds || []).filter(id => !delivery.includes(id)), delivery }
}

/** Only send the column when it exists: on an edited row that carries it, or on a new row once the migration is live. */
export function poModePayload(form, editRow, ready) {
  if (editRow) return has(editRow, 'tax_invoice_mode') ? { tax_invoice_mode: mode(form?.tax_invoice_mode) } : {}
  return ready === true ? { tax_invoice_mode: mode(form?.tax_invoice_mode) } : {}
}
export function supplierModePayload(form, editItem, ready) {
  if (editItem) return has(editItem, 'default_tax_invoice_mode') ? { default_tax_invoice_mode: mode(form?.default_tax_invoice_mode) } : {}
  return ready === true ? { default_tax_invoice_mode: mode(form?.default_tax_invoice_mode) } : {}
}

/** Mirror of po_tax_invoice_mode_guard: changeable only while draft/ordered, no receipt, no active PO-level link. */
export function poModeLockedText(po, moneyIndex, poLinks) {
  if (!po || !['draft', 'ordered'].includes(po.status)) return PO_MODE_LOCKED_TEXT
  if ((moneyIndex?.get?.(po.id)?.receiptIds?.size || 0) > 0) return PO_MODE_LOCKED_TEXT
  if (poLinks?.get?.(po.id)) return PO_MODE_LOCKED_TEXT
  return ''
}

export function deliveryPoBadge(po, moneyIndex, receiptLinks) {
  if (!po || po.tax_invoice_mode !== 'delivery' || !moneyIndex || !receiptLinks) return { kind: null, text: '' }
  const ids = [...(moneyIndex.get(po.id)?.receiptIds || [])]
  const awaiting = ids.filter(id => !receiptLinks.has(id)).length
  if (awaiting > 0) return { kind: 'awaiting', text: `รอใบกำกับ ${awaiting} ล็อต` }
  if (ids.length > 0) return { kind: 'linked', text: `ใบกำกับครบ ${ids.length} ล็อต` }
  return { kind: 'delivery', text: 'ใบกำกับต่อการส่งของ' }
}

/** New tax-invoice form for one receipt: lines from the PO lines received (ex-VAT prices), net/VAT from the receipt. */
export function formForReceipt(receipt, today) {
  const p = receipt?.purchase_orders || {}
  const incl = !!(p.has_vat && p.price_includes_vat)
  const lines = (receipt?.po_receipt_items || []).map(ri => {
    const it = ri.purchase_order_items || {}
    const stock = !!it.inventory_item_id
    const hasBase = stock && ri.base_qty != null && Number(ri.base_qty) > 0
    return {
      ...emptyLine(),
      description: it.description || '', qty: String(ri.quantity ?? it.quantity ?? ''), unit: it.unit || '',
      unit_price: String(exVatUnitPrice(Number(it.unit_price) || 0, incl)), discount_pct: String(it.discount_pct ?? 0),
      inventory_item_id: stock ? it.inventory_item_id : '', site_id: stock ? (p.site_id || '') : '',
      base_qty: hasBase ? String(ri.base_qty) : '', base_manual: hasBase, base_stale: false,
    }
  })
  return {
    supplier_id: p.supplier_id || '', invoice_no: '', invoice_date: receipt?.received_date || today,
    net_before_vat: receipt?.goods_subtotal != null ? String(receipt.goods_subtotal) : '',
    vat: receipt?.goods_vat != null ? String(receipt.goods_vat) : '',
    match_note: '', lines, po_ids: [], link_kind: 'delivery', receipt_ids: receipt?.id ? [receipt.id] : [],
  }
}

const pickLinks = (row, list) => (row?.status === 'void' ? list || [] : (list || []).filter(l => l.active))
export const linkKindOf = row => ((row?.supplier_tax_invoice_receipts || []).length ? 'delivery' : 'po')

/** Base the list page compares match_diff with: Σ receipt goods (+VAT when matched on the inclusive basis), else Σ PO subtotals. */
export function invoiceMatchBase(row) {
  const rl = pickLinks(row, row?.supplier_tax_invoice_receipts)
  if (rl.length) {
    const incl = (row.post_result?.checks || []).some(c => c.code === 'match_vat_inclusive')
    return round2(rl.reduce((s, l) => s + (Number(l.goods_subtotal) || 0) + (incl ? Number(l.goods_vat) || 0 : 0), 0))
  }
  return pickLinks(row, row?.supplier_tax_invoice_pos).reduce((s, l) => s + (Number(l.po_subtotal) || 0), 0)
}
```

- [ ] **Step 4: Run, expect pass; then the whole suite**

Run: `npx vitest run src/lib/deliveryTaxInvoice.test.js` -> PASS. Run: `npx vitest run` -> all PASS (no existing test touched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/deliveryTaxInvoiceText.js src/lib/deliveryTaxInvoice.js src/lib/deliveryTaxInvoice.test.js
git commit -m "feat(lib): pure helpers for supplier tax invoice per delivery"
```

---

### Task 2: Extend the existing pure modules (form model, signature, PO proposal, receive routing, RPC args)

**Files:**
- Modify: `src/lib/taxInvoiceForm.js`, `src/lib/supplierTaxInvoice.js`, `src/lib/poReceiptErrors.js`, `src/lib/taxInvoiceLinks.js`
- Test: `src/lib/taxInvoiceForm.test.js`, `src/lib/supplierTaxInvoice.test.js`, `src/lib/poReceiptErrors.test.js`, `src/lib/taxInvoiceLinks.test.js` (append only)

**Interfaces:**
- Consumes: `RECEIVE_DELIVERY_DISCOUNT_TEXT` (Task 1).
- Produces: form fields `link_kind: 'po'|'delivery'` and `receipt_ids: string[]`; `toRpcPayload(form) -> { header, items, poIds, receiptIds, linkKind }`; `missingReceiptIds(ids, rows)`; `formSignature` includes `k`/`rc` only for delivery forms; `proposePos` skips `tax_invoice_mode === 'delivery'`; `postSummaryLines({ ..., receiptCount })`; `reversingReceiptCount(n, checks)`; `receiveRoute` delivery branch; `isMissingEmbedError(err, table)`; `saveReceiptDraftArgs(id, header, items, receiptIds)`; `TAX_INVOICE_RPCS.saveReceipts = 'save_supplier_tax_invoice_receipt_draft'`.

- [ ] **Step 1: Write the failing tests** (append to the four test files)

`src/lib/taxInvoiceForm.test.js` (add `missingReceiptIds` to the import list):

```js
describe('per-delivery form model', () => {
  it('empty form is PO kind with no receipts', () => {
    expect(emptyTaxInvoiceForm('2026-10-08')).toMatchObject({ link_kind: 'po', receipt_ids: [], po_ids: [] })
  })
  it('formFromInvoice: active receipt links -> delivery kind', () => {
    const f = formFromInvoice({ supplier_id: 'S', invoice_no: 'X', invoice_date: '2026-10-08', net_before_vat: 1, vat: 0, supplier_tax_invoice_items: [],
      supplier_tax_invoice_pos: [], supplier_tax_invoice_receipts: [{ receipt_id: 'r1', active: true }, { receipt_id: 'r0', active: false }] })
    expect(f).toMatchObject({ link_kind: 'delivery', receipt_ids: ['r1'], po_ids: [] })
    expect(formFromInvoice({ supplier_id: 'S', invoice_no: 'X', invoice_date: '2026-10-08', net_before_vat: 1, vat: 0, supplier_tax_invoice_items: [], supplier_tax_invoice_pos: [] }))
      .toMatchObject({ link_kind: 'po', receipt_ids: [] })
  })
  it('toRpcPayload carries receipt ids and the kind', () => {
    const p = toRpcPayload({ ...emptyTaxInvoiceForm('2026-10-08'), supplier_id: 'S', invoice_no: 'X', net_before_vat: '1', link_kind: 'delivery', receipt_ids: ['r1', 'r2'] })
    expect(p.receiptIds).toEqual(['r1', 'r2']); expect(p.linkKind).toBe('delivery')
    expect(toRpcPayload({ ...emptyTaxInvoiceForm('2026-10-08') }).linkKind).toBe('po')
  })
  it('missingReceiptIds: null rows -> nothing; unknown ids listed', () => {
    expect(missingReceiptIds(['a'], null)).toEqual([])
    expect(missingReceiptIds(['a', 'b'], [{ id: 'a' }])).toEqual(['b'])
  })
})
```

`src/lib/supplierTaxInvoice.test.js` (add `reversingReceiptCount` to the import list):

```js
describe('per-delivery additions', () => {
  it('formSignature: a PO form signature is unchanged; a delivery form also covers kind and receipts', () => {
    const base = { supplier_id: 'S', invoice_no: 'X', invoice_date: '2026-10-08', net_before_vat: '1', vat: '0', match_note: '', lines: [], po_ids: ['p1'] }
    expect(formSignature({ ...base, link_kind: 'po', receipt_ids: ['r9'] })).toBe(formSignature(base))
    const d = { ...base, po_ids: [], link_kind: 'delivery', receipt_ids: ['r2', 'r1'] }
    expect(formSignature(d)).toBe(formSignature({ ...d, receipt_ids: ['r1', 'r2'] }))
    expect(formSignature(d)).not.toBe(formSignature({ ...d, receipt_ids: ['r1'] }))
  })
  it('proposePos never offers a delivery-mode PO', () => {
    const r = proposePos({ pos: [{ id: 'p1', supplier_id: 'A', status: 'received', date: '2026-10-01' }, { id: 'p2', supplier_id: 'A', status: 'received', date: '2026-10-01', tax_invoice_mode: 'delivery' }],
      supplierId: 'A', invoiceDate: '2026-10-08', activeLinks: new Map(), invoiceId: null })
    expect(r.proposed.map(p => p.id)).toEqual(['p1'])
  })
  it('postSummaryLines: receipt wording only when receiptCount is given; PO wording unchanged', () => {
    const po = postSummaryLines({ invoiceNo: 'INV', invoiceDate: '2026-10-08', stockLineCount: 1, poCount: 2, preview: { checks: [], rows: [] }, matchNote: '' })
    expect(po[1]).toBe('กลับรายการรับเข้าสต็อกของใบสั่งซื้อ 2 ใบ')
    expect(po).toContain('รายจ่ายของใบสั่งซื้อไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ INV')
    const d = postSummaryLines({ invoiceNo: 'INV', invoiceDate: '2026-10-08', stockLineCount: 1, receiptCount: 2,
      preview: { checks: [{ code: 'receipt_stock_from_invoice', blocking: false, receipt_id: 'r2' }], rows: [] }, matchNote: '' })
    expect(d[1]).toBe('กลับรายการรับเข้าสต็อกของการรับของ 1 ล็อต')
    expect(d).toContain('บิลของล็อตที่เลือกไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ INV')
  })
  it('reversingReceiptCount', () => {
    expect(reversingReceiptCount(3, [{ code: 'receipt_no_stock_movements', receipt_id: 'a' }, { code: 'receipt_no_stock_movements', receipt_id: 'a' }])).toBe(2)
  })
})
```

`src/lib/poReceiptErrors.test.js` (add `isMissingEmbedError` to the import list; import `RECEIVE_DELIVERY_DISCOUNT_TEXT` from `./deliveryTaxInvoiceText.js`):

```js
describe('receiveRoute for delivery-mode POs (never the old whole-PO receive)', () => {
  const item = (o = {}) => ({ id: 'i1', line_total: 100, ...o })
  const dpo = (status, items = [item()]) => ({ id: 'P', status, tax_invoice_mode: 'delivery', purchase_order_items: items })
  const ready = buildPoMoneyIndex({ receiptItems: [], deposits: [] })
  const pre = buildPoMoneyIndex({ receiptItems: [], deposits: [], schemaReady: false })
  it('new dialog when the schema is ready', () => {
    expect(receiveRoute(dpo('ordered'), ready)).toEqual({ kind: 'new' })
    expect(receiveRoute(dpo('partially_received'), ready)).toEqual({ kind: 'new' })
  })
  it('disabled (not old) before the schema and with a discount line', () => {
    expect(receiveRoute(dpo('ordered'), pre)).toEqual({ kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT })
    expect(receiveRoute(dpo('ordered', [item(), item({ id: 'i2', line_total: -5 })]), ready)).toEqual({ kind: 'disabled', reason: RECEIVE_DELIVERY_DISCOUNT_TEXT })
  })
})
describe('isMissingEmbedError', () => {
  it('PGRST200 naming the table only', () => {
    expect(isMissingEmbedError({ code: 'PGRST200', message: "Could not find a relationship between 'supplier_tax_invoices' and 'supplier_tax_invoice_receipts' in the schema cache" }, 'supplier_tax_invoice_receipts')).toBe(true)
    expect(isMissingEmbedError({ code: 'PGRST200', message: "... 'suppliers' ..." }, 'supplier_tax_invoice_receipts')).toBe(false)
    expect(isMissingEmbedError({ code: '42501', message: 'supplier_tax_invoice_receipts' }, 'supplier_tax_invoice_receipts')).toBe(false)
    expect(isMissingEmbedError(null, 'x')).toBe(false)
  })
})
```

`src/lib/taxInvoiceLinks.test.js` (add `saveReceiptDraftArgs` to the import list):

```js
describe('receipt draft args', () => {
  it('defaults and shape', () => {
    expect(saveReceiptDraftArgs(undefined, { a: 1 }, undefined, undefined)).toEqual({ p_id: null, p_header: { a: 1 }, p_items: [], p_receipt_ids: [] })
    expect(saveReceiptDraftArgs('i', {}, [1], ['r'])).toEqual({ p_id: 'i', p_header: {}, p_items: [1], p_receipt_ids: ['r'] })
    expect(TAX_INVOICE_RPCS.saveReceipts).toBe('save_supplier_tax_invoice_receipt_draft')
  })
})
```

- [ ] **Step 2: Run, expect failures**

Run: `npx vitest run src/lib/taxInvoiceForm.test.js src/lib/supplierTaxInvoice.test.js src/lib/poReceiptErrors.test.js src/lib/taxInvoiceLinks.test.js`
Expected: FAIL on the new describes only (missing exports / wrong values).

- [ ] **Step 3: Implement**

`src/lib/taxInvoiceForm.js`:
- `emptyTaxInvoiceForm` returns `{ supplier_id: '', invoice_no: '', invoice_date: today, net_before_vat: '', vat: '', match_note: '', lines: [], po_ids: [], link_kind: 'po', receipt_ids: [] }`.
- In `formFromInvoice`, before `return`, add `const rl = (row.supplier_tax_invoice_receipts || []).filter(l => l.active)` and add to the returned object: `link_kind: rl.length ? 'delivery' : 'po', receipt_ids: rl.map(l => l.receipt_id),`.
- In `toRpcPayload`, after `poIds: [...(form.po_ids || [])],` add `receiptIds: [...(form.receipt_ids || [])], linkKind: form.link_kind === 'delivery' ? 'delivery' : 'po',`.
- Add at the end:

```js
/** receipt_ids not among the loaded receipts (must be shown, never dropped silently). */
export function missingReceiptIds(ids, rows) {
  if (!rows) return []
  const have = new Set(rows.map(r => r.id))
  return (ids || []).filter(id => !have.has(id))
}
```

`src/lib/supplierTaxInvoice.js`:
- In `formSignature`, after the `pos:` line add `...(f.link_kind === 'delivery' ? { k: 'delivery', rc: [...(f.receipt_ids || [])].sort() } : {}),`.
- In `proposePos`, the `eligible` filter becomes `po => po.supplier_id === supplierId && po.status === 'received' && po.tax_invoice_mode !== 'delivery'`.
- Below `reversingPoCount` add:

```js
const NO_REVERSAL_RECEIPT_CODES = ['receipt_no_stock_movements', 'receipt_stock_from_invoice']
/** Number of linked receipts that really have stock movements to reverse. */
export function reversingReceiptCount(receiptCount, checks) {
  const skipped = new Set((checks || []).filter(c => NO_REVERSAL_RECEIPT_CODES.includes(c.code) && c.receipt_id).map(c => c.receipt_id))
  return Math.max(0, receiptCount - skipped.size)
}
```

- `postSummaryLines` signature becomes `({ invoiceNo, invoiceDate, stockLineCount, poCount, receiptCount, preview, matchNote })`; first statement becomes:

```js
  const byReceipt = receiptCount != null
  const out = [`เพิ่มสต็อกจากใบกำกับ ${stockLineCount} รายการ`, byReceipt
    ? `กลับรายการรับเข้าสต็อกของการรับของ ${reversingReceiptCount(receiptCount, preview?.checks)} ล็อต`
    : `กลับรายการรับเข้าสต็อกของใบสั่งซื้อ ${reversingPoCount(poCount, preview?.checks)} ใบ`]
```
and the stamping line becomes `out.push(byReceipt ? \`บิลของล็อตที่เลือกไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ ${invoiceNo}\` : \`รายจ่ายของใบสั่งซื้อไม่เปลี่ยนยอด แต่จะประทับเลขที่ใบกำกับ ${invoiceNo}\`)`.

`src/lib/poReceiptErrors.js`:
- Add `import { RECEIVE_DELIVERY_DISCOUNT_TEXT } from './deliveryTaxInvoiceText.js'`.
- In `receiveRoute`, directly after `if (!index) return { kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT }` insert:

```js
  // a 'delivery' PO is received lot by lot only (receive_po_lines): the server refuses the old whole-PO receive
  // (po_delivery_needs_receipt) because no po_receipts row would exist to link an invoice to
  if (po.tax_invoice_mode === 'delivery') {
    if (index.schemaReady === false) return { kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT }
    if (discount) return { kind: 'disabled', reason: RECEIVE_DELIVERY_DISCOUNT_TEXT }
    return { kind: 'new' }
  }
```
- Append:

```js
/** True when PostgREST cannot find the embedded relationship to `table` (PGRST200), e.g. before the migration creates it. */
export function isMissingEmbedError(err, table) {
  if (!err) return false
  const msg = `${err.message || ''} ${err.details || ''} ${err.hint || ''}`
  return (err.code === 'PGRST200' || /could not find a relationship/i.test(msg)) && msg.includes(table)
}
```

`src/lib/taxInvoiceLinks.js`: add after `saveDraftArgs`:

```js
export const saveReceiptDraftArgs = (id, header, items, receiptIds) =>
  ({ p_id: id || null, p_header: header, p_items: items || [], p_receipt_ids: receiptIds || [] })
```
and add `saveReceipts: 'save_supplier_tax_invoice_receipt_draft',` to `TAX_INVOICE_RPCS`.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run` -> all PASS (every pre-existing test unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/taxInvoiceForm.js src/lib/supplierTaxInvoice.js src/lib/poReceiptErrors.js src/lib/taxInvoiceLinks.js src/lib/taxInvoiceForm.test.js src/lib/supplierTaxInvoice.test.js src/lib/poReceiptErrors.test.js src/lib/taxInvoiceLinks.test.js
git commit -m "feat(lib): link kind, receipt ids, delivery receive routing and receipt draft args"
```

---

### Task 3: Migration 2026-10-09-04 — mode columns, link table, guards (+ SQL test A)

**Files:**
- Create: `supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql`, `supabase/tests/delivery_tax_invoice_test_a.sql`

**Interfaces:**
- Produces: `purchase_orders.tax_invoice_mode TEXT NOT NULL DEFAULT 'po'` (`po_tax_invoice_mode_check`); `suppliers.default_tax_invoice_mode TEXT NOT NULL DEFAULT 'po'` (`suppliers_default_tax_invoice_mode_check`); table `supplier_tax_invoice_receipts(id, tenant_id, invoice_id, receipt_id, po_id, active, goods_subtotal, goods_vat)` with `stirc_invoice_fk`, `stirc_receipt_fk`, `stirc_invoice_receipt_uq`, partial unique `stirc_receipt_active_uq`; triggers `po_tax_invoice_mode_guard_trg` (codes `po_mode_locked`, `po_delivery_needs_receipt`), `stirc_link_kind_guard_trg` + `stip_link_kind_guard_trg` (codes `invoice_mixed_links`, `cross_tenant_reference`).

- [ ] **Step 1 (CONTROLLER ONLY, read-only MCP `execute_sql`, project `kntspldhvcjeaubtqtkn`; the implementer does not run it): prove the objects do not exist yet**

```sql
SELECT to_regclass('public.supplier_tax_invoice_receipts') AS link_table,
       (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('purchase_orders','suppliers') AND column_name LIKE '%tax_invoice_mode') AS mode_cols;
```
Expected (controller reports back): `link_table` null, `mode_cols` 0.

- [ ] **Step 1b (CONTROLLER ONLY): baseline of the six existing tests on live, WITHOUT the new migrations** — must finish before Step 5. For each `T` in `supplier_tax_invoice_test.sql tax_invoice_multi_bill_test.sql po_receipt_test_a.sql po_receipt_test_b.sql po_deposit_test.sql supplier_credit_notes_test.sql`:

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
T=supplier_tax_invoice_test.sql   # repeat for each of the six names
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"
  grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/$T
  echo "ROLLBACK;" ) > /tmp/dti_base_$T
cd /Users/plfx/code/FacadeXPM/facadex-app && npx supabase db query --linked -f /tmp/dti_base_$T
```
Record each outcome verbatim (`RESULT: <name> ALL PASSED`, or "no error" for the two files without a RESULT marker, or the error text). A baseline failure goes to the owner and is not fixed in this branch; the Task 4 regression runs are compared against these baselines.

- [ ] **Step 2: Write the test** — `supabase/tests/delivery_tax_invoice_test_a.sql`:

```sql
-- ================================================================
-- Tests for 2026-10-09-04-delivery-tax-invoice.sql. Part A of 2.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-04; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: delivery_tax_invoice_test_a ALL PASSED'. Anything else = failure.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t2 UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_dtia_owner__@example.com'; email2 TEXT := '__test_dtia_owner2__@example.com';
  poD UUID; d1 UUID; d2 UUID; poP UUID; p1 UUID; rc1 UUID; bill1 UUID; inv1 UUID; inv2 UUID; inv3 UUID; j JSONB;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date; v_msg TEXT; v_n INT;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtia__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtia 2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant), (email2, 'OWNER', 'approved', t2);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__DTIA-1__', '__dtia site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__dtia sup__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__dtia cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtia item__', 'kg') RETURNING id INTO t_item;
  -- A1 defaults
  IF (SELECT default_tax_invoice_mode FROM suppliers WHERE id = t_sup) <> 'po' THEN RAISE EXCEPTION 'A1 FAIL: supplier default'; END IF;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-D', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poD;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD, 'D1', 2, 300, 600, t_item, 0) RETURNING id INTO d1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD, 'D2', 4, 100, 400, t_item, 1) RETURNING id INTO d2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 10, 10) RETURNING id INTO p1;
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poD) <> 'po' THEN RAISE EXCEPTION 'A1 FAIL: PO default'; END IF;

  -- A2 CHECK constraints
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'lot' WHERE id = poD; RAISE EXCEPTION 'A2 FAIL: bad PO mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE suppliers SET default_tax_invoice_mode = 'lot' WHERE id = t_sup; RAISE EXCEPTION 'A2 FAIL: bad supplier mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A3 free while ordered without receipts; the client sets both columns
  UPDATE suppliers SET default_tax_invoice_mode = 'delivery' WHERE id = t_sup;
  UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poD;
  UPDATE purchase_orders SET tax_invoice_mode = 'po' WHERE id = poD;
  UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poD;
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poD) <> 'delivery' OR (SELECT default_tax_invoice_mode FROM suppliers WHERE id = t_sup) <> 'delivery' THEN
    RAISE EXCEPTION 'A3 FAIL: client could not set the modes';
  END IF;
  -- A3b the supplier default never rewrites an existing PO
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poP) <> 'po' THEN RAISE EXCEPTION 'A3b FAIL: supplier default propagated'; END IF;

  -- A5 a delivery PO is never received the old whole-PO way (no receipt row would exist to invoice)
  BEGIN UPDATE purchase_orders SET status = 'received' WHERE id = poD; RAISE EXCEPTION 'A5 FAIL: direct status change accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_delivery_needs_receipt%' THEN RAISE EXCEPTION 'A5 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_with_deposits(poD, '[]'::jsonb, 1000, 70); RAISE EXCEPTION 'A5 FAIL: legacy receive accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_delivery_needs_receipt%' THEN RAISE EXCEPTION 'A5 FAIL: legacy got %', v_msg; END IF; END;

  -- A4 lot 1 through receive_po_lines works; then the mode is locked
  j := receive_po_lines(poD, ARRAY[d1], v_bkk, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', d1, 'base_qty', 2, 'unit_cost', 300)));
  rc1 := (j->>'receipt_id')::uuid; bill1 := (j->>'expense_id')::uuid;
  IF (SELECT status FROM purchase_orders WHERE id = poD) <> 'partially_received' THEN RAISE EXCEPTION 'A4 FAIL: status'; END IF;
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'po' WHERE id = poD; RAISE EXCEPTION 'A4 FAIL: mode changed after a receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_mode_locked%' THEN RAISE EXCEPTION 'A4 FAIL: got %', v_msg; END IF; END;
  -- A4b a 'po' PO received the legacy way (still allowed for 'po') is locked too
  UPDATE purchase_orders SET status = 'received' WHERE id = poP;
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poP; RAISE EXCEPTION 'A4b FAIL: mode changed on a received PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_mode_locked%' THEN RAISE EXCEPTION 'A4b FAIL: got %', v_msg; END IF; END;

  -- A6 clients read the link table but never write it
  inv1 := save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIA-1', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42), '[]'::jsonb, '{}'::uuid[]);
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv1, rc1, poD); RAISE EXCEPTION 'A6 FAIL: client insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM 1 FROM supplier_tax_invoice_receipts;
  -- A7 anon cannot read it
  SET LOCAL role = 'anon';
  BEGIN PERFORM 1 FROM supplier_tax_invoice_receipts; RAISE EXCEPTION 'A7 FAIL: anon read';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SET LOCAL role = 'authenticated';
  -- A11 a receipt bill still cannot be deleted
  BEGIN DELETE FROM expenses WHERE id = bill1; GET DIAGNOSTICS v_n = ROW_COUNT; RAISE EXCEPTION 'A11 FAIL: delete not refused (% rows)', v_n;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'expense_is_receipt_bill%' THEN RAISE EXCEPTION 'A11 FAIL: got %', v_msg; END IF; END;

  -- A8-A10 guards, as the RPCs will write (superuser)
  RESET role;
  INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv1, rc1, poD);
  BEGIN INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, inv1, poP); RAISE EXCEPTION 'A8 FAIL: PO link added to a receipt invoice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_mixed_links%' THEN RAISE EXCEPTION 'A8 FAIL: got %', v_msg; END IF; END;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total) VALUES (t_tenant, t_sup, 'DTIA-2', v_bkk, 10, 0, 10) RETURNING id INTO inv2;
  INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, inv2, poP);
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv2, rc1, poD); RAISE EXCEPTION 'A8 FAIL: receipt link added to a PO invoice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_mixed_links%' THEN RAISE EXCEPTION 'A8 FAIL: reverse got %', v_msg; END IF; END;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total) VALUES (t_tenant, t_sup, 'DTIA-3', v_bkk, 10, 0, 10) RETURNING id INTO inv3;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poP); RAISE EXCEPTION 'A9 FAIL: wrong po_id accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A9 FAIL: got %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t2, inv3, rc1, poD); RAISE EXCEPTION 'A9 FAIL: other tenant accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A9 FAIL: tenant got %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poD); RAISE EXCEPTION 'A10 FAIL: receipt in two active invoices';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE supplier_tax_invoice_receipts SET active = false WHERE invoice_id = inv1;
  INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poD);   -- allowed once inactive

  -- A12 grants, RLS, function privileges
  IF has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'INSERT') OR has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'DELETE') OR NOT has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'SELECT')
     OR has_table_privilege('anon', 'supplier_tax_invoice_receipts', 'SELECT') THEN RAISE EXCEPTION 'A12 FAIL: table grants'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.supplier_tax_invoice_receipts'::regclass) THEN RAISE EXCEPTION 'A12 FAIL: RLS off'; END IF;
  IF has_function_privilege('authenticated', 'po_tax_invoice_mode_guard()', 'EXECUTE') OR has_function_privilege('anon', 'sti_link_kind_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'sti_link_kind_guard()', 'EXECUTE') THEN RAISE EXCEPTION 'A12 FAIL: trigger function executable'; END IF;

  -- A13 tenant isolation of reads
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email2, 'role', 'authenticated')::text, true);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts) THEN RAISE EXCEPTION 'A13 FAIL: other tenant sees links'; END IF;
  RESET role;

  RAISE EXCEPTION 'RESULT: delivery_tax_invoice_test_a ALL PASSED';
END $$;
ROLLBACK;
```

- [ ] **Step 3: Write the migration** — `supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql`:

```sql
-- ============================================================
-- Supplier tax invoice per delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ): schema + guards.
-- Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md
-- Plan: docs/superpowers/plans/2026-10-08-per-delivery-tax-invoice-plan.md (Task 3)
-- Requires (live): 2026-10-08-01..02, 2026-10-09-01..03. Additive only.
-- Two columns (no view selects purchase_orders.* or suppliers.*: checked live 2026-10-08; clients already hold
-- table-level INSERT/UPDATE on both tables, so the PO form and the supplier page can set them).
-- New link table: SELECT-only for clients; 2026-10-09-05's RPCs write it. po_id is a plain copy (NO FK): a second
-- purchase_orders <-> supplier_tax_invoices path would make existing many-to-many embeds ambiguous. No FK to expenses.
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE purchase_orders ADD COLUMN tax_invoice_mode TEXT NOT NULL DEFAULT 'po'
  CONSTRAINT po_tax_invoice_mode_check CHECK (tax_invoice_mode IN ('po', 'delivery'));
ALTER TABLE suppliers ADD COLUMN default_tax_invoice_mode TEXT NOT NULL DEFAULT 'po'
  CONSTRAINT suppliers_default_tax_invoice_mode_check CHECK (default_tax_invoice_mode IN ('po', 'delivery'));

CREATE TABLE supplier_tax_invoice_receipts (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id     UUID NOT NULL,
  receipt_id     UUID NOT NULL,
  po_id          UUID NOT NULL,      -- plain copy of po_receipts.po_id (checked by sti_link_kind_guard)
  active         BOOLEAN NOT NULL DEFAULT true,
  goods_subtotal NUMERIC,            -- the receipt's goods value when the invoice posted
  goods_vat      NUMERIC,
  CONSTRAINT stirc_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stirc_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT stirc_invoice_receipt_uq UNIQUE (invoice_id, receipt_id),
  CONSTRAINT stirc_finite_check CHECK (
    (goods_subtotal IS NULL OR (goods_subtotal > '-Infinity'::numeric AND goods_subtotal < 'Infinity'::numeric))
    AND (goods_vat IS NULL OR (goods_vat > '-Infinity'::numeric AND goods_vat < 'Infinity'::numeric)))
);
-- a receipt belongs to at most one non-void invoice (drafts included), same rule as stip_po_active_uq
CREATE UNIQUE INDEX stirc_receipt_active_uq ON supplier_tax_invoice_receipts (receipt_id) WHERE active;
CREATE INDEX idx_stirc_receipt ON supplier_tax_invoice_receipts(receipt_id);   -- ON DELETE RESTRICT lookups
CREATE INDEX idx_stirc_po ON supplier_tax_invoice_receipts(po_id);
CREATE INDEX idx_stirc_tenant ON supplier_tax_invoice_receipts(tenant_id);

ALTER TABLE supplier_tax_invoice_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON supplier_tax_invoice_receipts FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON supplier_tax_invoice_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON supplier_tax_invoice_receipts TO authenticated;

-- An invoice links POs OR receipts, never both; a receipt link must match its receipt (tenant, PO).
-- The invoice row is locked first so two links of different kinds cannot be added concurrently.
CREATE OR REPLACE FUNCTION sti_link_kind_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM supplier_tax_invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF TG_TABLE_NAME = 'supplier_tax_invoice_receipts' THEN
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = NEW.invoice_id) THEN RAISE EXCEPTION 'invoice_mixed_links'; END IF;
    IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoices i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id)
       OR NOT EXISTS (SELECT 1 FROM po_receipts r WHERE r.id = NEW.receipt_id AND r.tenant_id = NEW.tenant_id AND r.po_id = NEW.po_id) THEN
      RAISE EXCEPTION 'cross_tenant_reference';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = NEW.invoice_id) THEN RAISE EXCEPTION 'invoice_mixed_links'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stirc_link_kind_guard_trg BEFORE INSERT OR UPDATE OF invoice_id, receipt_id, po_id ON supplier_tax_invoice_receipts
  FOR EACH ROW EXECUTE FUNCTION sti_link_kind_guard();
CREATE TRIGGER stip_link_kind_guard_trg BEFORE INSERT OR UPDATE OF invoice_id ON supplier_tax_invoice_pos
  FOR EACH ROW EXECUTE FUNCTION sti_link_kind_guard();

-- The mode is set before the first receipt / active PO-level invoice only (owner Q1). A 'delivery' PO is received
-- only through receive_po_lines (flag app.po_receipt_rpc): the old whole-PO receive leaves no receipt to invoice.
CREATE OR REPLACE FUNCTION po_tax_invoice_mode_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tax_invoice_mode IS DISTINCT FROM OLD.tax_invoice_mode
     AND (OLD.status NOT IN ('draft', 'ordered')
          OR EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id)
          OR EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = OLD.id AND active)) THEN
    RAISE EXCEPTION 'po_mode_locked';
  END IF;
  IF NEW.tax_invoice_mode = 'delivery' AND NEW.status IN ('received', 'partially_received')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND COALESCE(current_setting('app.po_receipt_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'po_delivery_needs_receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_tax_invoice_mode_guard_trg BEFORE INSERT OR UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION po_tax_invoice_mode_guard();

REVOKE ALL ON FUNCTION sti_link_kind_guard(), po_tax_invoice_mode_guard() FROM PUBLIC, anon, authenticated;
```

- [ ] **Step 4: Static checks (no database)**

```bash
grep -c "SECURITY DEFINER SET search_path = public" supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql   # expect 2
grep -n "REFERENCES expenses\|REFERENCES purchase_orders" supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql   # expect no output
npx vitest run src/lib/poReceiptErrors.test.js   # still PASS (this file is not in its RAISE list yet; Task 5 adds it)
```

- [ ] **Step 5: Hand to the controller (do not run it yourself)**

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"
  cat $W/supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql
  grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/delivery_tax_invoice_test_a.sql
  echo "ROLLBACK;" ) > /tmp/dti_a_dry.sql
cd /Users/plfx/code/FacadeXPM/facadex-app && npx supabase db query --linked -f /tmp/dti_a_dry.sql
```
Expected: ERROR text containing `RESULT: delivery_tax_invoice_test_a ALL PASSED`. Not done until the controller reports it; on any other error fix and repeat.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql supabase/tests/delivery_tax_invoice_test_a.sql
git commit -m "feat(db): tax invoice mode per PO and supplier, receipt link table and guards (not applied)"
```

---

### Task 4: Migration 2026-10-09-05 — delivery check, receipt links in draft/post/void (+ SQL test B, verbatim proof, regressions)

**Files:**
- Create: `supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql`, `supabase/tests/delivery_tax_invoice_test_b.sql`
- Temporary (not committed): `/tmp/build_dti05.py`

**Interfaces:**
- Consumes: Task 3 objects; live `_sti_finite`, `_sti_tolerance`, `_sti_wac_after_*`, `_stock_receipt_reversal`, `_sti_touched_keys`, `_sti_negatives`, `_sti_stamp_other_bills`, `_sti_unstamp_other_bills`, `preview_supplier_tax_invoice`, `delete_supplier_tax_invoice_draft`, `record_stock_movement`, `receive_po_lines`, `split_payment`.
- Produces: client RPC `save_supplier_tax_invoice_receipt_draft(p_id UUID, p_header JSONB, p_items JSONB, p_receipt_ids UUID[]) RETURNS UUID` (codes `receipt_not_eligible`, `receipt_linked_elsewhere`); unchanged signatures of `save_supplier_tax_invoice_draft` (+ code `po_is_delivery_mode`), `post_supplier_tax_invoice(UUID, INT)`, `void_supplier_tax_invoice(UUID, TEXT)`, `preview_supplier_tax_invoice(UUID)`. For a receipt-linked invoice the preview adds keys `sum_incl`, `diff_excl`, `diff_incl`, `basis` and check codes from `DELIVERY_CHECK_TEXT`; every receipt check carries `po_id`, `receipt_id`, `receipt_no` (e.g. `PO-1-R2`).

**Review gate for this task (reviewer checks exactly this):** the five Step 5 diffs are empty and the marker count is 7; every new function is SECURITY DEFINER with `search_path = public` (except `delivery_tax_invoice_ready`, SECURITY INVOKER, no table access) and has the REVOKE/GRANT lines; lock order invoice -> POs -> balances -> expenses; test B covers B1-B18 and the controller reported test A, test B and all six regressions equal to baseline.

- [ ] **Step 1 (CONTROLLER ONLY, read-only MCP): prove the RPCs do not exist**

```sql
SELECT count(*) FROM pg_proc WHERE proname IN ('save_supplier_tax_invoice_receipt_draft', '_sti_check_delivery', '_sti_stamp_receipt_bills', 'delivery_tax_invoice_ready');
```
Expected (controller reports back): 0.

- [ ] **Step 2: Write the test** — `supabase/tests/delivery_tax_invoice_test_b.sql`:

```sql
-- ================================================================
-- Tests for 2026-10-09-05-delivery-tax-invoice-rpcs.sql. Part B of 2.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-04; 2026-10-09-05; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: delivery_tax_invoice_test_b ALL PASSED'. Anything else = failure.
-- One transaction: now() is constant, so posted_at equals the created_at of every later split (the >= filter keeps them).
-- Bills carry NON-NULL prior numbers ('DN-…') so a wrong restore is visible.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t2 UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID; site_t2 UUID; sup_t2 UUID; cat_t2 UUID;
  iI UUID; iJ UUID; iK UUID; iL UUID; iM UUID;
  email TEXT := '__test_dtib_owner__@example.com'; w_email TEXT := '__test_dtib_worker__@example.com';
  poD1 UUID; a1 UUID; a2 UUID; poD2 UUID; b1 UUID; poX UUID; x1 UUID; poP UUID; p1 UUID; poD3 UUID; k1 UUID; k2 UUID; poF UUID; f1 UUID; poT2 UUID;
  rc1 UUID; rc2 UUID; rc3 UUID; rcX UUID; rcP UUID; rcK1 UUID; rcK2 UUID; rcF UUID; rcT2 UUID;
  bill1 UUID; bill2 UUID; bill3 UUID; billP UUID; c3 UUID; g2 UUID; x_exp UUID; mv1 UUID;
  inv1 UUID; inv2 UUID; inv4 UUID; invM UUID; invP UUID; invF UUID; invK UUID; invL UUID;
  j JSONB; e JSONB; hdr JSONB; v_rev INT; v_msg TEXT; v_q NUMERIC; v_w NUMERIC;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtib__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant), (w_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__DTIB-1__', '__dtib site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name, default_tax_invoice_mode) VALUES (t_tenant, '__dtib cac__', 'delivery') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__dtib other__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__dtib cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib I__', 'kg') RETURNING id INTO iI;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib J__', 'kg') RETURNING id INTO iJ;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib K__', 'kg') RETURNING id INTO iK;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib L__', 'kg') RETURNING id INTO iL;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib M__', 'kg') RETURNING id INTO iM;
  -- tenant 2 owns one delivery receipt (cross-tenant probe)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtib t2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2, '__DTIB-T2__', '__dtib t2 site__') RETURNING id INTO site_t2;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2, '__dtib t2 sup__') RETURNING id INTO sup_t2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2, '__dtib t2 cat__') RETURNING id INTO cat_t2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode)
  VALUES (t2, 'PO-DTIB-T2', site_t2, sup_t2, cat_t2, v_bkk, 'ordered', 'delivery') RETURNING id INTO poT2;
  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, goods_subtotal, goods_vat) VALUES (t2, poT2, 1, v_bkk, 10, 0.7) RETURNING id INTO rcT2;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D1', t_site, t_sup, t_cat, v_bkk - 3, 'ordered', 'delivery') RETURNING id INTO poD1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD1, 'A1', 2, 300, 600, iI, 0) RETURNING id INTO a1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD1, 'A2', 4, 100, 400, iI, 1) RETURNING id INTO a2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D2', t_site, t_sup, t_cat, v_bkk - 3, 'ordered', 'delivery') RETURNING id INTO poD2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD2, 'B1', 5, 200, 1000, iJ, 0) RETURNING id INTO b1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-X', t_site, t_sup2, t_cat, v_bkk, 'ordered', 'delivery') RETURNING id INTO poX;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poX, 'X1', 1, 100, 100, 0) RETURNING id INTO x1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poP, 'P1', 1, 50, 50, iM, 0) RETURNING id INTO p1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D3', t_site, t_sup, t_cat, v_bkk, 'ordered', 'delivery') RETURNING id INTO poD3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD3, 'K1', 3, 100, 300, iK, 0) RETURNING id INTO k1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD3, 'L1', 1, 50, 50, iL, 1) RETURNING id INTO k2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode, stock_from_invoice) VALUES (t_tenant, 'PO-DTIB-F', t_site, t_sup, t_cat, v_bkk, 'ordered', 'delivery', true) RETURNING id INTO poF;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poF, 'F1', 1, 100, 100, iI, 0) RETURNING id INTO f1;

  j := receive_po_lines(poD1, ARRAY[a1], v_bkk - 2, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 2, 'unit_cost', 300)));
  rc1 := (j->>'receipt_id')::uuid; bill1 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poD2, ARRAY[b1], v_bkk - 1, '[]'::jsonb, 1000, 70, jsonb_build_array(jsonb_build_object('po_item_id', b1, 'base_qty', 5, 'unit_cost', 200)));
  rc3 := (j->>'receipt_id')::uuid; bill3 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poX, ARRAY[x1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); rcX := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poP, ARRAY[p1], v_bkk, '[]'::jsonb, 50, 3.5, jsonb_build_array(jsonb_build_object('po_item_id', p1, 'base_qty', 1, 'unit_cost', 50)));
  rcP := (j->>'receipt_id')::uuid; billP := (j->>'expense_id')::uuid;
  j := receive_po_lines(poD3, ARRAY[k1], v_bkk, '[]'::jsonb, 300, 21, jsonb_build_array(jsonb_build_object('po_item_id', k1, 'base_qty', 3, 'unit_cost', 100))); rcK1 := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poD3, ARRAY[k2], v_bkk, '[]'::jsonb, 50, 3.5, jsonb_build_array(jsonb_build_object('po_item_id', k2, 'base_qty', 1, 'unit_cost', 50))); rcK2 := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); rcF := (j->>'receipt_id')::uuid;

  RESET role;
  UPDATE expenses SET invoice_no = 'DN-1' WHERE id = bill1;
  UPDATE expenses SET invoice_no = 'DN-3' WHERE id = bill3;
  UPDATE expenses SET invoice_no = 'DN-P' WHERE id = billP;
  -- an unrelated bill of the same supplier carrying the future invoice number: must never be touched
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status, invoice_no)
  VALUES (t_tenant, v_bkk, '__dtib other__', t_site, t_cat, t_sup, 10, 0.7, 10.7, 'transfer', 'pending', 'DTIB-2') RETURNING id INTO x_exp;
  SET LOCAL role = 'authenticated';

  -- B1 a receipt draft links one lot of a two-lot PO
  hdr := jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-1', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42);
  inv1 := save_supplier_tax_invoice_receipt_draft(NULL, hdr,
    jsonb_build_array(jsonb_build_object('description', 'เหล็ก ล็อต 1', 'qty', 2.5, 'unit', 'kg', 'unit_price', 240, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 2.5)),
    ARRAY[rc1]);
  IF (SELECT count(*) FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND receipt_id = rc1 AND po_id = poD1 AND active) <> 1 THEN RAISE EXCEPTION 'B1 FAIL: link row'; END IF;
  -- B1b not eligible: other supplier, 'po' mode PO, other tenant; B1c the same receipt twice
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcX]); RAISE EXCEPTION 'B1b FAIL: other supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B1b FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcP]); RAISE EXCEPTION 'B1b FAIL: po-mode receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B1b FAIL: po got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcT2]); RAISE EXCEPTION 'B16 FAIL: other tenant receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B16 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-Y"'), '[]'::jsonb, ARRAY[rc1]); RAISE EXCEPTION 'B1c FAIL: linked twice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_linked_elsewhere%' THEN RAISE EXCEPTION 'B1c FAIL: got %', v_msg; END IF; END;

  -- B2 a delivery PO cannot be linked at PO level
  BEGIN PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-Z"'), '[]'::jsonb, ARRAY[poD2]); RAISE EXCEPTION 'B2 FAIL: delivery PO linked whole';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_is_delivery_mode%' THEN RAISE EXCEPTION 'B2 FAIL: got %', v_msg; END IF; END;

  -- B3 re-saving a receipt draft as a PO draft drops its receipt links; deleting a draft frees its links
  invM := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-M"'), '[]'::jsonb, ARRAY[rc3]);
  PERFORM save_supplier_tax_invoice_draft(invM, jsonb_set(hdr, '{invoice_no}', '"DTIB-M"'), '[]'::jsonb, ARRAY[poP]);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = invM) OR NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = invM AND po_id = poP) THEN
    RAISE EXCEPTION 'B3 FAIL: kind switch';
  END IF;
  PERFORM delete_supplier_tax_invoice_draft(invM);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = poP) THEN RAISE EXCEPTION 'B3 FAIL: links survived the delete'; END IF;

  -- B4 preview of lot 1: excl basis, stock add/remove per receipt
  j := preview_supplier_tax_invoice(inv1);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B4 FAIL: blocking %', j->'checks'; END IF;
  IF (j->>'po_sum')::numeric <> 600 OR j->>'basis' <> 'excl' OR (j->>'diff')::numeric <> 0 THEN RAISE EXCEPTION 'B4 FAIL: match %', j; END IF;
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iI::text;
  IF (e->>'before_qty')::numeric <> 2 OR (e->>'add_qty')::numeric <> 2.5 OR (e->>'remove_qty')::numeric <> 2 OR (e->>'after_qty')::numeric <> 2.5 THEN RAISE EXCEPTION 'B4 FAIL: row %', e; END IF;
  v_rev := (j->>'revision')::int;

  -- B5 post lot 1: only that receipt's stock and bill; PO status unchanged
  j := post_supplier_tax_invoice(inv1, v_rev);
  IF (j->>'lines_posted')::int <> 1 OR (j->>'receipts_reversed')::int <> 1 OR (j->>'expenses_stamped')::int <> 1 THEN RAISE EXCEPTION 'B5 FAIL: result %', j; END IF;
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 2.5 OR abs(v_w - 240) > 1e-9 THEN RAISE EXCEPTION 'B5 FAIL: I % @ %', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B5 FAIL: bill1 not stamped'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv1 AND expense_id = bill1 AND po_id = poD1 AND prev_invoice_no = 'DN-1' AND stamped_invoice_no = 'DTIB-1') THEN
    RAISE EXCEPTION 'B5 FAIL: stamp row';
  END IF;
  IF (SELECT status FROM purchase_orders WHERE id = poD1) <> 'partially_received' THEN RAISE EXCEPTION 'B5 FAIL: PO status changed by post'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND goods_subtotal = 600 AND goods_vat = 42) THEN RAISE EXCEPTION 'B5 FAIL: snapshot'; END IF;
  SELECT stock_movement_id INTO mv1 FROM po_receipt_items WHERE receipt_id = rc1;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1 AND source_movement_id = mv1 AND quantity = 2 AND unit_cost = 300) THEN RAISE EXCEPTION 'B5 FAIL: reversal row'; END IF;
  SET LOCAL role = 'authenticated';

  -- B6 lot 2 is received after lot 1's invoice posted; its bill is not stamped
  j := receive_po_lines(poD1, ARRAY[a2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', a2, 'base_qty', 4, 'unit_cost', 100)));
  rc2 := (j->>'receipt_id')::uuid; bill2 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'received' THEN RAISE EXCEPTION 'B6 FAIL: status %', j->>'status'; END IF;
  RESET role;
  UPDATE expenses SET invoice_no = 'DN-2' WHERE id = bill2;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_expense_stamps WHERE expense_id = bill2) THEN RAISE EXCEPTION 'B6 FAIL: bill2 stamped'; END IF;
  SET LOCAL role = 'authenticated';

  -- B7 two lots of two POs in one invoice, VAT-inclusive basis; bill3 split BEFORE the post, bill2 split AFTER
  j := split_payment(bill3, 100, v_bkk, 'transfer'); c3 := (j->>'remaining_expense_id')::uuid;
  inv2 := save_supplier_tax_invoice_receipt_draft(NULL,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-2', 'invoice_date', v_bkk, 'net_before_vat', 1390, 'vat', 108),
    jsonb_build_array(
      jsonb_build_object('description', 'เหล็ก ล็อต 2', 'qty', 4, 'unit', 'kg', 'unit_price', 97.5, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 4),
      jsonb_build_object('description', 'J', 'qty', 5, 'unit', 'kg', 'unit_price', 200, 'inventory_item_id', iJ, 'site_id', t_site, 'base_qty', 5)),
    ARRAY[rc2, rc3]);
  j := preview_supplier_tax_invoice(inv2);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B7 FAIL: blocking %', j->'checks'; END IF;
  IF j->>'basis' <> 'incl' OR (j->>'diff')::numeric <> 0 OR (j->>'diff_excl')::numeric <> -10 OR (j->>'sum_incl')::numeric <> 1498 THEN RAISE EXCEPTION 'B7 FAIL: match %', j; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_vat_inclusive' AND NOT (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B7 FAIL: no match_vat_inclusive'; END IF;
  j := post_supplier_tax_invoice(inv2, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 2 OR (j->>'expenses_stamped')::int <> 3 THEN RAISE EXCEPTION 'B7 FAIL: result %', j; END IF;
  j := split_payment(bill2, 100, v_bkk, 'transfer'); g2 := (j->>'remaining_expense_id')::uuid;
  RESET role;
  IF (SELECT count(*) FROM expenses WHERE id IN (bill2, bill3, c3, g2) AND invoice_no = 'DTIB-2') <> 4 THEN RAISE EXCEPTION 'B7 FAIL: not every part stamped'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) <> 'DTIB-2' OR (SELECT notes FROM expenses WHERE id = x_exp) IS NOT NULL THEN RAISE EXCEPTION 'B7 FAIL: unrelated expense touched'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B7 FAIL: other invoice bill touched'; END IF;
  IF (SELECT match_diff FROM supplier_tax_invoices WHERE id = inv2) <> 0 THEN RAISE EXCEPTION 'B7 FAIL: match_diff'; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6.5 OR abs(v_w - 990 / 6.5) > 1e-9 THEN RAISE EXCEPTION 'B7 FAIL: I % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iJ AND site_id = t_site;
  IF v_q <> 5 OR abs(v_w - 200) > 1e-9 THEN RAISE EXCEPTION 'B7 FAIL: J % @ %', v_q, v_w; END IF;
  SET LOCAL role = 'authenticated';

  -- B8 a receipt in a posted invoice cannot be linked again
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-8"'), '[]'::jsonb, ARRAY[rc1]); RAISE EXCEPTION 'B8 FAIL: relinked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_linked_elsewhere%' THEN RAISE EXCEPTION 'B8 FAIL: got %', v_msg; END IF; END;

  -- B9 void the 2-lot invoice: exact (nothing moved since), every part restored, the other invoice untouched
  j := void_supplier_tax_invoice(inv2, 'ทดสอบ');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'warnings') w WHERE w->>'code' IN ('void_inexact', 'expense_changed')) THEN RAISE EXCEPTION 'B9 FAIL: warnings %', j; END IF;
  RESET role;
  IF (SELECT invoice_no FROM expenses WHERE id = bill2) <> 'DN-2' OR (SELECT invoice_no FROM expenses WHERE id = g2) <> 'DN-2'
     OR (SELECT invoice_no FROM expenses WHERE id = bill3) <> 'DN-3' OR (SELECT invoice_no FROM expenses WHERE id = c3) <> 'DN-3' THEN
    RAISE EXCEPTION 'B9 FAIL: restore';
  END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B9 FAIL: other invoice restored'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) <> 'DTIB-2' OR (SELECT notes FROM expenses WHERE id = x_exp) IS NOT NULL THEN RAISE EXCEPTION 'B9 FAIL: unrelated expense touched'; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6.5 OR abs(v_w - 1000 / 6.5) > 1e-9 THEN RAISE EXCEPTION 'B9 FAIL: I % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iJ AND site_id = t_site;
  IF v_q <> 5 OR abs(v_w - 200) > 1e-9 THEN RAISE EXCEPTION 'B9 FAIL: J % @ %', v_q, v_w; END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv2 AND active) OR NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND active) THEN
    RAISE EXCEPTION 'B9 FAIL: links';
  END IF;
  SET LOCAL role = 'authenticated';

  -- B10 void lot 1's invoice after lot 2 moved the same item: inexact (by formulas), warned, bill restored exactly
  j := void_supplier_tax_invoice(inv1, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'warnings') w WHERE w->>'code' = 'void_inexact') THEN RAISE EXCEPTION 'B10 FAIL: expected void_inexact %', j; END IF;
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6 OR abs(v_w - 1000 / 6.0) > 1e-6 THEN RAISE EXCEPTION 'B10 FAIL: I % @ %', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DN-1' THEN RAISE EXCEPTION 'B10 FAIL: bill1'; END IF;
  SET LOCAL role = 'authenticated';

  -- B11 after the void the lot is free again and its original movement is reversed again
  inv4 := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-4"'),
    jsonb_build_array(jsonb_build_object('description', 'x', 'qty', 1, 'unit_price', 600)), ARRAY[rc1]);
  j := preview_supplier_tax_invoice(inv4);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B11 FAIL: blocking %', j->'checks'; END IF;
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iI::text;
  IF (e->>'remove_qty')::numeric <> 2 THEN RAISE EXCEPTION 'B11 FAIL: row %', e; END IF;
  PERFORM delete_supplier_tax_invoice_draft(inv4);

  -- B12 'po' mode is unchanged (short; the full regression runs separately)
  invP := save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-P', 'invoice_date', v_bkk, 'net_before_vat', 50, 'vat', 3.5),
    jsonb_build_array(jsonb_build_object('description', 'M', 'qty', 1, 'unit', 'kg', 'unit_price', 50, 'inventory_item_id', iM, 'site_id', t_site, 'base_qty', 1)), ARRAY[poP]);
  j := preview_supplier_tax_invoice(invP);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) OR j ? 'basis' THEN RAISE EXCEPTION 'B12 FAIL: preview %', j; END IF;
  j := post_supplier_tax_invoice(invP, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 1 OR (j->>'expenses_stamped')::int <> 1 THEN RAISE EXCEPTION 'B12 FAIL: post %', j; END IF;
  RESET role; IF (SELECT invoice_no FROM expenses WHERE id = billP) <> 'DTIB-P' THEN RAISE EXCEPTION 'B12 FAIL: stamp'; END IF; SET LOCAL role = 'authenticated';
  PERFORM void_supplier_tax_invoice(invP, 'ทดสอบ');
  RESET role; IF (SELECT invoice_no FROM expenses WHERE id = billP) <> 'DN-P' THEN RAISE EXCEPTION 'B12 FAIL: restore'; END IF; SET LOCAL role = 'authenticated';

  -- B13 a lot of a "stock from invoice" PO: nothing to reverse, the invoice adds stock
  invF := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-F', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'I', 'qty', 1, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 1)), ARRAY[rcF]);
  j := preview_supplier_tax_invoice(invF);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'receipt_stock_from_invoice' AND NOT (c->>'blocking')::boolean AND c->>'receipt_id' = rcF::text) THEN
    RAISE EXCEPTION 'B13 FAIL: checks %', j->'checks';
  END IF;
  j := post_supplier_tax_invoice(invF, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 0 OR (j->>'lines_posted')::int <> 1 THEN RAISE EXCEPTION 'B13 FAIL: %', j; END IF;

  -- B14 reversal to exactly 0 (WAC kept) and below 0 (allowed, reported)
  PERFORM record_stock_movement(iK, t_site, 'sale_out', 2, 100, 'invoice', NULL, NULL);
  PERFORM record_stock_movement(iL, t_site, 'sale_out', 1, 50, 'invoice', NULL, NULL);
  invK := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-K', 'invoice_date', v_bkk, 'net_before_vat', 200, 'vat', 14, 'match_note', 'ส่งไม่ครบ 1 ชิ้น'),
    jsonb_build_array(jsonb_build_object('description', 'K', 'qty', 2, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', iK, 'site_id', t_site, 'base_qty', 2)), ARRAY[rcK1]);
  j := preview_supplier_tax_invoice(invK);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_outside_tolerance') THEN RAISE EXCEPTION 'B14 FAIL: K checks %', j->'checks'; END IF;
  j := post_supplier_tax_invoice(invK, (j->>'revision')::int);
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iK AND site_id = t_site;
  IF v_q <> 0 OR abs(v_w - 100) > 1e-9 THEN RAISE EXCEPTION 'B14 FAIL: K % @ %', v_q, v_w; END IF;
  SET LOCAL role = 'authenticated';
  invL := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-L', 'invoice_date', v_bkk, 'net_before_vat', 50, 'vat', 3.5),
    jsonb_build_array(jsonb_build_object('description', 'ค่าขนส่ง', 'qty', 1, 'unit_price', 50)), ARRAY[rcK2]);
  j := preview_supplier_tax_invoice(invL);
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iL::text;
  IF (e->>'after_qty')::numeric <> -1 OR NOT (e->>'negative')::boolean THEN RAISE EXCEPTION 'B14 FAIL: L preview %', e; END IF;
  j := post_supplier_tax_invoice(invL, (j->>'revision')::int);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'negative') n WHERE n->>'inventory_item_id' = iL::text AND (n->>'qty')::numeric = -1) THEN RAISE EXCEPTION 'B14 FAIL: negative not reported %', j; END IF;

  -- B15 role gate
  PERFORM set_config('request.jwt.claims', json_build_object('email', w_email, 'role', 'authenticated')::text, true);
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, hdr, '[]'::jsonb, '{}'::uuid[]); RAISE EXCEPTION 'B15 FAIL: worker allowed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B15 FAIL: got %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- B17 grants and search_path
  RESET role;
  IF has_function_privilege('anon', 'save_supplier_tax_invoice_receipt_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'save_supplier_tax_invoice_receipt_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'void_supplier_tax_invoice(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'save_supplier_tax_invoice_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check_po(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check_delivery(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements_po(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements_delivery(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_stamp_receipt_bills(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B17 FAIL: function privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('_sti_check', '_sti_check_po', '_sti_check_delivery', '_sti_receipt_movements', '_sti_receipt_movements_po',
               '_sti_receipt_movements_delivery', '_sti_stamp_receipt_bills', 'save_supplier_tax_invoice_receipt_draft', 'save_supplier_tax_invoice_draft',
               'post_supplier_tax_invoice', 'void_supplier_tax_invoice')
             AND (NOT prosecdef OR proconfig IS NULL OR NOT ('search_path=public' = ANY (proconfig)))) THEN
    RAISE EXCEPTION 'B17 FAIL: definer / search_path';
  END IF;

  RAISE EXCEPTION 'RESULT: delivery_tax_invoice_test_b ALL PASSED';
END $$;
ROLLBACK;
```

- [ ] **Step 3: Write the hand-written part of the migration** — `supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql`. The line `-- @@VERBATIM_COPIES@@` is replaced by the builder in Step 4 (it must appear exactly once):

```sql
-- ============================================================
-- Supplier tax invoice per delivery: RPCs (migration 05 of 2026-10-09). Requires 2026-10-09-04.
-- Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md · Plan: 2026-10-08-per-delivery-tax-invoice-plan.md (Task 4)
-- 'po' mode is unchanged: _sti_check / _sti_receipt_movements bodies move VERBATIM to _sti_check_po / _sti_receipt_movements_po
-- (the old names become dispatchers by link kind); save_supplier_tax_invoice_draft (2026-10-08-02) and post / void
-- (2026-10-09-03, their latest definitions) are re-created verbatim plus marked lines. The verbatim section is generated
-- by the plan's builder script and proved by diff. Same signatures and grants: the deployed client is unaffected.
-- Lock order unchanged: invoice -> PO rows by id -> balances by (item, site) -> expenses by id.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- @@VERBATIM_COPIES@@

-- ── delivery check (mirrored by evaluateDeliveryMatch in src/lib/deliveryTaxInvoice.js) ──
-- Same header checks, line checks and output keys as _sti_check_po, plus sum_incl / diff_excl / diff_incl / basis.
-- Match: invoice net vs Σ goods_subtotal; else invoice total vs Σ(goods_subtotal + goods_vat) (supplier documents mix both bases).
CREATE OR REPLACE FUNCTION _sti_check_delivery(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv supplier_tax_invoices%ROWTYPE;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  c JSONB := '[]'::jsonb;
  rc RECORD; v_no TEXT; v_ref JSONB;
  v_sum NUMERIC := 0; v_vat NUMERIC := 0; v_sumi NUMERIC; v_lines NUMERIC; v_dex NUMERIC; v_din NUMERIC; v_n INT := 0;
  v_basis TEXT; v_diff NUMERIC; v_tol NUMERIC;
BEGIN
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('checks', jsonb_build_array(jsonb_build_object('code', 'invoice_not_found', 'blocking', true)));
  END IF;
  IF inv.status <> 'draft' THEN c := c || jsonb_build_object('code', 'not_draft', 'blocking', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_items', 'blocking', true);
  END IF;
  IF inv.invoice_date > v_today THEN c := c || jsonb_build_object('code', 'invoice_date_in_future', 'blocking', true); END IF;

  FOR rc IN
    SELECT l.receipt_id AS link_rc, r.id, r.seq, r.received_date, r.goods_subtotal, r.goods_vat, r.expense_id,
           po.id AS po_id, po.po_number, po.supplier_id, po.tax_invoice_mode, po.stock_from_invoice
      FROM supplier_tax_invoice_receipts l
      LEFT JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
      LEFT JOIN purchase_orders po ON po.id = r.po_id AND po.tenant_id = p_tenant
     WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
     ORDER BY l.receipt_id
  LOOP
    IF rc.id IS NULL OR rc.po_id IS NULL THEN
      c := c || jsonb_build_object('code', 'receipt_not_found', 'blocking', true, 'receipt_id', rc.link_rc);
      CONTINUE;
    END IF;
    v_n := v_n + 1;
    v_no := rc.po_number || '-R' || rc.seq;
    v_ref := jsonb_build_object('po_id', rc.po_id, 'receipt_id', rc.id, 'receipt_no', v_no);
    IF rc.supplier_id IS DISTINCT FROM inv.supplier_id THEN c := c || (jsonb_build_object('code', 'receipt_wrong_supplier', 'blocking', true) || v_ref); END IF;
    IF rc.tax_invoice_mode IS DISTINCT FROM 'delivery' THEN c := c || (jsonb_build_object('code', 'receipt_po_not_delivery', 'blocking', true) || v_ref); END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts o WHERE o.receipt_id = rc.id AND o.active AND o.invoice_id <> p_id) THEN
      c := c || (jsonb_build_object('code', 'receipt_linked_elsewhere', 'blocking', true) || v_ref);
    END IF;
    -- defence in depth (normally unreachable: a posted invoice keeps its receipt link active)
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals v JOIN supplier_tax_invoices i ON i.id = v.invoice_id
                 JOIN po_receipt_items pri ON pri.stock_movement_id = v.source_movement_id
                WHERE pri.receipt_id = rc.id AND i.status = 'posted' AND i.id <> p_id) THEN
      c := c || (jsonb_build_object('code', 'receipt_already_reversed', 'blocking', true) || v_ref);
    END IF;
    -- warnings (never block)
    IF EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.po_id = rc.po_id AND cn.tenant_id = p_tenant AND cn.status = 'confirmed') THEN
      c := c || (jsonb_build_object('code', 'po_has_credit_note', 'blocking', false) || v_ref);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM po_receipt_items i WHERE i.receipt_id = rc.id AND i.tenant_id = p_tenant AND i.stock_movement_id IS NOT NULL) THEN
      c := c || (jsonb_build_object('code', CASE WHEN rc.stock_from_invoice THEN 'receipt_stock_from_invoice' ELSE 'receipt_no_stock_movements' END, 'blocking', false) || v_ref);
    END IF;
    IF date_trunc('month', rc.received_date) <> date_trunc('month', inv.invoice_date) THEN
      c := c || (jsonb_build_object('code', 'receipt_outside_month', 'blocking', false) || v_ref);
    END IF;
    IF EXISTS (SELECT 1 FROM po_deposit_applications a WHERE a.receipt_id = rc.id AND a.tenant_id = p_tenant) THEN
      c := c || (jsonb_build_object('code', 'receipt_has_deposit', 'blocking', false) || v_ref);
    END IF;
    IF rc.expense_id IS NULL THEN c := c || (jsonb_build_object('code', 'receipt_no_expense', 'blocking', false) || v_ref); END IF;
    v_sum := v_sum + COALESCE(rc.goods_subtotal, 0);
    v_vat := v_vat + COALESCE(rc.goods_vat, 0);
  END LOOP;

  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_items i
              WHERE i.invoice_id = p_id AND i.inventory_item_id IS NOT NULL
                AND (NOT EXISTS (SELECT 1 FROM inventory_items x WHERE x.id = i.inventory_item_id AND x.tenant_id = p_tenant)
                     OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = i.site_id AND s.tenant_id = p_tenant))) THEN
    c := c || jsonb_build_object('code', 'stock_line_invalid', 'blocking', true);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_lines FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant;
  IF NOT (_sti_finite(v_sum) AND _sti_finite(v_vat))
     OR EXISTS (SELECT 1 FROM _sti_receipt_movements(p_id, p_tenant) r WHERE NOT (_sti_finite(r.quantity) AND _sti_finite(r.unit_cost))) THEN
    c := c || jsonb_build_object('code', 'po_data_not_finite', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  IF NOT (_sti_finite(v_lines) AND _sti_finite(inv.net_before_vat) AND _sti_finite(inv.grand_total)) THEN
    c := c || jsonb_build_object('code', 'bad_header', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  IF abs(v_lines - inv.net_before_vat) > _sti_tolerance(inv.net_before_vat) + 0.005 THEN
    c := c || jsonb_build_object('code', 'lines_total_mismatch', 'blocking', true, 'detail', round(v_lines, 2)::text);
  END IF;

  v_sumi := round(v_sum + v_vat, 2);
  v_sum := round(v_sum, 2);
  v_dex := round(inv.net_before_vat - v_sum, 2);
  v_din := round(inv.grand_total - v_sumi, 2);
  IF abs(v_dex) <= _sti_tolerance(v_sum) + 0.005 THEN
    v_basis := 'excl'; v_diff := v_dex; v_tol := _sti_tolerance(v_sum);
  ELSIF abs(v_din) <= _sti_tolerance(v_sumi) + 0.005 THEN
    v_basis := 'incl'; v_diff := v_din; v_tol := _sti_tolerance(v_sumi);
    c := c || jsonb_build_object('code', 'match_vat_inclusive', 'blocking', false, 'detail', v_din::text);
  ELSE
    v_basis := 'none'; v_diff := v_dex; v_tol := _sti_tolerance(v_sum);
    IF v_n > 0 THEN
      IF COALESCE(btrim(inv.match_note), '') = '' THEN
        c := c || jsonb_build_object('code', 'match_note_required', 'blocking', true, 'detail', v_dex::text);
      ELSE
        c := c || jsonb_build_object('code', 'match_outside_tolerance', 'blocking', false, 'detail', v_dex::text);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('checks', c, 'po_sum', v_sum, 'diff', v_diff, 'tolerance', v_tol, 'lines_sum', round(v_lines, 2),
                            'sum_incl', v_sumi, 'diff_excl', v_dex, 'diff_incl', v_din, 'basis', v_basis);
END $$;

-- ── dispatcher: an invoice with receipt links is checked by _sti_check_delivery, every other invoice exactly as before ──
CREATE OR REPLACE FUNCTION _sti_check(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB; v_r BOOLEAN; v_p BOOLEAN;
BEGIN
  v_r := EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = p_tenant);
  v_p := EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = p_id AND tenant_id = p_tenant);
  IF v_r THEN v := _sti_check_delivery(p_id, p_tenant); ELSE v := _sti_check_po(p_id, p_tenant); END IF;
  -- defence in depth (sti_link_kind_guard prevents it): mixed links block first
  IF v_r AND v_p THEN
    v := jsonb_set(v, '{checks}', jsonb_build_array(jsonb_build_object('code', 'invoice_mixed_links', 'blocking', true)) || (v->'checks'));
  END IF;
  RETURN v;
END $$;

-- ── the linked receipts' real stock movements (po_receipt_items.stock_movement_id), in reversal order ──
-- po_number carries the receipt number (PO-R<n>) so post's reversal note names the lot.
CREATE OR REPLACE FUNCTION _sti_receipt_movements_delivery(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.po_id, (p.po_number || '-R' || r.seq)::text, m.id, m.inventory_item_id, m.site_id, m.quantity, COALESCE(m.unit_cost, 0)
    FROM supplier_tax_invoice_receipts l
    JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
    JOIN purchase_orders p ON p.id = r.po_id AND p.tenant_id = p_tenant
    JOIN po_receipt_items i ON i.receipt_id = r.id AND i.tenant_id = p_tenant AND i.stock_movement_id IS NOT NULL
    JOIN stock_movements m ON m.id = i.stock_movement_id AND m.tenant_id = p_tenant AND m.movement_type = 'purchase_in'
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
   ORDER BY p.id, m.created_at, m.id
$$;

CREATE OR REPLACE FUNCTION _sti_receipt_movements(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts x WHERE x.invoice_id = p_id AND x.tenant_id = p_tenant) THEN
    RETURN QUERY SELECT * FROM _sti_receipt_movements_delivery(p_id, p_tenant);
  ELSE
    RETURN QUERY SELECT * FROM _sti_receipt_movements_po(p_id, p_tenant);
  END IF;
END $$;

-- ── receipt draft: header + items through the PO-mode save (same validation; it also clears this draft's links), then receipts ──
CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_receipt_draft(p_id UUID, p_header JSONB, p_items JSONB, p_receipt_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_id UUID; v_sup UUID; v_rc UUID; rec RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  -- a delivery draft always has at least one lot (an empty one would reopen as a PO draft)
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p_receipt_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL) THEN RAISE EXCEPTION 'no_receipts'; END IF;
  v_id := save_supplier_tax_invoice_draft(p_id, p_header, p_items, '{}'::uuid[]);
  SELECT supplier_id INTO v_sup FROM supplier_tax_invoices WHERE id = v_id AND tenant_id = v_tenant;
  FOR v_rc IN SELECT DISTINCT u FROM unnest(COALESCE(p_receipt_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL ORDER BY u LOOP
    SELECT r.id, r.po_id, po.supplier_id, po.tax_invoice_mode INTO rec
      FROM po_receipts r JOIN purchase_orders po ON po.id = r.po_id AND po.tenant_id = v_tenant
     WHERE r.id = v_rc AND r.tenant_id = v_tenant;
    IF NOT FOUND OR rec.supplier_id IS DISTINCT FROM v_sup OR rec.tax_invoice_mode IS DISTINCT FROM 'delivery' THEN RAISE EXCEPTION 'receipt_not_eligible'; END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE receipt_id = v_rc AND active AND invoice_id <> v_id) THEN
      RAISE EXCEPTION 'receipt_linked_elsewhere';
    END IF;
    BEGIN
      INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (v_tenant, v_id, v_rc, rec.po_id);
    EXCEPTION WHEN unique_violation THEN
      -- two drafts saving the same lot at once: the loser gets the same code as the pre-check above
      RAISE EXCEPTION 'receipt_linked_elsewhere';
    END;
  END LOOP;
  RETURN v_id;
END $$;

-- Web readiness probe: exists only once this migration is live (the web keys every new choice on it, not on 04's table).
CREATE OR REPLACE FUNCTION delivery_tax_invoice_ready() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$ SELECT true $$;

-- ── post step (c) for receipts: snapshot the matched values, stamp each linked receipt's bill and its split parts ──
-- Only that receipt's bill tree (expense_splits) still carrying the PO; deposit and credit-note rows are never bills.
-- Rows go to supplier_tax_invoice_expense_stamps, so _sti_unstamp_other_bills (void) restores them unchanged,
-- including parts split off AFTER the post. Expenses are locked in id order (after the balances).
CREATE OR REPLACE FUNCTION _sti_stamp_receipt_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_n INT := 0;
BEGIN
  UPDATE supplier_tax_invoice_receipts l
     SET goods_subtotal = r.goods_subtotal, goods_vat = r.goods_vat
    FROM po_receipts r
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant AND r.id = l.receipt_id AND r.tenant_id = p_tenant;
  FOR k IN
    WITH RECURSIVE tree AS (
      SELECT r.expense_id, r.po_id
        FROM supplier_tax_invoice_receipts l JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
       WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant AND r.expense_id IS NOT NULL
      UNION
      SELECT s.new_expense_id, t.po_id
        FROM expense_splits s JOIN tree t ON s.source_expense_id = t.expense_id
       WHERE s.tenant_id = p_tenant)
    SELECT e.id, e.invoice_no, t.po_id
      FROM tree t JOIN expenses e ON e.id = t.expense_id AND e.tenant_id = p_tenant AND e.po_id = t.po_id
     WHERE NOT EXISTS (SELECT 1 FROM supplier_deposits sd WHERE sd.expense_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.expense_id = e.id)
     ORDER BY e.id
     FOR UPDATE OF e
  LOOP
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

REVOKE ALL ON FUNCTION _sti_check_po(UUID, UUID), _sti_check_delivery(UUID, UUID), _sti_check(UUID, UUID),
  _sti_receipt_movements_po(UUID, UUID), _sti_receipt_movements_delivery(UUID, UUID), _sti_receipt_movements(UUID, UUID),
  _sti_stamp_receipt_bills(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), save_supplier_tax_invoice_receipt_draft(UUID, JSONB, JSONB, UUID[]),
  post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), save_supplier_tax_invoice_receipt_draft(UUID, JSONB, JSONB, UUID[]),
  post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION delivery_tax_invoice_ready() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delivery_tax_invoice_ready() TO authenticated;
```

Add to test B, right before `-- B15 role gate` (and add `B18`/`B19` to the review gate list):

```sql
  -- B18 a delivery draft needs at least one lot (client also refuses it)
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-E"'), '[]'::jsonb, '{}'::uuid[]); RAISE EXCEPTION 'B18 FAIL: empty accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'no_receipts%' THEN RAISE EXCEPTION 'B18 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-E"'), '[]'::jsonb, ARRAY[NULL::uuid]); RAISE EXCEPTION 'B18 FAIL: null-only accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'no_receipts%' THEN RAISE EXCEPTION 'B18 FAIL: null got %', v_msg; END IF; END;
  -- B19 readiness probe callable by clients
  IF delivery_tax_invoice_ready() IS DISTINCT FROM true THEN RAISE EXCEPTION 'B19 FAIL: probe'; END IF;
```
and add to the B17 privilege check: `OR has_function_privilege('anon', 'delivery_tax_invoice_ready()', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'delivery_tax_invoice_ready()', 'EXECUTE')`. The `unique_violation` catch cannot be raced inside one session (the pre-check always fires first); it is pinned by code review plus the JS 23505 mapping test of Task 5.

- [ ] **Step 4: Generate the verbatim section with the builder (never hand-copy)**

Create `/tmp/build_dti05.py` (not committed) and run it from the worktree root with `python3 /tmp/build_dti05.py`:

```python
MIG = 'supabase/migrations/'
SRC2 = open(MIG + '2026-10-08-02-supplier-tax-invoice-rpcs.sql').read().split('\n')
SRC3 = open(MIG + '2026-10-09-03-tax-invoice-multi-bill.sql').read().split('\n')
TAG = '   -- 2026-10-09-05'

def cut(src, a, b, head):
    block = src[a - 1:b]
    assert block[0].startswith(head), block[0]
    assert block[-1] in ('END $$;', '$$;'), block[-1]
    return block

def after(block, anchor, new):
    hits = [i for i, l in enumerate(block) if l == anchor]
    assert len(hits) == 1, (anchor, len(hits))
    i = hits[0]
    return block[:i + 1] + [new + TAG] + block[i + 1:]

chk = cut(SRC2, 45, 147, 'CREATE OR REPLACE FUNCTION _sti_check(')
chk[0] = chk[0].replace('FUNCTION _sti_check(', 'FUNCTION _sti_check_po(', 1)
chk = after(chk, "    IF p.status <> 'received' THEN c := c || jsonb_build_object('code', 'po_not_received', 'blocking', true, 'po_id', p.id); END IF;",
            "    IF EXISTS (SELECT 1 FROM purchase_orders x WHERE x.id = p.id AND x.tax_invoice_mode = 'delivery') THEN c := c || jsonb_build_object('code', 'po_is_delivery_mode', 'blocking', true, 'po_id', p.id); END IF;")

mv = cut(SRC2, 20, 30, 'CREATE OR REPLACE FUNCTION _sti_receipt_movements(')
mv[0] = mv[0].replace('FUNCTION _sti_receipt_movements(', 'FUNCTION _sti_receipt_movements_po(', 1)

sv = cut(SRC2, 150, 233, 'CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_draft(')
sv = after(sv, '    DELETE FROM supplier_tax_invoice_pos WHERE invoice_id = v_id;',
           '    DELETE FROM supplier_tax_invoice_receipts WHERE invoice_id = v_id;')
sv = after(sv, "    IF NOT FOUND OR v_psup IS DISTINCT FROM v_sup OR v_pstatus <> 'received' THEN RAISE EXCEPTION 'po_not_eligible'; END IF;",
           "    IF EXISTS (SELECT 1 FROM purchase_orders WHERE id = v_po AND tenant_id = v_tenant AND tax_invoice_mode = 'delivery') THEN RAISE EXCEPTION 'po_is_delivery_mode'; END IF;")

LOCK = '  PERFORM 1 FROM purchase_orders WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = v_tenant) ORDER BY id FOR UPDATE;'
po = cut(SRC3, 103, 228, 'CREATE OR REPLACE FUNCTION post_supplier_tax_invoice(')
po = after(po, '   ORDER BY id FOR UPDATE;', LOCK)
po = after(po, '  v_stamped := v_stamped + _sti_stamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03',
           '  v_stamped := v_stamped + _sti_stamp_receipt_bills(p_id, v_tenant, inv.invoice_no);')
vo = cut(SRC3, 231, 317, 'CREATE OR REPLACE FUNCTION void_supplier_tax_invoice(')
vo = after(vo, '   ORDER BY id FOR UPDATE;', LOCK)
vo = after(vo, '  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;',
           '  UPDATE supplier_tax_invoice_receipts SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;')

out = []
for title, blk in [('_sti_check_po: verbatim body of _sti_check (2026-10-08-02 lines 45-147) + 1 marked line', chk),
                   ('_sti_receipt_movements_po: verbatim body of _sti_receipt_movements (2026-10-08-02 lines 20-30)', mv),
                   ('save_supplier_tax_invoice_draft: verbatim (2026-10-08-02 lines 150-233) + 2 marked lines', sv),
                   ('post_supplier_tax_invoice: verbatim (2026-10-09-03 lines 103-228) + 2 marked lines', po),
                   ('void_supplier_tax_invoice: verbatim (2026-10-09-03 lines 231-317) + 2 marked lines', vo)]:
    out += ['', '-- ── ' + title + ' ──'] + blk
F = MIG + '2026-10-09-05-delivery-tax-invoice-rpcs.sql'
txt = open(F).read()
PH = '-- @@VERBATIM_COPIES@@'
assert txt.count(PH) == 1
open(F, 'w').write(txt.replace(PH, '\n'.join(out).strip('\n')))
print('ok')
```
Expected output: `ok`. Any AssertionError means an anchor/line range moved: stop and report (do not edit around it).

- [ ] **Step 5: Prove the copies (must print nothing except the count `7`)**

```bash
F=supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql
O2=supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql
O3=supabase/migrations/2026-10-09-03-tax-invoice-multi-bill.sql
diff <(sed -n '46,147p' $O2) <(awk '/^CREATE OR REPLACE FUNCTION _sti_check_po\(/,/^END \$\$;/' $F | sed 1d | grep -v -- '-- 2026-10-09-05')
diff <(sed -n '21,30p' $O2) <(awk '/^CREATE OR REPLACE FUNCTION _sti_receipt_movements_po\(/,/^\$\$;/' $F | sed 1d)
diff <(sed -n '150,233p' $O2) <(awk '/^CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_draft\(/,/^END \$\$;/' $F | grep -v -- '-- 2026-10-09-05')
diff <(sed -n '103,228p' $O3) <(awk '/^CREATE OR REPLACE FUNCTION post_supplier_tax_invoice\(/,/^END \$\$;/' $F | grep -v -- '-- 2026-10-09-05')
diff <(sed -n '231,317p' $O3) <(awk '/^CREATE OR REPLACE FUNCTION void_supplier_tax_invoice\(/,/^END \$\$;/' $F | grep -v -- '-- 2026-10-09-05')
grep -c -- '-- 2026-10-09-05' $F
grep -c "@@VERBATIM_COPIES@@" $F
```
Expected: five empty diffs, then `7`, then `0`. Also `grep -c "SECURITY DEFINER SET search_path = public" $F` = 11 and `grep -c "SECURITY INVOKER" $F` = 1.

- [ ] **Step 6: Hand to the controller (do not run yourself)**

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
dry () {  # $1 = test file, $2 = output file
  ( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"
    cat $W/supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql
    cat $W/supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql
    grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/$1
    echo "ROLLBACK;" ) > $2
}
dry delivery_tax_invoice_test_b.sql /tmp/dti_b_dry.sql
cd /Users/plfx/code/FacadeXPM/facadex-app && npx supabase db query --linked -f /tmp/dti_b_dry.sql
```
Expected: `RESULT: delivery_tax_invoice_test_b ALL PASSED`. Then the same `dry` for `delivery_tax_invoice_test_a.sql` (A must still pass with 05 added) and for each regression test: `supplier_tax_invoice_test.sql` -> `RESULT: supplier_tax_invoice_test ALL PASSED`; `tax_invoice_multi_bill_test.sql` -> `RESULT: tax_invoice_multi_bill_test ALL PASSED`; `po_receipt_test_a.sql` / `po_receipt_test_b.sql` -> their RESULT lines; `po_deposit_test.sql` and `supplier_credit_notes_test.sql` -> no error (they end without a RESULT marker). Each regression result must equal its baseline (Global Constraints). Not done until the controller reports every result.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql supabase/tests/delivery_tax_invoice_test_b.sql
git commit -m "feat(db): per-delivery tax invoice check, receipt draft, receipt stock reversal and bill stamping (not applied)"
```

---

### Task 5: Hooks, RPC wrapper, error maps and code-coverage tests

**Files:**
- Modify: `src/hooks/useSupabase.js`, `src/lib/supplierTaxInvoice.js`, `src/lib/poReceiptErrors.js`
- Test: `src/lib/supplierTaxInvoiceCodes.test.js`, `src/lib/poReceiptErrors.test.js`, `src/lib/taxInvoiceLinks.test.js`, `src/hooks/poFailSoft.test.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces (hooks): `useDeliveryTaxInvoiceReady() -> true|false|null`; `useDeliveryReceipts() -> { data: {ready, rows}|null, loading, error, refetch }`; `fetchDeliveryReceipts()`; `useActiveReceiptTaxInvoiceLinks() -> { data: {ready, map}|null, ... }`; `fetchActiveReceiptLinks()`; `saveSupplierTaxInvoiceReceiptDraft(id, header, items, receiptIds)`; `useSupplierTaxInvoices` / `useSupplierTaxInvoice` rows gain `supplier_tax_invoice_receipts` (absent before the migration).

- [ ] **Step 1: Write the failing tests**

`src/lib/supplierTaxInvoiceCodes.test.js`: after `const sql2 = ...` add
```js
const sql4 = read('2026-10-09-04-delivery-tax-invoice.sql')
const sql5 = read('2026-10-09-05-delivery-tax-invoice-rpcs.sql')
```
change `raised` to read `(sql1 + sql2 + sql4 + sql5)`, add after the `for (const m of checkBody.matchAll...)` line:
```js
for (const m of sql5.matchAll(/'code', (?:CASE WHEN [^']*?THEN )?'([a-z_]+)'/g)) checkCodes.add(m[1])
for (const m of sql5.matchAll(/ELSE '([a-z_]+)' END/g)) checkCodes.add(m[1])
```
and change `reported` to read `(sql2 + sql5)`. Add:
```js
  it('delivery codes are covered', () => {
    for (const c of ['receipt_wrong_supplier', 'match_vat_inclusive', 'po_is_delivery_mode', 'invoice_mixed_links', 'receipt_no_stock_movements']) expect(checkCodes.has(c), c).toBe(true)
    for (const c of ['po_mode_locked', 'receipt_not_eligible', 'no_receipts']) expect(raised.has(c), c).toBe(true)
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "stirc_receipt_active_uq"' })).toBe(CHECK_TEXT.receipt_linked_elsewhere)
  })
```

`src/lib/poReceiptErrors.test.js`: in the "every RAISE EXCEPTION literal" describe, change the file list to `['2026-10-09-01-po-receipts.sql', '2026-10-09-02-po-receipt-rpcs.sql', '2026-10-09-04-delivery-tax-invoice.sql']`, and add:
```js
describe('PO page texts for the mode guards', () => {
  it('mode locked / legacy receive refused', () => {
    expect(mapPoReceiptRpcError({ message: 'po_mode_locked' })).toMatch(/เปลี่ยนวิธีออกใบกำกับภาษีไม่ได้/)
    expect(mapPoReceiptRpcError({ message: 'po_delivery_needs_receipt' })).toMatch(/ทีละล็อต/)
    // the PO form save path (handleSave -> mapPoReceiptRpcError) shows Thai for every code 04 can raise
    for (const c of ['po_mode_locked', 'po_delivery_needs_receipt', 'invoice_mixed_links']) expect(mapPoReceiptRpcError({ message: c })).not.toBe(c)
  })
})
```

`src/lib/taxInvoiceLinks.test.js`: in "RPC argument builders" add
```js
  it('saveReceipts matches 2026-10-09-05', () => {
    const sql5 = readFileSync(new URL('../../supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql', import.meta.url), 'utf8')
    const m = sql5.match(/FUNCTION save_supplier_tax_invoice_receipt_draft\(([^)]*)\)/)
    expect(m).toBeTruthy()
    expect(Object.keys(saveReceiptDraftArgs(null, {}, [], [])).sort()).toEqual(m[1].split(',').map(a => a.trim().split(/\s+/)[0]).sort())
  })
```
and in "hooks file wiring" add
```js
  it('receipt-link embeds name constraints that exist in 2026-10-09-04; the receipt wrapper calls its own RPC', () => {
    const mig4 = readFileSync(new URL('../../supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql', import.meta.url), 'utf8')
    for (const c of ['stirc_invoice_fk', 'stirc_receipt_fk']) { expect(mig4).toContain(`CONSTRAINT ${c} FOREIGN KEY`); expect(hooks).toContain(`!${c}(`) }
    for (const c of ['po_receipts_po_fk', 'po_receipt_items_receipt_fk', 'po_receipt_items_item_fk']) expect(hooks).toContain(`!${c}`)
    const line = hooks.split('\n').find(l => l.startsWith('export const saveSupplierTaxInvoiceReceiptDraft ='))
    expect(line).toContain('TAX_INVOICE_RPCS.saveReceipts,')
  })
```

`src/lib/receiveDeposits.test.js` (the old-receive error map, used by `mapReceiveRpcError`; a new bundle that still hits the legacy path gets Thai text):
```js
it('legacy receive refused for a delivery PO has Thai text', () => {
  expect(mapReceiveRpcError({ message: 'po_delivery_needs_receipt' })).toMatch(/ทีละล็อต/)
})
```
(import `mapReceiveRpcError` from wherever `PurchaseOrders.jsx` imports it — read the import first; if it lives in `receiveDeposits.js`, add `po_delivery_needs_receipt: DELIVERY_RPC_TEXT.po_delivery_needs_receipt` to that module's `RPC_ERROR_TEXT` in Step 3, importing the leaf `deliveryTaxInvoiceText.js`.)

`src/hooks/poFailSoft.test.js`: follow the file's existing mocking pattern for `supabase` (read the top of the file first) and add tests: when `supabase.rpc('delivery_tax_invoice_ready')` errors (`PGRST202`), `deliveryReadyProbe()` is false and `fetchDeliveryReceipts()` / `fetchActiveReceiptLinks()` return not-ready WITHOUT querying the tables (04 applied alone must not light anything up); with the probe returning `true`: `fetchDeliveryReceipts()` resolves `{ ready: false, rows: [] }` when the query errors with `{ code: '42703', message: 'column purchase_orders.tax_invoice_mode does not exist' }` and when it errors with `{ code: 'PGRST205', message: "Could not find the table 'public.po_receipts'" }`; rethrows `{ code: '42501', message: 'permission denied' }`; `fetchActiveReceiptLinks()` resolves `{ ready: false, map: Map(0) }` on `PGRST205` and `{ ready: true, map }` with rows `[{ receipt_id: 'r1', invoice_id: 'i1', active: true, supplier_tax_invoices: { invoice_no: 'A', status: 'draft' } }]` -> `map.get('r1').invoice_no === 'A'`.

- [ ] **Step 2: Run, expect failures**

Run: `npx vitest run src/lib/supplierTaxInvoiceCodes.test.js src/lib/poReceiptErrors.test.js src/lib/taxInvoiceLinks.test.js src/hooks/poFailSoft.test.js` -> FAIL on the new cases.

- [ ] **Step 3: Implement**

`src/lib/supplierTaxInvoice.js`: add `import { DELIVERY_CHECK_TEXT, DELIVERY_RPC_TEXT } from './deliveryTaxInvoiceText.js'`; append `...DELIVERY_CHECK_TEXT,` as the last entry of `CHECK_TEXT` and `...DELIVERY_RPC_TEXT,` as the last entry of `RPC_TEXT`; in `mapTaxInvoiceRpcError`'s 23505 block add `if (msg.includes('stirc_receipt_active_uq')) return CHECK_TEXT.receipt_linked_elsewhere`.

`src/lib/poReceiptErrors.js`: extend the import to `import { RECEIVE_DELIVERY_DISCOUNT_TEXT, DELIVERY_RPC_TEXT } from './deliveryTaxInvoiceText.js'` and append `...DELIVERY_RPC_TEXT,` as the last entry of `PO_RECEIPT_ERROR_TEXT`.

`src/hooks/useSupabase.js`:
- Imports: add `saveReceiptDraftArgs` to the `taxInvoiceLinks.js` import; add `isMissingEmbedError` to the `poReceiptErrors.js` import; add `import { buildActiveReceiptLinkMap } from '../lib/deliveryTaxInvoice.js'`.
- Replace the body of `useSupplierTaxInvoices` and `useSupplierTaxInvoice` with the fallback versions (the select strings before `STI_RECEIPTS_EMBED` are today's literals, unchanged):

```js
const STI_LIST_SELECT = '*, suppliers!sti_supplier_fk(name, supplier_number), supplier_tax_invoice_items!stii_invoice_fk(id, sort_order, description, amount), supplier_tax_invoice_pos!stip_invoice_fk(id, po_id, active, po_subtotal, expense_id, prev_invoice_no, stamped_invoice_no, purchase_orders!stip_po_fk(id, po_number, date, site_id, supplier_id, status))'
const STI_ONE_SELECT = '*, supplier_tax_invoice_items!stii_invoice_fk(*), supplier_tax_invoice_pos!stip_invoice_fk(id, po_id, active, po_subtotal, expense_id, prev_invoice_no, stamped_invoice_no)'
// per-delivery links (2026-10-09-04); before the migration the relationship is missing: retry without it
const STI_RECEIPTS_EMBED = ', supplier_tax_invoice_receipts!stirc_invoice_fk(id, receipt_id, po_id, active, goods_subtotal, goods_vat, po_receipts!stirc_receipt_fk(seq, received_date, purchase_orders!po_receipts_po_fk(po_number)))'
const withReceiptsFallback = async run => {
  try { return await run(STI_RECEIPTS_EMBED) } catch (e) { if (isMissingEmbedError(e, 'supplier_tax_invoice_receipts')) return run(''); throw e }
}

export function useSupplierTaxInvoices(filters = {}) {
  const r = useQuery(async () => withReceiptsFallback(extra => fetchAllRows(() => {
    let q = supabase.from('supplier_tax_invoices').select(STI_LIST_SELECT + extra)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status) q = q.eq('status', filters.status)
    return q
  })), [JSON.stringify(filters)])
  return { ...r, notReady: isTaxInvoiceNotReady(r.error) }
}

export function useSupplierTaxInvoice(id) {
  const r = useQuery(async () => {
    if (!id) return null
    return withReceiptsFallback(async extra => {
      const { data, error } = await supabase.from('supplier_tax_invoices').select(STI_ONE_SELECT + extra).eq('id', id).maybeSingle()
      if (error) throw error
      return data
    })
  }, [id])
  return { ...r, notReady: isTaxInvoiceNotReady(r.error) }
}
```
- After `export const voidSupplierTaxInvoice = ...` add:

```js
export const saveSupplierTaxInvoiceReceiptDraft = (id, header, items, receiptIds) => rpcOrThrow(TAX_INVOICE_RPCS.saveReceipts, saveReceiptDraftArgs(id, header, items, receiptIds))

// ── Supplier tax invoice per delivery (2026-10-09-04..05) ─────────
// Before the migration the link table / mode column do not exist: these return { ready: false, ... } and never
// throw for that case, so the PO page, the receive dialog and the tax invoice page behave as today.

/** Keyed on delivery_tax_invoice_ready(), created by 2026-10-09-05 (NOT on 04's table): false until BOTH are live. */
export async function deliveryReadyProbe() {
  const { data, error } = await supabase.rpc('delivery_tax_invoice_ready')
  return !error && data === true
}
/** true = the per-delivery migrations are live; false = not yet / unreadable; null while loading. */
export function useDeliveryTaxInvoiceReady() {
  return useQuery(deliveryReadyProbe, []).data
}

const DELIVERY_RECEIPT_SELECT = 'id, po_id, seq, received_date, goods_subtotal, goods_vat, expense_id, '
  + 'purchase_orders!po_receipts_po_fk!inner(id, po_number, supplier_id, site_id, tax_invoice_mode, stock_from_invoice, has_vat, price_includes_vat), '
  + 'po_receipt_items!po_receipt_items_receipt_fk(id, po_item_id, quantity, line_total, base_qty, unit_cost, stock_movement_id, '
  + 'purchase_order_items!po_receipt_items_item_fk(description, unit, quantity, unit_price, discount_pct, line_total, inventory_item_id))'

/** Receipts of 'delivery' POs (every supplier of the tenant). data = { ready, rows } | null while loading. */
export function useDeliveryReceipts() {
  return useQuery(fetchDeliveryReceipts, [])
}
export async function fetchDeliveryReceipts() {
  if (!(await deliveryReadyProbe())) return { ready: false, rows: [] }
  try {
    const rows = await fetchAllRows(() => supabase.from('po_receipts').select(DELIVERY_RECEIPT_SELECT)
      .eq('purchase_orders.tax_invoice_mode', 'delivery').order('id'))
    return { ready: true, rows }
  } catch (e) {
    if (isMissingRelationError(e) || isMissingColumnError(e, 'tax_invoice_mode')) return { ready: false, rows: [] }
    throw e
  }
}

/** data = { ready, map: Map<receipt_id, {invoice_id, invoice_no, status}> } | null while loading. */
export function useActiveReceiptTaxInvoiceLinks() {
  return useQuery(fetchActiveReceiptLinks, [])
}
export async function fetchActiveReceiptLinks() {
  if (!(await deliveryReadyProbe())) return { ready: false, map: new Map() }
  try {
    const rows = await fetchAllRows(() => supabase.from('supplier_tax_invoice_receipts')
      .select('receipt_id, invoice_id, active, supplier_tax_invoices!stirc_invoice_fk(invoice_no, status)')
      .eq('active', true).order('id'))
    return { ready: true, map: buildActiveReceiptLinkMap(rows) }
  } catch (e) {
    if (isMissingRelationError(e)) return { ready: false, map: new Map() }
    throw e
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run` -> all PASS. Run: `npm run build` -> succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/lib/supplierTaxInvoice.js src/lib/poReceiptErrors.js src/lib/receiveDeposits.js src/lib/receiveDeposits.test.js src/lib/supplierTaxInvoiceCodes.test.js src/lib/poReceiptErrors.test.js src/lib/taxInvoiceLinks.test.js src/hooks/poFailSoft.test.js
git commit -m "feat(hooks): fail-soft delivery receipts, receipt links and receipt draft wrapper; Thai text for new codes"
```

---

### Task 6: PO form mode choice, supplier default, ⋯ mode switch, swap hidden for delivery POs

**Review gate:** 'po' PO rows/forms render and save exactly as before when `__deliveryReady=false` (sections 1-9 unchanged and passing); the mode column is sent only via `poModePayload`; `tax_invoice_mode_touched` never reaches a payload; section 10 all PASS incl. 375 px.

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`, `src/pages/Suppliers.jsx`
- Modify (harness): `scripts/tax-invoice-harness/mockPoHooks.js`, `scripts/tax-invoice-harness/runPo.mjs`, `scripts/tax-invoice-harness/README.md`

**Interfaces:**
- Consumes: `useDeliveryTaxInvoiceReady`, `useActiveTaxInvoiceLinks`, `usePoMoneyIndex` (hooks); `defaultTaxInvoiceMode`, `poModePayload`, `poModeLockedText`, `supplierModePayload` (Task 1); `PO_MODE_LOCKED_TEXT`.
- Produces: PO rows written with `tax_invoice_mode`; suppliers with `default_tax_invoice_mode`; `PurchaseOrderForm` props `showModeChoice`, `modeLocked`.

- [ ] **Step 1: Add the harness mocks and failing scenarios**

`mockPoHooks.js` (next to `useActiveTaxInvoiceLinks`):
```js
export const useDeliveryTaxInvoiceReady = () => useQuery(() => delay(() => W.__deliveryReady !== false)).data
export const useActiveReceiptTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__deliveryReady === false ? { ready: false, map: new Map() } : { ready: true, map: new Map(W.__receiptLinks || []) })), [W.__posVersion])
```
`runPo.mjs`: before the final summary add section 10 (set `__deliveryReady=false` at the very top of the file's existing setup so sections 1-9 run exactly as before, then set it in section 10):

```js
console.log('=== 10 delivery mode: PO form, supplier default, ⋯ mode switch')
const SD = '22222222-2222-2222-2222-222222222222'
await page.evaluate(([sd]) => {
  window.__data.suppliers.push({ id: sd, name: 'CAC', default_tax_invoice_mode: 'delivery' })
}, [SD])
await page.evaluate(sd => {
  const base = window.__data.pos[2]
  window.__data.pos.push({ ...base, id: 'G', po_number: 'PO-G', status: 'ordered', tax_invoice_mode: 'po' })
  window.__data.pos.push({ ...base, id: 'H', po_number: 'PO-H', status: 'ordered', tax_invoice_mode: 'delivery', supplier_id: sd, suppliers: { name: 'CAC' } })
  window.__data.pos.push({ ...base, id: 'R', po_number: 'PO-R', status: 'received', tax_invoice_mode: 'delivery', expense_id: 'eR', supplier_id: sd, suppliers: { name: 'CAC' } })
}, SD)
await set('__deliveryReady', false); await render()
await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
ok('not ready: no mode choice in the form', !(await text()).includes('ใบกำกับภาษีของใบสั่งซื้อนี้'))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)
await openMenu(/PO-G/)
ok('not ready: no mode switch in ⋯', !(await text()).includes('เปลี่ยนเป็นใบกำกับต่อการส่งของ'))
await closeMenu()
await set('__deliveryReady', true); await render()
await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
t = await text()
ok('ready: mode choice shown, PO mode preselected', t.includes('ใบกำกับภาษีของใบสั่งซื้อนี้') && await page.getByLabel('1 ใบต่อใบสั่งซื้อ (ปกติ)').isChecked())
```
Then (same section) drive the supplier picker to `CAC` exactly as the existing scenarios that pick a supplier do (reuse their selector), and assert `ok('supplier default preselects delivery', await page.getByLabel(/1 ใบต่อการส่งของ/).isChecked())`; pick the PO-mode radio by hand, pick another supplier, assert it stays on PO mode (`tax_invoice_mode_touched`); fill the minimum fields the existing add-form scenario fills, save, and assert `(await log()).some(([k, tb, p]) => k === 'insert' && tb === 'purchase_orders' && JSON.parse(p).tax_invoice_mode === 'po')`. Then:

```js
await openMenu(/PO-G/)
ok('⋯ offers the switch to delivery', (await text()).includes('🧾 เปลี่ยนเป็นใบกำกับต่อการส่งของ'))
await menuItem('🧾 เปลี่ยนเป็นใบกำกับต่อการส่งของ').click(); await wait(200)
await page.getByRole('button', { name: 'ยืนยัน' }).click(); await wait(300)
ok('switch writes one update', (await log()).filter(([k, tb, p]) => k === 'update' && tb === 'purchase_orders' && p.includes('"tax_invoice_mode":"delivery"')).length === 1)
await set('__money', [['H', { receivedItemIds: ['x'], receiptIds: ['r1'] }]]); await render()
await openMenu(/PO-H/)
ok('switch disabled after a receipt', (await menuItem('🧾 เปลี่ยนเป็นใบกำกับต่อใบสั่งซื้อ').getAttribute('title')) === 'เปลี่ยนวิธีออกใบกำกับภาษีไม่ได้ — ใบสั่งซื้อนี้รับของหรือผูกใบกำกับแล้ว')
await closeMenu()
await openMenu(/PO-R/)
ok('no swap for a delivery PO', !(await text()).includes('สลับใบกำกับภาษี'))
await closeMenu()
await page.setViewportSize({ width: 375, height: 740 })
await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
ok('375px: mode radios fit', await page.evaluate(() => document.documentElement.scrollWidth <= 375))
await page.getByRole('button', { name: '← กลับ' }).click(); await page.setViewportSize({ width: 1280, height: 800 })
```
(Use the existing `__money` format of section 7 — read it first and match it exactly; the confirm button label is `ConfirmDialog`'s confirm text — read `Modal.jsx` and use it.) Also in section 10:
- **draft restore keeps a hand-picked mode:** open the add form, pick CAC (delivery preselected), click `1 ใบต่อใบสั่งซื้อ (ปกติ)`, `__render()` again (remount restores the draft), assert the PO-mode radio is still checked and picking CAC again keeps it.
- **inline-created supplier:** add a supplier through the supplier `QuickAddSelect` "+ สร้างใหม่" path the way the existing scenarios create inline records (read `MockQuickAdd.jsx` usage in `buildPo.mjs` first); assert the mode stays `1 ใบต่อใบสั่งซื้อ (ปกติ)`.
- **readiness arrives late:** `__deliveryReady = false`, open the add form, pick CAC; `__deliveryReady = true` and trigger a refetch (re-render with the form open as section 1 does); assert delivery is now preselected.
- **discount warning:** delivery mode + a line with unit price `-5`: click save -> a dialog with `จะรับของไม่ได้` appears (the harness `page.on('dialog')` collector records it; dismissing it means no `insert` in `__log` — use `page.once('dialog', d => d.dismiss())` for that click).

- [ ] **Step 2: Build + run, expect FAIL** — `node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs` -> section 10 FAILs, sections 1-9 PASS.

- [ ] **Step 3: Implement `PurchaseOrders.jsx`**

1. Imports: add `useDeliveryTaxInvoiceReady` to the hooks import; add `import { defaultTaxInvoiceMode, poModePayload, poModeLockedText } from '../lib/deliveryTaxInvoice.js'` and `import { PO_MODE_LOCKED_TEXT } from '../lib/deliveryTaxInvoiceText.js'`.
2. `EMPTY_FORM`: add `tax_invoice_mode: 'po',` after `stock_from_invoice: false,`.
3. `PurchaseOrderForm` signature: add `showModeChoice = false, modeLocked = false,` after `stockFlagLocked = false,`. After `const set = ...` add:

```js
  // A new PO takes the supplier's remembered mode (owner Q1) until the user picks one by hand. The "picked by hand" flag
  // lives IN the form state (tax_invoice_mode_touched), so the useDraftForm restore after an Android reload keeps it.
  // An inline-created supplier is not in `suppliers` yet: poModeForSupplier gives 'po', its column default.
  const pickSupplier = id => setForm(f => ({ ...f, supplier_id: id,
    ...(showModeChoice ? { tax_invoice_mode: poModeForSupplier(f, (suppliers || []).find(s => s.id === id)) } : {}) }))
  // readiness can arrive after a supplier was picked (or after a draft restore): apply the default once, if untouched
  useEffect(() => {
    if (!isAdd || !showModeChoice || !form.supplier_id || form.tax_invoice_mode_touched) return
    const next = poModeForSupplier(form, (suppliers || []).find(s => s.id === form.supplier_id))
    if (next !== form.tax_invoice_mode) set('tax_invoice_mode', next)
  }, [isAdd, showModeChoice, form.supplier_id, suppliers]) // eslint-disable-line react-hooks/exhaustive-deps
```
   and the supplier `QuickAddSelect` gets `onChange={pickSupplier}` (was `onChange={id => set('supplier_id', id)}`). Editing an existing PO starts with `tax_invoice_mode_touched: true` (step 7). `tax_invoice_mode_touched` is never sent to the database (the payload is built field by field). Import `poModeForSupplier, poDeliveryDiscountWarning` instead of `defaultTaxInvoiceMode`.
4. After the `{showStockFlag && (...)}` block insert:

```jsx
          {showModeChoice && (
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <div style={{ marginBottom: 4 }}>🧾 ใบกำกับภาษีของใบสั่งซื้อนี้</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {[['po', '1 ใบต่อใบสั่งซื้อ (ปกติ)'], ['delivery', '1 ใบต่อการส่งของ (ส่งเป็นล็อต แต่ละล็อตมีใบกำกับของตัวเอง)']].map(([v, label]) => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: modeLocked ? 'not-allowed' : 'pointer', minWidth: 0 }}>
                    <input type="radio" name="po-tax-invoice-mode" aria-label={label} disabled={modeLocked} checked={(form.tax_invoice_mode || 'po') === v}
                      onChange={() => setForm(f => ({ ...f, tax_invoice_mode: v, tax_invoice_mode_touched: true }))} />
                    {label}
                  </label>
                ))}
              </div>
              {modeLocked && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{PO_MODE_LOCKED_TEXT}</div>}
            </div>
          )}
```
5. In `PurchaseOrders`: `const deliveryReady = useDeliveryTaxInvoiceReady()`; state `const [modeRow, setModeRow] = useState(null)` and `const [modeSaving, setModeSaving] = useState(false)`.
6. `handleSave`: first statement inside `try` (before building the payload): `const discWarn = deliveryReady === true ? poDeliveryDiscountWarning(form, lineTotal) : ''; if (discWarn && !window.confirm(discWarn)) return` (the `finally` resets `saving`). After `Object.assign(poPayload, buildPoPayloadFlag(form, editRow))` add `Object.assign(poPayload, poModePayload(form, editRow, deliveryReady))`.
7. `editFormInitial`: add `tax_invoice_mode: editRow.tax_invoice_mode === 'delivery' ? 'delivery' : 'po', tax_invoice_mode_touched: true,`.
8. `<PurchaseOrderForm ...>`: add `showModeChoice={deliveryReady === true} modeLocked={!!editRow && !!poModeLockedText(editRow, moneyIndex, taxInvoiceLinks)}`.
9. `poMenuItems`: after the create-deposit block add:

```js
    if (canEdit && deliveryReady === true && ['draft', 'ordered'].includes(po.status) && Object.prototype.hasOwnProperty.call(po, 'tax_invoice_mode')) {
      const modeLock = poModeLockedText(po, moneyIndex, taxInvoiceLinks)
      items.push({ label: po.tax_invoice_mode === 'delivery' ? '🧾 เปลี่ยนเป็นใบกำกับต่อใบสั่งซื้อ' : '🧾 เปลี่ยนเป็นใบกำกับต่อการส่งของ',
        disabled: !!modeLock, disabledTitle: modeLock || undefined, onClick: () => setModeRow(po) })
    }
```
   and the swap condition becomes `if (po.expense_id && !taxInvoiceLinks?.get(po.id) && po.tax_invoice_mode !== 'delivery') {`.
10. Handler and dialog:

```js
  const handleModeChange = async () => {
    if (!modeRow || modeSaving) return
    const next = modeRow.tax_invoice_mode === 'delivery' ? 'po' : 'delivery'
    setModeSaving(true)
    try {
      const { error } = await supabase.from('purchase_orders').update({ tax_invoice_mode: next }).eq('id', modeRow.id)
      if (error) throw error
      await auditLog('purchase_orders', modeRow.id, 'UPDATE', { tax_invoice_mode: modeRow.tax_invoice_mode }, { tax_invoice_mode: next })
      setModeRow(null); refetchAll()
      showToast(next === 'delivery' ? 'ตั้งเป็นใบกำกับต่อการส่งของแล้ว' : 'ตั้งเป็นใบกำกับต่อใบสั่งซื้อแล้ว')
    } catch (e) {
      setModeRow(null); refetchAll(); alert(mapPoReceiptRpcError(e))
    } finally { setModeSaving(false) }
  }
```
```jsx
      {modeRow && (
        <ConfirmDialog title="วิธีออกใบกำกับภาษี"
          message={modeRow.tax_invoice_mode === 'delivery'
            ? `เปลี่ยน ${modeRow.po_number} เป็น "1 ใบกำกับต่อใบสั่งซื้อ"? (จับคู่ใบกำกับได้เมื่อรับของครบ)`
            : `เปลี่ยน ${modeRow.po_number} เป็น "1 ใบกำกับต่อการส่งของ"? แต่ละล็อตที่รับจะลงใบกำกับของตัวเอง — เปลี่ยนกลับไม่ได้หลังรับของล็อตแรก`}
          onConfirm={handleModeChange} confirmDisabled={modeSaving}
          onCancel={() => { if (modeSaving) return false; setModeRow(null) }} />
      )}
```

- [ ] **Step 4: Implement `Suppliers.jsx`** (no harness exists for this page: covered by the `supplierModePayload` vitest and the live checklist)

- `EMPTY_FORM`: add `default_tax_invoice_mode: 'po'`.
- `SupplierForm({ initial, onSave, onCancel, loading, showMode = false })`; the initial state spreads `default_tax_invoice_mode: initial.default_tax_invoice_mode === 'delivery' ? 'delivery' : 'po'`. After the payment block add:

```jsx
        {showMode && (
          <div>
            <label className="label">ใบกำกับภาษีจากผู้จำหน่ายนี้ (ค่าเริ่มต้นของใบสั่งซื้อใหม่)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
              {[['po', '1 ใบต่อใบสั่งซื้อ (ปกติ)'], ['delivery', '1 ใบต่อการส่งของ (ส่งเป็นล็อต)']].map(([v, label]) => (
                <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                  <input type="radio" name="supplier-tax-invoice-mode" checked={form.default_tax_invoice_mode === v} onChange={() => set('default_tax_invoice_mode', v)} />
                  {label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ใช้กับใบสั่งซื้อที่สร้างใหม่เท่านั้น ใบสั่งซื้อเดิมไม่เปลี่ยน</div>
          </div>
        )}
```
- `Suppliers`: `const deliveryReady = useDeliveryTaxInvoiceReady()` (import from hooks); `import { supplierModePayload } from '../lib/deliveryTaxInvoice.js'`; in `handleSave` add `...supplierModePayload(form, editItem, deliveryReady),` to `payload`; render `<SupplierForm ... showMode={deliveryReady === true} />`; in the list's name cell append `{s.default_tax_invoice_mode === 'delivery' && <span className="badge badge-po-ordered" style={{ marginLeft: 6 }}>ใบกำกับต่อการส่งของ</span>}`.

- [ ] **Step 5: Verify** — `npx vitest run` PASS; `npm run build` OK; `node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs` -> `ALL PASS`. Add one README line under "PO page scenarios": "Section 10: delivery mode (`__deliveryReady`, `__receiptLinks`): form mode choice + supplier default, ⋯ mode switch and lock, no swap for delivery POs, 375 px."

- [ ] **Step 6: Commit**

```bash
git add src/pages/PurchaseOrders.jsx src/pages/Suppliers.jsx scripts/tax-invoice-harness/mockPoHooks.js scripts/tax-invoice-harness/runPo.mjs scripts/tax-invoice-harness/README.md
git commit -m "feat(po): choose tax invoice per PO or per delivery, remembered per supplier"
```

---

### Task 7: Receive dialog checkbox, hand-off, per-receipt status in the PO popup and row badge

**Files:**
- Modify: `src/components/ReceivePoLinesModal.jsx`, `src/pages/PurchaseOrders.jsx`, `src/lib/poTaxInvoiceStatus.js`
- Test: `src/lib/poTaxInvoiceStatus.test.js` (append)
- Modify (harness): `scripts/tax-invoice-harness/entryPo.jsx`, `scripts/tax-invoice-harness/runPo.mjs`, `scripts/tax-invoice-harness/README.md`

**Interfaces:**
- Consumes: `useActiveReceiptTaxInvoiceLinks`, `receiptTaxInvoiceStatus`, `deliveryPoBadge`, `receiptLabel`.
- Produces: `ReceivePoLinesModal` prop `offerInvoiceNext: boolean`; `onDone(res, { openInvoice })`; navigation `navigateTo('supplier_tax_invoices', { newForReceipt: { receiptId, poId, supplierId } })` (consumed by Task 9).

- [ ] **Step 1: Harness first**

`entryPo.jsx`: render the page with `navigateTo={(t, s) => { (window.__nav = window.__nav || []).push([t, s]) }}` (was `() => {}`). `runPo.mjs` section 11:

```js
console.log('=== 11 delivery: receive checkbox + hand-off, popup lot status, row badge')
await set('__deliveryReady', true); await set('__money', []); await set('__receiptLinks', []); await page.evaluate(() => { window.__nav = [] }); await render()
await openMenu(/PO-H/); await menuItem('📦 รับของ').click(); await wait(400)
const cb = page.getByLabel('ลงใบกำกับภาษีของล็อตนี้ต่อทันที')
ok('delivery PO: checkbox shown and ticked', await cb.isVisible() && await cb.isChecked())
await page.getByRole('button', { name: /ยืนยันรับของ/ }).dblclick(); await wait(500)
const nav = await page.evaluate(() => window.__nav)
ok('double click = one receipt + one hand-off', (await log()).filter(([k, n]) => k === 'rpc' && n === 'receive_po_lines').length === 1 && nav.length === 1
  && nav[0][0] === 'supplier_tax_invoices' && nav[0][1].newForReceipt.receiptId === 'r1' && nav[0][1].newForReceipt.poId === 'H', JSON.stringify(nav))
await page.evaluate(() => { window.__nav = [] }); await render()
await openMenu(/PO-H/); await menuItem('📦 รับของ').click(); await wait(400)
await page.getByLabel('ลงใบกำกับภาษีของล็อตนี้ต่อทันที').uncheck()
await page.getByRole('button', { name: /ยืนยันรับของ/ }).click(); await wait(500)
ok('unticked: no hand-off', (await page.evaluate(() => window.__nav)).length === 0)
await openMenu(/PO-G/); await menuItem('📦 รับของ').click(); await wait(400)
ok('po-mode PO: no checkbox', !(await text()).includes('ลงใบกำกับภาษีของล็อตนี้ต่อทันที'))
await page.getByRole('button', { name: 'ยกเลิก' }).click(); await wait(200)
```
Then set `__ledger` for `H` with two receipts `{ id: 'r1', seq: 1, received_date: '2026-10-05', goods_subtotal: 600, goods_vat: 42, po_receipt_items: [] }` and `r2` (seq 2), `__receiptLinks = [['r1', { invoice_id: 'i9', invoice_no: 'INV-9', status: 'posted' }]]`, `__money = [['H', { receivedItemIds: [], receiptIds: ['r1', 'r2'] }]]` (match section 7's format), render, and assert: row text contains `รอใบกำกับ 1 ล็อต`; opening 📄 on PO-H shows `R1` with `ใบกำกับ INV-9` and `R2` with `รอใบกำกับ` and a button `🧾 ลงใบกำกับ`; clicking it pushes `['supplier_tax_invoices', { newForReceipt: { receiptId: 'r2', poId: 'H', supplierId: SD } }]`; with `__deliveryReady=false` the popup shows neither text; at 375 px the popup has no horizontal page scroll.

Also in section 11: a received delivery PO flagged `stock_from_invoice: true` (push `{ ...PO-R, id: 'RS', po_number: 'PO-RS', stock_from_invoice: true }`) never shows `รอใบกำกับ (สต็อกยังไม่เข้า)` in its row or popup (only the per-lot badge).

`src/lib/poTaxInvoiceStatus.test.js` (append):
```js
describe('poTaxInvoiceBadge and delivery POs', () => {
  it('the PO-level "awaiting" badge never shows for a delivery PO (lots carry their own status)', () => {
    expect(poTaxInvoiceBadge({ id: 'P', status: 'received', stock_from_invoice: true, tax_invoice_mode: 'delivery' }, new Map())).toEqual({ kind: null, text: '' })
    expect(poTaxInvoiceBadge({ id: 'P', status: 'received', stock_from_invoice: true }, new Map()).kind).toBe('awaiting')
  })
})
```

- [ ] **Step 2: Build + run -> section 11 FAILs; `npx vitest run src/lib/poTaxInvoiceStatus.test.js` FAILs.**

- [ ] **Step 2b: `src/lib/poTaxInvoiceStatus.js`** — in `poTaxInvoiceBadge`, the awaiting line becomes `if (po.status === 'received' && po.stock_from_invoice && po.tax_invoice_mode !== 'delivery') return { kind: 'awaiting', text: 'รอใบกำกับ (สต็อกยังไม่เข้า)' }`.

- [ ] **Step 3: Implement `ReceivePoLinesModal.jsx`**

- Signature: `({ po, stockPlanFor, stockBalances, onDone, onClose, offerInvoiceNext = false })`; state `const [invoiceNext, setInvoiceNext] = useState(true)` (owner Q2: ticked by default).
- In `confirm`, replace `onDone(res || {})` with `onDone(res || {}, { openInvoice: offerInvoiceNext && invoiceNext })`.
- Before `{error && ...}` insert:

```jsx
        {offerInvoiceNext && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <input type="checkbox" aria-label="ลงใบกำกับภาษีของล็อตนี้ต่อทันที" checked={invoiceNext} disabled={busy} onChange={e => setInvoiceNext(e.target.checked)} />
            <span>🧾 ลงใบกำกับภาษีของล็อตนี้ต่อทันที <span style={{ ...muted, fontSize: 12 }}>(ไม่ติ๊ก = ล็อตนี้ "รอใบกำกับ" ลงทีหลังได้)</span></span>
          </label>
        )}
```

- [ ] **Step 4: Implement `PurchaseOrders.jsx`**

- Imports: add `useActiveReceiptTaxInvoiceLinks` (hooks); extend the `deliveryTaxInvoice.js` import with `deliveryPoBadge, receiptTaxInvoiceStatus`.
- `TAX_BADGE_CLASS`: add `delivery: 'badge-po-ordered'`.
- In `PurchaseOrders`: `const { data: receiptLinkData, refetch: refetchReceiptLinks } = useActiveReceiptTaxInvoiceLinks()`; `const receiptLinks = receiptLinkData?.ready ? receiptLinkData.map : null`; `refetchAll` also calls `refetchReceiptLinks()`.
- `const startInvoiceForReceipt = (po, receiptId) => navigateTo('supplier_tax_invoices', { newForReceipt: { receiptId, poId: po.id, supplierId: po.supplier_id } })`.
- Receive modal: add `offerInvoiceNext={receiveRow.tax_invoice_mode === 'delivery' && deliveryReady === true}`; `onDone={async (res, opts) => { ... existing body ...; inside the finally, after showToast: if (opts?.openInvoice && res.receipt_id) startInvoiceForReceipt(po, res.receipt_id) }}`.
- Row status cell, after the tax badge: `{(() => { const d = deliveryPoBadge(po, moneyIndex, receiptLinks); return d.kind ? <span className={\`badge ${TAX_BADGE_CLASS[d.kind]}\`} style={{ marginLeft: 4 }}>{d.text}</span> : null })()}`.
- `PODetailModal` gets props `receiptLinks` and `onStartInvoice` (pass `receiptLinks={receiptLinks}` and `onStartInvoice={canEdit ? rid => { setDetailRow(null); startInvoiceForReceipt(detailRow, rid) } : null}`); its receipt row becomes:

```jsx
              <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>R{r.seq} · {fmtDate(r.received_date)} · ก่อน VAT <span className="font-mono">{fmt(r.goods_subtotal)}</span> · VAT <span className="font-mono">{fmt(r.goods_vat)}</span></span>
                {po.tax_invoice_mode === 'delivery' && (() => {
                  const st = receiptTaxInvoiceStatus(r.id, receiptLinks)
                  if (!st.kind) return null
                  return <>
                    <span className={`badge ${TAX_BADGE_CLASS[st.kind]}`}>{st.text}</span>
                    {st.kind === 'awaiting' && onStartInvoice && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onStartInvoice(r.id)}>🧾 ลงใบกำกับ</button>}
                  </>
                })()}
              </div>
```

- [ ] **Step 5: Verify** — vitest PASS, build OK, `runPo.mjs` ALL PASS; README line: "Section 11: receive checkbox + hand-off (`window.__nav`), popup lot status, row badge."

- [ ] **Step 6: Commit**

```bash
git add src/components/ReceivePoLinesModal.jsx src/pages/PurchaseOrders.jsx src/lib/poTaxInvoiceStatus.js src/lib/poTaxInvoiceStatus.test.js scripts/tax-invoice-harness/entryPo.jsx scripts/tax-invoice-harness/runPo.mjs scripts/tax-invoice-harness/README.md
git commit -m "feat(po): key the lot's tax invoice right after receiving; lot invoice status in the PO popup"
```

---

### Task 8: Tax invoice form — switch "ผูกกับ: ใบสั่งซื้อ | การส่งของ" and receipt picker

**Files:**
- Modify: `src/components/SupplierTaxInvoiceForm.jsx`
- Modify (harness): `scripts/tax-invoice-harness/mockHooks.js`, `scripts/tax-invoice-harness/run.mjs`

**Interfaces:**
- Consumes: `useDeliveryReceipts`, `useActiveReceiptTaxInvoiceLinks`; `evaluateDeliveryMatch`, `receiptPickerRows`, `receiptLabel` (Task 1); `missingReceiptIds` (Task 2); form fields `link_kind`, `receipt_ids`.
- Produces: the form emits `link_kind`/`receipt_ids` through `onSaveDraft(form)` / `onPreview(form)` (Task 9 saves them).

- [ ] **Step 1: Harness first.** `mockHooks.js`:

```js
export const useDeliveryReceipts = () => useQuery(() => delay(() => (W.__deliveryReady === false ? { ready: false, rows: [] } : { ready: true, rows: D().deliveryReceipts || [] })), [W.__dVersion])
export const useActiveReceiptTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__deliveryReady === false ? { ready: false, map: new Map() } : { ready: true, map: new Map(D().receiptLinks || []) })), [W.__dVersion])
export const saveSupplierTaxInvoiceReceiptDraft = (...a) => call('saveReceipts', a)
```
In `run.mjs` add to `data`: `deliveryReceipts` = three receipts of supplier `S1` with `purchase_orders.tax_invoice_mode: 'delivery'` (`rA` 2026-10-04 600/42 with one item line `{ quantity: 2, base_qty: 2, purchase_order_items: { description: 'Steel', unit: 'kg', quantity: 2, unit_price: 300, discount_pct: 0, inventory_item_id: 'I1' } }`, `rB` 2026-10-02 400/28, `rC` 2026-10-03 linked elsewhere) and one of another supplier; `receiptLinks: [['rC', { invoice_id: 'X', invoice_no: 'INV-X', status: 'posted' }]]`. Set `window.__deliveryReady = false` at boot so existing sections are untouched. New section:

```js
console.log('=== D1 form: link kind switch and receipt picker')
await page.evaluate(() => { window.__deliveryReady = false }); await render()
await page.getByRole('button', { name: '+ เพิ่มใบกำกับภาษีผู้ขาย' }).click(); await wait(300)
ok('not ready: no switch', !(await text()).includes('ผูกกับ:'))
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(200)
await page.evaluate(() => { window.__deliveryReady = true; window.__log = [] }); await render()
await page.getByRole('button', { name: '+ เพิ่มใบกำกับภาษีผู้ขาย' }).click(); await wait(300)
```
then pick supplier `Supplier One` (same selector the existing sections use), click radio `การส่งของ`, and assert: the picker lists `PO-1-R?` labels oldest first (`rB` before `rA`), `rC` is disabled with `ผูกกับใบกำกับ INV-X`, the other supplier's receipt is absent; ticking `rB` and `rA` and typing net `1000` vat `70` shows `มูลค่าสินค้าที่รับ 1,000.00`; net `990` vat `80` shows `ตรงเมื่อเทียบรวม VAT` (incl basis); switching back to `ใบสั่งซื้อ` clears the ticks (re-switching shows none ticked); 💾 บันทึกร่าง with delivery kind logs `['rpc', 'saveReceipts', ...]` whose 4th argument is `["rB","rA"]` (order of ticking) and NOT `save`; at 375 px the picker has no horizontal page scroll.

Also in D1:
- **delivery POs never in the PO picker:** add to `data.pos` a received PO `{ ...PO, id: 'PD', po_number: 'PO-DEL', tax_invoice_mode: 'delivery' }`; in `ใบสั่งซื้อ` kind for `Supplier One`, `PO-DEL` is not listed (proposed, outside month or linked elsewhere).
- **stale draft that selected a delivery PO:** open an existing draft invoice whose `supplier_tax_invoice_pos` holds `PD` (data written before the PO was switched): the picker does not list it, an amber notice shows `PO-DEL — ` + `DELIVERY_PO_IN_PO_INVOICE_TEXT` with a button `เอาออก`, the match sum excludes it, and 💾 บันทึกร่าง alerts that text without calling `save`; after `เอาออก` save calls `save` with `PD` absent.
- **empty delivery selection:** `การส่งของ` kind with no lot ticked: 💾 บันทึกร่าง alerts `NO_RECEIPTS_TEXT` and logs no RPC.
- **scan in delivery kind:** with `การส่งของ` kind and `rA` ticked, upload a file with the mocked extractor returning two lines, `prices_include_vat: true`, unit price `107`: the lines are replaced with unit price `100` (ex-VAT), net is filled only if it was blank, `receipt_ids` stays `['rA']` (no PO auto-tick, no proposal list appears), and the kind stays `การส่งของ`.

- [ ] **Step 2: Build + run (`node scripts/tax-invoice-harness/build.mjs && node scripts/tax-invoice-harness/run.mjs`) -> D1 FAILs** (save wiring is Task 9; the `saveReceipts` assertion is expected to keep failing until Task 9 — mark it with a `// Task 9` comment and keep it).

- [ ] **Step 3: Implement** in `SupplierTaxInvoiceForm.jsx`:

1. Imports: add `useDeliveryReceipts, useActiveReceiptTaxInvoiceLinks` to the hooks import; `import { evaluateDeliveryMatch, receiptPickerRows, receiptLabel } from '../lib/deliveryTaxInvoice.js'`; add `missingReceiptIds` to the `taxInvoiceForm.js` import.
2. After `const { data: examples } = ...`:

```js
  const { data: deliveryData } = useDeliveryReceipts()
  const { data: receiptLinkData } = useActiveReceiptTaxInvoiceLinks()
  const deliveryReady = deliveryData?.ready === true && receiptLinkData?.ready === true
  const kind = form.link_kind === 'delivery' ? 'delivery' : 'po'
  const receiptRows = deliveryReady ? deliveryData.rows : null
  const picker = useMemo(() => receiptPickerRows({ receipts: receiptRows || [], supplierId: form.supplier_id, links: receiptLinkData?.map || new Map(), invoiceId }),
    [receiptRows, form.supplier_id, receiptLinkData, invoiceId])
  const receiptById = useMemo(() => new Map((receiptRows || []).map(r => [r.id, r])), [receiptRows])
  const selectedReceipts = (form.receipt_ids || []).map(id => receiptById.get(id)).filter(Boolean)
  const missingReceipts = kind === 'delivery' ? missingReceiptIds(form.receipt_ids, receiptRows) : []
```
3. Auto-tick effect: first line becomes `if (invoiceId || kind !== 'po' || !posRows || !links || !form.supplier_id || autoTickedFor === form.supplier_id) return` and add `kind` to its deps.
4. `const missing = kind === 'po' ? missingPoIds(form.po_ids, posRows) : []`.
5. Move `const netNum = Number(form.net_before_vat)` above the match, then:

```js
  const grandNum = round2((Number.isFinite(netNum) ? netNum : 0) + (Number.isFinite(Number(form.vat)) ? Number(form.vat) : 0))
  const match = kind === 'delivery'
    ? evaluateDeliveryMatch({ netBeforeVat: form.net_before_vat, grandTotal: grandNum, receipts: selectedReceipts, lineAmounts: form.lines.map(lineAmount) })
    : evaluateMatch({ netBeforeVat: form.net_before_vat, poSubtotals: selectedPos.map(poSubtotal), lineAmounts: form.lines.map(lineAmount) })
```
6. `const unlinkedInMonth = kind === 'po' ? proposal.proposed.filter(p => !form.po_ids.includes(p.id)) : []`; common site:

```js
  const siteIds = kind === 'delivery' ? selectedReceipts.map(r => r.purchase_orders?.site_id) : selectedPos.map(p => p.site_id)
  const commonSite = siteIds.length && siteIds.every(s => s === siteIds[0]) ? siteIds[0] || '' : ''
```
7. Below `togglePo`:

```js
  const toggleReceipt = id => set('receipt_ids', form.receipt_ids.includes(id) ? form.receipt_ids.filter(x => x !== id) : [...form.receipt_ids, id])
  const setKind = k => setForm(f => ({ ...f, link_kind: k, po_ids: [], receipt_ids: [] }))
```
   and `pickSupplier` becomes `v => setForm(f => ({ ...f, supplier_id: v, po_ids: [], receipt_ids: [] }))`.
8. After the "reconciled" effect add (prefilled lines from a receipt without a stored base quantity):

```js
  const baseFilled = useRef(false)
  useEffect(() => {
    if (invoiceId || baseFilled.current || !allItems || !unitFactors) return
    baseFilled.current = true
    setForm(f => ({ ...f, lines: f.lines.map(l => (l.inventory_item_id && l.base_qty === '' && !l.base_manual ? applyLineChange(l, {}, lookupsRef.current) : l)) }))
  }, [invoiceId, allItems, unitFactors])
```
8b. Stale delivery POs in a PO-kind selection (import `splitDeliveryPoIds` and `DELIVERY_PO_IN_PO_INVOICE_TEXT`, `NO_RECEIPTS_TEXT`):

```js
  const { delivery: deliveryPoIds } = kind === 'po' ? splitDeliveryPoIds(form.po_ids, posRows) : { delivery: [] }
```
   `selectedPos` becomes `form.po_ids.filter(id => !deliveryPoIds.includes(id)).map(id => poById.get(id)).filter(Boolean)`; below the PO picker render, when `deliveryPoIds.length`:

```jsx
              <div style={{ ...amber, marginTop: 8 }}>
                {deliveryPoIds.map(id => (
                  <div key={id}>{poById.get(id)?.po_number || id.slice(0, 8)} — {DELIVERY_PO_IN_PO_INVOICE_TEXT}
                    <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }} onClick={() => set('po_ids', form.po_ids.filter(x => x !== id))}>เอาออก</button>
                  </div>
                ))}
              </div>
```
9. `run`: replace the two PO-specific checks with

```js
    if (kind === 'delivery') {
      if (!form.receipt_ids.length) errs.push(NO_RECEIPTS_TEXT)
      if (form.supplier_id && !receiptRows && form.receipt_ids.length) errs.push('กำลังโหลดการรับของ กรุณารอสักครู่')
      if (missingReceipts.length) errs.push(`มีการรับของที่เลือกไว้ ${missingReceipts.length} รายการที่ไม่พบในรายการ — เอาออกก่อนบันทึก`)
    } else {
      if (form.supplier_id && !posRows && form.po_ids.length) errs.push('กำลังโหลดใบสั่งซื้อ กรุณารอสักครู่')
      if (missing.length) errs.push(`มีใบสั่งซื้อที่เลือกไว้ ${missing.length} ใบที่ไม่พบในรายการ — เอาออกก่อนบันทึก`)
      if (deliveryPoIds.length) errs.push(DELIVERY_PO_IN_PO_INVOICE_TEXT)
    }
```
   The scan handler is unchanged: it only replaces lines/net/VAT/number/date, and the auto-tick effect is gated on `kind === 'po'` (item 3), so a delivery scan never ticks POs.
10. Render helper next to `renderPoRow`:

```jsx
  const renderReceiptRow = (r, { disabled, link } = {}) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, padding: '4px 0', opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" disabled={disabled} checked={form.receipt_ids.includes(r.id)} onChange={() => toggleReceipt(r.id)} style={{ marginTop: 3 }} />
      <span>
        <b>{receiptLabel(r.purchase_orders?.po_number, r.seq)}</b> · รับ {fmtDate(r.received_date)}
        {' · '}มูลค่าสินค้า {fmt(r.goods_subtotal)} · VAT {fmt(r.goods_vat)}
        {!r.expense_id && <span style={badge('#b45309', 'rgba(245,158,11,.15)')}>ไม่มีบิล (หักมัดจำครบ)</span>}
        {r.purchase_orders?.stock_from_invoice && <span style={badge('#1d4ed8', 'rgba(59,130,246,.15)')}>สต็อกเข้าจากใบกำกับ</span>}
        {link && <span style={{ color: 'var(--text3)', marginLeft: 6 }}>ผูกกับใบกำกับ {link.invoice_no}</span>}
      </span>
    </label>
  )
```
11. JSX: directly above the PO picker `<div>` insert the switch, and wrap the existing PO picker `<div>...</div>` in `{kind === 'po' && (...)}` followed by the delivery picker:

```jsx
          {(deliveryReady || kind === 'delivery') && (
            <div role="radiogroup" aria-label="ผูกกับ" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, alignItems: 'center' }}>
              <span>ผูกกับ:</span>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="radio" name="sti-link-kind" checked={kind === 'po'} onChange={() => setKind('po')} /> ใบสั่งซื้อ</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="radio" name="sti-link-kind" checked={kind === 'delivery'} onChange={() => setKind('delivery')} /> การส่งของ</label>
            </div>
          )}
```
```jsx
          {kind === 'delivery' && (
            <div>
              <label className="label">การส่งของ (ล็อต) ที่รวมอยู่ในใบกำกับนี้</label>
              {!form.supplier_id ? (
                <div style={{ fontSize: 13, color: 'var(--text3)' }}>เลือกซัพพลายเออร์ก่อน</div>
              ) : !receiptRows ? (
                <div style={{ fontSize: 13, color: 'var(--text3)' }}>⏳ กำลังโหลดการรับของ...</div>
              ) : (
                <>
                  {picker.available.length === 0 && picker.linkedElsewhere.length === 0 && (
                    <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่พบการรับของที่รอใบกำกับของซัพพลายเออร์นี้ (ใบสั่งซื้อต้องตั้งเป็น "1 ใบต่อการส่งของ")</div>
                  )}
                  {picker.available.map(r => <div key={r.id}>{renderReceiptRow(r)}</div>)}
                  {picker.linkedElsewhere.map(({ receipt, link }) => <div key={receipt.id}>{renderReceiptRow(receipt, { disabled: true, link })}</div>)}
                </>
              )}
              {missingReceipts.length > 0 && (
                <div style={{ ...amber, marginTop: 8 }}>
                  การรับของที่เลือกไว้ไม่พบในรายการ {missingReceipts.length} รายการ — บันทึกไม่ได้จนกว่าจะเอาออก
                  {missingReceipts.map(id => (
                    <button key={id} type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }}
                      onClick={() => set('receipt_ids', form.receipt_ids.filter(x => x !== id))}>เอาออก {id.slice(0, 8)}</button>
                  ))}
                </div>
              )}
            </div>
          )}
```
12. Match box text: `{match.invalid ? 'กรอกยอดก่อน VAT และรายการให้ครบเพื่อเทียบกับใบสั่งซื้อ' : kind === 'delivery' ? \`มูลค่าสินค้าที่รับ ${fmt(match.sum)} (รวม VAT ${fmt(match.sumIncl)}) · ใบกำกับก่อน VAT ${fmt(netNum)} · ต่าง ${fmt(match.diffExcl)}${match.basis === 'incl' ? \` · ตรงเมื่อเทียบรวม VAT (ต่าง ${fmt(match.diffIncl)})\` : ''} (เกณฑ์ ±${fmt(match.tolerance)})\` : <today's PO text, unchanged>}`. The total shown in the "ยอดรวม" box uses `grandNum`.

- [ ] **Step 4: Verify** — vitest PASS; build OK; `run.mjs` all sections PASS except the one `// Task 9` assertion.

- [ ] **Step 5: Commit**

```bash
git add src/components/SupplierTaxInvoiceForm.jsx scripts/tax-invoice-harness/mockHooks.js scripts/tax-invoice-harness/run.mjs
git commit -m "feat(tax-invoice): link an invoice to deliveries (receipt picker, both VAT bases)"
```

---

### Task 9: Tax invoice page — save by kind, hand-off, "ใบรับของที่รอใบกำกับ", list and view

**Review gate:** a PO-kind invoice saves, previews, posts and voids through exactly the old wrappers and texts (existing run.mjs sections unchanged and passing); the hand-off consumes `navState` once and never opens two forms; every list/view path handles rows without `supplier_tax_invoice_receipts` (pre-migration fallback); D2 all PASS incl. 375 px.

**Files:**
- Modify: `src/pages/SupplierTaxInvoices.jsx`, `src/components/TaxInvoicePreview.jsx`
- Modify (harness): `scripts/tax-invoice-harness/entry.jsx`, `scripts/tax-invoice-harness/run.mjs`, `scripts/tax-invoice-harness/README.md`

**Interfaces:**
- Consumes: `saveSupplierTaxInvoiceReceiptDraft`, `useDeliveryReceipts`, `useActiveReceiptTaxInvoiceLinks` (Task 5); `formForReceipt`, `receiptsAwaitingInvoice`, `receiptLabel`, `invoiceMatchBase`, `linkKindOf` (Task 1); `toRpcPayload().receiptIds/linkKind`, `postSummaryLines({ receiptCount })` (Task 2); `navState.newForReceipt` (Task 7); `DELIVERY_NOT_READY_TEXT`, `HANDOFF_RECEIPT_NOT_FOUND_TEXT`.

- [ ] **Step 1: Harness first.** `entry.jsx`: render `<Page navState={window.__navState || {}} navigateTo={(t, s) => { (window.__nav = window.__nav || []).push([t, s]) }} />`. `run.mjs` section D2: with `__deliveryReady=true`: (a) the awaiting card `📦 ใบรับของที่รอใบกำกับ (2)` lists `rB` then `rA` under `Supplier One`, not `rC`; (b) clicking its `🧾 ลงใบกำกับ` on `rA` opens the form with `การส่งของ` checked, `rA` ticked, net `600`, line `Steel` qty `2` unit price `300`; (c) `window.__navState = { newForReceipt: { receiptId: 'rA' } }` + render opens the same form by itself and pushes `['supplier_tax_invoices', {}]` (consumed); an unknown receipt id alerts `HANDOFF_RECEIPT_NOT_FOUND_TEXT`; (d) the Task 8 `saveReceipts` assertion now passes; (e) a posted delivery invoice row (`supplier_tax_invoice_receipts` with two active links, `post_result.checks` containing `match_vat_inclusive`, `match_diff: 0`) shows `2 ล็อต` in the count column and no red diff; its 👁️ view lists `PO-1-R1` / `PO-1-R2` with their goods values; (f) preview checks carrying `receipt_no` show `(... PO-1-R2)` after the Thai text; (g) 375 px: awaiting card and form fit.

- [ ] **Step 2: Build + run -> D2 FAILs.**

- [ ] **Step 3: Implement**

`TaxInvoicePreview.jsx` `checkLine`:
```js
export function checkLine(c, poNumberById) {
  const po = c.po_id ? (poNumberById?.get?.(c.po_id) || null) : null
  const ref = c.receipt_no || po
  return (CHECK_TEXT[c.code] || c.code) + (ref ? ` (${ref})` : '')
}
```

`SupplierTaxInvoices.jsx`:
1. Signature `export default function SupplierTaxInvoices({ navState, navigateTo } = {})`. Imports: add `saveSupplierTaxInvoiceReceiptDraft, useDeliveryReceipts, useActiveReceiptTaxInvoiceLinks` (hooks); `import { formForReceipt, receiptsAwaitingInvoice, receiptLabel, invoiceMatchBase, linkKindOf } from '../lib/deliveryTaxInvoice.js'`; `import { DELIVERY_NOT_READY_TEXT, HANDOFF_RECEIPT_NOT_FOUND_TEXT } from '../lib/deliveryTaxInvoiceText.js'`.
2. Data:

```js
  const { data: deliveryData, refetch: refetchDelivery } = useDeliveryReceipts()
  const { data: receiptLinkData, refetch: refetchReceiptLinks } = useActiveReceiptTaxInvoiceLinks()
  const refetchAllLinks = () => { refetch(); refetchDelivery(); refetchReceiptLinks() }
  const awaiting = deliveryData?.ready && receiptLinkData?.ready
    ? (receiptsAwaitingInvoice(deliveryData.rows, receiptLinkData.map) || []).filter(g => !supplierFilter || g.supplierId === supplierFilter)
    : null
```
   Replace every `refetch()` call inside `handleSaveDraft`, `handlePreview`, `doPost`, `doVoid`, `doDelete` with `refetchAllLinks()`.
3. `openNewForReceipt`:

```js
  const openNewForReceipt = rc => {
    keySeq.current += 1
    latestFormRef.current = null; setPreview(null); setConfirm(null)
    setEditing({ id: null, loadId: null, key: keySeq.current, form: formForReceipt(rc, bangkokTodayIso()) })
  }
  // hand-off from the receive dialog / PO popup (Task 7): consume once, then open the lot's invoice
  const handoffId = navState?.newForReceipt?.receiptId || null
  useEffect(() => {
    if (!handoffId || !canEdit || !deliveryData) return
    navigateTo?.('supplier_tax_invoices', {})
    if (!deliveryData.ready) { alert(DELIVERY_NOT_READY_TEXT); return }
    const rc = deliveryData.rows.find(r => r.id === handoffId)
    if (!rc) { alert(HANDOFF_RECEIPT_NOT_FOUND_TEXT); return }
    openNewForReceipt(rc)
  }, [handoffId, canEdit, deliveryData]) // eslint-disable-line react-hooks/exhaustive-deps
```
4. `saveDraft`:

```js
  const saveDraft = async form => {
    const { header, items, poIds, receiptIds, linkKind } = toRpcPayload(form)
    const id = linkKind === 'delivery'
      ? await saveSupplierTaxInvoiceReceiptDraft(editing?.id || null, header, items, receiptIds)
      : await saveSupplierTaxInvoiceDraft(editing?.id || null, header, items, poIds)
    setEditing(e => (e ? { ...e, id } : e))
    return id
  }
```
5. `askPost` passes `postSummaryLines({ ..., poCount: preview.form.po_ids.length, receiptCount: preview.form.link_kind === 'delivery' ? preview.form.receipt_ids.length : undefined, ... })`.
6. List: `const diffBad = n.match_diff != null && !withinTolerance(n.match_diff, invoiceMatchBase(n))`; count cell: `{linkKindOf(n) === 'delivery' ? \`${(n.status === 'void' ? n.supplier_tax_invoice_receipts : n.supplier_tax_invoice_receipts.filter(l => l.active)).length} ล็อต\` : links.length}`. Remove the now-unused `poSumOf` only if nothing else uses it.
7. Awaiting card, between the filter bar and the error line:

```jsx
      {awaiting && awaiting.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>📦 ใบรับของที่รอใบกำกับ ({awaiting.reduce((s, g) => s + g.rows.length, 0)})</div>
          {awaiting.map(g => (
            <div key={g.supplierId} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{supplierNameById[g.supplierId] || '—'}</div>
              {g.rows.map(r => (
                <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, padding: '2px 0' }}>
                  <span className="font-mono">{receiptLabel(r.purchase_orders?.po_number, r.seq)}</span>
                  <span>รับ {fmtDate(r.received_date)}</span>
                  <span>มูลค่าสินค้า <span className="font-mono">{fmt(r.goods_subtotal)}</span></span>
                  {canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={() => openNewForReceipt(r)}>🧾 ลงใบกำกับ</button>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
```
8. `ViewModal`: under "ใบสั่งซื้อที่ผูก", when `linkKindOf(row) === 'delivery'` render instead:

```jsx
          <div style={{ fontWeight: 600, marginBottom: 4 }}>การส่งของที่ผูก</div>
          {(row.status === 'void' ? row.supplier_tax_invoice_receipts : row.supplier_tax_invoice_receipts.filter(l => l.active)).map(l => (
            <div key={l.id}>{receiptLabel(l.po_receipts?.purchase_orders?.po_number, l.po_receipts?.seq)} · รับ {fmtDate(l.po_receipts?.received_date)} · มูลค่าสินค้า {fmt(l.goods_subtotal)} · VAT {fmt(l.goods_vat)}</div>
          ))}
```
   and the header label `ต่างจากใบสั่งซื้อ` reads `ต่างจากมูลค่าที่รับ` for delivery rows.

- [ ] **Step 4: Verify** — vitest PASS; build OK; `run.mjs` ALL PASS; `runPo.mjs` ALL PASS (run separately). README: "Section D1/D2: delivery kind (`__deliveryReady`, `deliveryReceipts`, `receiptLinks`, `__navState`, `window.__nav`)."

- [ ] **Step 5: Commit**

```bash
git add src/pages/SupplierTaxInvoices.jsx src/components/TaxInvoicePreview.jsx scripts/tax-invoice-harness/entry.jsx scripts/tax-invoice-harness/run.mjs scripts/tax-invoice-harness/README.md
git commit -m "feat(tax-invoice): save delivery invoices, receive hand-off and the list of lots awaiting an invoice"
```

---

### Task 10: Manual subsection

**Files:** Modify `public/manual/index.html` (2.9 MB, contains giant base64 lines: NEVER print whole lines; use `grep -n -o '<h[234][^>]*>[^<]\{0,80\}'` and `awk 'NR>=415 && NR<=460 { print NR": "substr($0,1,200) }'`; edit with exact-string `Edit` calls only).

- [ ] **Step 1:** Confirm the anchors (read-only): line ~450 holds the bullet starting `<li>การจับคู่ใบกำกับภาษีซื้อ: <b>1 ใบกำกับภาษีต่อ 1 ใบสั่งซื้อ</b>`; line ~456 holds `<p class="callout"><span class="callout-icon">💬</span>` (support contact). Print them with `awk 'NR>=448 && NR<=457 { print NR": "substr($0,1,300) }' public/manual/index.html`.
- [ ] **Step 2:** Edit that bullet so its first sentence reads `การจับคู่ใบกำกับภาษีซื้อ: ปกติ <b>1 ใบกำกับภาษีต่อ 1 ใบสั่งซื้อ</b> ทำได้หลังรับของครบ — ถ้าผู้จำหน่ายส่งของเป็นล็อตและออกใบกำกับทุกล็อต ให้ตั้งใบสั่งซื้อเป็น <b>1 ใบต่อการส่งของ</b> (ข้อ 7)` (keep the rest of the line byte-identical; use the shortest unique `old_string`).
- [ ] **Step 3:** Insert immediately before the support-contact `<p class="callout">` line:

```html
         <h4>7. ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ (ส่งของเป็นล็อต)</h4>
         <ul class="features">
           <li>ตอนสร้างใบสั่งซื้อ เลือก <b>🧾 ใบกำกับภาษีของใบสั่งซื้อนี้: 1 ใบต่อการส่งของ</b> — หรือตั้งที่หน้าผู้จำหน่ายให้เป็นค่าเริ่มต้น (เช่น CAC) ใบสั่งซื้อใหม่ของผู้จำหน่ายนั้นจะเลือกให้เอง</li>
           <li>เปลี่ยนวิธีได้จากเมนู <b>⋯</b> เฉพาะก่อนรับของล็อตแรก</li>
           <li>รับของแต่ละล็อตตามปกติ (สต๊อกเข้าตอนรับของ) ติ๊ก <b>ลงใบกำกับภาษีของล็อตนี้ต่อทันที</b> (ติ๊กไว้ให้แล้ว) ระบบจะเปิดฟอร์มใบกำกับพร้อมรายการของล็อตนั้น</li>
           <li>ถ้าใบกำกับยังไม่มา เอาติ๊กออก ล็อตนั้นจะขึ้น <b>รอใบกำกับ</b> ในหน้าใบสั่งซื้อ และอยู่ในรายการ <b>📦 ใบรับของที่รอใบกำกับ</b> ที่หน้าใบกำกับภาษีผู้ขาย กด <b>🧾 ลงใบกำกับ</b> เมื่อได้ใบกำกับ</li>
           <li>ใบกำกับ 1 ใบรวมได้หลายล็อต (แม้ต่างใบสั่งซื้อ ของผู้จำหน่ายเดียวกัน) เทียบยอดได้ทั้งแบบก่อน VAT และแบบรวม VAT</li>
           <li>เมื่อบันทึก: สต๊อกของล็อตที่เลือกถูกกลับรายการและลงตามรายการในใบกำกับ ประทับเลขที่ใบกำกับเฉพาะบิลของล็อตนั้น (รวมบิลที่แยกจ่าย) — ยกเลิกใบกำกับ = คืนทุกอย่างเฉพาะล็อตนั้น</li>
         </ul>
```
- [ ] **Step 4:** Verify: `grep -c "1 ใบต่อการส่งของ" public/manual/index.html` >= 3; `git diff --stat public/manual/index.html` shows only small changes (no base64 line touched: `git diff public/manual/index.html | awk '{ if (length($0) > 400) n++ } END { print n+0 }'` prints `0`).
- [ ] **Step 5: Commit**

```bash
git add public/manual/index.html
git commit -m "docs(manual): tax invoice per delivery"
```

---

### Task 11: Whole-branch verification and owner handoff

**Files:** none new (fixes go back to the owning task's files).

- [ ] **Step 1: Whole-branch review** by a fresh reviewer on the strongest model, over `git diff main...HEAD`, with this checklist: Global Constraints line by line; Review Focus 1-5 each pinned by a passing test; every new embed names its constraint; no `REFERENCES expenses`; Task 4 Step 5 diffs re-run and empty; `'po'` code paths untouched apart from the 7 marked lines and the `receiveRoute`/`proposePos`/swap guards (each keyed on `tax_invoice_mode === 'delivery'`); fail-soft paths reviewed with the migration absent.
- [ ] **Step 2: Local gates** — `npx vitest run` (all PASS), `npm run build`, `npm run lint` if present in `package.json`, both harnesses ALL PASS (run one at a time).
- [ ] **Step 3: Controller dry runs, final** — Task 3 Step 5 and Task 4 Step 6 commands, every result recorded in the handoff (test A, test B, six regressions vs their baselines).
- [ ] **Step 4: Owner handoff note** (written into the controller's report, not a file). The controller builds ONE apply file (04 and 05 must never be live one without the other):

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/release-deposit-tax
( echo "BEGIN;"
  cat $W/supabase/migrations/2026-10-09-04-delivery-tax-invoice.sql
  cat $W/supabase/migrations/2026-10-09-05-delivery-tax-invoice-rpcs.sql
  echo "COMMIT;" ) > /Users/plfx/code/FacadeXPM/facadex-app/dti_apply_2026-10-09-04_05.sql
```
  and dry-runs exactly that file once more with `COMMIT;` swapped for test B's body + `ROLLBACK;`. The owner then applies it in one step:

```
! npx supabase db query --linked --workdir /Users/plfx/code/FacadeXPM/facadex-app -f /Users/plfx/code/FacadeXPM/facadex-app/dti_apply_2026-10-09-04_05.sql
```
  (Any error = nothing applied; report it, do not retry piecemeal.) Web deploy (build + wrangler, per the chang-ship skill) strictly AFTER the combined apply and the Step 5 checks. Delete the apply file afterwards.
- [ ] **Step 5: Post-apply ACL and body checks (controller, read-only MCP)**

```sql
SELECT p.proname, p.prosecdef, p.proconfig, p.proacl FROM pg_proc p
 WHERE p.proname IN ('_sti_check','_sti_check_po','_sti_check_delivery','_sti_receipt_movements','_sti_receipt_movements_po','_sti_receipt_movements_delivery',
                     '_sti_stamp_receipt_bills','save_supplier_tax_invoice_receipt_draft','save_supplier_tax_invoice_draft','post_supplier_tax_invoice',
                     'void_supplier_tax_invoice','sti_link_kind_guard','po_tax_invoice_mode_guard','delivery_tax_invoice_ready') ORDER BY 1;
SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'supplier_tax_invoice_receipts' ORDER BY 1, 2;
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.supplier_tax_invoice_receipts'::regclass;
SELECT proname, md5(prosrc) FROM pg_proc WHERE proname IN ('post_supplier_tax_invoice','void_supplier_tax_invoice','save_supplier_tax_invoice_draft','_sti_check_po','_sti_receipt_movements_po') ORDER BY 1;
```
  Expected: no `anon=X` and no `=X/` (PUBLIC) entry on any of them; helpers and trigger functions without `authenticated=X`; client RPCs with `authenticated=X`; table grants exactly `authenticated SELECT` (plus owner roles); RLS true; md5 values equal to the md5 of the bodies in `2026-10-09-05` (compute locally with the same python md5-of-`$$`-body snippet used in planning).
- [ ] **Step 6: Live checklist on a TEST tenant only (never the owner's real data)** — 1) suppliers page shows the default choice; set the test supplier to "1 ใบต่อการส่งของ"; 2) a new PO for it pre-selects delivery; 3) receive lot 1 with the checkbox ticked -> the invoice form opens with lot 1 ticked and its lines; preview -> post; the lot's bill shows the invoice number, the PO stays "รับบางส่วน", the other lot's bill does not; 4) receive lot 2 unticked -> PO popup shows "รอใบกำกับ" and the tax-invoice page lists it under "ใบรับของที่รอใบกำกับ"; 5) void lot 1's invoice -> bill number and stock restored; 6) a normal 'po' PO of another supplier: receive, invoice, void exactly as before; 7) open the PO list, supplier list and tax-invoice list on a 375 px phone.

---

## Spec coverage map

| Spec item | Task |
|---|---|
| 3.1 mode on PO, per-supplier default, changeable before first receipt / active invoice only | 3 (columns, guard), 6 (form, supplier page, ⋯ switch), 1 (`poModeLockedText`) |
| 3.2 link table, partial unique, named FKs, RLS/grants, POs OR receipts never both | 3, 4 (dispatcher defence) |
| 3.3 eligibility, partially received allowed, late invoice + "รอใบกำกับ" badge and list, match with both VAT bases | 1, 4, 7, 8, 9 |
| 3.4 post reverses only linked receipts' movements, stamps the receipt's bill + split children, void restores only that invoice, PO status unchanged | 4 (B5-B10) |
| 3.5 receive checkbox ticked by default, hand-off with prefilled lines, stock at receipt, `stock_from_invoice` optional | 7, 9, 1 (`formForReceipt`), 4 (B13) |
| 3.6 form switch + receipt picker with running Σ; popup per-receipt invoice and button; swap kept for 'po' only | 8, 7, 6 |
| 4 additive, locking order, receipt in posted invoice not editable/deletable, fail-soft web | 3, 4, 5, 3 (A11) |
| 6 testing list | 1, 2, 3, 4, 6-9 |
| 8 plan details: supplier default edited on the suppliers page (no bulk set), migration numbering, scan VAT basis (existing ex-VAT conversion + inclusive basis on the server), manual subsection | 6, 3/4, 8, 10 |
