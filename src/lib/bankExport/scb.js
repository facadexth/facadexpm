// SCB Business Anywhere (CPX) payroll upload file. Layout: reference doc §2.
// Pipe-delimited, UTF-8 without BOM, CRLF between lines, none after TRAILR.
import { BANKS, scbCheckDigitOk, validateAccount } from './banks.js'

const pad = n => String(n).padStart(2, '0')
const money = n => (Math.round(Number(n) * 100) / 100).toFixed(2)
const BANNED = /[!"#$%&*+;<=>?@[\\\]^_`{|}~]/
const CTRL = /[\x00-\x1F\x7F]/
const REF_OK = /^[A-Za-z0-9 \-():\/',.^#]{1,20}$/ // reference §2.2 col F (| excluded: breaks the pipe format)
const NEXT_DAY = ['SPN']
const PRODUCTS = ['SPN', 'SPS', 'PAY']

const stamp = d => `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function rowError(r, product) {
  if (!r.bank_code || !r.account) return 'ยังไม่มีเลขบัญชี'
  if (!r.name || BANNED.test(r.name) || CTRL.test(r.name) || r.name.length > 140 || r.name.startsWith(' ')) return 'ชื่อบัญชีมีอักขระที่ธนาคารไม่รับ'
  if (r.ref && (!REF_OK.test(r.ref) || CTRL.test(r.ref))) return `รหัสอ้างอิง/รหัสพนักงาน "${r.ref}" มีตัวอักษรที่ธนาคารไม่รับ หรือยาวเกิน 20 ตัว`
  if (r.email && (CTRL.test(r.email) || r.email.includes('|'))) return 'อีเมลมีอักขระที่ธนาคารไม่รับ'
  if (!(Number(r.amount) > 0)) return 'ยอดจ่ายต้องมากกว่า 0'
  if (product === 'PAY' && r.bank_code !== '014') return 'PAY จ่ายได้เฉพาะบัญชีไทยพาณิชย์'
  if (product !== 'PAY' && !BANKS.some(b => b.code === r.bank_code)) return `ไม่รู้จักรหัสธนาคาร ${r.bank_code}`
  const acct = validateAccount(r.bank_code, r.account)
  if (acct) return acct
  if (product !== 'PAY') {
    if (!/^\d{4}$/.test(r.branch || '')) return 'ไม่มีรหัสสาขา 4 หลัก'
    if (r.bank_code !== '014' && Number(r.amount) > 2000000) return 'ยอดเกิน 2,000,000 บาท (ต่างธนาคาร)'
  }
  return null
}

export function buildScbPayrollFile({ settings, valueDate, now = new Date(), rows }) {
  const { product, debit_account, fee_account, fee_charge, system_ref } = settings
  if (!PRODUCTS.includes(product)) throw new Error('บริการไม่ถูกต้อง (ต้องเป็น SPN, SPS หรือ PAY)')
  if (!['OUR', 'BEN'].includes(fee_charge)) throw new Error('ผู้จ่ายค่าธรรมเนียมไม่ถูกต้อง')
  if (!scbCheckDigitOk(debit_account)) throw new Error('บัญชีต้นทาง (ไทยพาณิชย์) ไม่ถูกต้อง')
  if (!scbCheckDigitOk(fee_account)) throw new Error('บัญชีหักค่าธรรมเนียมไม่ถูกต้อง')
  if (system_ref && !/^[A-Za-z0-9]{1,18}$/.test(system_ref)) throw new Error('System Reference ID ต้องเป็นตัวอักษร/ตัวเลข 1-18 ตัว')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate || '')) throw new Error('วันที่โอนไม่ถูกต้อง')
  const today = ymd(now)
  if (valueDate < today) throw new Error('วันที่โอนย้อนหลังไม่ได้')
  if (NEXT_DAY.includes(product) && valueDate <= today) throw new Error('SPN (โอนวันถัดไป) ต้องเลือกวันที่หลังวันนี้')

  const errors = []
  const ok = []
  for (const r of rows) {
    const msg = rowError(r, product)
    if (msg) errors.push({ ref: r.ref, name: r.name, message: msg })
    else ok.push(r)
  }
  const ref = stamp(now)
  const total = ok.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100
  const isPay = product === 'PAY'
  const txn = r => {
    const email = r.email || ''
    const flag = email ? 'Y' : 'N'
    return [
      'TXNDET', r.ref || '', r.account, '', isPay ? '014' : r.bank_code, isPay ? '0111' : r.branch, money(r.amount),
      isPay ? '' : '01', fee_charge, 'N', '', flag, email, r.name, '', '', '', 'N', '', '', flag, 'N', '', '', '',
      email ? 'E' : 'N', email, '',
    ].join('|')
  }
  const lines = [
    ['HEADER', `${ref}${product}`, system_ref || ''].join('|'),
    ['BCHDET', ref, product, valueDate.replace(/-/g, ''), debit_account, fee_account, money(total), ok.length, '', ''].join('|'),
    ...ok.map(txn),
    ['TRAILR', '1', ok.length, money(total)].join('|'),
  ]
  return { filename: `SCB_file_reference_${ref}.txt`, content: lines.join('\r\n'), total, count: ok.length, errors }
}
