import { describe, it, expect } from 'vitest'
import * as app from './advanceRules.js'
import * as edge from '../../../supabase/functions/_shared/advance-logic.ts'

const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

it('phrase tables are identical', () => {
  expect(edge.ADVANCE_PHRASES).toEqual(app.ADVANCE_PHRASES)
})

describe.each([['app', app], ['edge', edge]])('advance rules (%s)', (_name, m) => {
  it('matches phrases', () => {
    expect(m.matchAdvanceAction('เบิกเงิน')).toBe('advance_request')
    expect(m.matchAdvanceAction('ขอเบิกเงิน 3000')).toBe('advance_request')
    expect(m.matchAdvanceAction('อยากเบิกเงิน')).toBe('advance_request')
    expect(m.matchAdvanceAction('ยอดเบิก')).toBe('advance_status')
    expect(m.matchAdvanceAction('สถานะคำขอ')).toBe('request_status')
    expect(m.matchAdvanceAction('ยื่นคำขอ')).toBe('request_menu')
    expect(m.matchAdvanceAction('ขอเบิกปูน')).toBeNull()
    expect(m.matchAdvanceAction('เบิกของ')).toBeNull()
    expect(m.matchAdvanceAction('')).toBeNull()
  })
  it('uses custom phrases', () => {
    expect(m.matchAdvanceAction('เบิกล่วงหน้า', { advance_request: ['เบิกล่วงหน้า'] })).toBe('advance_request')
    expect(m.matchAdvanceAction('ขอยอด', { advance_status: ['ขอยอด'] })).toBe('advance_status')
    expect(m.matchAdvanceAction('เมนูคำขอ', { request_menu: ['เมนูคำขอ'] })).toBe('request_menu')
    expect(m.matchAdvanceAction('เช็คคำขอ', { request_status: ['เช็คคำขอ'] })).toBe('request_status')
  })
  it('parses amounts', () => {
    expect(m.parseAdvanceAmount('5,000')).toEqual({ ok: true, amount: 5000 })
    expect(m.parseAdvanceAmount(' 5 000 ')).toEqual({ ok: true, amount: 5000 })
    expect(m.parseAdvanceAmount('๕,๐๐๐')).toEqual({ ok: true, amount: 5000 })
    expect(m.parseAdvanceAmount('５０００')).toEqual({ ok: true, amount: 5000 })
    expect(m.parseAdvanceAmount('5000.505')).toEqual({ ok: true, amount: 5000.51 })
    expect(m.parseAdvanceAmount(1000000).ok).toBe(true)
    for (const bad of ['0', '-1', 'abc', '2000000']) expect(m.parseAdvanceAmount(bad).ok).toBe(false)
    expect(m.parseAdvanceAmount('')).toEqual({ ok: false, error: 'กรุณาใส่จำนวนเงิน' })
    expect(m.parseAdvanceAmount('0').error).toBe('จำนวนเงินต้องมากกว่า 0 และไม่เกิน 1,000,000 บาท')
  })
  it('workerMonthlyPay', () => {
    expect(m.workerMonthlyPay({ pay_type: 'daily', daily_wage: 200 })).toBe(6000)
    expect(m.workerMonthlyPay({ pay_type: 'monthly', monthly_salary: 25145 })).toBe(25145)
    expect(m.workerMonthlyPay(null)).toBe(0)
  })
  it('summarizeAdvances', () => {
    const s = m.summarizeAdvances(
      [{ id: 'a', title: 'x', amount: 5000, installments: 2, status: 'approved' }],
      [{ advance_id: 'a', amount: 2000 }])
    expect(s.outstanding).toBe(3000)
    expect(s.items[0]).toMatchObject({ deducted: 2000, remaining: 3000, paidInstallments: 1 })
    const p = m.summarizeAdvances(
      [{ id: 'p1', amount: 1000, status: 'pending' }, { id: 'p2', amount: 500, status: 'pending' },
       { id: 'r', amount: 900, status: 'rejected' }], [], 'p1')
    expect(p.pendingOther).toBe(500)
    expect(p.outstanding).toBe(0)
    const over = m.summarizeAdvances(
      [{ id: 'a', amount: 1000, installments: 1, status: 'approved' }], [{ advance_id: 'a', amount: 1200 }])
    expect(over.outstanding).toBe(0)
    expect(over.items[0].remaining).toBe(0)
  })
  it('advanceLimit', () => {
    expect(m.advanceLimit({ monthlyPay: 25145, outstanding: 3000, pendingOther: 500 })).toBe(21645)
    expect(m.advanceLimit({ monthlyPay: 1000, outstanding: 3000, pendingOther: 0 })).toBe(-2000)
  })
  it('defaultStartMonth', () => {
    expect(m.defaultStartMonth({ '2026-10': 'confirmed' }, { year: 2026, month: 10 })).toEqual({ year: 2026, month: 11 })
    expect(m.defaultStartMonth({ '2026-12': 'closed' }, { year: 2026, month: 12 })).toEqual({ year: 2027, month: 1 })
    expect(m.defaultStartMonth({ '2026-10': 'draft' }, { year: 2026, month: 10 })).toEqual({ year: 2026, month: 10 })
    expect(m.defaultStartMonth({}, { year: 2026, month: 10 })).toEqual({ year: 2026, month: 10 })
  })
  it('formatAdvanceStatusReply', () => {
    const empty = m.summarizeAdvances([], [])
    expect(m.formatAdvanceStatusReply(empty, fmt)).toBe('ยังไม่มีรายการเบิกเงินครับ')
    const s = m.summarizeAdvances([
      { id: 'a', title: 'ค่าเทอม', amount: 1500, installments: 3, status: 'approved' },
      { id: 'b', title: 'ซ่อมรถ', amount: 800, installments: 1, status: 'rejected', reject_reason: 'เกินวงเงิน' },
      { id: 'c', title: 'ด่วน', amount: 500, installments: 1, status: 'pending' },
    ], [{ advance_id: 'a', amount: 500 }])
    const t = m.formatAdvanceStatusReply(s, fmt)
    expect(t).toContain('• ค่าเทอม 1,500 บาท — อนุมัติแล้ว')
    expect(t).toContain('หักแล้ว 1/3 งวด')
    expect(t).toContain('• ซ่อมรถ 800 บาท — ไม่อนุมัติ (เกินวงเงิน)')
    expect(t).toContain('• ด่วน 500 บาท — รออนุมัติ')
    expect(t.split('\n').pop()).toBe('ยอดคืนคงเหลือ 1,000 บาท')
  })
  it('formatRequestStatusReply', () => {
    const none = { leave: { recent: [], personalLeft: 4, sickLeft: 28 }, advances: m.summarizeAdvances([], []) }
    // Days left always show when known, even with no leave requests.
    expect(m.formatRequestStatusReply(none, fmt)).toBe('🏖️ การลา\nลากิจคงเหลือ 4 วัน · ลาป่วยคงเหลือ 28 วัน')
    expect(m.formatRequestStatusReply({ leave: null, advances: m.summarizeAdvances([], []) }, fmt)).toBe('ยังไม่มีคำขอครับ')
    expect(m.formatRequestStatusReply({ leave: { recent: [] }, advances: null }, fmt)).toBe('ยังไม่มีคำขอครับ')
    const t = m.formatRequestStatusReply({
      leave: { recent: [
        { type: 'leave_personal', from: '2026-10-20', to: '2026-10-22', status: 'approved' },
        { type: 'leave_sick', from: '2026-10-05', to: '2026-10-05', status: 'pending' },
      ], personalLeft: 4, sickLeft: 28 },
      advances: m.summarizeAdvances([{ id: 'c', title: 'ด่วน', amount: 500, installments: 1, status: 'pending' }], []),
    }, fmt)
    expect(t).toContain('🏖️ การลา')
    expect(t).toContain('• ลากิจ 20–22 ต.ค. — อนุมัติแล้ว')
    expect(t).toContain('• ลาป่วย 5 ต.ค. — รออนุมัติ')
    expect(t).toContain('ลากิจคงเหลือ 4 วัน · ลาป่วยคงเหลือ 28 วัน')
    expect(t).toContain('💸 เบิกเงิน')
    expect(t).toContain('• ด่วน 500 บาท — รออนุมัติ')
    expect(m.formatRequestStatusReply({ leave: none.leave, advances: null }, fmt)).toBe('🏖️ การลา\nลากิจคงเหลือ 4 วัน · ลาป่วยคงเหลือ 28 วัน')
    const withAdv = m.formatRequestStatusReply({
      leave: { recent: [], personalLeft: 0, sickLeft: 30 },
      advances: m.summarizeAdvances([{ id: 'c', title: 'ด่วน', amount: 500, installments: 1, status: 'pending' }], []),
    }, fmt)
    expect(withAdv.startsWith('🏖️ การลา\nลากิจคงเหลือ 0 วัน · ลาป่วยคงเหลือ 30 วัน\n\n💸 เบิกเงิน')).toBe(true)
  })
  it('money guard: a rename never drops the built-in เบิกเงิน / ยอดเบิก', () => {
    expect(m.matchAdvanceAction('ขอเบิกเงิน', { advance_request: ['เงินด่วน'] })).toBe('advance_request')
    expect(m.matchAdvanceAction('เงินด่วน', { advance_request: ['เงินด่วน'] })).toBe('advance_request')
    expect(m.matchAdvanceAction('ยอดเบิก', { advance_status: ['ขอยอด'] })).toBe('advance_status')
    // request menus are not money: their rename replaces the default
    expect(m.matchAdvanceAction('ยื่นคำขอ', { request_menu: ['เมนูคำขอ'] })).toBeNull()
  })
  it('"ยอดเบิกของ" is not the advance status (stays material)', () => {
    expect(m.matchAdvanceAction('ยอดเบิกของ')).toBeNull()
    expect(m.matchAdvanceAction('ยอดเบิกของเดือนนี้')).toBeNull()
    expect(m.matchAdvanceAction('ยอดเบิก')).toBe('advance_status')
    expect(m.matchAdvanceAction('ยอดเบิกเงิน')).toBe('advance_status')
  })
  it('closed lines: every line counts toward deducted, only lines above 0 count as installments', () => {
    const s = m.summarizeAdvances([{ id: 'a', title: 'x', amount: 3000, installments: 3, status: 'approved' }], [
      { advance_id: 'a', amount: 1000 }, { advance_id: 'a', amount: 0 }, { advance_id: 'a', amount: 500 },
    ])
    expect(s.items[0].deducted).toBe(1500)
    expect(s.items[0].paidInstallments).toBe(2)
    expect(s.outstanding).toBe(1500)
  })
})
