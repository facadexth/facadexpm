import { describe, it, expect } from 'vitest'
import { advancesDueFor, manualFromLines, buildPayrollRun, diffRuns } from './run.js'
import { DEFAULT_PAY_ITEMS as ITEMS } from './defaultItems.js'

const adv = (over = {}) => ({ id: 'a1', worker_id: 'w1', title: 'ค่าตำรวจ', amount: 10000, installments: 10, start_year: 2026, start_month: 5, status: 'approved', ...over })

describe('advancesDueFor', () => {
  it('is not due before the start month', () => {
    expect(advancesDueFor({ advances: [adv()], priorLines: [], year: 2026, month: 4 })).toEqual({})
  })
  it('advance due counts earlier non-closed months (no double deduction)', () => {
    const prior = [5, 6, 7, 8].map(m => ({ advance_id: 'a1', amount: 1000, year: 2026, month: m }))
    const r = advancesDueFor({ advances: [adv()], priorLines: prior, year: 2026, month: 9 })
    expect(r.w1).toEqual([{ advance_id: 'a1', title: 'ค่าตำรวจ', amount: 1000, installment_no: 5, installments: 10, remaining_after: 5000 }])
  })
  it('ignores lines from the same or later months', () => {
    const prior = [{ advance_id: 'a1', amount: 1000, year: 2026, month: 9 }]
    expect(advancesDueFor({ advances: [adv()], priorLines: prior, year: 2026, month: 9 }).w1[0].installment_no).toBe(1)
  })
  it('a skipped (0) month does not use up an installment', () => {
    const prior = [{ advance_id: 'a1', amount: 1000, year: 2026, month: 5 }, { advance_id: 'a1', amount: 0, year: 2026, month: 6 }]
    expect(advancesDueFor({ advances: [adv()], priorLines: prior, year: 2026, month: 7 }).w1[0].installment_no).toBe(2)
  })
  it('skips settled and fully deducted advances', () => {
    expect(advancesDueFor({ advances: [adv({ status: 'settled' })], priorLines: [], year: 2026, month: 9 })).toEqual({})
    const prior = [{ advance_id: 'a2', amount: 500, year: 2026, month: 5 }]
    expect(advancesDueFor({ advances: [adv({ id: 'a2', amount: 500, installments: 1 })], priorLines: prior, year: 2026, month: 6 })).toEqual({})
  })
})

describe('manualFromLines', () => {
  it('manual lines feed the next run', () => {
    const lines = [
      { pay_item_id: 'student_loan', advance_id: null, amount: 500, is_manual: true },
      { pay_item_id: 'advances', advance_id: 'a1', amount: 0, is_manual: true },
      { pay_item_id: 'salary', advance_id: null, amount: 9000, is_manual: false },
    ]
    expect(manualFromLines(lines)).toEqual({ student_loan: 500, 'advances:a1': 0 })
  })
})

describe('buildPayrollRun', () => {
  it('includes active workers with no shifts at full salary', () => {
    const run = buildPayrollRun({
      items: ITEMS,
      workers: [{ id: 'w1', name: 'ก', pay_type: 'monthly', monthly_salary: 10000, has_social_security: false }],
      amountsByWorker: {}, attendanceByWorker: {}, manualByWorker: {}, advancesDueByWorker: {}, settings: {},
    })
    expect(run).toHaveLength(1)
    expect(run[0].totals.net).toBe(10000)
    expect(run[0].facts).toMatchObject({ daysWorked: 0 })
  })
})

describe('diffRuns', () => {
  it('lists only changed amounts by item name', () => {
    const saved = [{ worker_id: 'w1', lines: [{ name: 'OT', pay_item_id: 'ot', advance_id: null, amount: 100 }, { name: 'เงินเดือน', pay_item_id: 'salary', advance_id: null, amount: 9000 }] }]
    const run = [{ worker_id: 'w1', worker: { name: 'ก' }, lines: [{ name: 'OT', pay_item_id: 'ot', advance_id: null, amount: 150 }, { name: 'เงินเดือน', pay_item_id: 'salary', advance_id: null, amount: 9000 }] }]
    expect(diffRuns(saved, run)).toEqual([{ worker_id: 'w1', name: 'ก', changes: [{ name: 'OT', before: 100, after: 150 }] }])
  })
  it('reports new workers and removed workers', () => {
    const run = [{ worker_id: 'w2', worker: { name: 'ข' }, lines: [{ name: 'เงินเดือน', pay_item_id: 'salary', advance_id: null, amount: 5000 }] }]
    const saved = [{ worker_id: 'w1', worker_name: 'ก', lines: [{ name: 'เงินเดือน', pay_item_id: 'salary', advance_id: null, amount: 9000 }] }]
    const d = diffRuns(saved, run)
    expect(d).toContainEqual({ worker_id: 'w2', name: 'ข', changes: [{ name: 'เงินเดือน', before: 0, after: 5000 }] })
    expect(d).toContainEqual({ worker_id: 'w1', name: 'ก', changes: [{ name: 'เงินเดือน', before: 9000, after: 0 }] })
  })
})
