// Golden test: the owner's September 2026 payroll sheet, 12 people.
// Every line and every net must match to the satang.
import { describe, it, expect } from 'vitest'
import { calculateWorkerPay } from './calc.js'
import { DEFAULT_PAY_ITEMS as ITEMS } from './defaultItems.js'

const M = (salary, sso = true) => ({ pay_type: 'monthly', monthly_salary: salary, daily_wage: null, has_social_security: sso })
const adv = amount => [{ advance_id: 'x', title: 'เบิก', amount, installment_no: 1, installments: 1 }]

// [nickname, worker, amounts, attendance, manual, advancesDue, expected per item, expected net]
const ROWS = [
  ['กร',    M(25145), { phone: 500, parking: 1000, house: 1512 }, { leavePersonalDays: 2 }, {}, [], { salary: 25145, contribution: 1257.25, phone: 500, parking: 1000, sso: 875, house: 1512, unpaid_leave: 1678, contribution_deduct: 1257.25 }, 22580],
  ['มุ่ย',   M(25145), { phone: 500, parking: 1000, house: 1822 }, { leavePersonalDays: 1 }, {}, [], { unpaid_leave: 839, house: 1822 }, 23109],
  ['ชัย',   M(25145), { phone: 500, parking: 1000, house: 1528 }, { otHours: 1.5 }, {}, [], { ot: 236 }, 24478],
  ['เอ้',   M(25145), { phone: 500, house: 1854 }, { leavePersonalDays: 1 }, {}, [], { unpaid_leave: 839 }, 22077],
  ['ต้น',   M(19260), { phone: 500, house: 1000 }, { leavePersonalDays: 2 }, {}, adv(7000), { contribution: 963, sso: 875, unpaid_leave: 1284, advances: 7000 }, 9601],
  ['ป้อม',  M(22500), { phone: 500, house: 1790 }, { otHours: 4 }, {}, adv(9155), { contribution: 1125, ot: 563, sso: 875, advances: 9155 }, 11743],
  ['กอล์ฟ', M(14980), { phone: 500, house: 1128 }, { otHours: 1.5, leavePersonalDays: 1 }, {}, [], { contribution: 749, ot: 141, sso: 811, unpaid_leave: 500 }, 13182],
  ['ลิต',   M(14980, false), { phone: 500, house: 1428 }, {}, {}, adv(3500), { sso: 0, advances: 3500 }, 10552],
  ['ซึง',   M(14980, false), { phone: 500, house: 1226 }, {}, {}, adv(1000), { advances: 1000 }, 13254],
  ['อ่อง',  M(13500, false), { phone: 500 }, { otHours: 1.5 }, {}, adv(5000), { contribution: 675, ot: 127, advances: 5000 }, 9127],
  ['โปรย',  M(27000), {}, {}, { student_loan: 500 }, adv(4000), { contribution: 1350, sso: 875, student_loan: 500, advances: 4000 }, 21625],
  ['นิด',   { pay_type: 'daily', daily_wage: 200, monthly_salary: 0, has_social_security: false }, {}, { daysWorked: 25 }, {}, [], { salary: 5000, contribution: 0 }, 5000],
]

const amountOf = (res, id) => res.lines.filter(l => l.pay_item_id === id).reduce((s, l) => s + l.amount, 0)

describe('September 2026 sheet', () => {
  const results = ROWS.map(([nick, w, amounts, attendance, manual, advancesDue]) =>
    [nick, calculateWorkerPay({ items: ITEMS, worker: { id: nick, ...w }, amounts, attendance, manual, advancesDue, settings: { holidayMultiplier: 1.5 } })])

  ROWS.forEach(([nick, , , , , , expectItems, expectNet], i) => {
    it(`${nick}: net ${expectNet}`, () => {
      const r = results[i][1]
      for (const [id, amt] of Object.entries(expectItems)) expect(amountOf(r, id), `${nick} ${id}`).toBe(amt)
      expect(r.totals.net).toBe(expectNet)
    })
  })

  it('column totals match the sheet', () => {
    const tot = id => results.reduce((s, [, r]) => s + amountOf(r, id), 0)
    expect(tot('salary')).toBe(232780)
    expect(tot('contribution')).toBe(11389)
    expect(tot('phone')).toBe(5000)
    expect(tot('ot')).toBe(1067)
    expect(tot('parking')).toBe(3000)
    expect(tot('sso')).toBe(6936)
    expect(tot('house')).toBe(13288)
    expect(tot('advances')).toBe(29655)
    expect(tot('student_loan')).toBe(500)
    expect(tot('unpaid_leave')).toBe(5140)
    expect(tot('contribution_deduct')).toBe(11389)
    expect(Math.round(results.reduce((s, [, r]) => s + r.totals.net, 0) * 100) / 100).toBe(186328)
  })
})
