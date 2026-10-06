# Supplier Credit Note + PEAK-format Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a company record a supplier credit note (purchase return) that reduces stock, reduces expense incl. VAT and tracks what the supplier owes back, and export expenses and credit notes as Excel files PEAK can import.

**Architecture:** Two new tables (`supplier_credit_notes` + items) and two RPCs (`confirm_`/`void_supplier_credit_note`) wrap the existing `record_stock_movement()` (new type `purchase_return`) and write a negative `expenses` row, so every existing expense total and VAT report drops automatically. PEAK export is a pair of pure builder functions (`src/lib/peakExport.js`) unit-tested against the real PEAK template headers, plus a small export dialog on the Expenses page.

**Tech Stack:** React 18 + Vite, Supabase (Postgres RPC/RLS), `xlsx`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-supplier-credit-note-peak-export-design.md`

## Global Constraints

- Additive-only migrations: new tables/columns; the one allowed replacement is widening `stock_movements_movement_type_check` and `CREATE OR REPLACE record_stock_movement` (superset of today's behaviour). No drops, renames, or data rewrites.
- **Never apply a migration yourself.** Write the `.sql` file and stop; the owner reviews, runs a `BEGIN … ROLLBACK` dry run, then applies (migrations go live the instant they are applied). Read-only checks via `SCAN DOCS/kc-yk-work/dbq.py` in the main checkout are allowed.
- Do not add columns to `expenses` (the `expenses_view` `e.*` column list freezes at creation). The credit note points at its expense via `supplier_credit_notes.expense_id`.
- Module gate: `has_module_access('purchase_orders')` in SQL, nav entry `module: 'purchase_orders'` in the UI. Role: `is_admin_or_owner()` / `minRole: 'ADMIN'`.
- Every table has `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` and RLS scoped to it. Credit-note numbers unique per `(tenant_id, supplier_id, doc_number)`, never globally.
- Thai UI strings; code and comments follow the surrounding file's style (Thai comments are normal here).
- Money: round with `round2` to 2 decimals; `amount` is VAT-inclusive, `amount_no_vat + vat = amount`.
- PEAK constants: payable `212101`, input VAT `115401`; PEAK dates `YYYYMMDD` strings; contact column = PEAK contact no., else 13-digit tax ID, else blank.
- Run `npx vitest run` before every commit; all existing tests must stay green. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Upq692foSk71qFm1jPANAh`.

## Review Focus

- Credit note whose stock line exceeds on-hand quantity: confirm must fail with a clear Thai message and change nothing (no half-posted stock/expense).
- Confirming twice / confirming a void note: second call must error, not double-post.
- Void after confirm: stock returns and the negative expense disappears; totals match pre-confirm.
- VAT rounding: prices incl. VAT (`2,140.00` -> net `2,000.00` + vat `140.00`) and a non-stock (service) line with no `inventory_item_id`.
- PEAK export of rows with missing category code / no contact / negative expense: row skipped or blanked **and counted** in the result, never silently dropped.
- Cross-tenant: tenant B cannot read/confirm tenant A's credit notes (RLS + RPC tenant check).

---

## File Structure

- Create `src/lib/creditNoteCalc.js` (+ `.test.js`) — totals, stock shortfall check, settlement→expense status map.
- Create `src/lib/peakExport.js` (+ `.test.js`) — PEAK date/headers, expense rows, credit-note journal rows, workbook download.
- Create `supabase/migrations/2026-10-06-01-supplier-credit-notes.sql` — tables, RLS, PEAK columns, stock type.
- Create `supabase/migrations/2026-10-06-02-credit-note-rpcs.sql` — confirm/void/settle RPCs.
- Modify `src/hooks/useSupabase.js` — `useSupplierCreditNotes`, `useSupplierCreditOwed`.
- Create `src/pages/SupplierCreditNotes.jsx`; modify `src/App.jsx` (nav + route).
- Modify `src/pages/PurchaseOrders.jsx` (button), `src/pages/Suppliers.jsx` (PEAK fields + owed), `src/pages/Categories.jsx` (PEAK code).
- Create `src/components/PeakExportModal.jsx`; modify `src/pages/Expenses.jsx` (open button).

---

### Task 1: Credit-note calculation helpers

**Files:**
- Create: `src/lib/creditNoteCalc.js`
- Test: `src/lib/creditNoteCalc.test.js`

**Interfaces:**
- Produces: `round2(n)`, `computeCreditNoteTotals(lines, {vatEnabled=true, vatRate=0.07, priceIncludesVat=false})` → `{amount_no_vat, vat, amount}`, `findStockShortfalls(lines, onHandByItemId)` → array of `{inventory_item_id, requested, onHand}`, `expenseStatusForSettlement(settlement)` → `'pending'|'paid'`, `SETTLEMENT_LABELS`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { round2, computeCreditNoteTotals, findStockShortfalls, expenseStatusForSettlement } from './creditNoteCalc.js'

describe('computeCreditNoteTotals', () => {
  it('adds VAT on top when prices exclude VAT', () => {
    expect(computeCreditNoteTotals([{ quantity: 2, unit_price: 1000 }]))
      .toEqual({ amount_no_vat: 2000, vat: 140, amount: 2140 })
  })
  it('splits VAT out when prices include VAT', () => {
    expect(computeCreditNoteTotals([{ quantity: 1, unit_price: 2140 }], { priceIncludesVat: true }))
      .toEqual({ amount_no_vat: 2000, vat: 140, amount: 2140 })
  })
  it('has no VAT when VAT is disabled', () => {
    expect(computeCreditNoteTotals([{ quantity: 3, unit_price: 100 }], { vatEnabled: false }))
      .toEqual({ amount_no_vat: 300, vat: 0, amount: 300 })
  })
  it('keeps net + vat = amount after rounding', () => {
    const t = computeCreditNoteTotals([{ quantity: 1, unit_price: 99.99 }], { priceIncludesVat: true })
    expect(round2(t.amount_no_vat + t.vat)).toBe(t.amount)
  })
  it('ignores blank/NaN lines', () => {
    expect(computeCreditNoteTotals([{ quantity: '', unit_price: 5 }, { quantity: 1, unit_price: 10 }], { vatEnabled: false }).amount).toBe(10)
  })
})

