import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  PEAK_EXPENSE_HEADERS, PEAK_JOURNAL_HEADERS, peakDate, peakContact,
  buildPeakExpenseRows, buildPeakJournalRows, summarizeExport,
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

describe("summarizeExport", () => {
  it("counts exported and skipped by reason", () => {
    expect(summarizeExport({ rows: [1, 2], skipped: [{ reason: "negative" }, { reason: "no_account" }, { reason: "no_account" }], noContact: 3 }))
      .toEqual({ exported: 2, skippedNegative: 1, skippedNoAccount: 2, noContact: 3, vatUnknown: 0 })
    expect(summarizeExport({ rows: [1], skipped: [], noContact: 0, vatUnknown: 2 }).vatUnknown).toBe(2)
  })
})

describe('builders with blank / tax-ID-only contacts and vatUnknown', () => {
  const exp = { id: 'e1', date: '2026-10-06', category_id: 'c1', supplier_id: 's2', amount: 107, amount_no_vat: 100, vat: 7, invoice_no: 'INV1', description: 'x' }
  const cn = { id: 'n1', doc_date: '2026-10-06', doc_number: 'CN-9', category_id: 'c1', supplier_id: 's2', amount: 107, amount_no_vat: 100, vat: 7 }
  const mk = supplier => ({ accountByCategoryId: { c1: '530306' }, supplierById: supplier ? { s2: supplier } : {} })
  const E = k => PEAK_EXPENSE_HEADERS.indexOf(k)
  const J = k => PEAK_JOURNAL_HEADERS.indexOf(k)

  it('expense: unknown supplier gives blank contact cells and counts noContact', () => {
    const { rows, noContact } = buildPeakExpenseRows([exp], mk(null))
    expect(noContact).toBe(1)
    expect(rows[0][E('ผู้รับเงิน/คู่ค้า')]).toBe(''); expect(rows[0][E('เลขทะเบียน 13 หลัก')]).toBe('')
  })
  it('expense: tax-id-only supplier fills tax id and branch, not counted as noContact', () => {
    const { rows, noContact } = buildPeakExpenseRows([exp], mk({ tax_id: '0105557083391', branch_no: '00001' }))
    expect(noContact).toBe(0)
    expect(rows[0][E('เลขทะเบียน 13 หลัก')]).toBe('0105557083391'); expect(rows[0][E('เลขสาขา 5 หลัก')]).toBe('00001')
  })
  it('journal: blank contact counted; tax-id-only used as contact', () => {
    const blank = buildPeakJournalRows([cn], mk(null))
    expect(blank.noContact).toBe(1); expect(blank.rows[0][J('ผู้ติดต่อ')]).toBe('')
    const tax = buildPeakJournalRows([cn], mk({ tax_id: '0105557083391' }))
    expect(tax.noContact).toBe(0); expect(tax.rows[0][J('ผู้ติดต่อ')]).toBe('0105557083391')
  })
  it('vatUnknown counts exported expenses with null/undefined amount_no_vat only', () => {
    const list = [exp, { ...exp, id: 'e2', amount_no_vat: null }, { ...exp, id: 'e3', amount_no_vat: undefined }, { ...exp, id: 'e4', amount_no_vat: null, category_id: 'zz' }]
    const out = buildPeakExpenseRows(list, mk({ peak_contact_no: 'C1' }))
    expect(out.rows).toHaveLength(3)
    expect(out.vatUnknown).toBe(2)
    expect(buildPeakExpenseRows([exp], mk(null)).vatUnknown).toBe(0)
  })
})
