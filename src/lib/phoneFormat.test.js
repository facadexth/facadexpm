import { describe, it, expect } from 'vitest'
import { fmtCompact, spendRatio, daysBetween, quotationNote } from './phoneFormat.js'

describe('fmtCompact', () => {
  it('millions, thousands, units, negatives, sign', () => {
    expect(fmtCompact(14017214)).toBe('14.02M')
    expect(fmtCompact(668500)).toBe('668.5K')
    expect(fmtCompact(300000)).toBe('300K')
    expect(fmtCompact(2000000)).toBe('2M')
    expect(fmtCompact(950)).toBe('950')
    expect(fmtCompact(-1426007.67)).toBe('-1.43M')
    expect(fmtCompact(82400, { sign: true })).toBe('+82.4K')
    expect(fmtCompact(0, { sign: true })).toBe('0')
    expect(fmtCompact(null)).toBe('0')
    expect(fmtCompact('x')).toBe('—')
  })
})

describe('spendRatio', () => {
  it('ratio, over, no income, nothing', () => {
    expect(spendRatio(7721235.95, 9147243.62)).toMatchObject({ over: true, label: '118%' })
    expect(spendRatio(300000, 217600)).toMatchObject({ over: false, label: '73%' })
    expect(spendRatio(0, 500)).toEqual({ pct: 100, over: true, label: 'ยังไม่มีรายรับ' })
    expect(spendRatio(0, 0)).toBeNull()
  })
})

describe('quotationNote', () => {
  const today = '2026-10-15'
  it('sent: days left, warn within 7, overdue, on hold', () => {
    expect(quotationNote({ status: 'sent', valid_until: '2026-10-27' }, 1, today)).toEqual({ text: 'หมดอายุใน 12 วัน', tone: '' })
    expect(quotationNote({ status: 'sent', valid_until: '2026-10-18' }, 1, today)).toEqual({ text: 'หมดอายุใน 3 วัน', tone: 'warn' })
    expect(quotationNote({ status: 'sent', valid_until: '2026-10-15' }, 1, today)).toEqual({ text: 'หมดอายุวันนี้', tone: 'warn' })
    expect(quotationNote({ status: 'sent', valid_until: '2026-10-10' }, 1, today)).toEqual({ text: 'เลยวันยืนราคา 5 วัน', tone: 'bad' })
    expect(quotationNote({ status: 'sent', on_hold: true, valid_until: '2026-10-10' }, 1, today).tone).toBe('warn')
  })
  it('draft without price; other statuses empty', () => {
    expect(quotationNote({ status: 'draft' }, 0, today)).toEqual({ text: 'ยังไม่ใส่ราคา', tone: 'warn' })
    expect(quotationNote({ status: 'draft' }, 10, today).text).toBe('')
    expect(quotationNote({ status: 'accepted' }, 10, today).text).toBe('')
  })
  it('daysBetween', () => { expect(daysBetween('2026-10-15', '2026-11-30')).toBe(46); expect(daysBetween('x', '2026-01-01')).toBeNull() })
})
