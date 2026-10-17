import { describe, it, expect } from 'vitest'
import { buildScbPayrollFile } from './scb.js'

const scbValid = nine => {
  const w = [4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((t, wi, i) => t + ((Number(nine[i]) * wi) % 10), 0)
  return nine + String((10 - (sum % 10)) % 10)
}
const DEBIT = scbValid('111222333')
const SCB_EMP = scbValid('987654321')
const settings = { product: 'SPN', debit_account: DEBIT, fee_account: DEBIT, fee_charge: 'OUR', system_ref: '' }
const now = new Date(2026, 9, 17, 14, 30, 5) // 17 Oct 2026 14:30:05 local
const rows = [
  { ref: 'EMP001', name: 'นาย ประภากร ปายันต์', bank_code: '004', account: '1234567890', branch: '0123', amount: 22580, email: '' },
  { ref: 'EMP002', name: 'นาย พรชัย คอนแก้ว', bank_code: '014', account: SCB_EMP, branch: '0987', amount: 23109.5, email: 'a@b.co' },
]

describe('buildScbPayrollFile', () => {
  it('writes HEADER, BCHDET, TXNDET×n, TRAILR with exact field counts', () => {
    const r = buildScbPayrollFile({ settings, valueDate: '2026-10-30', now, rows })
    const lines = r.content.split('\r\n')
    expect(r.filename).toBe('SCB_file_reference_171026143005.txt')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('HEADER|171026143005SPN|')
    expect(lines[1]).toBe(`BCHDET|171026143005|SPN|20261030|${DEBIT}|${DEBIT}|45689.50|2||`)
    expect(lines[0].split('|')).toHaveLength(3)
    expect(lines[1].split('|')).toHaveLength(10)
    expect(lines[2].split('|')).toHaveLength(28)
    expect(lines[3].split('|')).toHaveLength(28)
    expect(lines[4].split('|')).toHaveLength(4)
    expect(lines[2]).toBe('TXNDET|EMP001|1234567890||004|0123|22580.00|01|OUR|N||N||นาย ประภากร ปายันต์||||N|||N|N||||N||')
    expect(lines[3]).toBe(`TXNDET|EMP002|${SCB_EMP}||014|0987|23109.50|01|OUR|N||Y|a@b.co|นาย พรชัย คอนแก้ว||||N|||Y|N||||E|a@b.co|`)
    expect(lines[4]).toBe('TRAILR|1|2|45689.50')
    expect(r.content.endsWith('45689.50')).toBe(true) // no newline after TRAILR
    expect(r.content.replace(/\r\n/g, '').includes('\n')).toBe(false) // CRLF only, no bare LF
    expect(r.content.charCodeAt(0)).toBe('H'.charCodeAt(0)) // no BOM
    expect(r.total).toBe(45689.5)
    expect(r.count).toBe(2)
    expect(r.errors).toEqual([])
  })
  it('writes system_ref into HEADER field 3', () => {
    const r = buildScbPayrollFile({ settings: { ...settings, system_ref: 'ABC123' }, valueDate: '2026-10-30', now, rows })
    expect(r.content.split('\r\n')[0]).toBe('HEADER|171026143005SPN|ABC123')
  })
  it('writes BEN fee charge in TXNDET field 9', () => {
    const r = buildScbPayrollFile({ settings: { ...settings, fee_charge: 'BEN' }, valueDate: '2026-10-30', now, rows })
    expect(r.content.split('\r\n')[2].split('|')[8]).toBe('BEN')
  })
  it('PAY uses branch 0111 and empty service type, SCB accounts only', () => {
    const r = buildScbPayrollFile({ settings: { ...settings, product: 'PAY' }, valueDate: '2026-10-30', now, rows })
    expect(r.errors).toEqual([{ ref: 'EMP001', name: rows[0].name, message: 'PAY จ่ายได้เฉพาะบัญชีไทยพาณิชย์' }])
    const txn = r.content.split('\r\n')[2].split('|')
    expect(txn).toHaveLength(28)
    expect(txn[4]).toBe('014')
    expect(txn[5]).toBe('0111')
    expect(txn[7]).toBe('')
    expect(r.content.split('\r\n')[2]).toBe(`TXNDET|EMP002|${SCB_EMP}||014|0111|23109.50||OUR|N||Y|a@b.co|นาย พรชัย คอนแก้ว||||N|||Y|N||||E|a@b.co|`)
  })
  it('leaves out bad rows and lists why', () => {
    const bad = [
      { ref: 'E3', name: 'ไม่มีบัญชี', bank_code: '', account: '', branch: '', amount: 100 },
      { ref: 'E4', name: 'ชื่อ|มีขีด', bank_code: '004', account: '1234567890', branch: '0123', amount: 100 },
      { ref: 'E5', name: 'เกินวงเงิน', bank_code: '004', account: '1234567890', branch: '0123', amount: 2000000.01 },
      { ref: 'E6', name: 'ไม่มีสาขา', bank_code: '004', account: '1234567890', branch: '', amount: 100 },
      { ref: 'E7', name: 'ศูนย์บาท', bank_code: '004', account: '1234567890', branch: '0123', amount: 0 },
    ]
    const r = buildScbPayrollFile({ settings, valueDate: '2026-10-30', now, rows: [...rows, ...bad] })
    expect(r.errors.map(e => e.ref)).toEqual(['E3', 'E4', 'E5', 'E6', 'E7'])
    expect(r.count).toBe(2)
    const lines = r.content.split('\r\n')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe(`BCHDET|171026143005|SPN|20261030|${DEBIT}|${DEBIT}|45689.50|2||`)
    expect(lines[4]).toBe('TRAILR|1|2|45689.50')
    expect(r.total).toBe(45689.5)
  })
  it('rejects refs the bank would refuse and names the ref', () => {
    const mk = ref => ({ ...rows[0], ref })
    const r = buildScbPayrollFile({ settings, valueDate: '2026-10-30', now, rows: [mk('A'.repeat(21)), mk('EMP_01'), mk('EMP\t1'), mk('EMP-01/A (2)'), mk('ช่าง1')] })
    expect(r.errors.map(e => e.ref)).toEqual(['A'.repeat(21), 'EMP_01', 'EMP\t1', 'ช่าง1'])
    expect(r.errors[1].message).toBe('รหัสอ้างอิง/รหัสพนักงาน "EMP_01" มีตัวอักษรที่ธนาคารไม่รับ หรือยาวเกิน 20 ตัว')
    expect(r.count).toBe(1)
  })
  it('rejects control characters in name and email', () => {
    const r = buildScbPayrollFile({ settings, valueDate: '2026-10-30', now, rows: [{ ...rows[0], name: 'นาย\nก' }, { ...rows[0], ref: 'X2', email: 'a@b.co\r' }] })
    expect(r.errors.map(e => e.ref)).toEqual(['EMP001', 'X2'])
    expect(r.count).toBe(0)
  })
  it('rejects unknown bank codes for SPN/SPS', () => {
    const r = buildScbPayrollFile({ settings, valueDate: '2026-10-30', now, rows: [{ ...rows[0], ref: 'U1', bank_code: '999' }] })
    expect(r.errors).toEqual([{ ref: 'U1', name: rows[0].name, message: 'ไม่รู้จักรหัสธนาคาร 999' }])
  })
  it('rejects bad settings and value dates', () => {
    expect(() => buildScbPayrollFile({ settings: { ...settings, debit_account: '1234567890' }, valueDate: '2026-10-30', now, rows })).toThrow('บัญชีต้นทาง')
    expect(() => buildScbPayrollFile({ settings, valueDate: '2026-10-17', now, rows })).toThrow('SPN')
    expect(() => buildScbPayrollFile({ settings: { ...settings, product: 'SPS' }, valueDate: '2026-10-16', now, rows })).toThrow('ย้อนหลัง')
    expect(buildScbPayrollFile({ settings: { ...settings, product: 'SPS' }, valueDate: '2026-10-17', now, rows }).count).toBe(2)
    expect(() => buildScbPayrollFile({ settings, valueDate: '30/10/2026', now, rows })).toThrow('วันที่')
    expect(() => buildScbPayrollFile({ settings: { ...settings, product: 'XXX' }, valueDate: '2026-10-30', now, rows })).toThrow('บริการ')
    expect(() => buildScbPayrollFile({ settings: { ...settings, system_ref: 'has space' }, valueDate: '2026-10-30', now, rows })).toThrow('System Reference')
  })
})
