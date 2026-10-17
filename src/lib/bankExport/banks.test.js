import { describe, it, expect } from 'vitest'
import { scbCheckDigitOk, suggestBranch, validateAccount, bankByCode } from './banks.js'

// build a valid SCB number from 9 digits using the documented algorithm (reference §2.6)
const scbValid = nine => {
  const w = [4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((t, wi, i) => t + ((Number(nine[i]) * wi) % 10), 0)
  return nine + String((10 - (sum % 10)) % 10)
}

describe('scbCheckDigitOk', () => {
  it('accepts a valid number and rejects a one-digit change', () => {
    const ok = scbValid('123456789')
    expect(scbCheckDigitOk(ok)).toBe(true)
    expect(scbCheckDigitOk(ok.slice(0, 9) + String((Number(ok[9]) + 1) % 10))).toBe(false)
    expect(scbCheckDigitOk('12345')).toBe(false)
  })
})

describe('suggestBranch', () => {
  it('derives a 4-digit branch per bank rule', () => {
    expect(suggestBranch('004', '1234567890')).toBe('0123')   // F3, zero-padded
    expect(suggestBranch('069', '1234567890')).toBe('1234')   // F4
    expect(suggestBranch('030', '123456789012')).toBe('9991') // 999F
    expect(suggestBranch('017', '1234567890')).toBe('0001')   // literal
    expect(suggestBranch('066', '123456789012')).toBe('0345') // M3,3
    expect(suggestBranch('004', '123')).toBeNull()            // wrong length
  })
})

describe('validateAccount', () => {
  it('checks digits, length and SCB check digit', () => {
    expect(validateAccount('004', '12345-67890')).toBe('กรอกเลขบัญชีเป็นตัวเลข')
    expect(validateAccount('004', '123456789')).toBe('เลขบัญชีกสิกรไทยต้องมี 10 หลัก')
    expect(validateAccount('004', '1234567890')).toBeNull()
    expect(validateAccount('014', scbValid('123456789'))).toBeNull()
    expect(bankByCode('014').name).toBe('ไทยพาณิชย์')
  })
  it('rejects an SCB number whose check digit is wrong', () => {
    const ok = scbValid('555666777')
    const bad = ok.slice(0, 9) + String((Number(ok[9]) + 1) % 10)
    expect(validateAccount('014', bad)).toBe('เลขบัญชีไทยพาณิชย์ไม่ถูกต้อง (เลขตรวจสอบไม่ตรง)')
  })
})
