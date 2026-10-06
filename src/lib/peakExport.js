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
  let noContact = 0, vatUnknown = 0, seq = 0
  const idx = k => PEAK_EXPENSE_HEADERS.indexOf(k)
  for (const e of expenses) {
    if (Number(e.amount) < 0) { skipped.push({ id: e.id, reason: 'negative' }); continue }
    const account = accountByCategoryId[e.category_id]
    if (!account) { skipped.push({ id: e.id, reason: 'no_account' }); continue }
    const contact = peakContact(supplierById[e.supplier_id])
    if (!hasContact(contact)) noContact++
    const vat = Number(e.vat) || 0
    if (e.amount_no_vat == null) vatUnknown++ // exported as gross, no VAT
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
  return { rows, skipped, noContact, vatUnknown }
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
        r[col('คำอธิบายการบันทึกบัญชี')] = `ใบลดหนี้ซัพพลายเออร์ ${n.doc_number || ''}${n.original_invoice_no ? ' อ้างถึงใบกำกับ ' + n.original_invoice_no : ''}${n.notes ? ' - ' + n.notes : ''}`.trim()
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

export function summarizeExport({ rows, skipped, noContact, vatUnknown = 0 }) {
  return {
    exported: rows.length,
    skippedNegative: skipped.filter(s => s.reason === "negative").length,
    skippedNoAccount: skipped.filter(s => s.reason === "no_account").length,
    noContact,
    vatUnknown,
  }
}
