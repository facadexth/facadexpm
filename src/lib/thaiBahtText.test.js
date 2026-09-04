import { describe, it, expect } from 'vitest'
import { thaiBahtText } from './thaiBahtText.js'

describe('thaiBahtText', () => {
  it('zero', () => {
    expect(thaiBahtText(0)).toBe('ศูนย์บาทถ้วน')
  })
  it('single-digit units', () => {
    expect(thaiBahtText(1)).toBe('หนึ่งบาทถ้วน')
    expect(thaiBahtText(5)).toBe('ห้าบาทถ้วน')
  })
  it('เอ็ด only replaces the true final digit, not a units-of-million digit', () => {
    expect(thaiBahtText(11)).toBe('สิบเอ็ดบาทถ้วน')
    expect(thaiBahtText(21)).toBe('ยี่สิบเอ็ดบาทถ้วน')
    expect(thaiBahtText(1000001)).toBe('หนึ่งล้านเอ็ดบาทถ้วน')
  })
  it('ยี่สิบ replaces สองสิบ, bare สิบ drops the leading หนึ่ง', () => {
    expect(thaiBahtText(10)).toBe('สิบบาทถ้วน')
    expect(thaiBahtText(20)).toBe('ยี่สิบบาทถ้วน')
    expect(thaiBahtText(30)).toBe('สามสิบบาทถ้วน')
  })
  it('hundreds/thousands, no เอ็ด leak into non-units positions', () => {
    expect(thaiBahtText(100)).toBe('หนึ่งร้อยบาทถ้วน')
    expect(thaiBahtText(101)).toBe('หนึ่งร้อยเอ็ดบาทถ้วน')
    expect(thaiBahtText(1000)).toBe('หนึ่งพันบาทถ้วน')
    expect(thaiBahtText(21000)).toBe('สองหมื่นหนึ่งพันบาทถ้วน')
  })
  it('million boundary', () => {
    expect(thaiBahtText(1000000)).toBe('หนึ่งล้านบาทถ้วน')
    expect(thaiBahtText(2500000)).toBe('สองล้านห้าแสนบาทถ้วน')
  })
  it('a realistic withholding amount, e.g. 3% of a labor payment', () => {
    // 18,000 * 3% = 540
    expect(thaiBahtText(540)).toBe('ห้าร้อยสี่สิบบาทถ้วน')
  })
  it('satang (cents)', () => {
    expect(thaiBahtText(1234.5)).toBe('หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์')
    expect(thaiBahtText(0.25)).toBe('ศูนย์บาทยี่สิบห้าสตางค์')
  })
  it('rounds to the nearest satang', () => {
    // Real inputs are already .toFixed(2)-clean (see labor_payments'
    // withholding_tax computation) -- this just confirms ordinary
    // rounding, not a claim about exact float halfway-point behavior.
    expect(thaiBahtText(10.01)).toBe('สิบบาทหนึ่งสตางค์')
    expect(thaiBahtText(10.004)).toBe('สิบบาทถ้วน')
    expect(thaiBahtText(10.006)).toBe('สิบบาทหนึ่งสตางค์')
  })
})