describe('findStockShortfalls', () => {
  it('flags lines that exceed on-hand and sums repeated items', () => {
    const lines = [{ inventory_item_id: 'a', quantity: 5 }, { inventory_item_id: 'a', quantity: 6 }, { inventory_item_id: null, quantity: 99 }]
    expect(findStockShortfalls(lines, { a: 10 })).toEqual([{ inventory_item_id: 'a', requested: 11, onHand: 10 }])
  })
  it('treats a missing balance as zero', () => {
    expect(findStockShortfalls([{ inventory_item_id: 'b', quantity: 1 }], {})).toEqual([{ inventory_item_id: 'b', requested: 1, onHand: 0 }])
  })
})

describe('expenseStatusForSettlement', () => {
  it('maps owed to pending and the rest to paid', () => {
    expect(expenseStatusForSettlement('owed')).toBe('pending')
    expect(expenseStatusForSettlement('offset')).toBe('paid')
    expect(expenseStatusForSettlement('refunded')).toBe('paid')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/creditNoteCalc.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// ============================================================
// Supplier credit note math -- pure, mirrored by the SQL RPCs
// (supabase/migrations/2026-10-06-02-credit-note-rpcs.sql) only for
// the expense status mapping; totals are computed client-side and
// stored on the credit note row, the RPC trusts them.
// ============================================================

export const SETTLEMENT_LABELS = {
  owed: 'รอรับคืน',
  offset: 'หักกับยอดจ่ายครั้งหน้า',
  refunded: 'รับคืนแล้ว',
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function computeCreditNoteTotals(lines, { vatEnabled = true, vatRate = 0.07, priceIncludesVat = false } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0))
  if (!vatEnabled) return { amount_no_vat: subtotal, vat: 0, amount: subtotal }
  if (priceIncludesVat) {
    const net = round2(subtotal / (1 + vatRate))
    return { amount_no_vat: net, vat: round2(subtotal - net), amount: subtotal }
  }
  const vat = round2(subtotal * vatRate)
  return { amount_no_vat: subtotal, vat, amount: round2(subtotal + vat) }
}

export function findStockShortfalls(lines, onHandByItemId) {
  const requested = {}
  for (const l of lines) {
    if (!l.inventory_item_id) continue
    requested[l.inventory_item_id] = (requested[l.inventory_item_id] || 0) + num(l.quantity)
  }
  return Object.entries(requested)
    .map(([id, req]) => ({ inventory_item_id: id, requested: req, onHand: num(onHandByItemId[id]) }))
    .filter(r => r.requested > r.onHand)
}

export function expenseStatusForSettlement(settlement) {
  return settlement === 'owed' ? 'pending' : 'paid'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/creditNoteCalc.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/creditNoteCalc.js src/lib/creditNoteCalc.test.js
git commit -m "feat: credit note totals/shortfall helpers"
```

---

### Task 2: PEAK export builders

**Files:**
- Create: `src/lib/peakExport.js`
- Test: `src/lib/peakExport.test.js`

**Interfaces:**
- Consumes: `round2` from `creditNoteCalc.js`.
- Produces:
  - `PEAK_EXPENSE_HEADERS`, `PEAK_JOURNAL_HEADERS` (exact template header strings), `PEAK_PAYABLE_ACCOUNT='212101'`, `PEAK_INPUT_VAT_ACCOUNT='115401'`
  - `peakDate('YYYY-MM-DD')` → `'YYYYMMDD'`
  - `peakContact(supplier)` → `{ contactNo, taxId, branch }` strings (blank if unknown)
  - `buildPeakExpenseRows(expenses, { accountByCategoryId, supplierById })` → `{ rows, skipped }` where `rows` are arrays in `PEAK_EXPENSE_HEADERS` order and `skipped` is `[{ id, reason }]` (`'negative'|'no_account'`); `contactMissing` count also returned: `{ rows, skipped, noContact }`
  - `buildPeakJournalRows(creditNotes, { accountByCategoryId, supplierById })` → `{ rows, skipped, noContact }`
  - `downloadPeakSheet(headers, rows, sheetName, filenameBase)`
- Input shapes: expense `{ id, date, invoice_no, description, category_id, supplier_id, amount, amount_no_vat, vat }`; credit note `{ id, doc_date, doc_number, category_id, supplier_id, amount, amount_no_vat, vat, notes }`; supplier `{ id, peak_contact_no, tax_id, branch_no }`.

- [ ] **Step 1: Write the failing test** (includes a guard that headers equal the real template files)

```js
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  PEAK_EXPENSE_HEADERS, PEAK_JOURNAL_HEADERS, peakDate, peakContact,
  buildPeakExpenseRows, buildPeakJournalRows,
} from './peakExport.js'

function templateHeaders(file) {
  const wb = XLSX.readFile(`docs/reference/peak-import-templates/${file}`)
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0]
}

describe('PEAK headers match the real templates', () => {
  it('expense', () => expect(PEAK_EXPENSE_HEADERS).toEqual(templateHeaders('PEAK_ImportExpense.xlsx')))
  it('journal', () => expect(PEAK_JOURNAL_HEADERS).toEqual(templateHeaders('PEAK_ImportJournal.xlsx')))
})

describe('peakDate', () => {
  it('formats ISO as YYYYMMDD', () => expect(peakDate('2026-10-06')).toBe('20261006'))
  it('returns blank for empty', () => expect(peakDate(null)).toBe(''))
})

describe('peakContact', () => {
  it('prefers peak contact no, then tax id + branch', () => {
    expect(peakContact({ peak_contact_no: 'C00007', tax_id: '0105557083391', branch_no: '00000' })).toEqual({ contactNo: 'C00007', taxId: '', branch: '' })
    expect(peakContact({ tax_id: '0105557083391', branch_no: '00001' })).toEqual({ contactNo: '', taxId: '0105557083391', branch: '00001' })
    expect(peakContact({})).toEqual({ contactNo: '', taxId: '', branch: '' })
    expect(peakContact(undefined)).toEqual({ contactNo: '', taxId: '', branch: '' })
  })
})

const ctx = { accountByCategoryId: { c1: '530306' }, supplierById: { s1: { id: 's1', peak_contact_no: 'C00001' } } }

describe('buildPeakExpenseRows', () => {
  const exp = { id: 'e1', date: '2026-10-06', invoice_no: 'IV-1', description: 'ค่าของ', category_id: 'c1', supplier_id: 's1', amount: 107, amount_no_vat: 100, vat: 7 }
  it('emits one row per expense, price excl. VAT with 7%', () => {
    const { rows, skipped, noContact } = buildPeakExpenseRows([exp], ctx)
    const h = PEAK_EXPENSE_HEADERS
    const r = Object.fromEntries(h.map((k, i) => [k, rows[0][i]]))
    expect(skipped).toEqual([]); expect(noContact).toBe(0)
    expect(r['ลำดับที่* ']).toBe(1)
    expect(r['วันที่เอกสาร']).toBe('20261006')
    expect(r['ผู้รับเงิน/คู่ค้า']).toBe('C00001')
    expect(r['ประเภทราคา']).toBe(1)
    expect(r['บัญชี']).toBe('530306')
    expect(r['ราคาต่อหน่วย']).toBe(100)
    expect(r['อัตราภาษี']).toBe(0.07)
  })
  it('uses price type 3 / NO when there is no VAT', () => {
    const { rows } = buildPeakExpenseRows([{ ...exp, vat: 0, amount_no_vat: 100, amount: 100 }], ctx)
    expect(rows[0][PEAK_EXPENSE_HEADERS.indexOf('ประเภทราคา')]).toBe(3)
    expect(rows[0][PEAK_EXPENSE_HEADERS.indexOf('อัตราภาษี')]).toBe('NO')
  })
  it('skips negative expenses and unmapped categories, counts missing contacts', () => {
    const out = buildPeakExpenseRows([
      { ...exp, id: 'neg', amount: -107, amount_no_vat: -100, vat: -7 },
      { ...exp, id: 'nocat', category_id: 'zz' },
      { ...exp, id: 'nocontact', supplier_id: null },
    ], ctx)
    expect(out.skipped).toEqual([{ id: 'neg', reason: 'negative' }, { id: 'nocat', reason: 'no_account' }])
    expect(out.rows).toHaveLength(1)
    expect(out.noContact).toBe(1)
  })
  it('falls back to amount when amount_no_vat is null', () => {
    const { rows } = buildPeakExpenseRows([{ ...exp, amount_no_vat: null, vat: null, amount: 250 }], ctx)
    expect(rows[0][PEAK_EXPENSE_HEADERS.indexOf('ราคาต่อหน่วย')]).toBe(250)
  })
})

describe('buildPeakJournalRows', () => {
  const cn = { id: 'n1', doc_date: '2026-10-06', doc_number: 'CN-9', category_id: 'c1', supplier_id: 's1', amount: 107, amount_no_vat: 100, vat: 7, notes: 'คืนกระจก' }
  it('balances: Dr payable total, Cr category net, Cr input VAT', () => {
    const { rows, skipped } = buildPeakJournalRows([cn], ctx)
    const h = PEAK_JOURNAL_HEADERS
    const col = k => h.indexOf(k)
    expect(skipped).toEqual([])
    expect(rows).toHaveLength(3)
    expect(rows[0][col('เลขที่บัญชี*')]).toBe('212101'); expect(rows[0][col('เดบิต')]).toBe(107)
    expect(rows[1][col('เลขที่บัญชี*')]).toBe('530306'); expect(rows[1][col('เครดิต')]).toBe(100)
    expect(rows[2][col('เลขที่บัญชี*')]).toBe('115401'); expect(rows[2][col('เครดิต')]).toBe(7)
    expect(rows.every(r => r[0] === 1)).toBe(true)
    expect(rows[0][col('สมุดบัญชี')]).toBe('รายวันซื้อ')
    expect(rows[0][col('อ้างอิง')]).toBe('CN-9')
  })
  it('omits the VAT line when vat is 0 and skips unmapped categories', () => {
    expect(buildPeakJournalRows([{ ...cn, vat: 0, amount: 100 }], ctx).rows).toHaveLength(2)
    expect(buildPeakJournalRows([{ ...cn, id: 'x', category_id: 'zz' }], ctx).skipped).toEqual([{ id: 'x', reason: 'no_account' }])
  })
  it('numbers each credit note separately', () => {
    const { rows } = buildPeakJournalRows([cn, { ...cn, id: 'n2', doc_number: 'CN-10' }], ctx)
    expect(rows.map(r => r[0])).toEqual([1, 1, 1, 2, 2, 2])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/peakExport.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// ============================================================
// PEAK import files (Excel) -- builders are pure so they can be
// tested without a download. Headers are copied from the templates
// in docs/reference/peak-import-templates/ (a test compares them to
// the real files). PEAK's contact column accepts only a PEAK contact
// no. or a 13-digit tax id (+5-digit branch), never a name.
// There is no PEAK credit-note template, so credit notes go out as
// journal entries (book รายวันซื้อ).
// ============================================================
import * as XLSX from 'xlsx'
import { round2 } from './creditNoteCalc.js'

export const PEAK_PAYABLE_ACCOUNT = '212101'    // เจ้าหนี้การค้า
export const PEAK_INPUT_VAT_ACCOUNT = '115401'  // ภาษีซื้อ

export const PEAK_EXPENSE_HEADERS = ['ลำดับที่* ', 'วันที่เอกสาร', 'อ้างอิงถึง', 'ผู้รับเงิน/คู่ค้า', 'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ (ถ้ามี)', 'วันที่ใบกำกับฯ (ถ้ามี)', 'วันที่บันทึกภาษีซื้อ (ถ้ามี)', 'ประเภทราคา', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี', 'หัก ณ ที่จ่าย (ถ้ามี)', 'ชำระโดย', 'จำนวนเงินที่ชำระ', 'ภ.ง.ด. (ถ้ามี)', 'หมายเหตุ', 'กลุ่มจัดประเภท']
export const PEAK_JOURNAL_HEADERS = ['ลำดับที', 'สมุดบัญชี', 'วันที่รายการ (YYYYMMDD)', 'อ้างอิง', 'ผู้ติดต่อ', 'คำอธิบายการบันทึกบัญชี', 'เลขที่บัญชี*', 'บัญชีย่อย', 'คำอธิบายรายการ (ว่างเพื่อให้ระบบใส่ให้)', 'เดบิต', 'เครดิต', 'กลุ่มจัดประเภท']

export function peakDate(iso) {
  return iso ? String(iso).slice(0, 10).replace(/-/g, '') : ''
}

export function peakContact(supplier) {
  if (!supplier) return { contactNo: '', taxId: '', branch: '' }
  if (supplier.peak_contact_no) return { contactNo: supplier.peak_contact_no, taxId: '', branch: '' }
  if (supplier.tax_id) return { contactNo: '', taxId: supplier.tax_id, branch: supplier.branch_no || '' }
  return { contactNo: '', taxId: '', branch: '' }
}

const emptyRow = n => Array(n).fill('')

function hasContact(c) { return !!(c.contactNo || c.taxId) }

export function buildPeakExpenseRows(expenses, { accountByCategoryId, supplierById }) {
  const rows = [], skipped = []
  let noContact = 0, seq = 0
  const idx = k => PEAK_EXPENSE_HEADERS.indexOf(k)
  for (const e of expenses) {
    if (Number(e.amount) < 0) { skipped.push({ id: e.id, reason: 'negative' }); continue }
    const account = accountByCategoryId[e.category_id]
    if (!account) { skipped.push({ id: e.id, reason: 'no_account' }); continue }
    const contact = peakContact(supplierById[e.supplier_id])
    if (!hasContact(contact)) noContact++
    const vat = Number(e.vat) || 0
    const net = e.amount_no_vat != null ? Number(e.amount_no_vat) : Number(e.amount)
    const r = emptyRow(PEAK_EXPENSE_HEADERS.length)
    r[idx('ลำดับที่* ')] = ++seq
    r[idx('วันที่เอกสาร')] = peakDate(e.date)
    r[idx('อ้างอิงถึง')] = e.invoice_no || ''
    r[idx('ผู้รับเงิน/คู่ค้า')] = contact.contactNo
    r[idx('เลขทะเบียน 13 หลัก')] = contact.taxId
    r[idx('เลขสาขา 5 หลัก')] = contact.branch
    r[idx('เลขที่ใบกำกับฯ (ถ้ามี)')] = e.invoice_no || ''
    r[idx('ประเภทราคา')] = vat > 0 ? 1 : 3
    r[idx('บัญชี')] = account
    r[idx('คำอธิบาย')] = e.description || ''
    r[idx('จำนวน')] = 1
    r[idx('ราคาต่อหน่วย')] = round2(net)
    r[idx('อัตราภาษี')] = vat > 0 ? 0.07 : 'NO'
    rows.push(r)
  }
  return { rows, skipped, noContact }
}

export function buildPeakJournalRows(creditNotes, { accountByCategoryId, supplierById }) {
  const rows = [], skipped = []
  let noContact = 0, seq = 0
  const col = k => PEAK_JOURNAL_HEADERS.indexOf(k)
  for (const n of creditNotes) {
    const account = accountByCategoryId[n.category_id]
    if (!account) { skipped.push({ id: n.id, reason: 'no_account' }); continue }
    const contact = peakContact(supplierById[n.supplier_id])
    if (!hasContact(contact)) noContact++
    seq++
    const line = (acct, debit, credit, first) => {
      const r = emptyRow(PEAK_JOURNAL_HEADERS.length)
      r[0] = seq
      if (first) {
        r[col('สมุดบัญชี')] = 'รายวันซื้อ'
        r[col('วันที่รายการ (YYYYMMDD)')] = peakDate(n.doc_date)
        r[col('อ้างอิง')] = n.doc_number || ''
        r[col('ผู้ติดต่อ')] = contact.contactNo || contact.taxId
        r[col('คำอธิบายการบันทึกบัญชี')] = `ใบลดหนี้ซัพพลายเออร์ ${n.doc_number || ''}${n.notes ? ' - ' + n.notes : ''}`.trim()
      }
      r[col('เลขที่บัญชี*')] = acct
      if (debit) r[col('เดบิต')] = round2(debit)
      if (credit) r[col('เครดิต')] = round2(credit)
      return r
    }
    rows.push(line(PEAK_PAYABLE_ACCOUNT, n.amount, 0, true))
    rows.push(line(account, 0, n.amount_no_vat, false))
    if (Number(n.vat) > 0) rows.push(line(PEAK_INPUT_VAT_ACCOUNT, 0, n.vat, false))
  }
  return { rows, skipped, noContact }
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function downloadPeakSheet(headers, rows, sheetName, filenameBase) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `${filenameBase}_${stamp()}.xlsx`)
}
```

Note: the credit-note journal can carry a contact-less row (PEAK blanks it); a journal contact of tax id is allowed by PEAK's "ผู้ติดต่อ" only if it is a contact no., so a note with only a tax id exports that tax id and PEAK may blank it — this is acceptable and counted in `noContact` only when both are empty.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/peakExport.test.js`
Expected: PASS. If a header test fails, the template differs from the plan's copy: fix the constant to equal the template (the template is authoritative).

- [ ] **Step 5: Commit**

```bash
git add src/lib/peakExport.js src/lib/peakExport.test.js
git commit -m "feat: PEAK import-format builders (expense + credit-note journal)"
```

---

### Task 3: Migration 1 — tables, PEAK columns, stock movement type

**Files:**
- Create: `supabase/migrations/2026-10-06-01-supplier-credit-notes.sql`

**Interfaces:**
- Produces tables `supplier_credit_notes` (`id, tenant_id, supplier_id, site_id, doc_number, doc_date, po_id, original_expense_id, category_id, amount_no_vat, vat, amount, settlement_status, settled_at, notes, status, expense_id, created_by, created_at, confirmed_at`), `supplier_credit_note_items` (`id, tenant_id, credit_note_id, inventory_item_id, description, quantity, unit, unit_price`); columns `suppliers.peak_contact_no/tax_id/branch_no`, `expense_categories.peak_account_code`; `purchase_return` movement type in the CHECK and in `record_stock_movement()`.

- [ ] **Step 1: Read-only schema facts** (do not skip; the SQL below assumes these and must be adjusted if they differ)

From the main checkout (`/Users/plfx/code/FacadeXPM/facadex-app/SCAN DOCS/kc-yk-work`), run:
`python3 dbq.py /tmp/ex_cols.json "select column_name,data_type,is_nullable,column_default from information_schema.columns where table_name='expenses' order by ordinal_position"` and
`python3 dbq.py /tmp/ex_st.json "select distinct status from expenses"` and
`python3 dbq.py /tmp/ex_ck.json "select conname,pg_get_constraintdef(oid) from pg_constraint where conrelid='expenses'::regclass"` and
`python3 dbq.py /tmp/ex_ck2.json "select conname,pg_get_constraintdef(oid) from pg_constraint where conrelid='stock_movements'::regclass and contype='c'"`.
Record in the commit message body: required (NOT NULL, no default) `expenses` columns, valid `status` values (expected to include `pending` and `paid`), whether any CHECK forbids negative `amount`, and the exact stock_movements CHECK name (expected `stock_movements_movement_type_check`). If a negative `amount` is forbidden or `paid`/`pending` are not valid statuses, STOP and report to the controller instead of continuing.

- [ ] **Step 2: Write the migration**

```sql
-- ============================================================
-- Supplier credit notes (purchase returns) + PEAK mapping columns.
-- Spec: docs/superpowers/specs/2026-10-06-supplier-credit-note-peak-export-design.md
-- Additive only, except widening the stock_movements type CHECK and
-- CREATE OR REPLACE of record_stock_movement() (a superset).
-- Does NOT touch expenses/expenses_view (e.* freezes its column list).
-- ============================================================

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS peak_contact_no TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_id TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS branch_no TEXT;
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS peak_account_code TEXT;

CREATE TABLE supplier_credit_notes (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  doc_number          TEXT NOT NULL,
  doc_date            DATE NOT NULL,
  po_id               UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  original_expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL,
  category_id         UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_no_vat       NUMERIC NOT NULL CHECK (amount_no_vat >= 0),
  vat                 NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  amount              NUMERIC NOT NULL CHECK (amount >= 0),
  settlement_status   TEXT NOT NULL DEFAULT 'owed' CHECK (settlement_status IN ('owed', 'offset', 'refunded')),
  settled_at          TIMESTAMPTZ,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'void')),
  expense_id          UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, supplier_id, doc_number)
);
CREATE INDEX idx_scn_tenant ON supplier_credit_notes(tenant_id);
CREATE INDEX idx_scn_supplier ON supplier_credit_notes(supplier_id);

CREATE TABLE supplier_credit_note_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  credit_note_id    UUID NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE CASCADE,
  inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE RESTRICT,
  description       TEXT NOT NULL,
  quantity          NUMERIC NOT NULL CHECK (quantity > 0),
  unit              TEXT,
  unit_price        NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX idx_scni_note ON supplier_credit_note_items(credit_note_id);

ALTER TABLE supplier_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_note_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON supplier_credit_notes FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_full_access ON supplier_credit_note_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- A confirmed/void note is immutable except via the RPCs (which run as definer).
CREATE OR REPLACE FUNCTION scn_block_edit_when_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'credit_note_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scn_lock_update BEFORE UPDATE OR DELETE ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION scn_block_edit_when_posted();

-- New stock movement type
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment', 'purchase_return'));

-- record_stock_movement(): identical to 2026-09-05-15 plus purchase_return
-- (decrease at the item's current average cost; refuses to go below zero).
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

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment', 'sale_out', 'sale_reversal', 'purchase_return') THEN
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
  ELSIF p_movement_type = 'purchase_return' THEN
    IF p_quantity > v_old_qty THEN
      RAISE EXCEPTION 'insufficient_stock';
    END IF;
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := COALESCE(p_unit_cost, v_old_wac);
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

Before writing, diff the function body against the **current** one in the database (`select pg_get_functiondef('record_stock_movement'::regprocedure)` via `dbq.py`) — if a later migration changed it, keep those changes and add only the `purchase_return` pieces. Also check that no migration after `2026-09-05-15` replaced it: `grep -ln "FUNCTION record_stock_movement" supabase/migrations/*.sql`.

- [ ] **Step 3: Static check**

Run: `grep -c "purchase_return" supabase/migrations/2026-10-06-01-supplier-credit-notes.sql`
Expected: 4 or more. Do NOT apply. Include in the final report the exact dry-run command for the owner: `printf 'BEGIN;\n' > /tmp/dry.sql; cat <file> >> /tmp/dry.sql; printf '\nROLLBACK;\n' >> /tmp/dry.sql; npx supabase db query --linked -f /tmp/dry.sql`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-06-01-supplier-credit-notes.sql
git commit -m "feat(db): supplier credit note tables, PEAK columns, purchase_return movement type"
```

---

### Task 4: Migration 2 — confirm / void / settle RPCs

**Files:**
- Create: `supabase/migrations/2026-10-06-02-credit-note-rpcs.sql`

**Interfaces:**
- Consumes: tables/columns from Task 3; `record_stock_movement`.
- Produces: `confirm_supplier_credit_note(p_id UUID) RETURNS UUID` (the negative expense id), `void_supplier_credit_note(p_id UUID) RETURNS VOID`, `set_credit_note_settlement(p_id UUID, p_settlement TEXT) RETURNS VOID`. Errors (exception message strings the UI maps to Thai): `credit_note_not_found`, `not_draft`, `not_confirmed`, `insufficient_stock`, `insufficient_privilege`, `bad_settlement`.

Adjust the `expenses` column list in `confirm_` to the facts recorded in Task 3 Step 1 (add any NOT NULL columns; drop any column that does not exist).

- [ ] **Step 1: Write the migration**

```sql
-- Supplier credit note RPCs. All run as definer but re-check tenant + role.

CREATE OR REPLACE FUNCTION confirm_supplier_credit_note(p_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  it RECORD;
  v_wac NUMERIC;
  v_exp UUID;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;

  FOR it IN SELECT * FROM supplier_credit_note_items
            WHERE credit_note_id = p_id AND inventory_item_id IS NOT NULL LOOP
    SELECT weighted_average_cost INTO v_wac FROM inventory_stock_balances
      WHERE inventory_item_id = it.inventory_item_id AND site_id = cn.site_id;
    PERFORM record_stock_movement(it.inventory_item_id, cn.site_id, 'purchase_return',
      it.quantity, COALESCE(v_wac, 0), 'supplier_credit_note', p_id, 'ใบลดหนี้ ' || cn.doc_number);
  END LOOP;

  INSERT INTO expenses (tenant_id, date, site_id, category_id, supplier_id, description,
                        amount, amount_no_vat, vat, invoice_no, status, notes)
  VALUES (v_tenant, cn.doc_date, cn.site_id, cn.category_id, cn.supplier_id,
          'ใบลดหนี้ ' || cn.doc_number,
          -cn.amount, -cn.amount_no_vat, -cn.vat, cn.doc_number,
          CASE WHEN cn.settlement_status = 'owed' THEN 'pending' ELSE 'paid' END,
          cn.notes)
  RETURNING id INTO v_exp;

  UPDATE supplier_credit_notes
     SET status = 'confirmed', expense_id = v_exp, confirmed_at = now()
   WHERE id = p_id;
  RETURN v_exp;
END $$;

CREATE OR REPLACE FUNCTION void_supplier_credit_note(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  mv RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'confirmed' THEN RAISE EXCEPTION 'not_confirmed'; END IF;

  FOR mv IN SELECT inventory_item_id, quantity, unit_cost FROM stock_movements
            WHERE tenant_id = v_tenant AND reference_type = 'supplier_credit_note'
              AND reference_id = p_id AND movement_type = 'purchase_return' LOOP
    PERFORM record_stock_movement(mv.inventory_item_id, cn.site_id, 'purchase_in',
      mv.quantity, mv.unit_cost, 'supplier_credit_note_void', p_id, 'ยกเลิกใบลดหนี้ ' || cn.doc_number);
  END LOOP;

  DELETE FROM expenses WHERE id = cn.expense_id AND tenant_id = v_tenant;
  UPDATE supplier_credit_notes SET status = 'void', expense_id = NULL WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION set_credit_note_settlement(p_id UUID, p_settlement TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_settlement NOT IN ('owed', 'offset', 'refunded') THEN RAISE EXCEPTION 'bad_settlement'; END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'confirmed' THEN RAISE EXCEPTION 'not_confirmed'; END IF;
  UPDATE supplier_credit_notes
     SET settlement_status = p_settlement,
         settled_at = CASE WHEN p_settlement = 'owed' THEN NULL ELSE now() END
   WHERE id = p_id;
  UPDATE expenses SET status = CASE WHEN p_settlement = 'owed' THEN 'pending' ELSE 'paid' END
   WHERE id = cn.expense_id AND tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION confirm_supplier_credit_note(UUID), void_supplier_credit_note(UUID),
  set_credit_note_settlement(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_supplier_credit_note(UUID), void_supplier_credit_note(UUID),
  set_credit_note_settlement(UUID, TEXT) TO authenticated;
```

Important: the `scn_block_edit_when_posted` trigger from Task 3 blocks edits when `current_user = 'authenticated'`; SECURITY DEFINER functions run as the function owner (postgres), so the RPC updates pass. Verify this assumption in the dry-run (Step 3).

- [ ] **Step 2: Static check**

Run: `grep -c "SECURITY DEFINER" supabase/migrations/2026-10-06-02-credit-note-rpcs.sql` — Expected: `3`.

- [ ] **Step 3: Hand off for dry run (owner)**

Do NOT apply. In the report give the owner this scratch-tenant verification script (to run after applying both migrations to CHANG on a throwaway tenant or inside `BEGIN … ROLLBACK`): create a note with one stock line > on-hand → `confirm` raises `insufficient_stock` and leaves stock/expenses unchanged; with a valid line → stock down by qty, one negative expense exists, `confirm` again raises `not_draft`; `void` → stock restored, expense gone; `set_credit_note_settlement` flips the expense `status`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-06-02-credit-note-rpcs.sql
git commit -m "feat(db): confirm/void/settle RPCs for supplier credit notes"
```

---

### Task 5: Hooks, credit-note page, navigation

**Files:**
- Modify: `src/hooks/useSupabase.js` (append after `usePurchaseOrders`)
- Create: `src/pages/SupplierCreditNotes.jsx`
- Modify: `src/App.jsx` (lazy import near line 32, nav entry in the 💸 รายจ่าย group near line 72, `case` near line 378)

**Interfaces:**
- Consumes: `computeCreditNoteTotals`, `findStockShortfalls`, `SETTLEMENT_LABELS` (Task 1); RPCs (Task 4); existing `useSuppliers`, `useSites`, `useCategories`, `useQuery`, `Modal`, `ConfirmDialog`, `SearchableSelect`, `fmt` and `supabase` from `../lib/supabase.js`.
- Produces: `useSupplierCreditNotes(filters)` → `{ data, loading, error, refetch }` rows with `suppliers(name)`, `sites(name)`, `supplier_credit_note_items(*)`; `useInventoryOnHand(siteId)` → `{ [inventory_item_id]: quantity_on_hand }`; page default export `SupplierCreditNotes({ prefill })` where `prefill` (optional) `{ supplier_id, site_id, po_id, category_id, items:[{inventory_item_id, description, quantity, unit, unit_price}] }` opens the form pre-filled (used by Task 6).

Follow `src/pages/Cheques.jsx` for page layout, table, `Modal`/`ConfirmDialog` usage, `useQuery` refetch pattern, and error `alert()` style; read it and `src/components/Modal.jsx` and `src/components/SearchableSelect.jsx` first for exact prop names.

- [ ] **Step 1: Add the hooks** (match how `usePurchaseOrders` is written; `useQuery` returns `{ data, loading, error, refetch }` — confirm by reading lines 12-55)

```js
export function useSupplierCreditNotes(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('supplier_credit_notes')
        .select('*, suppliers(name, supplier_number), sites(name), expense_categories(name), supplier_credit_note_items(id, inventory_item_id, description, quantity, unit, unit_price)')
        .order('doc_date', { ascending: false })
        .order('id', { ascending: false })
      if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
      if (filters.status)     q = q.eq('status', filters.status)
      if (filters.settlement) q = q.eq('settlement_status', filters.settlement)
      return q
    }
    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

/** Quantity on hand per inventory item at one site (for the return shortfall check). */
export function useInventoryOnHand(siteId) {
  return useQuery(async () => {
    if (!siteId) return {}
    const { data, error } = await supabase
      .from('inventory_stock_balances')
      .select('inventory_item_id, quantity_on_hand')
      .eq('site_id', siteId)
    if (error) throw error
    return Object.fromEntries((data || []).map(r => [r.inventory_item_id, Number(r.quantity_on_hand)]))
  }, [siteId])
}
```

- [ ] **Step 2: Build the page.** Required behaviour (write it in the Cheques.jsx style):
  - List: columns เลขที่, วันที่, ซัพพลายเออร์, ไซต์, ยอดรวม (`fmt`), สถานะเอกสาร (ร่าง/ยืนยันแล้ว/ยกเลิก), สถานะเงิน (`SETTLEMENT_LABELS`), row actions: แก้ไข (draft only), ยืนยัน (draft), ยกเลิก (confirmed), เปลี่ยนสถานะเงิน (confirmed). Filters: supplier select, document status.
  - Form modal fields: ซัพพลายเออร์ (required), ไซต์ (required), เลขที่ใบลดหนี้ (required), วันที่ (default `bangkokTodayIso()`), หมวดหมู่ (required), ผูก PO (optional select from `usePurchaseOrders({supplierId})`), checkbox "มี VAT" (default on), checkbox "ราคารวม VAT แล้ว", notes, and an editable lines table (inventory item via `SearchableSelect` from the inventory items list, or free-text description for non-stock lines; quantity; unit; unit price). Live totals from `computeCreditNoteTotals`.
  - Save draft (insert/update `supplier_credit_notes` + replace items: delete then insert items) and "บันทึกและยืนยัน" (save then call confirm).
  - Before confirm, run `findStockShortfalls(lines, onHand)` using `useInventoryOnHand(form.site_id)`; if any, block with a Thai message naming the items and quantities (the RPC is the final authority).
  - RPC error mapping:

```js
const CN_ERRORS = {
  insufficient_stock: 'สต็อกไม่พอสำหรับคืนสินค้า — ตรวจจำนวนในรายการอีกครั้ง',
  not_draft: 'ใบลดหนี้นี้ยืนยันหรือยกเลิกไปแล้ว',
  not_confirmed: 'ใบลดหนี้นี้ยังไม่ได้ยืนยัน',
  credit_note_not_found: 'ไม่พบใบลดหนี้',
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้',
}
const cnErrorText = e => CN_ERRORS[(e?.message || '').split(':')[0].trim()] || e?.message || 'เกิดข้อผิดพลาด'
async function confirmNote(id) {
  const { error } = await supabase.rpc('confirm_supplier_credit_note', { p_id: id })
  if (error) throw new Error(cnErrorText(error))
}
async function voidNote(id) {
  const { error } = await supabase.rpc('void_supplier_credit_note', { p_id: id })
  if (error) throw new Error(cnErrorText(error))
}
async function setSettlement(id, p_settlement) {
  const { error } = await supabase.rpc('set_credit_note_settlement', { p_id: id, p_settlement })
  if (error) throw new Error(cnErrorText(error))
}
```
  - Duplicate `(supplier, doc_number)` insert error (`23505`) → show "เลขที่ใบลดหนี้นี้มีอยู่แล้วสำหรับซัพพลายเออร์นี้".
  - `prefill` prop opens the form once on mount with those values.
  - Wrap writes in try/catch with the page's existing error pattern; refetch after every success.

- [ ] **Step 3: Wire navigation.** In `src/App.jsx`: `const SupplierCreditNotes = lazy(() => import('./pages/SupplierCreditNotes.jsx'))` next to the other lazies; add `{ id: 'supplier_credit_notes', label: '↩️ ใบลดหนี้ซัพพลายเออร์', minRole: 'ADMIN', module: 'purchase_orders' },` after the `purchase_orders` entry; add `case 'supplier_credit_notes': return <SupplierCreditNotes {...props} />` after the `purchase_orders` case. Check whether `PackageComparison.jsx`/any tab-id allow-list (grep `'purchase_orders'` across `src/`) needs the new id and add it where tab ids are enumerated.

- [ ] **Step 4: Verify**

Run: `npx vitest run` — Expected: all pass. Run: `npm run build` — Expected: success (catches import/JSX errors). Run the dev server already running (`b9f3dgkr4` is for another worktree — start a separate `npm run dev -- --port 5180` in this worktree if you need a browser check) and confirm the page renders and the list shows the empty state; creating/confirming needs the migrations applied, so report that part as **not live-verified** rather than claiming it.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/SupplierCreditNotes.jsx src/App.jsx
git commit -m "feat: supplier credit notes page, hooks and navigation"
```

---

### Task 6: Entry points — PO button and supplier credit owed

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx` (row actions area; the PO rows already carry `purchase_order_items` with `inventory_item_id`, `description`, `quantity`, `unit`, `unit_price`)
- Modify: `src/pages/Suppliers.jsx`
- Modify: `src/App.jsx` only if page-to-page navigation needs a prefill channel (see Step 1)

**Interfaces:**
- Consumes: `SupplierCreditNotes` `prefill` prop (Task 5), `useSupplierCreditNotes`, `SETTLEMENT_LABELS`.
- Produces: "สร้างใบลดหนี้" row action on received POs; "ยอดรอรับคืน" figure on the supplier row.

- [ ] **Step 1: PO action.** Read how `App.jsx` passes `props` and how other pages navigate (grep `setActiveTab` / `onNavigate` in `src/pages/*.jsx`). Implement the smallest mechanism that lets the PO row open the credit-note form pre-filled: render `<Modal>` containing the credit-note form is NOT allowed (no nested modals), so navigate: store the prefill object in a small module-level holder `src/lib/creditNotePrefill.js`:

```js
let pending = null
export const setCreditNotePrefill = p => { pending = p }
export const takeCreditNotePrefill = () => { const p = pending; pending = null; return p }
```
  PO action builds `{ supplier_id, site_id, po_id, category_id, items }` from the PO row (items mapped from `purchase_order_items`, quantity defaulting to the ordered quantity), calls `setCreditNotePrefill`, then navigates to `supplier_credit_notes`. In `SupplierCreditNotes`, replace the `prefill` prop read with `takeCreditNotePrefill()` on mount (keep the prop as an override). Only show the action when `po.status` is the received status — read the file for the real status value.

- [ ] **Step 2: Supplier owed.** On `Suppliers.jsx`, call `useSupplierCreditNotes({ settlement: 'owed' })`, keep only `status === 'confirmed'`, sum `amount` per `supplier_id`, and show "รอรับคืน ฿X" on suppliers with a non-zero sum (same cell style as other badges in the file).

- [ ] **Step 3: Test the pure part.** Add `src/lib/creditNotePrefill.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { setCreditNotePrefill, takeCreditNotePrefill } from './creditNotePrefill.js'
describe('creditNotePrefill', () => {
  it('hands the value over exactly once', () => {
    setCreditNotePrefill({ po_id: 'p1' })
    expect(takeCreditNotePrefill()).toEqual({ po_id: 'p1' })
    expect(takeCreditNotePrefill()).toBeNull()
  })
})
```

- [ ] **Step 4: Verify** — `npx vitest run` passes; `npm run build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/creditNotePrefill.js src/lib/creditNotePrefill.test.js src/pages/PurchaseOrders.jsx src/pages/Suppliers.jsx src/pages/SupplierCreditNotes.jsx src/App.jsx
git commit -m "feat: create credit note from a PO; show supplier credit owed"
```

---

### Task 7: PEAK mapping fields (category account, supplier contact)

**Files:**
- Modify: `src/pages/Categories.jsx` (category edit form)
- Modify: `src/pages/Suppliers.jsx` (supplier form)
- Modify: `src/hooks/useSupabase.js` (add `setCategoryPeakCode`)

**Interfaces:**
- Produces: `setCategoryPeakCode(categoryId, code)`; supplier form saves `peak_contact_no`, `tax_id`, `branch_no`.

- [ ] **Step 1: Validation helper + test.** Create `src/lib/peakFields.js` and `src/lib/peakFields.test.js`:

```js
// peakFields.js
export const isPeakAccountCode = s => /^\d{6}$/.test(String(s || '').trim())
export const isTaxId13 = s => /^\d{13}$/.test(String(s || '').trim())
export const isBranch5 = s => /^\d{5}$/.test(String(s || '').trim())
```
```js
// peakFields.test.js
import { describe, it, expect } from 'vitest'
import { isPeakAccountCode, isTaxId13, isBranch5 } from './peakFields.js'
describe('peak field validators', () => {
  it('accepts exactly 6 / 13 / 5 digits', () => {
    expect(isPeakAccountCode('530306')).toBe(true)
    expect(isPeakAccountCode('53030')).toBe(false)
    expect(isTaxId13('0105557083391')).toBe(true)
    expect(isTaxId13('010555708339')).toBe(false)
    expect(isBranch5('00000')).toBe(true)
    expect(isBranch5('0')).toBe(false)
  })
  it('rejects blanks and non-digits', () => {
    expect(isPeakAccountCode('')).toBe(false)
    expect(isTaxId13('01055570833ab')).toBe(false)
  })
})
```
Run `npx vitest run src/lib/peakFields.test.js` — fail first (module missing), then pass after creating the file.

- [ ] **Step 2: Hook**

```js
export async function setCategoryPeakCode(categoryId, code) {
  const { error } = await supabase
    .from('expense_categories')
    .update({ peak_account_code: code || null })
    .eq('id', categoryId)
  if (error) throw error
}
```

- [ ] **Step 3: UI.** In `Categories.jsx` add a 6-digit "รหัสบัญชี PEAK" input per category row/edit form (blank allowed; a non-blank value must pass `isPeakAccountCode` or the save is refused with "รหัสบัญชีต้องเป็นตัวเลข 6 หลัก"); follow how `setCategoryUseForDeduction` is wired. In the supplier form add three optional inputs: "รหัสผู้ติดต่อ PEAK", "เลขประจำตัวผู้เสียภาษี (13 หลัก)", "สาขา (5 หลัก)" with the same validators ("ใส่ครบ 13 หลัก", "ใส่ครบ 5 หลัก"), saved through the page's existing supplier save call. Do not touch the backfill/"DBD lookup" idea; those inputs are just manual fields.

- [ ] **Step 4: Verify** — `npx vitest run`, `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/peakFields.js src/lib/peakFields.test.js src/pages/Categories.jsx src/pages/Suppliers.jsx src/hooks/useSupabase.js
git commit -m "feat: PEAK account code on categories, PEAK contact fields on suppliers"
```

---

### Task 8: PEAK export dialog on the Expenses page

**Files:**
- Create: `src/components/PeakExportModal.jsx`
- Modify: `src/pages/Expenses.jsx` (add a "ส่งออก PEAK" button near the existing Excel export button)

**Interfaces:**
- Consumes: `buildPeakExpenseRows`, `buildPeakJournalRows`, `downloadPeakSheet`, `PEAK_EXPENSE_HEADERS`, `PEAK_JOURNAL_HEADERS` (Task 2); `useCategories`, `useSuppliers`, `useExpenses`, `useSupplierCreditNotes`.
- Produces: modal with date range (from/to), button "ดาวน์โหลดไฟล์รายจ่าย" and "ดาวน์โหลดไฟล์ใบลดหนี้ (journal)", and a result summary.

- [ ] **Step 1: Summary helper + test.** Add to `src/lib/peakExport.js`:

```js
export function summarizeExport({ rows, skipped, noContact }) {
  return {
    exported: rows.length,
    skippedNegative: skipped.filter(s => s.reason === 'negative').length,
    skippedNoAccount: skipped.filter(s => s.reason === 'no_account').length,
    noContact,
  }
}
```
and in `peakExport.test.js`:
```js
import { summarizeExport } from './peakExport.js'
describe('summarizeExport', () => {
  it('counts exported and skipped by reason', () => {
    expect(summarizeExport({ rows: [1, 2], skipped: [{ reason: 'negative' }, { reason: 'no_account' }, { reason: 'no_account' }], noContact: 3 }))
      .toEqual({ exported: 2, skippedNegative: 1, skippedNoAccount: 2, noContact: 3 })
  })
})
```
Note the journal builder emits several rows per note, so for the journal "exported" counts rows not notes; label it "แถว" in the UI.

- [ ] **Step 2: Modal.** Build `PeakExportModal({ onClose })` with `Modal` (maxWidth ~460). On a button click: fetch rows for the date range (expenses: `useExpenses({ from, to })` data filtered client-side; credit notes: confirmed only, `doc_date` within range), build `accountByCategoryId = Object.fromEntries(categories.filter(c => c.peak_account_code).map(c => [c.id, c.peak_account_code]))` and `supplierById`, call the builder, show the summary in Thai ("ส่งออก N รายการ · ข้าม X ใบ (ยอดติดลบ) · Y รายการไม่มีรหัสบัญชี PEAK · Z รายการไม่มีผู้ติดต่อ (PEAK จะเว้นว่าง)"), then call `downloadPeakSheet(PEAK_EXPENSE_HEADERS, rows, 'Import_Expenses', 'PEAK_expenses')` / `downloadPeakSheet(PEAK_JOURNAL_HEADERS, rows, 'Import Multiple Journal', 'PEAK_credit_notes')`. Disable download when `rows` is empty and say why. Show one notice line in the modal: "ตรวจไฟล์ก่อนนำเข้า PEAK ทุกครั้ง" (do not claim anything about PEAK per-document credit cost; it is unverified)..

- [ ] **Step 3: Button + verify.** Add the button and `showPeakExport` state in `Expenses.jsx`; `npx vitest run`, `npm run build`. In the dev server, open the modal and download both files with an empty/mapped dataset; open the downloaded `.xlsx` and compare the header row to `docs/reference/peak-import-templates/*`. Report the PEAK import itself as **not verified** (no PEAK access this session) — the owner must try one file in PEAK before relying on it.

- [ ] **Step 4: Commit**

```bash
git add src/components/PeakExportModal.jsx src/pages/Expenses.jsx src/lib/peakExport.js src/lib/peakExport.test.js
git commit -m "feat: PEAK export dialog (expenses + credit-note journal)"
```

---

### Task 9: Final report and owner handoff (no code)

- [ ] **Step 1:** Run `npx vitest run` and `npm run build` on the branch tip; report counts.
- [ ] **Step 2:** Write `docs/superpowers/plans/2026-10-06-supplier-credit-note-peak-export-handoff.md` listing: the two migration files and their dry-run command, the verification script from Task 4 Step 3, what is verified vs not (PEAK import of the files, live RPC behaviour), and the follow-ups left out (income/invoice export, DBD tax-ID lookup, settings for the two PEAK constants). Commit it.
- [ ] **Step 3:** Do not merge or push; the controller asks the owner after the whole arc is done (memory: branch merge timing).
