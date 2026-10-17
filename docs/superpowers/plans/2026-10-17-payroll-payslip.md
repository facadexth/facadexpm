# Payroll Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CHANG's fixed-column payroll with tenant-configurable pay items. Add a draft → confirmed → closed month workflow, advances with installments, an A5 payslip, and an SCB payroll upload file. The September 2026 FacadeX sheet must reproduce to the satang.

**Architecture:** All money logic lives in pure, vitest-covered modules under `src/lib/payroll/` and `src/lib/bankExport/`. The UI loads inputs, calls the pure engine, and saves the result through `SECURITY DEFINER` RPCs that write a whole month atomically. Postgres enforces the period lock, the owner-only actions and worker visibility. Hiding a button is not the protection.

**Tech Stack:** React 18 + Vite, Supabase (Postgres 15, RLS, plpgsql RPCs), vitest, html2pdf.js through `src/lib/pdf.js`.

**Spec:** `docs/superpowers/specs/2026-10-17-payroll-payslip-design.md`. Bank formats: `docs/reference/bank-payroll-file-formats.md`. Mockup: https://claude.ai/artifact/ToTC4HTXzpgfsxqka2cDjC

## Global Constraints

- **Daily rate:** monthly workers use `monthly_salary / 30`, daily workers use `daily_wage`. No `/26` anywhere, SQL included.
- **SSO:** 5% of the earning items marked `sso_base`, capped at 875 and rounded half-up to whole baht. It is skipped when `workers.has_social_security = false`.
- **Unpaid leave:** leave_personal days × ceil(salary/30). Sick leave never deducts. Daily workers get no unpaid-leave line.
- **OT:** OT hours × rate/8 × 1.5, plus holiday shifts × rate × 0.5 × `holiday_pay_multiplier`. The total is rounded **up** to whole baht (owner-confirmed 2026-10-17).
- **Net pay:** Σ earnings − Σ deductions, always derived from lines. It is never typed in.
- **Period states:** `draft` → `confirmed` → `closed`.
  - Admins and the owner can confirm, unconfirm and close.
  - Only the owner can reopen a closed period. Reopening needs a reason and writes `audit_logs`.
- **Advances:** only the owner approves or rejects them.
- **Workers see only their own records,** and only in `confirmed`/`closed` periods.
- **Dates:** never use `toISOString()` or `new Date('YYYY-MM-DD')` for payroll dates. Use `src/lib/payroll/period.js`.
- **Migrations:**
  - Files go in `supabase/migrations/2026-10-17-NN-*.sql`.
  - `apply_migration` puts a migration live on CHANG immediately. Tasks 2–5 only **write** the files and test them inside `BEGIN … ROLLBACK` with `execute_sql`. Task 13 applies them, after the whole-branch review and the owner's OK.
- **Grants:**
  - Every new function gets `REVOKE ALL … FROM PUBLIC, anon;`.
  - Callable RPCs also get `GRANT EXECUTE … TO authenticated;`.
  - Trigger and helper functions get no grant.
- **Views:** every view that is recreated lists its columns explicitly. A view's `x.*` list freezes when the view is created, so check this on every recreated view.
- **Upserts:** `onConflict` must name the real PK or unique index exactly. Prefer RPCs over client upserts for payroll tables.
- **UI copy:** Thai, short and in plain words, the same as existing HR pages.
- **Bank export:** job 1 builds the SCB generator only (`SPN`/`SPS`/`PAY`). KBank is out of scope.
- **Tests:** run with `npx vitest run`. The baseline is 1208 passing tests in 93 files. Never drop below it.

## Review Focus

1. **Recalculating a draft month after an admin typed กยศ or skipped an advance installment.** The typed values must survive the recalculation (Task 1 test `keeps manual values`, Task 6 test `manual lines feed the next run`).
2. **Deleting a worker, or resetting the demo tenant, when that person has records in a closed period.** The lock must not wedge the demo reset; it must bypass through `chang.payroll_bypass`. A plain worker delete must fail with a Thai message, not a silent error (Task 2 SQL test, Task 5 SQL test).
3. **A period whose earlier month is still a draft or confirmed when an advance is due.** The installment number and amount must count deductions from earlier months in any status, so nothing is deducted twice (Task 6 test `advance due counts earlier non-closed months`).
4. **February, 30-day and 31-day months under `TZ=Asia/Bangkok`.** The last day is included, and Sunday detection is correct (Task 1 `period.test.js`).
5. **Bank export with a worker who has no account, an invalid SCB check digit, a name containing `|`, or an amount over 2,000,000 on a non-SCB bank.** The worker is listed as an error and left out, and the file stays well-formed (Task 12 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/payroll/money.js` | `round2`, `roundAmount(x, mode)` |
| `src/lib/payroll/period.js` | month range, weekday, Thai period label, period compare |
| `src/lib/payroll/defaultItems.js` | the 11 default pay items (JS mirror of the SQL seed) |
| `src/lib/payroll/calc.js` | `validatePayItems`, `dailyRate`, `calculateWorkerPay`, `advanceInstallmentDue` |
| `src/lib/payroll/attendance.js` | `summarizeAttendance` (shifts + OT + holidays → per-worker facts) |
| `src/lib/payroll/run.js` | `buildPayrollRun` (all workers), `advancesDueFor`, `diffRuns` |
| `src/lib/payroll/load.js` | Supabase fetches feeding `run.js`, and RPC wrappers |
| `src/lib/bankExport/banks.js` | Thai bank list, account-length rules, `scbCheckDigitOk`, `suggestBranch`, `validateAccount` |
| `src/lib/bankExport/scb.js` | `buildScbPayrollFile` |
| `src/hooks/usePayroll.js` | React hooks for pay items, periods, records, advances, bank settings |
| `src/pages/hr/PayItemsEditor.jsx` | Settings card: pay item structure |
| `src/pages/hr/WorkerPayFields.jsx` | Worker form section: code, bank, pay type, fixed amounts |
| `src/pages/hr/PayrollMonth.jsx` | HR → เงินเดือน tab: grid, calculate, states |
| `src/pages/hr/AdvancesPanel.jsx` | HR → เบิกล่วงหน้า tab |
| `src/pages/hr/Payslip.jsx` | A5 payslip render + modal + download |
| `src/pages/hr/BankExportModal.jsx` | Export dialog for a confirmed/closed month |
| `src/pages/hr/BankExportSettings.jsx` | Settings card: SCB debit account, product, fee |
| `supabase/migrations/2026-10-19-01-payroll-structure.sql` | tables, columns, triggers, RLS, default-item seed |
| `supabase/migrations/2026-10-19-02-payroll-rpcs.sql` | save/confirm/close/reopen, manual line, advances |
| `supabase/migrations/2026-10-19-03-labor-cost-divide-30.sql` | views to ÷30 + daily_wage |
| `supabase/migrations/2026-10-19-04-payroll-backfill.sql` | `payroll_backfill_lines` + demo seed/reset hooks |

`src/pages/Payroll.jsx` is deleted. In `src/pages/HR.jsx`, `SalaryForm`, `calcNet`, `SalarySlipModal`, `handleCalcFromAssign` and `handleConfirmCalc` are removed and replaced by the components above.

---

### Task 1: Pure payroll engine + September golden test

**Files:**
- Create: `src/lib/payroll/money.js`, `src/lib/payroll/period.js`, `src/lib/payroll/defaultItems.js`, `src/lib/payroll/calc.js`
- Test: `src/lib/payroll/period.test.js`, `src/lib/payroll/calc.test.js`, `src/lib/payroll/september2026.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `round2(x:number):number`, `roundAmount(x:number, mode:'none'|'ceil'|'round'):number`
  - `monthRange(year, month) → {from:'YYYY-MM-DD', to:'YYYY-MM-DD', lastDay:number}`, `weekdayOf('YYYY-MM-DD') → 0..6`, `periodLabel(year, month) → '1–30 ก.ย. 2569'`, `comparePeriod({year,month},{year,month}) → number`, `MONTHS_TH`
  - `DEFAULT_PAY_ITEMS: PayItem[]`, where `PayItem = {id, name, side:'earning'|'deduction', method, params, sso_base, rounding, applies_to:'all'|'monthly'|'daily', sort_order, active, system_key}`
  - `validatePayItems(items) → [{item_id, code:'missing_ref'|'bad_ref'|'cycle'}]`
  - `dailyRate(worker) → number`
  - `calculateWorkerPay({items, worker, amounts, attendance, manual, advancesDue, settings}) → {lines: Line[], totals:{earnings, deductions, net}, warnings: string[]}`, where `Line = {pay_item_id, advance_id, name, side, sort_order, amount, quantity, rate, note, is_manual}`
  - `advanceInstallmentDue({amount, installments, deductedBefore, installmentsBefore}) → {amount, installment_no, remaining_after} | null`
  - `worker = {id, pay_type:'monthly'|'daily', monthly_salary, daily_wage, has_social_security}`
  - `attendance = {daysWorked, leavePersonalDays, leaveSickDays, otHours, holidayShifts}`
  - `manual` keys are a pay_item_id (manual_monthly), or `${advancesItemId}:${advance_id}` (advance override).

- [ ] **Step 1: Write the failing period test**

```js
// src/lib/payroll/period.test.js
import { describe, it, expect } from 'vitest'
import { monthRange, weekdayOf, periodLabel, comparePeriod } from './period.js'

describe('monthRange', () => {
  it('includes the last day for 28/29/30/31-day months', () => {
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28', lastDay: 28 })
    expect(monthRange(2028, 2).to).toBe('2028-02-29')
    expect(monthRange(2026, 9).to).toBe('2026-09-30')
    expect(monthRange(2026, 10).to).toBe('2026-10-31')
    expect(monthRange(2026, 12).to).toBe('2026-12-31')
  })
})

describe('weekdayOf', () => {
  it('reads the calendar date, not a UTC instant', () => {
    expect(weekdayOf('2026-10-18')).toBe(0) // Sunday
    expect(weekdayOf('2026-10-17')).toBe(6)
    expect(weekdayOf('2026-11-01')).toBe(0)
  })
})

describe('periodLabel / comparePeriod', () => {
  it('formats a Thai BE range', () => {
    expect(periodLabel(2026, 9)).toBe('1–30 ก.ย. 2569')
  })
  it('orders periods', () => {
    expect(comparePeriod({ year: 2026, month: 9 }, { year: 2026, month: 10 })).toBeLessThan(0)
    expect(comparePeriod({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBeGreaterThan(0)
    expect(comparePeriod({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and check that it fails**

Run: `TZ=Asia/Bangkok npx vitest run src/lib/payroll/period.test.js`
Expected: FAIL, "Failed to resolve import ./period.js".

- [ ] **Step 3: Implement money.js and period.js**

```js
// src/lib/payroll/money.js
// Money rounding for payroll. round2 = satang; roundAmount applies a pay item's
// rounding mode on top of round2 so float noise (562.5000001) never ceils up.
export function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100
}

export function roundAmount(x, mode = 'none') {
  const v = round2(x)
  if (mode === 'ceil') return Math.ceil(v)
  if (mode === 'round') return Math.round(v)
  return v
}
```

```js
// src/lib/payroll/period.js
// Payroll dates are calendar strings ('YYYY-MM-DD'). Never go through
// toISOString() (UTC) — under UTC+7 that dropped the last day of every month.
export const MONTHS_TH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

const pad = n => String(n).padStart(2, '0')

export function monthRange(year, month) {
  const lastDay = new Date(year, month, 0).getDate()
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}`, lastDay }
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

export function periodLabel(year, month) {
  const { lastDay } = monthRange(year, month)
  return `1–${lastDay} ${MONTHS_TH[month - 1]} ${year + 543}`
}

export function comparePeriod(a, b) {
  return (a.year * 12 + a.month) - (b.year * 12 + b.month)
}
```

- [ ] **Step 4: Run the period test and check that it passes**

Run: `TZ=Asia/Bangkok npx vitest run src/lib/payroll/period.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Write defaultItems.js**

```js
// src/lib/payroll/defaultItems.js
// JS mirror of seed_default_pay_items() (migration 2026-10-19-01). ids are the
// system_key so tests can reference items by key; the DB uses uuids and stores
// percent_of_item references as params.of_item_id = <uuid>.
export const DEFAULT_PAY_ITEMS = [
  { id: 'salary', system_key: 'salary', name: 'เงินเดือน', side: 'earning', method: 'base_pay', params: {}, sso_base: true, rounding: 'none', applies_to: 'all', sort_order: 10, active: true },
  { id: 'contribution', system_key: 'contribution', name: 'สมทบ', side: 'earning', method: 'percent_of_item', params: { percent: 5, of_item_id: 'salary' }, sso_base: true, rounding: 'none', applies_to: 'monthly', sort_order: 20, active: true },
  { id: 'phone', system_key: 'phone', name: 'โทรศัพท์', side: 'earning', method: 'fixed_per_worker', params: {}, sso_base: true, rounding: 'none', applies_to: 'all', sort_order: 30, active: true },
  { id: 'ot', system_key: 'ot', name: 'OT', side: 'earning', method: 'ot', params: { multiplier: 1.5 }, sso_base: false, rounding: 'ceil', applies_to: 'all', sort_order: 40, active: true },
  { id: 'parking', system_key: 'parking', name: 'เงินพิเศษค่าจอดรถ', side: 'earning', method: 'fixed_per_worker', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 50, active: true },
  { id: 'sso', system_key: 'sso', name: 'ประกันสังคม', side: 'deduction', method: 'sso', params: { rate: 0.05, cap: 875 }, sso_base: false, rounding: 'round', applies_to: 'all', sort_order: 110, active: true },
  { id: 'house', system_key: 'house', name: 'ค่าบ้าน', side: 'deduction', method: 'fixed_per_worker', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 120, active: true },
  { id: 'advances', system_key: 'advances', name: 'เบิกล่วงหน้า', side: 'deduction', method: 'advances', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 130, active: true },
  { id: 'student_loan', system_key: 'student_loan', name: 'กยศ', side: 'deduction', method: 'manual_monthly', params: {}, sso_base: false, rounding: 'none', applies_to: 'all', sort_order: 140, active: true },
  { id: 'unpaid_leave', system_key: 'unpaid_leave', name: 'ลาไม่รับค่าจ้าง', side: 'deduction', method: 'unpaid_leave', params: { daily_rate_rounding: 'ceil' }, sso_base: false, rounding: 'none', applies_to: 'monthly', sort_order: 150, active: true },
  { id: 'contribution_deduct', system_key: 'contribution_deduct', name: 'หักเงินสมทบ', side: 'deduction', method: 'percent_of_item', params: { percent: 100, of_item_id: 'contribution' }, sso_base: false, rounding: 'none', applies_to: 'monthly', sort_order: 160, active: true },
]
```

- [ ] **Step 6: Write the failing unit tests for calc.js**

```js
// src/lib/payroll/calc.test.js
import { describe, it, expect } from 'vitest'
import { calculateWorkerPay, validatePayItems, dailyRate, advanceInstallmentDue } from './calc.js'
import { DEFAULT_PAY_ITEMS as ITEMS } from './defaultItems.js'

const monthly = (over = {}) => ({ id: 'w', pay_type: 'monthly', monthly_salary: 25145, daily_wage: null, has_social_security: true, ...over })
const amountOf = (res, id) => res.lines.filter(l => l.pay_item_id === id).reduce((s, l) => s + l.amount, 0)

describe('dailyRate', () => {
  it('is salary/30 for monthly and daily_wage for daily', () => {
    expect(dailyRate(monthly({ monthly_salary: 30000 }))).toBe(1000)
    expect(dailyRate({ pay_type: 'daily', daily_wage: 200 })).toBe(200)
  })
})

describe('calculateWorkerPay', () => {
  it('ceils OT to whole baht (กอล์ฟ 1.5h → 141)', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 14980 }), attendance: { otHours: 1.5 } })
    expect(amountOf(r, 'ot')).toBe(141)
  })
  it('adds the holiday premium into OT', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 30000 }), attendance: { holidayShifts: 2 }, settings: { holidayMultiplier: 1.5 } })
    expect(amountOf(r, 'ot')).toBe(1500) // 2 × 1000 × 0.5 × 1.5
  })
  it('ceils the daily rate for unpaid leave (กร 2 days → 1678)', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly(), attendance: { leavePersonalDays: 2 } })
    expect(amountOf(r, 'unpaid_leave')).toBe(1678)
  })
  it('never deducts sick leave', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly(), attendance: { leaveSickDays: 3 } })
    expect(amountOf(r, 'unpaid_leave')).toBe(0)
  })
  it('caps SSO at 875 and rounds half-up', () => {
    const big = calculateWorkerPay({ items: ITEMS, worker: monthly(), amounts: { phone: 500 } })
    expect(amountOf(big, 'sso')).toBe(875)
    const golf = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 14980 }), amounts: { phone: 500 } })
    expect(amountOf(golf, 'sso')).toBe(811) // (14980+749+500)×5% = 811.45
  })
  it('skips SSO without social security', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ has_social_security: false }) })
    expect(amountOf(r, 'sso')).toBe(0)
  })
  it('pays daily workers by days worked, no contribution, no leave line', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: { id: 'n', pay_type: 'daily', daily_wage: 200, monthly_salary: 0, has_social_security: false }, attendance: { daysWorked: 25, leavePersonalDays: 1, otHours: 2 } })
    expect(amountOf(r, 'salary')).toBe(5000)
    expect(amountOf(r, 'contribution')).toBe(0)
    expect(amountOf(r, 'unpaid_leave')).toBe(0)
    expect(amountOf(r, 'ot')).toBe(75) // 2 × 200/8 × 1.5
    expect(r.lines.find(l => l.pay_item_id === 'salary')).toMatchObject({ quantity: 25, rate: 200 })
  })
  it('warns when a daily worker has no wage', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: { id: 'n', pay_type: 'daily', daily_wage: null, has_social_security: false }, attendance: { daysWorked: 3 } })
    expect(r.warnings).toContain('missing_daily_wage')
  })
  it('keeps manual values, including an explicit 0 advance override', () => {
    const r = calculateWorkerPay({
      items: ITEMS, worker: monthly(),
      manual: { student_loan: 500, 'advances:a1': 0 },
      advancesDue: [{ advance_id: 'a1', title: 'ค่าตำรวจ', amount: 1000, installment_no: 5, installments: 10 }],
    })
    expect(amountOf(r, 'student_loan')).toBe(500)
    const adv = r.lines.find(l => l.advance_id === 'a1')
    expect(adv).toMatchObject({ amount: 0, is_manual: true, note: 'ค่าตำรวจ งวด 5/10' })
  })
  it('drops zero lines that are not manual, and derives net', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 10000, has_social_security: false }) })
    expect(r.lines.map(l => l.pay_item_id)).toEqual(['salary', 'contribution', 'contribution_deduct'])
    expect(r.totals).toEqual({ earnings: 10500, deductions: 500, net: 10000 })
  })
  it('flags negative net', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 1000 }), manual: { student_loan: 5000 } })
    expect(r.warnings).toContain('negative_net')
  })
  it('ignores inactive items', () => {
    const items = ITEMS.map(i => i.id === 'contribution' ? { ...i, active: false } : i)
    const r = calculateWorkerPay({ items, worker: monthly({ monthly_salary: 10000, has_social_security: false }) })
    expect(r.totals.net).toBe(10000)
    expect(amountOf(r, 'contribution_deduct')).toBe(0)
  })
})

describe('validatePayItems', () => {
  it('rejects a percent cycle and a reference to SSO', () => {
    const a = { id: 'a', method: 'percent_of_item', params: { of_item_id: 'b' } }
    const b = { id: 'b', method: 'percent_of_item', params: { of_item_id: 'a' } }
    expect(validatePayItems([a, b]).map(e => e.code)).toContain('cycle')
    const c = { id: 'c', method: 'percent_of_item', params: { of_item_id: 'sso' } }
    expect(validatePayItems([...ITEMS, c]).map(e => e.code)).toContain('bad_ref')
    expect(validatePayItems(ITEMS)).toEqual([])
  })
})

describe('advanceInstallmentDue', () => {
  it('splits evenly and puts the remainder on the last installment', () => {
    expect(advanceInstallmentDue({ amount: 10000, installments: 3, deductedBefore: 0, installmentsBefore: 0 })).toEqual({ amount: 3333.33, installment_no: 1, remaining_after: 6666.67 })
    expect(advanceInstallmentDue({ amount: 10000, installments: 3, deductedBefore: 6666.66, installmentsBefore: 2 })).toEqual({ amount: 3333.34, installment_no: 3, remaining_after: 0 })
  })
  it('returns null when fully deducted', () => {
    expect(advanceInstallmentDue({ amount: 1000, installments: 1, deductedBefore: 1000, installmentsBefore: 1 })).toBeNull()
  })
  it('keeps deducting the remainder after a skipped month', () => {
    expect(advanceInstallmentDue({ amount: 10000, installments: 10, deductedBefore: 9000, installmentsBefore: 9 })).toEqual({ amount: 1000, installment_no: 10, remaining_after: 0 })
  })
})
```

- [ ] **Step 7: Run it and check that it fails**

Run: `npx vitest run src/lib/payroll/calc.test.js`
Expected: FAIL, "Failed to resolve import ./calc.js".

- [ ] **Step 8: Implement calc.js**

```js
// src/lib/payroll/calc.js
// Pure payroll engine: one worker, one month. No Supabase, no Date.
// Order: single-value items → percent_of_item (dependency order) → SSO → advances.
import { round2, roundAmount } from './money.js'

export const SYSTEM_METHODS = ['base_pay', 'ot', 'sso', 'unpaid_leave', 'advances']

export function dailyRate(worker) {
  return worker.pay_type === 'daily'
    ? Number(worker.daily_wage) || 0
    : (Number(worker.monthly_salary) || 0) / 30
}

function appliesTo(item, worker) {
  const t = item.applies_to || 'all'
  return t === 'all' || t === (worker.pay_type || 'monthly')
}

export function validatePayItems(items) {
  const errors = []
  const byId = new Map(items.map(i => [i.id, i]))
  for (const i of items) {
    if (i.method !== 'percent_of_item') continue
    const ref = byId.get(i.params?.of_item_id)
    if (!ref) errors.push({ item_id: i.id, code: 'missing_ref' })
    else if (ref.method === 'sso' || ref.method === 'advances') errors.push({ item_id: i.id, code: 'bad_ref' })
  }
  for (const i of items) {
    const seen = new Set()
    let cur = i
    while (cur && cur.method === 'percent_of_item') {
      if (seen.has(cur.id)) { errors.push({ item_id: i.id, code: 'cycle' }); break }
      seen.add(cur.id)
      cur = byId.get(cur.params?.of_item_id)
    }
  }
  return errors
}

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)

export function calculateWorkerPay({ items, worker, amounts = {}, attendance = {}, manual = {}, advancesDue = [], settings = {} }) {
  const errors = validatePayItems(items)
  if (errors.length) throw new Error(`pay_items_invalid: ${JSON.stringify(errors)}`)

  const att = { daysWorked: 0, leavePersonalDays: 0, leaveSickDays: 0, otHours: 0, holidayShifts: 0, ...attendance }
  const isDaily = worker.pay_type === 'daily'
  const rate = dailyRate(worker)
  const active = items
    .filter(i => i.active !== false && appliesTo(i, worker))
    .sort((a, b) => a.sort_order - b.sort_order)
  const activeIds = new Set(active.map(i => i.id))
  const value = new Map()
  const lines = []
  const warnings = []
  if (isDaily && !(Number(worker.daily_wage) > 0)) warnings.push('missing_daily_wage')

  const line = (item, amount, extra = {}) => ({
    pay_item_id: item.id, advance_id: null, name: item.name, side: item.side,
    sort_order: item.sort_order, amount, quantity: null, rate: null, note: null, is_manual: false, ...extra,
  })

  const single = item => {
    switch (item.method) {
      case 'base_pay':
        return isDaily
          ? line(item, round2(att.daysWorked * rate), { quantity: att.daysWorked, rate })
          : line(item, round2(Number(worker.monthly_salary) || 0))
      case 'fixed_per_worker':
        return line(item, round2(Number(amounts[item.id]) || 0))
      case 'manual_monthly':
        return line(item, round2(Number(manual[item.id]) || 0), { is_manual: has(manual, item.id) })
      case 'ot': {
        const otMult = Number(item.params?.multiplier ?? 1.5)
        const holMult = Number(settings.holidayMultiplier ?? 1.5)
        const raw = att.otHours * rate / 8 * otMult + att.holidayShifts * rate * 0.5 * holMult
        return line(item, roundAmount(raw, item.rounding), { quantity: att.otHours || null })
      }
      case 'unpaid_leave': {
        if (isDaily) return line(item, 0)
        const dr = item.params?.daily_rate_rounding === 'ceil' ? Math.ceil(round2(rate)) : round2(rate)
        return line(item, round2(att.leavePersonalDays * dr), { quantity: att.leavePersonalDays || null, rate: dr })
      }
      default:
        return null
    }
  }

  for (const item of active) {
    const l = single(item)
    if (l) { value.set(item.id, l.amount); lines.push(l) }
  }

  let pending = active.filter(i => i.method === 'percent_of_item')
  while (pending.length) {
    const next = []
    for (const item of pending) {
      const refId = item.params?.of_item_id
      if (activeIds.has(refId) && !value.has(refId)) { next.push(item); continue }
      const base = value.get(refId) || 0
      const amt = roundAmount(base * Number(item.params?.percent || 0) / 100, item.rounding)
      value.set(item.id, amt)
      lines.push(line(item, amt))
    }
    if (next.length === pending.length) throw new Error('percent_of_item_unresolved')
    pending = next
  }

  const sso = active.find(i => i.method === 'sso')
  if (sso) {
    let amt = 0
    if (worker.has_social_security) {
      const base = active
        .filter(i => i.side === 'earning' && i.sso_base)
        .reduce((s, i) => s + (value.get(i.id) || 0), 0)
      const r = Number(sso.params?.rate ?? 0.05)
      const cap = Number(sso.params?.cap ?? 875)
      amt = roundAmount(Math.min(base * r, cap), sso.rounding)
    }
    value.set(sso.id, amt)
    lines.push(line(sso, amt))
  }

  const adv = active.find(i => i.method === 'advances')
  if (adv) {
    for (const d of advancesDue) {
      const key = `${adv.id}:${d.advance_id}`
      const isManual = has(manual, key)
      lines.push(line(adv, round2(isManual ? Number(manual[key]) || 0 : d.amount), {
        advance_id: d.advance_id, is_manual: isManual, note: `${d.title} งวด ${d.installment_no}/${d.installments}`,
      }))
    }
  }

  const kept = lines.filter(l => l.amount !== 0 || l.is_manual).sort((a, b) => a.sort_order - b.sort_order)
  const sum = side => round2(kept.filter(l => l.side === side).reduce((s, l) => s + l.amount, 0))
  const earnings = sum('earning')
  const deductions = sum('deduction')
  const net = round2(earnings - deductions)
  if (net < 0) warnings.push('negative_net')
  return { lines: kept, totals: { earnings, deductions, net }, warnings }
}

export function advanceInstallmentDue({ amount, installments, deductedBefore = 0, installmentsBefore = 0 }) {
  const remaining = round2(amount - deductedBefore)
  if (remaining <= 0) return null
  const per = round2(amount / installments)
  const isLast = installmentsBefore + 1 >= installments
  const due = isLast ? remaining : Math.min(per, remaining)
  return { amount: due, installment_no: installmentsBefore + 1, remaining_after: round2(remaining - due) }
}
```

- [ ] **Step 9: Run the calc tests and check that they pass**

Run: `npx vitest run src/lib/payroll/calc.test.js`
Expected: PASS (all tests). If `drops zero lines…` fails on order, check that `sort` is by `sort_order` only.

- [ ] **Step 10: Write the September golden test**

The data is transcribed from the owner's sheet (เดือนกันยายน 2026, paid 30/09/2026). The advance column goes in as a single due installment per person.

```js
// src/lib/payroll/september2026.test.js
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
```

- [ ] **Step 11: Run the golden test**

Run: `npx vitest run src/lib/payroll/september2026.test.js`
Expected: PASS (13 tests). If a total fails, **do not adjust the expected numbers**. They come from the owner's sheet. Find the engine bug.

- [ ] **Step 12: Run the full suite and commit**

Run: `npx vitest run`
Expected: all pass, total ≥ 1208 + new tests.

```bash
git add src/lib/payroll
git commit -m "feat(payroll): pure pay engine with September 2026 golden test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema migration — pay items, periods, lines, advances, locks, RLS

**Files:**
- Create: `supabase/migrations/2026-10-19-01-payroll-structure.sql`

**Interfaces:**
- Consumes: the existing `current_tenant_id()`, `is_admin_or_owner()`, `is_owner()`, `has_module_access(text)`, and the tables `workers`, `salary_records`, `tenants`.
- Produces:
  - Tables: `pay_items`, `worker_pay_item_amounts`, `payroll_periods`, `salary_record_lines`, `salary_advances`, `payroll_bank_settings`.
  - `workers` columns: `employee_code`, `bank_code`, `bank_account_no`, `bank_account_name`, `bank_branch_code`, `pay_type`, `daily_wage`.
  - `salary_records` columns: `period_id`, `facts jsonb`.
  - Functions: `seed_default_pay_items(uuid)`, `payroll_bypass_on() → boolean`, `payroll_period_for(uuid tenant, int year, int month) → uuid`.
  - Bypass: setting `set_config('chang.payroll_bypass','on',true)` inside a transaction disables the lock and system-item delete guards. It is for SECURITY DEFINER maintenance only.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-19-01-payroll-structure.sql
-- Payroll rework, part 1: configurable pay items, periods with a DB-enforced
-- lock, per-item salary lines, advances, SCB bank-export settings.
-- Spec: docs/superpowers/specs/2026-10-17-payroll-payslip-design.md

-- ── bypass switch for SECURITY DEFINER maintenance (demo reset, backfill, RPCs) ──
CREATE OR REPLACE FUNCTION payroll_bypass_on()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(current_setting('chang.payroll_bypass', true), '') = 'on';
$$;
REVOKE ALL ON FUNCTION payroll_bypass_on() FROM PUBLIC, anon;

-- ── pay_items ──
CREATE TABLE pay_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  side        TEXT NOT NULL CHECK (side IN ('earning','deduction')),
  method      TEXT NOT NULL CHECK (method IN ('fixed_per_worker','manual_monthly','percent_of_item','base_pay','ot','sso','unpaid_leave','advances')),
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sso_base    BOOLEAN NOT NULL DEFAULT false,
  rounding    TEXT NOT NULL DEFAULT 'none' CHECK (rounding IN ('none','ceil','round')),
  applies_to  TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','monthly','daily')),
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  system_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pay_items_method_side CHECK (
       (method IN ('base_pay','ot') AND side = 'earning')
    OR (method IN ('sso','unpaid_leave','advances') AND side = 'deduction')
    OR method IN ('fixed_per_worker','manual_monthly','percent_of_item'))
);
CREATE UNIQUE INDEX pay_items_one_system_method ON pay_items (tenant_id, method)
  WHERE method IN ('base_pay','ot','sso','unpaid_leave','advances');
CREATE UNIQUE INDEX pay_items_system_key ON pay_items (tenant_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX pay_items_tenant ON pay_items (tenant_id, sort_order);

-- SECURITY DEFINER because it calls payroll_bypass_on(), which authenticated cannot execute
CREATE OR REPLACE FUNCTION pay_items_protect_system()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF payroll_bypass_on() THEN RETURN OLD; END IF;
  IF OLD.method IN ('base_pay','ot','sso','unpaid_leave','advances') THEN
    RAISE EXCEPTION 'รายการระบบลบไม่ได้ (ซ่อนได้แทน)' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.method IS DISTINCT FROM OLD.method
     AND OLD.method IN ('base_pay','ot','sso','unpaid_leave','advances') THEN
    RAISE EXCEPTION 'เปลี่ยนวิธีคิดของรายการระบบไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION pay_items_protect_system() FROM PUBLIC, anon;
CREATE TRIGGER pay_items_protect_system BEFORE DELETE OR UPDATE OF method ON pay_items
  FOR EACH ROW EXECUTE FUNCTION pay_items_protect_system();

-- ── per-worker amounts for fixed_per_worker items ──
CREATE TABLE worker_pay_item_amounts (
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  pay_item_id UUID NOT NULL REFERENCES pay_items(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, pay_item_id)
);

-- ── workers: code, bank, pay type ──
ALTER TABLE workers
  ADD COLUMN employee_code     TEXT,
  ADD COLUMN bank_code         TEXT CHECK (bank_code ~ '^[0-9]{3}$'),
  ADD COLUMN bank_account_no   TEXT CHECK (bank_account_no ~ '^[0-9]{1,25}$'),
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_branch_code  TEXT CHECK (bank_branch_code ~ '^[0-9]{4}$'),
  ADD COLUMN pay_type          TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','daily')),
  ADD COLUMN daily_wage        NUMERIC CHECK (daily_wage IS NULL OR daily_wage >= 0);
CREATE UNIQUE INDEX workers_employee_code ON workers (tenant_id, employee_code) WHERE employee_code IS NOT NULL;

-- ── payroll_periods ──
CREATE TABLE payroll_periods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  year           INT NOT NULL,
  month          INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','closed')),
  confirmed_by   TEXT, confirmed_at TIMESTAMPTZ,
  closed_by      TEXT, closed_at    TIMESTAMPTZ,
  paid_date      DATE,
  reopen_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, year, month)
);

CREATE OR REPLACE FUNCTION payroll_period_for(p_tenant UUID, p_year INT, p_month INT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO payroll_periods (tenant_id, year, month) VALUES (p_tenant, p_year, p_month)
  ON CONFLICT (tenant_id, year, month) DO NOTHING;
  SELECT id INTO v_id FROM payroll_periods WHERE tenant_id = p_tenant AND year = p_year AND month = p_month;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION payroll_period_for(UUID, INT, INT) FROM PUBLIC, anon, authenticated;

-- ── salary_records: header row, now tied to a period ──
ALTER TABLE salary_records
  ADD COLUMN period_id UUID REFERENCES payroll_periods(id),
  ADD COLUMN facts     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── advances (before lines: lines reference them) ──
CREATE TABLE salary_advances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  amount        NUMERIC NOT NULL CHECK (amount > 0),
  installments  INT NOT NULL CHECK (installments BETWEEN 1 AND 60),
  start_year    INT NOT NULL,
  start_month   INT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','settled')),
  requested_by  TEXT NOT NULL DEFAULT auth.email(),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   TEXT, approved_at TIMESTAMPTZ,
  reject_reason TEXT
);
CREATE INDEX salary_advances_worker ON salary_advances (worker_id, status);

-- ── salary_record_lines ──
CREATE TABLE salary_record_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  salary_record_id UUID NOT NULL REFERENCES salary_records(id) ON DELETE CASCADE,
  pay_item_id      UUID REFERENCES pay_items(id) ON DELETE SET NULL,
  advance_id       UUID REFERENCES salary_advances(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('earning','deduction')),
  sort_order       INT NOT NULL DEFAULT 0,
  amount           NUMERIC NOT NULL,
  quantity         NUMERIC,
  rate             NUMERIC,
  note             TEXT,
  is_manual        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX salary_record_lines_record ON salary_record_lines (salary_record_id);
CREATE INDEX salary_record_lines_advance ON salary_record_lines (advance_id) WHERE advance_id IS NOT NULL;

-- ── bank export settings (one row per tenant) ──
CREATE TABLE payroll_bank_settings (
  tenant_id     UUID PRIMARY KEY DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  bank          TEXT NOT NULL DEFAULT 'scb' CHECK (bank IN ('scb')),
  product       TEXT NOT NULL DEFAULT 'SPN' CHECK (product IN ('SPN','SPS','PAY')),
  debit_account TEXT CHECK (debit_account ~ '^[0-9]{10}$'),
  fee_account   TEXT CHECK (fee_account ~ '^[0-9]{10}$'),
  fee_charge    TEXT NOT NULL DEFAULT 'OUR' CHECK (fee_charge IN ('OUR','BEN')),
  system_ref    TEXT CHECK (system_ref IS NULL OR system_ref ~ '^[A-Za-z0-9]{1,18}$'),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── triggers: period assignment, lock, net ──
CREATE OR REPLACE FUNCTION salary_records_set_period()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.period_id := payroll_period_for(NEW.tenant_id, NEW.year, NEW.month);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION salary_records_set_period() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_records_set_period BEFORE INSERT OR UPDATE OF year, month ON salary_records
  FOR EACH ROW EXECUTE FUNCTION salary_records_set_period();

CREATE OR REPLACE FUNCTION payroll_assert_open(p_period UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
  IF p_period IS NULL OR payroll_bypass_on() THEN RETURN; END IF;
  SELECT status INTO v_status FROM payroll_periods WHERE id = p_period;
  IF v_status IN ('confirmed','closed') THEN
    RAISE EXCEPTION 'เงินเดือนเดือนนี้ยืนยันหรือปิดงวดแล้ว แก้ไขไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
END $$;
REVOKE ALL ON FUNCTION payroll_assert_open(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION salary_records_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM payroll_assert_open(OLD.period_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM payroll_assert_open(NEW.period_id); RETURN NEW; END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION salary_records_lock() FROM PUBLIC, anon, authenticated;
-- runs after set_period (trigger names fire alphabetically: _lock < _set_period would be wrong)
CREATE TRIGGER salary_records_zz_lock BEFORE INSERT OR UPDATE OR DELETE ON salary_records
  FOR EACH ROW EXECUTE FUNCTION salary_records_lock();

CREATE OR REPLACE FUNCTION salary_record_lines_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_period UUID;
BEGIN
  SELECT period_id INTO v_period FROM salary_records
   WHERE id = COALESCE(NEW.salary_record_id, OLD.salary_record_id);
  PERFORM payroll_assert_open(v_period);  -- NULL (parent already gone in a cascade) passes
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION salary_record_lines_lock() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_record_lines_lock BEFORE INSERT OR UPDATE OR DELETE ON salary_record_lines
  FOR EACH ROW EXECUTE FUNCTION salary_record_lines_lock();

CREATE OR REPLACE FUNCTION salary_record_lines_net()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rec UUID := COALESCE(NEW.salary_record_id, OLD.salary_record_id);
BEGIN
  UPDATE salary_records r SET net_pay = COALESCE((
    SELECT round(sum(CASE WHEN l.side = 'earning' THEN l.amount ELSE -l.amount END), 2)
      FROM salary_record_lines l WHERE l.salary_record_id = v_rec), 0)
   WHERE r.id = v_rec;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION salary_record_lines_net() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_record_lines_net AFTER INSERT OR UPDATE OR DELETE ON salary_record_lines
  FOR EACH ROW EXECUTE FUNCTION salary_record_lines_net();

-- ── default items: seed per tenant (mirror of src/lib/payroll/defaultItems.js) ──
CREATE OR REPLACE FUNCTION seed_default_pay_items(p_tenant UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_salary UUID; v_contrib UUID;
BEGIN
  INSERT INTO pay_items (tenant_id, system_key, name, side, method, params, sso_base, rounding, applies_to, sort_order) VALUES
    (p_tenant, 'salary',              'เงินเดือน',          'earning',   'base_pay',         '{}',                                   true,  'none',  'all',     10),
    (p_tenant, 'contribution',        'สมทบ',              'earning',   'percent_of_item',  '{"percent":5}',                        true,  'none',  'monthly', 20),
    (p_tenant, 'phone',               'โทรศัพท์',           'earning',   'fixed_per_worker', '{}',                                   true,  'none',  'all',     30),
    (p_tenant, 'ot',                  'OT',                'earning',   'ot',               '{"multiplier":1.5}',                   false, 'ceil',  'all',     40),
    (p_tenant, 'parking',             'เงินพิเศษค่าจอดรถ',   'earning',   'fixed_per_worker', '{}',                                   false, 'none',  'all',     50),
    (p_tenant, 'sso',                 'ประกันสังคม',         'deduction', 'sso',              '{"rate":0.05,"cap":875}',              false, 'round', 'all',     110),
    (p_tenant, 'house',               'ค่าบ้าน',            'deduction', 'fixed_per_worker', '{}',                                   false, 'none',  'all',     120),
    (p_tenant, 'advances',            'เบิกล่วงหน้า',        'deduction', 'advances',         '{}',                                   false, 'none',  'all',     130),
    (p_tenant, 'student_loan',        'กยศ',               'deduction', 'manual_monthly',   '{}',                                   false, 'none',  'all',     140),
    (p_tenant, 'unpaid_leave',        'ลาไม่รับค่าจ้าง',      'deduction', 'unpaid_leave',     '{"daily_rate_rounding":"ceil"}',       false, 'none',  'monthly', 150),
    (p_tenant, 'contribution_deduct', 'หักเงินสมทบ',        'deduction', 'percent_of_item',  '{"percent":100}',                      false, 'none',  'monthly', 160)
  ON CONFLICT (tenant_id, system_key) WHERE system_key IS NOT NULL DO NOTHING;

  SELECT id INTO v_salary  FROM pay_items WHERE tenant_id = p_tenant AND system_key = 'salary';
  SELECT id INTO v_contrib FROM pay_items WHERE tenant_id = p_tenant AND system_key = 'contribution';
  UPDATE pay_items SET params = params || jsonb_build_object('of_item_id', v_salary)
   WHERE tenant_id = p_tenant AND system_key = 'contribution' AND NOT params ? 'of_item_id';
  UPDATE pay_items SET params = params || jsonb_build_object('of_item_id', v_contrib)
   WHERE tenant_id = p_tenant AND system_key = 'contribution_deduct' AND NOT params ? 'of_item_id';
END $$;
REVOKE ALL ON FUNCTION seed_default_pay_items(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION tenants_seed_pay_items()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM seed_default_pay_items(NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenants_seed_pay_items() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER tenants_seed_pay_items AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_seed_pay_items();

DO $$ DECLARE t UUID; BEGIN
  FOR t IN SELECT id FROM tenants LOOP PERFORM seed_default_pay_items(t); END LOOP;
END $$;

-- existing rows get their period
UPDATE salary_records SET period_id = payroll_period_for(tenant_id, year, month) WHERE period_id IS NULL;

-- ── RLS ──
ALTER TABLE pay_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_pay_item_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_record_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_advances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_bank_settings   ENABLE ROW LEVEL SECURITY;

-- admin/owner manage the structure; everyone in the tenant with payroll may read item names
CREATE POLICY tenant_read ON pay_items FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_write ON pay_items FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());

CREATE POLICY admin_all ON worker_pay_item_amounts FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());

-- periods: read-only to clients; transitions only through RPCs (migration -02)
CREATE POLICY tenant_read ON payroll_periods FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- lines: admins read all; a worker reads own lines in confirmed/closed periods; writes via RPC only
CREATE POLICY read_lines ON salary_record_lines FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR EXISTS (
      SELECT 1 FROM salary_records r
      JOIN payroll_periods p ON p.id = r.period_id
      JOIN workers w ON w.id = r.worker_id
      WHERE r.id = salary_record_lines.salary_record_id
        AND p.status IN ('confirmed','closed') AND w.email = auth.email())));

-- salary_records: worker sees own rows only once confirmed; all writes via RPC
DROP POLICY IF EXISTS worker_reads_own ON salary_records;
CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR (
      worker_id IN (SELECT id FROM workers WHERE email = auth.email())
      AND period_id IN (SELECT id FROM payroll_periods WHERE status IN ('confirmed','closed')))));
DROP POLICY IF EXISTS admin_writes  ON salary_records;
DROP POLICY IF EXISTS admin_updates ON salary_records;
DROP POLICY IF EXISTS admin_deletes ON salary_records;

-- advances
CREATE POLICY read_advances ON salary_advances FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email())));
CREATE POLICY request_advance ON salary_advances FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND status = 'pending' AND approved_by IS NULL AND requested_by = auth.email()
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email())));
CREATE POLICY admin_delete_open ON salary_advances FOR DELETE TO authenticated
  USING (tenant_id = current_tenant_id() AND is_admin_or_owner() AND status IN ('pending','rejected'));

CREATE POLICY admin_all ON payroll_bank_settings FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());
```

- [ ] **Step 2: Check `has_module_access` and the RLS state of `workers` before testing**

Run this with `execute_sql` on CHANG (read-only):

```sql
SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname IN ('has_module_access','current_tenant_id','is_admin_or_owner','is_owner');
SELECT tgname FROM pg_trigger WHERE tgrelid = 'salary_records'::regclass AND NOT tgisinternal;
```

Expected: all 4 functions exist. `has_module_access` takes `(text)`. List the existing `salary_records` triggers. If any existing trigger name sorts after `salary_records_zz_lock` and changes `period_id`, rename the lock trigger so it stays last.

- [ ] **Step 3: Dry-run the whole migration inside a rolled-back transaction**

Run this with `execute_sql` on CHANG: `BEGIN;`, then the full file contents, then the checks below, then `ROLLBACK;`. Send it as **one** call so nothing commits.

```sql
-- checks (inside the same transaction, before ROLLBACK)
SELECT count(*) AS tenants_without_items FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM pay_items p WHERE p.tenant_id = t.id); -- expect 0
SELECT count(*) AS items_per_tenant FROM pay_items GROUP BY tenant_id LIMIT 1;                                                 -- expect 11
SELECT count(*) FILTER (WHERE period_id IS NULL) AS records_without_period FROM salary_records;                                  -- expect 0
-- lock: close one period and try to edit
UPDATE payroll_periods SET status = 'closed' WHERE id = (SELECT period_id FROM salary_records LIMIT 1);
DO $$ BEGIN
  UPDATE salary_records SET notes = 'x' WHERE period_id = (SELECT id FROM payroll_periods WHERE status = 'closed' LIMIT 1);
  RAISE EXCEPTION 'LOCK DID NOT FIRE';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'lock ok'; END $$;
-- deleting a worker who has a closed record is refused with the Thai message (cascade hits the lock)
DO $$ BEGIN
  DELETE FROM workers WHERE id = (SELECT worker_id FROM salary_records WHERE period_id = (SELECT id FROM payroll_periods WHERE status = 'closed' LIMIT 1) LIMIT 1);
  RAISE EXCEPTION 'WORKER DELETE DID NOT FAIL';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'worker delete blocked ok: %', SQLERRM; END $$;
-- bypass works
SELECT set_config('chang.payroll_bypass', 'on', true);
UPDATE salary_records SET notes = notes WHERE period_id = (SELECT id FROM payroll_periods WHERE status = 'closed' LIMIT 1);
ROLLBACK;
```

Expected: `tenants_without_items = 0`, `items_per_tenant = 11`, `records_without_period = 0`, notice `lock ok`, and no `LOCK DID NOT FIRE`. Fix the file and rerun until clean.

- [ ] **Step 4: Commit (do not apply)**

```bash
git add supabase/migrations/2026-10-19-01-payroll-structure.sql
git commit -m "feat(payroll): schema for pay items, periods, lines, advances, bank settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: RPC migration — save draft, manual line, state transitions, advances

**Files:**
- Create: `supabase/migrations/2026-10-19-02-payroll-rpcs.sql`

**Interfaces:**
- Consumes: Task 2 tables and functions.
- Produces these RPCs (all `SECURITY DEFINER`, granted to `authenticated`):
  - `save_payroll_draft(p_year int, p_month int, p_records jsonb) → int`. `p_records` is `[{worker_id, facts:{…}, lines:[Line]}]`; Line is as in Task 1, without `is_manual` defaults.
  - `set_payroll_manual_line(p_record_id uuid, p_pay_item_id uuid, p_advance_id uuid, p_amount numeric) → void`. A null amount removes the override.
  - `confirm_payroll_period(p_year int, p_month int) → void` and `unconfirm_payroll_period(p_year int, p_month int) → void`
  - `close_payroll_period(p_year int, p_month int, p_paid_date date) → void`
  - `reopen_payroll_period(p_year int, p_month int, p_reason text) → void` (owner only)
  - `approve_salary_advance(p_id uuid) → void` and `reject_salary_advance(p_id uuid, p_reason text) → void` (owner only)
  - Helper: `advance_deducted_closed(p_advance uuid) → numeric`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-19-02-payroll-rpcs.sql
-- Payroll rework, part 2: the only write paths for salary_records / lines /
-- period state / advance approval. Each checks role + tenant itself.

CREATE OR REPLACE FUNCTION payroll_require_admin()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'ต้องเป็นแอดมินหรือเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN current_tenant_id();
END $$;
REVOKE ALL ON FUNCTION payroll_require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION save_payroll_draft(p_year INT, p_month INT, p_records JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant UUID := payroll_require_admin();
  v_period UUID; v_status TEXT; v_rec JSONB; v_line JSONB; v_record_id UUID; v_n INT := 0;
  v_workers UUID[] := '{}';
BEGIN
  v_period := payroll_period_for(v_tenant, p_year, p_month);
  SELECT status INTO v_status FROM payroll_periods WHERE id = v_period FOR UPDATE;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'เงินเดือนเดือนนี้ยืนยันหรือปิดงวดแล้ว แก้ไขไม่ได้' USING ERRCODE = 'check_violation';
  END IF;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_records) LOOP
    IF NOT EXISTS (SELECT 1 FROM workers WHERE id = (v_rec->>'worker_id')::uuid AND tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'ไม่พบพนักงาน %', v_rec->>'worker_id';
    END IF;
    v_workers := v_workers || (v_rec->>'worker_id')::uuid;

    INSERT INTO salary_records (tenant_id, worker_id, year, month, facts)
    VALUES (v_tenant, (v_rec->>'worker_id')::uuid, p_year, p_month, COALESCE(v_rec->'facts', '{}'::jsonb))
    ON CONFLICT (worker_id, month, year) DO UPDATE SET facts = EXCLUDED.facts
    RETURNING id INTO v_record_id;

    DELETE FROM salary_record_lines WHERE salary_record_id = v_record_id;
    FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(v_rec->'lines', '[]'::jsonb)) LOOP
      INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, advance_id, name, side, sort_order, amount, quantity, rate, note, is_manual)
      SELECT v_tenant, v_record_id,
             (SELECT id FROM pay_items WHERE id = NULLIF(v_line->>'pay_item_id','')::uuid AND tenant_id = v_tenant),
             (SELECT id FROM salary_advances WHERE id = NULLIF(v_line->>'advance_id','')::uuid AND tenant_id = v_tenant),
             v_line->>'name', v_line->>'side', COALESCE((v_line->>'sort_order')::int, 0),
             round((v_line->>'amount')::numeric, 2),
             NULLIF(v_line->>'quantity','')::numeric, NULLIF(v_line->>'rate','')::numeric,
             v_line->>'note', COALESCE((v_line->>'is_manual')::boolean, false);
    END LOOP;
    v_n := v_n + 1;
  END LOOP;

  -- workers no longer in the run (inactive) drop out of this draft month
  DELETE FROM salary_records WHERE period_id = v_period AND NOT (worker_id = ANY (v_workers));
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION save_payroll_draft(INT, INT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_payroll_draft(INT, INT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION set_payroll_manual_line(p_record_id UUID, p_pay_item_id UUID, p_advance_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant UUID := payroll_require_admin(); v_item pay_items; v_note TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM salary_records WHERE id = p_record_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'ไม่พบรายการเงินเดือน';
  END IF;
  SELECT * INTO v_item FROM pay_items WHERE id = p_pay_item_id AND tenant_id = v_tenant;
  IF v_item.id IS NULL OR v_item.method NOT IN ('manual_monthly','advances') THEN
    RAISE EXCEPTION 'รายการนี้กรอกเองไม่ได้';
  END IF;
  IF v_item.method = 'advances' AND p_advance_id IS NULL THEN RAISE EXCEPTION 'ต้องระบุรายการเบิก'; END IF;

  SELECT note INTO v_note FROM salary_record_lines
   WHERE salary_record_id = p_record_id AND pay_item_id = p_pay_item_id
     AND advance_id IS NOT DISTINCT FROM p_advance_id LIMIT 1;
  DELETE FROM salary_record_lines
   WHERE salary_record_id = p_record_id AND pay_item_id = p_pay_item_id
     AND advance_id IS NOT DISTINCT FROM p_advance_id;
  IF p_amount IS NOT NULL THEN
    INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, advance_id, name, side, sort_order, amount, note, is_manual)
    VALUES (v_tenant, p_record_id, p_pay_item_id, p_advance_id, v_item.name, v_item.side, v_item.sort_order, round(p_amount, 2), v_note, true);
  END IF;
END $$;
REVOKE ALL ON FUNCTION set_payroll_manual_line(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_payroll_manual_line(UUID, UUID, UUID, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION payroll_transition(p_year INT, p_month INT, p_from TEXT, p_to TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant UUID := current_tenant_id(); v_id UUID; v_status TEXT;
BEGIN
  SELECT id, status INTO v_id, v_status FROM payroll_periods
   WHERE tenant_id = v_tenant AND year = p_year AND month = p_month FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'ยังไม่มีเงินเดือนของเดือนนี้'; END IF;
  IF v_status <> p_from THEN
    RAISE EXCEPTION 'สถานะตอนนี้คือ % ทำรายการนี้ไม่ได้', v_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE payroll_periods SET status = p_to WHERE id = v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION payroll_transition(INT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION confirm_payroll_period(p_year INT, p_month INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM payroll_require_admin();
  IF NOT EXISTS (SELECT 1 FROM salary_records r JOIN payroll_periods p ON p.id = r.period_id
                  WHERE p.tenant_id = current_tenant_id() AND p.year = p_year AND p.month = p_month) THEN
    RAISE EXCEPTION 'ยังไม่ได้คำนวณเงินเดือนเดือนนี้';
  END IF;
  v_id := payroll_transition(p_year, p_month, 'draft', 'confirmed');
  UPDATE payroll_periods SET confirmed_by = auth.email(), confirmed_at = now() WHERE id = v_id;
END $$;
REVOKE ALL ON FUNCTION confirm_payroll_period(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_payroll_period(INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION unconfirm_payroll_period(p_year INT, p_month INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM payroll_require_admin();
  v_id := payroll_transition(p_year, p_month, 'confirmed', 'draft');
  UPDATE payroll_periods SET confirmed_by = NULL, confirmed_at = NULL WHERE id = v_id;
END $$;
REVOKE ALL ON FUNCTION unconfirm_payroll_period(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION unconfirm_payroll_period(INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION advance_deducted_closed(p_advance UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(l.amount), 0) FROM salary_record_lines l
  JOIN salary_records r ON r.id = l.salary_record_id
  JOIN payroll_periods p ON p.id = r.period_id
  WHERE l.advance_id = p_advance AND p.status = 'closed';
$$;
REVOKE ALL ON FUNCTION advance_deducted_closed(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION advance_deducted_closed(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION close_payroll_period(p_year INT, p_month INT, p_paid_date DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_tenant UUID := payroll_require_admin();
BEGIN
  IF p_paid_date IS NULL THEN RAISE EXCEPTION 'ใส่วันที่จ่ายก่อนปิดงวด'; END IF;
  v_id := payroll_transition(p_year, p_month, 'confirmed', 'closed');
  UPDATE payroll_periods SET closed_by = auth.email(), closed_at = now(), paid_date = p_paid_date WHERE id = v_id;
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  UPDATE salary_records SET paid_date = p_paid_date WHERE period_id = v_id;
  PERFORM set_config('chang.payroll_bypass', '', true);
  UPDATE salary_advances a SET status = 'settled'
   WHERE a.tenant_id = v_tenant AND a.status = 'approved' AND advance_deducted_closed(a.id) >= a.amount;
END $$;
REVOKE ALL ON FUNCTION close_payroll_period(INT, INT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_payroll_period(INT, INT, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION reopen_payroll_period(p_year INT, p_month INT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_tenant UUID := current_tenant_id(); v_old JSONB;
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'เปิดงวดใหม่ได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'ใส่เหตุผลที่เปิดงวด'; END IF;
  SELECT to_jsonb(p) INTO v_old FROM payroll_periods p WHERE tenant_id = v_tenant AND year = p_year AND month = p_month;
  v_id := payroll_transition(p_year, p_month, 'closed', 'draft');
  UPDATE payroll_periods SET reopen_reason = p_reason, confirmed_by = NULL, confirmed_at = NULL,
                             closed_by = NULL, closed_at = NULL WHERE id = v_id;
  INSERT INTO audit_logs (tenant_id, table_name, record_id, action, user_email, old_values, new_values)
  VALUES (v_tenant, 'payroll_periods', v_id, 'UPDATE', auth.email(), v_old,
          jsonb_build_object('status', 'draft', 'reopen_reason', p_reason));
  UPDATE salary_advances a SET status = 'approved'
   WHERE a.tenant_id = v_tenant AND a.status = 'settled' AND advance_deducted_closed(a.id) < a.amount;
END $$;
REVOKE ALL ON FUNCTION reopen_payroll_period(INT, INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_payroll_period(INT, INT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION approve_salary_advance(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'อนุมัติได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE salary_advances SET status = 'approved', approved_by = auth.email(), approved_at = now()
   WHERE id = p_id AND tenant_id = current_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ'; END IF;
END $$;
REVOKE ALL ON FUNCTION approve_salary_advance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_salary_advance(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION reject_salary_advance(p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'ไม่อนุมัติได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE salary_advances SET status = 'rejected', approved_by = auth.email(), approved_at = now(), reject_reason = p_reason
   WHERE id = p_id AND tenant_id = current_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ'; END IF;
END $$;
REVOKE ALL ON FUNCTION reject_salary_advance(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_salary_advance(UUID, TEXT) TO authenticated;
```

- [ ] **Step 2: Dry-run migrations -01 and -02 together as admin, owner and worker**

Use one `execute_sql` call: `BEGIN;` + file -01 + file -02 + the script below + `ROLLBACK;`. Impersonate with the same JWT-claims pattern as `demo_impersonate()` in `2026-10-15-01-demo-tenant-seed.sql`: read that function first and copy how it sets `request.jwt.claims` and `role`. Use the **demo tenant** (`8b61c890-0a90-4223-91d3-b5f8f4e89908`). Its logins are `demo-owner@facadex.co.th` (OWNER), `demo-admin@facadex.co.th` (ADMIN), plus the demo worker email from `demo_worker_email()`.

```sql
-- as ADMIN
SELECT set_config('request.jwt.claims', json_build_object('email','demo-admin@facadex.co.th','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT save_payroll_draft(2026, 11, jsonb_build_array(jsonb_build_object(
  'worker_id', (SELECT id FROM workers WHERE tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908' LIMIT 1),
  'facts', '{"daysWorked":22}'::jsonb,
  'lines', '[{"name":"เงินเดือน","side":"earning","amount":15000,"sort_order":10},{"name":"ประกันสังคม","side":"deduction","amount":750,"sort_order":110}]'::jsonb)));
SELECT net_pay FROM salary_records WHERE year = 2026 AND month = 11;            -- expect 14250
SELECT confirm_payroll_period(2026, 11);
DO $$ BEGIN PERFORM save_payroll_draft(2026, 11, '[]'::jsonb); RAISE EXCEPTION 'SAVE ON CONFIRMED DID NOT FAIL';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'confirmed lock ok'; END $$;
SELECT close_payroll_period(2026, 11, '2026-11-30');
DO $$ BEGIN PERFORM reopen_payroll_period(2026, 11, 'test'); RAISE EXCEPTION 'ADMIN REOPEN DID NOT FAIL';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'admin cannot reopen ok'; END $$;
-- as OWNER
RESET ROLE;
SELECT set_config('request.jwt.claims', json_build_object('email','demo-owner@facadex.co.th','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT reopen_payroll_period(2026, 11, 'test');
SELECT status, reopen_reason FROM payroll_periods WHERE year = 2026 AND month = 11;   -- expect draft / test
SELECT count(*) FROM audit_logs WHERE table_name = 'payroll_periods';                  -- expect ≥ 1
-- as WORKER: cannot see a draft month
RESET ROLE;
SELECT set_config('request.jwt.claims', json_build_object('email', demo_worker_email('8b61c890-0a90-4223-91d3-b5f8f4e89908'),'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT count(*) FROM salary_records WHERE year = 2026 AND month = 11;                  -- expect 0 (draft)
DO $$ BEGIN PERFORM approve_salary_advance(gen_random_uuid()); RAISE EXCEPTION 'WORKER APPROVE DID NOT FAIL';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'worker cannot approve ok'; END $$;
ROLLBACK;
```

Expected: net 14250, three `ok` notices plus `worker cannot approve ok`, status `draft`/`test`, and worker count 0. No `DID NOT FAIL` exception.

- [ ] **Step 3: Commit (do not apply)**

```bash
git add supabase/migrations/2026-10-19-02-payroll-rpcs.sql
git commit -m "feat(payroll): RPCs for draft save, manual lines, period states, advance approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Costing views use ÷30 and daily wage

**Files:**
- Create: `supabase/migrations/2026-10-19-03-labor-cost-divide-30.sql`

**Interfaces:**
- Consumes: Task 2 `workers.pay_type`, `workers.daily_wage`.
- Produces:
  - `workers_with_rate` gets the same columns as before, plus these appended: `employee_code, bank_code, bank_account_no, bank_account_name, bank_branch_code, pay_type, daily_wage`.
  - `daily_rate` follows the Global Constraints rule.
  - `labor_cost_by_site` and `ot_cost_by_site` keep the same columns, with the new rate.

- [ ] **Step 1: Pull the live definitions (they may differ from the repo files)**

Run with `execute_sql` on CHANG:

```sql
SELECT c.relname, pg_get_viewdef(c.oid, true), c.reloptions
FROM pg_class c WHERE c.relname IN ('workers_with_rate','labor_cost_by_site','ot_cost_by_site');
```

Copy each definition into the migration and change only the rate expressions. Keep `security_invoker` if `reloptions` shows it.

- [ ] **Step 2: Write the migration**

The rate expression to use everywhere:
`(CASE WHEN w.pay_type = 'daily' THEN COALESCE(w.daily_wage, 0) ELSE w.monthly_salary / 30 END)`.
In `workers_with_rate`, the alias is the table itself, so use `pay_type`/`daily_wage` without the `w.` prefix.

```sql
-- supabase/migrations/2026-10-19-03-labor-cost-divide-30.sql
-- One daily rate everywhere: monthly_salary / 30 (owner decision 2026-10-16),
-- daily_wage for pay_type='daily'. Lowers site labor cost ~13% for all months
-- (live views) — accepted by the owner. Also fixes social_security_amount
-- (was monthly_salary*0.05/100*750, a wrong formula) to LEAST(875, round(5%)).

CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(CASE WHEN pay_type = 'daily' THEN COALESCE(daily_wage, 0) ELSE monthly_salary / 30 END, 2) AS daily_rate,
  LEAST(875, ROUND(monthly_salary * 0.05, 0)) AS social_security_amount,
  email, show_in_assign, annual_sick_leave_days,
  id_card_number, address, id_card_photo_path,
  employee_code, bank_code, bank_account_no, bank_account_name, bank_branch_code, pay_type, daily_wage
FROM workers;

CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND((CASE WHEN w.pay_type = 'daily' THEN COALESCE(w.daily_wage, 0) ELSE w.monthly_salary / 30 END) * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory'
   OR (wa.type = 'site' AND (wa.confirmed_at IS NOT NULL OR NOT checkin_confirmation_required()))
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary, w.pay_type, w.daily_wage;

CREATE OR REPLACE VIEW ot_cost_by_site WITH (security_invoker = true) AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * ((CASE WHEN w.pay_type = 'daily' THEN COALESCE(w.daily_wage, 0) ELSE w.monthly_salary / 30 END) / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;
```

If the Step 1 output differs from the SQL above in any column or join, the **live** version wins: keep it and change only the rate. If `ot_cost_by_site` has no `security_invoker` live, keep it without one. Don't change security in this task.

- [ ] **Step 3: Grep the app and the other SQL for leftover /26**

Run: `grep -rnE "/ ?26\b" src supabase/migrations --include='*.js' --include='*.jsx' --include='*.sql' | grep -v "2026-0[0-9]\|2026-10-0\|2026-10-1[0-6]"`
Expected: no hits outside historical migrations. `src/pages/Payroll.jsx` is deleted in Task 9; ignore it here.

- [ ] **Step 4: Dry-run with -01 and compare totals**

In one `execute_sql` call: `BEGIN;` + file -01 + file -03 + the query below + `ROLLBACK;`:

```sql
SELECT round(sum(labor_cost)) AS new_total FROM labor_cost_by_site;
```

Run `SELECT round(sum(labor_cost)) FROM labor_cost_by_site;` once more outside the transaction to get the old total.
Expected: new ≈ old × 26/30, which is about 0.867. Note both numbers in the commit message.

- [ ] **Step 5: Commit (do not apply)**

```bash
git add supabase/migrations/2026-10-19-03-labor-cost-divide-30.sql
git commit -m "feat(payroll): costing views use salary/30 and daily wage

Labor cost total on CHANG: <old> -> <new> (dry run).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Backfill old salary records into lines + demo seed/reset

**Files:**
- Create: `supabase/migrations/2026-10-19-04-payroll-backfill.sql`

**Interfaces:**
- Consumes: Task 2 tables and seed function.
- Produces:
  - `payroll_backfill_lines(p_tenant uuid, p_apply boolean) → jsonb`, returning `{records, lines, mismatches:[{record_id, worker, year, month, old_net, lines_net}]}`.
  - `seed_demo_tenant` and `reset_demo_tenant`, updated.

- [ ] **Step 1: Check monthly_contribution against 5% on CHANG (spec requirement)**

Run with `execute_sql`:

```sql
SELECT t.company_name, w.name, w.monthly_salary, w.monthly_contribution, round(w.monthly_salary * 0.05, 2) AS five_pct
FROM workers w JOIN tenants t ON t.id = w.tenant_id
WHERE w.status = 'active' AND COALESCE(w.monthly_contribution, 0) <> round(w.monthly_salary * 0.05, 2)
ORDER BY 1, 2;
```

If any rows come back for FacadeX, **stop and report them to the owner** before going on. The สมทบ default is "5% of salary", and these workers would change pay. Do not change the default without an owner decision. Rows for the demo tenant or for tenants with no contribution set (0) are fine.

- [ ] **Step 2: Write the migration**

Old columns map to default items like this:
- base_salary → salary
- contribution → contribution, plus contribution_deduct for the same amount (old net never included it)
- phone_allowance → phone
- ot_amount → ot
- special_allowance → parking
- social_security_ded → sso
- leave_deduction → unpaid_leave
- advance_deduction → advances
- loan_deduction → student_loan

Then, if Σ lines ≠ old net_pay, an adjustment line `ปรับยอดจากระบบเดิม` (pay_item_id NULL) holds the difference. That way the amount actually paid never changes. Every such row is reported.

```sql
-- supabase/migrations/2026-10-19-04-payroll-backfill.sql
-- Converts pre-rework salary_records (fixed money columns) into
-- salary_record_lines so old months open in the new grid and payslip.
-- Paid months (every record has paid_date) become 'closed'.
-- p_apply=false is a dry run (counts + mismatches, then RAISE to roll back).

CREATE OR REPLACE FUNCTION payroll_backfill_lines(p_tenant UUID, p_apply BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r RECORD; v_items JSONB; v_lines INT := 0; v_recs INT := 0; v_mis JSONB := '[]'::jsonb;
  v_sum NUMERIC; v_out JSONB;
BEGIN
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  PERFORM seed_default_pay_items(p_tenant);
  SELECT jsonb_object_agg(system_key, jsonb_build_object('id', id, 'name', name, 'side', side, 'sort', sort_order))
    INTO v_items FROM pay_items WHERE tenant_id = p_tenant AND system_key IS NOT NULL;

  FOR r IN
    SELECT s.*, w.name AS worker_name FROM salary_records s JOIN workers w ON w.id = s.worker_id
    WHERE s.tenant_id = p_tenant
      AND NOT EXISTS (SELECT 1 FROM salary_record_lines l WHERE l.salary_record_id = s.id)
  LOOP
    v_recs := v_recs + 1;
    INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, name, side, sort_order, amount)
    SELECT p_tenant, r.id, (v_items->k->>'id')::uuid, v_items->k->>'name', v_items->k->>'side', (v_items->k->>'sort')::int, amt
    FROM (VALUES
      ('salary', r.base_salary), ('contribution', r.contribution), ('phone', r.phone_allowance),
      ('ot', r.ot_amount), ('parking', r.special_allowance), ('sso', r.social_security_ded),
      ('house', 0::numeric), ('advances', r.advance_deduction), ('student_loan', r.loan_deduction),
      ('unpaid_leave', r.leave_deduction), ('contribution_deduct', r.contribution)
    ) AS m(k, amt)
    WHERE COALESCE(amt, 0) <> 0;
    GET DIAGNOSTICS v_sum = ROW_COUNT; v_lines := v_lines + v_sum;

    SELECT COALESCE(sum(CASE WHEN side = 'earning' THEN amount ELSE -amount END), 0) INTO v_sum
      FROM salary_record_lines WHERE salary_record_id = r.id;
    IF round(v_sum, 2) <> round(COALESCE(r.net_pay, 0), 2) THEN
      v_mis := v_mis || jsonb_build_object('record_id', r.id, 'worker', r.worker_name, 'year', r.year, 'month', r.month,
                                           'old_net', r.net_pay, 'lines_net', round(v_sum, 2));
      INSERT INTO salary_record_lines (tenant_id, salary_record_id, name, side, sort_order, amount, note)
      VALUES (p_tenant, r.id, 'ปรับยอดจากระบบเดิม',
              CASE WHEN COALESCE(r.net_pay, 0) > v_sum THEN 'earning' ELSE 'deduction' END, 999,
              abs(round(COALESCE(r.net_pay, 0) - v_sum, 2)), 'ยอดสุทธิเดิมที่จ่ายจริง');
      v_lines := v_lines + 1;
    END IF;
  END LOOP;

  UPDATE payroll_periods p SET status = 'closed', paid_date = (SELECT max(paid_date) FROM salary_records s WHERE s.period_id = p.id)
   WHERE p.tenant_id = p_tenant AND p.status = 'draft'
     AND EXISTS (SELECT 1 FROM salary_records s WHERE s.period_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM salary_records s WHERE s.period_id = p.id AND s.paid_date IS NULL);

  PERFORM set_config('chang.payroll_bypass', '', true);
  v_out := jsonb_build_object('records', v_recs, 'lines', v_lines, 'mismatches', v_mis);
  IF NOT p_apply THEN RAISE EXCEPTION 'DRY RUN %', v_out; END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION payroll_backfill_lines(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
```

The `house` row is a placeholder with 0. It is filtered out and kept only so the mapping table lists every default.

Then add the demo hooks. Copy the **live** `seed_demo_tenant` and `reset_demo_tenant` bodies (`SELECT pg_get_functiondef('seed_demo_tenant(uuid)'::regprocedure)`, and the same for reset) and add only these lines:
- In `reset_demo_tenant`, the first statement after `PERFORM demo_tenant_guard(p_tenant_id);` becomes `PERFORM set_config('chang.payroll_bypass', 'on', true);`.
- In `seed_demo_tenant`, before `v_out := v_out || demo_seed_people(p_tenant_id);`, add `PERFORM seed_default_pay_items(p_tenant_id);`.
- After that line, add `v_out := v_out || jsonb_build_object('payroll_backfill', payroll_backfill_lines(p_tenant_id, true));`.

Keep both functions' `REVOKE`/`GRANT` lines exactly as live.

- [ ] **Step 3: Dry-run the backfill on every tenant and read the mismatches**

In one `execute_sql` call: `BEGIN;` + files -01, -02 and -04 + the block below + `ROLLBACK;`:

```sql
DO $$ DECLARE t RECORD; BEGIN
  FOR t IN SELECT id, company_name FROM tenants LOOP
    BEGIN
      PERFORM payroll_backfill_lines(t.id, false);
    EXCEPTION WHEN raise_exception THEN RAISE NOTICE '% → %', t.company_name, SQLERRM; END;
  END LOOP;
END $$;
ROLLBACK;
```

Expected: one `DRY RUN {...}` notice per tenant. **Copy the FacadeX mismatch list into the task report.** Mismatches are expected where admins typed a net by hand, or where the old recalc bug left a stale net. Those records get the adjustment line, so the paid amount is preserved.

- [ ] **Step 4: Dry-run a demo reset**

In one `execute_sql` call: `BEGIN;` + files -01, -02, -03 and -04, impersonating the demo owner the same way as in Task 3, then:

```sql
SELECT reset_demo_tenant('8b61c890-0a90-4223-91d3-b5f8f4e89908') -> 'seeded' -> 'payroll_backfill';
SELECT count(*) FROM pay_items WHERE tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908';   -- expect 11
SELECT count(*) FROM payroll_periods WHERE tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908' AND status = 'closed';  -- expect > 0
ROLLBACK;
```

Expected: no `demo_reset_stuck` error, 11 items, at least 1 closed period, and `mismatches` = `[]` for the demo, whose seed nets are computed exactly.

- [ ] **Step 5: Commit (do not apply)**

```bash
git add supabase/migrations/2026-10-19-04-payroll-backfill.sql
git commit -m "feat(payroll): backfill old salary records into lines; demo seed/reset aware of payroll lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Attendance summary, run builder, advances due, diff, data layer

**Files:**
- Create: `src/lib/payroll/attendance.js`, `src/lib/payroll/run.js`, `src/lib/payroll/load.js`, `src/hooks/usePayroll.js`
- Test: `src/lib/payroll/attendance.test.js`, `src/lib/payroll/run.test.js`

**Interfaces:**
- Consumes: Task 1 (`calculateWorkerPay`, `advanceInstallmentDue`, `comparePeriod`, `monthRange`, `weekdayOf`), and the Task 2/3 tables and RPCs.
- Produces:
  - `summarizeAttendance({shifts, otRows, holidayDates, requireConfirm}) → {[worker_id]: {daysWorked, leavePersonalDays, leaveSickDays, otHours, holidayShifts, officeDays}}`
  - `findAssignGaps({workers, shifts, holidayDates, year, month, today:'YYYY-MM-DD'}) → [{worker_id, name, dates:[{date, missing:('morning'|'evening')[]}]}]`. `loadPayrollMonth` returns it as `assignGaps`, and so `calculateMonth` returns it too.
  - `advancesDueFor({advances, priorLines, year, month}) → {[worker_id]: Due[]}`, where `Due = {advance_id, title, amount, installment_no, installments, remaining_after}`, `advances` are rows with status `approved`, and `priorLines = [{advance_id, amount, year, month}]`.
  - `manualFromLines(lines) → manual map` (the `calculateWorkerPay` format)
  - `buildPayrollRun({items, workers, amountsByWorker, attendanceByWorker, manualByWorker, advancesDueByWorker, settings}) → [{worker_id, worker, lines, totals, warnings, facts}]`
  - `diffRuns(savedRecords, run) → [{worker_id, name, changes:[{name, before, after}]}]`, where `savedRecords = [{worker_id, lines}]`.
  - `load.js`: `loadPayrollMonth(year, month) → {period, items, workers, records, inputs}`, `calculateMonth(year, month) → {run, diff, period}`, `saveDraft(year, month, run)`, `setManualLine(recordId, payItemId, advanceId, amount)`, `confirmMonth`, `unconfirmMonth`, `closeMonth(y, m, paidDate)`, `reopenMonth(y, m, reason)`, `approveAdvance(id)`, `rejectAdvance(id, reason)`, `requestAdvance({worker_id, title, amount, installments, start_year, start_month})`
  - `usePayroll.js`: `usePayItems()`, `usePayrollMonth(year, month)`, `useAdvances({workerId}?)`, `useBankSettings()`, `useWorkerPayAmounts(workerId)`. Each returns `{data, loading, error, refetch}` built on `useQuery` from `useSupabase.js`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/payroll/attendance.test.js
import { describe, it, expect } from 'vitest'
import { summarizeAttendance } from './attendance.js'

describe('summarizeAttendance', () => {
  const shifts = [
    { worker_id: 'a', type: 'site', date: '2026-10-16', ot_hours: 1, confirmed_at: null },
    { worker_id: 'a', type: 'site', date: '2026-10-18', ot_hours: 0, confirmed_at: '2026-10-18T08:00:00Z' }, // Sunday
    { worker_id: 'a', type: 'factory', date: '2026-10-23', ot_hours: 0 },                                      // holiday
    { worker_id: 'a', type: 'office', date: '2026-10-24' },
    { worker_id: 'a', type: 'leave_personal', date: '2026-10-26' },
    { worker_id: 'a', type: 'leave', date: '2026-10-27' },
    { worker_id: 'a', type: 'leave_sick', date: '2026-10-28' },
    { worker_id: 'a', type: 'site', date: '2026-10-31', ot_hours: 0, confirmed_at: null },                    // last day of month
  ]
  it('counts worked shifts as half days, leave and OT, with confirmation off', () => {
    const r = summarizeAttendance({ shifts, otRows: [{ worker_id: 'a', ot_hours: 2 }], holidayDates: ['2026-10-23'], requireConfirm: false })
    expect(r.a).toEqual({ daysWorked: 2.5, leavePersonalDays: 1, leaveSickDays: 0.5, otHours: 3, holidayShifts: 2, officeDays: 0.5 })
  })
  it('drops unconfirmed site shifts from days and holiday premium when confirmation is required', () => {
    const r = summarizeAttendance({ shifts, otRows: [], holidayDates: ['2026-10-23'], requireConfirm: true })
    expect(r.a.daysWorked).toBe(1.5)
    expect(r.a.holidayShifts).toBe(2)
  })
  it('creates an entry for a worker who only has OT rows', () => {
    const r = summarizeAttendance({ shifts: [], otRows: [{ worker_id: 'b', ot_hours: 4 }], holidayDates: [] })
    expect(r.b.otHours).toBe(4)
  })
})
```

```js
// src/lib/payroll/run.test.js
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
```

Add the Assign-gap test to `attendance.test.js`. This is the owner's request of 2026-10-17: warn the admin when Assign is incomplete.

```js
import { findAssignGaps } from './attendance.js'

describe('findAssignGaps', () => {
  const workers = [
    { id: 'a', name: 'กร', show_in_assign: true },
    { id: 'h', name: 'โปรย', show_in_assign: false },
  ]
  // October 2026, "today" = Wed 7 Oct: days 1..7 are in scope; 4 Oct is Sunday; 5 Oct is a company holiday
  const shifts = [
    { worker_id: 'a', date: '2026-10-01', shift: 'morning' }, { worker_id: 'a', date: '2026-10-01', shift: 'evening' },
    { worker_id: 'a', date: '2026-10-02', shift: 'morning' },                                                   // evening missing
    { worker_id: 'a', date: '2026-10-03', shift: 'morning' }, { worker_id: 'a', date: '2026-10-03', shift: 'evening' },
    { worker_id: 'a', date: '2026-10-06', shift: 'morning' }, { worker_id: 'a', date: '2026-10-06', shift: 'evening' },
  ]
  it('lists Mon–Sat non-holiday days up to today with a missing shift, skipping hidden workers', () => {
    const r = findAssignGaps({ workers, shifts, holidayDates: ['2026-10-05'], year: 2026, month: 10, today: '2026-10-07' })
    expect(r).toEqual([{ worker_id: 'a', name: 'กร', dates: [
      { date: '2026-10-02', missing: ['evening'] },
      { date: '2026-10-07', missing: ['morning', 'evening'] },
    ] }])
  })
  it('checks the whole month when today is after it', () => {
    const r = findAssignGaps({ workers: [workers[0]], shifts: [], holidayDates: [], year: 2026, month: 2, today: '2026-10-07' })
    expect(r[0].dates).toHaveLength(24) // Feb 2026: 28 days − 4 Sundays
  })
  it('returns nothing for a month that has not started', () => {
    expect(findAssignGaps({ workers, shifts: [], holidayDates: [], year: 2026, month: 11, today: '2026-10-07' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and check that they fail**

Run: `TZ=Asia/Bangkok npx vitest run src/lib/payroll/attendance.test.js src/lib/payroll/run.test.js`
Expected: FAIL (missing modules).

- [ ] **Step 3: Implement attendance.js and run.js**

```js
// src/lib/payroll/attendance.js
// Shifts (worker_assignments) + worker_ot + company holidays → per-worker facts.
// 1 shift = 0.5 day. Rules carried over from HR.jsx handleCalcFromAssign:
// legacy 'leave' counts as leave_personal; site shifts count only when confirmed
// if confirmation is required; factory always counts; Sunday = holiday rate.
import { weekdayOf } from './period.js'

const WORK_TYPES = ['site', 'factory', 'office']

export function summarizeAttendance({ shifts = [], otRows = [], holidayDates = [], requireConfirm = false }) {
  const hol = new Set(holidayDates)
  const out = {}
  const get = id => (out[id] ||= { daysWorked: 0, leavePersonalDays: 0, leaveSickDays: 0, otHours: 0, holidayShifts: 0, officeDays: 0 })
  for (const s of shifts) {
    const a = get(s.worker_id)
    const siteCounts = s.type === 'site' && (!requireConfirm || !!s.confirmed_at)
    if (WORK_TYPES.includes(s.type) && (s.type !== 'site' || siteCounts)) a.daysWorked += 0.5
    if (s.type === 'office') a.officeDays += 0.5
    if (s.type === 'leave_sick') a.leaveSickDays += 0.5
    if (s.type === 'leave_personal' || s.type === 'leave') a.leavePersonalDays += 0.5
    if (s.type === 'site') a.otHours += Number(s.ot_hours) || 0
    if ((s.type === 'factory' || siteCounts) && (hol.has(s.date) || weekdayOf(s.date) === 0)) a.holidayShifts += 1
  }
  for (const o of otRows) get(o.worker_id).otHours += Number(o.ot_hours) || 0
  return out
}

// Owner request 2026-10-17: warn whoever runs payroll when Assign is not filled
// in. A gap = Mon–Sat, not a company holiday, on or before `today`, missing the
// morning or evening row (any type counts, incl. leave/holiday). Workers hidden
// from Assign (show_in_assign=false) are skipped.
export function findAssignGaps({ workers, shifts, holidayDates = [], year, month, today }) {
  const { from, to, lastDay } = monthRange(year, month)
  if (today < from) return []
  const end = today < to ? Number(today.slice(8, 10)) : lastDay
  const hol = new Set(holidayDates)
  const have = new Set(shifts.map(s => `${s.worker_id}|${s.date}|${s.shift}`))
  const days = []
  for (let d = 1; d <= end; d++) {
    const date = `${from.slice(0, 8)}${String(d).padStart(2, '0')}`
    if (weekdayOf(date) !== 0 && !hol.has(date)) days.push(date)
  }
  const out = []
  for (const w of workers) {
    if (w.show_in_assign === false) continue
    const dates = []
    for (const date of days) {
      const missing = ['morning', 'evening'].filter(s => !have.has(`${w.id}|${date}|${s}`))
      if (missing.length) dates.push({ date, missing })
    }
    if (dates.length) out.push({ worker_id: w.id, name: w.name, dates })
  }
  return out
}
```

Change the import at the top of attendance.js to `import { weekdayOf, monthRange } from './period.js'`.

```js
// src/lib/payroll/run.js
// Whole-month helpers around calculateWorkerPay. Pure.
import { calculateWorkerPay, advanceInstallmentDue } from './calc.js'
import { comparePeriod } from './period.js'
import { round2 } from './money.js'

export function advancesDueFor({ advances, priorLines, year, month }) {
  const out = {}
  for (const a of advances) {
    if (a.status !== 'approved') continue
    if (comparePeriod({ year: a.start_year, month: a.start_month }, { year, month }) > 0) continue
    const before = priorLines.filter(l => l.advance_id === a.id && comparePeriod(l, { year, month }) < 0)
    const due = advanceInstallmentDue({
      amount: Number(a.amount),
      installments: a.installments,
      deductedBefore: round2(before.reduce((s, l) => s + Number(l.amount), 0)),
      installmentsBefore: before.filter(l => Number(l.amount) > 0).length,
    })
    if (!due) continue
    ;(out[a.worker_id] ||= []).push({ advance_id: a.id, title: a.title, amount: due.amount, installment_no: due.installment_no, installments: a.installments, remaining_after: due.remaining_after })
  }
  return out
}

export function manualFromLines(lines = []) {
  const m = {}
  for (const l of lines) {
    if (!l.is_manual || !l.pay_item_id) continue
    m[l.advance_id ? `${l.pay_item_id}:${l.advance_id}` : l.pay_item_id] = Number(l.amount)
  }
  return m
}

const EMPTY_FACTS = { daysWorked: 0, leavePersonalDays: 0, leaveSickDays: 0, otHours: 0, holidayShifts: 0, officeDays: 0 }

export function buildPayrollRun({ items, workers, amountsByWorker = {}, attendanceByWorker = {}, manualByWorker = {}, advancesDueByWorker = {}, settings = {} }) {
  return workers.map(worker => {
    const facts = { ...EMPTY_FACTS, ...(attendanceByWorker[worker.id] || {}) }
    const res = calculateWorkerPay({
      items, worker, settings, attendance: facts,
      amounts: amountsByWorker[worker.id] || {},
      manual: manualByWorker[worker.id] || {},
      advancesDue: advancesDueByWorker[worker.id] || [],
    })
    return { worker_id: worker.id, worker, facts, ...res }
  })
}

const lineKey = l => `${l.pay_item_id || l.name}:${l.advance_id || ''}`

export function diffRuns(savedRecords, run) {
  const saved = new Map(savedRecords.map(r => [r.worker_id, r]))
  const out = []
  const compare = (worker_id, name, before = [], after = []) => {
    const b = new Map(before.map(l => [lineKey(l), l]))
    const a = new Map(after.map(l => [lineKey(l), l]))
    const changes = []
    for (const k of new Set([...b.keys(), ...a.keys()])) {
      const bv = Number(b.get(k)?.amount || 0), av = Number(a.get(k)?.amount || 0)
      if (bv !== av) changes.push({ name: (a.get(k) || b.get(k)).name, before: bv, after: av })
    }
    if (changes.length) out.push({ worker_id, name, changes })
  }
  for (const r of run) compare(r.worker_id, r.worker?.name, saved.get(r.worker_id)?.lines, r.lines)
  for (const s of savedRecords) if (!run.some(r => r.worker_id === s.worker_id)) compare(s.worker_id, s.worker_name, s.lines, [])
  return out
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `TZ=Asia/Bangkok npx vitest run src/lib/payroll`
Expected: PASS (all payroll tests).

- [ ] **Step 5: Write load.js (Supabase I/O, no money logic)**

```js
// src/lib/payroll/load.js
// Fetches one month's inputs, runs the pure engine, and wraps the payroll RPCs.
// All money math stays in calc.js/run.js.
import { supabase } from '../supabase.js'
import { monthRange } from './period.js'
import { summarizeAttendance, findAssignGaps } from './attendance.js'
import { advancesDueFor, manualFromLines, buildPayrollRun, diffRuns } from './run.js'

const must = ({ data, error }) => { if (error) throw error; return data }

export async function loadPayrollMonth(year, month) {
  const { from, to } = monthRange(year, month)
  const [items, workers, amounts, period, records, shifts, otRows, holidays, advances, settingsRows] = await Promise.all([
    supabase.from('pay_items').select('*').order('sort_order').then(must),
    supabase.from('workers_with_rate').select('*').eq('status', 'active').order('name').then(must),
    supabase.from('worker_pay_item_amounts').select('worker_id, pay_item_id, amount').then(must),
    supabase.from('payroll_periods').select('*').eq('year', year).eq('month', month).maybeSingle().then(must),
    supabase.from('salary_records')
      .select('id, worker_id, net_pay, paid_date, facts, workers(name, nickname, position, employee_code, bank_code, bank_account_no, bank_account_name), salary_record_lines(*)')
      .eq('year', year).eq('month', month).then(must),
    supabase.from('worker_assignments').select('worker_id, type, shift, ot_hours, date, confirmed_at').gte('date', from).lte('date', to).then(must),
    supabase.from('worker_ot').select('worker_id, ot_hours').gte('date', from).lte('date', to).then(must),
    supabase.from('company_holidays').select('date').gte('date', from).lte('date', to).then(must),
    supabase.from('salary_advances').select('*').in('status', ['approved', 'settled']).then(must),
    supabase.from('app_settings').select('key, value').in('key', ['holiday_pay_multiplier', 'require_checkin_confirmation']).then(must),
  ])
  const setting = k => settingsRows.find(r => r.key === k)?.value
  const priorLines = await loadAdvanceLines(advances.map(a => a.id))
  const amountsByWorker = {}
  for (const a of amounts) (amountsByWorker[a.worker_id] ||= {})[a.pay_item_id] = Number(a.amount)
  const manualByWorker = {}
  for (const r of records) manualByWorker[r.worker_id] = manualFromLines(r.salary_record_lines)
  const inputs = {
    items, workers, amountsByWorker, manualByWorker,
    attendanceByWorker: summarizeAttendance({ shifts, otRows, holidayDates: holidays.map(h => h.date), requireConfirm: setting('require_checkin_confirmation') === 'true' }),
    advancesDueByWorker: advancesDueFor({ advances, priorLines, year, month }),
    settings: { holidayMultiplier: parseFloat(setting('holiday_pay_multiplier')) || 1.5 },
  }
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const assignGaps = findAssignGaps({ workers, shifts, holidayDates: holidays.map(h => h.date), year, month, today })
  return { period, items, workers, records, advances, inputs, assignGaps }
}

async function loadAdvanceLines(advanceIds) {
  if (!advanceIds.length) return []
  const rows = await supabase.from('salary_record_lines')
    .select('advance_id, amount, salary_records!inner(year, month)')
    .in('advance_id', advanceIds).then(must)
  return rows.map(r => ({ advance_id: r.advance_id, amount: Number(r.amount), year: r.salary_records.year, month: r.salary_records.month }))
}

export async function calculateMonth(year, month) {
  const m = await loadPayrollMonth(year, month)
  const run = buildPayrollRun(m.inputs)
  const saved = m.records.map(r => ({ worker_id: r.worker_id, worker_name: r.workers?.name, lines: r.salary_record_lines }))
  return { ...m, run, diff: diffRuns(saved, run) }
}

export async function saveDraft(year, month, run) {
  const p_records = run.map(r => ({ worker_id: r.worker_id, facts: r.facts, lines: r.lines }))
  return must(await supabase.rpc('save_payroll_draft', { p_year: year, p_month: month, p_records }))
}

const rpc = (fn, args) => supabase.rpc(fn, args).then(must)
export const setManualLine  = (recordId, payItemId, advanceId, amount) => rpc('set_payroll_manual_line', { p_record_id: recordId, p_pay_item_id: payItemId, p_advance_id: advanceId, p_amount: amount })
export const confirmMonth   = (y, m) => rpc('confirm_payroll_period', { p_year: y, p_month: m })
export const unconfirmMonth = (y, m) => rpc('unconfirm_payroll_period', { p_year: y, p_month: m })
export const closeMonth     = (y, m, paidDate) => rpc('close_payroll_period', { p_year: y, p_month: m, p_paid_date: paidDate })
export const reopenMonth    = (y, m, reason) => rpc('reopen_payroll_period', { p_year: y, p_month: m, p_reason: reason })
export const approveAdvance = id => rpc('approve_salary_advance', { p_id: id })
export const rejectAdvance  = (id, reason) => rpc('reject_salary_advance', { p_id: id, p_reason: reason })
export async function requestAdvance(row) {
  return must(await supabase.from('salary_advances').insert(row).select().single())
}
```

- [ ] **Step 6: Write usePayroll.js**

```js
// src/hooks/usePayroll.js
import { useQuery } from './useSupabase.js'
import { supabase } from '../lib/supabase.js'
import { loadPayrollMonth } from '../lib/payroll/load.js'

const must = ({ data, error }) => { if (error) throw error; return data }

export function usePayItems() {
  return useQuery(() => supabase.from('pay_items').select('*').order('sort_order').then(must), [])
}

export function usePayrollMonth(year, month) {
  return useQuery(() => loadPayrollMonth(year, month), [year, month])
}

export function useAdvances(workerId = null) {
  return useQuery(async () => {
    let q = supabase.from('salary_advances').select('*, workers(name, nickname)').order('requested_at', { ascending: false })
    if (workerId) q = q.eq('worker_id', workerId)
    const rows = must(await q)
    const ids = rows.map(r => r.id)
    if (!ids.length) return rows
    const lines = must(await supabase.from('salary_record_lines')
      .select('advance_id, amount, salary_records!inner(period_id, payroll_periods!inner(status))')
      .in('advance_id', ids))
    return rows.map(r => {
      const mine = lines.filter(l => l.advance_id === r.id)
      const closed = mine.filter(l => l.salary_records.payroll_periods.status === 'closed')
      const deducted = closed.reduce((s, l) => s + Number(l.amount), 0)
      return { ...r, deducted, remaining: Number(r.amount) - deducted, paidInstallments: closed.filter(l => Number(l.amount) > 0).length }
    })
  }, [workerId])
}

export function useBankSettings() {
  return useQuery(() => supabase.from('payroll_bank_settings').select('*').maybeSingle().then(must), [])
}

export function useWorkerPayAmounts(workerId) {
  return useQuery(async () => {
    if (!workerId) return {}
    const rows = must(await supabase.from('worker_pay_item_amounts').select('pay_item_id, amount').eq('worker_id', workerId))
    return Object.fromEntries(rows.map(r => [r.pay_item_id, Number(r.amount)]))
  }, [workerId])
}
```

Check that `useQuery` is exported from `src/hooks/useSupabase.js`. It is defined at line 18. If it is not exported, add `export` to it in this task.

The embed `salary_records!inner(period_id, payroll_periods!inner(status))` assumes exactly one FK between `salary_records` and `payroll_periods`. That holds after Task 2, but if PostgREST reports an ambiguous embed, name the constraint (`payroll_periods!salary_records_period_id_fkey`). See the PostgREST ambiguous-FK lesson.

- [ ] **Step 7: Run the full suite and commit**

Run: `npx vitest run && npx vite build`
Expected: all tests pass, build succeeds.

```bash
git add src/lib/payroll src/hooks/usePayroll.js src/hooks/useSupabase.js
git commit -m "feat(payroll): attendance summary, run builder, advances due, data layer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Bank helpers + worker form fields (code, bank, pay type, fixed amounts)

**Files:**
- Create: `src/lib/bankExport/banks.js`, `src/pages/hr/WorkerPayFields.jsx`
- Test: `src/lib/bankExport/banks.test.js`
- Modify: `src/pages/HR.jsx`: `EMPTY_WORKER` (line ~32), `WorkerForm` (line ~38) and `handleSaveWorker` (line ~550).

**Interfaces:**
- Consumes: `usePayItems()`, `useWorkerPayAmounts(workerId)` (Task 6).
- Produces:
  - `BANKS: [{code, name, lengths:number[], branch:string[]}]` (one branch rule per length: `'F3'|'F4'|'999F'|'M3,3'|<4-digit literal>`)
  - `bankByCode(code)`
  - `scbCheckDigitOk(acct) → boolean`
  - `suggestBranch(code, acct) → '####' | null`
  - `validateAccount(code, acct) → null | Thai error string`
  - `WorkerPayFields({form, set, payItems, amounts, setAmount})`, a JSX section

- [ ] **Step 1: Write the failing test**

```js
// src/lib/bankExport/banks.test.js
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
```

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run src/lib/bankExport/banks.test.js`. Expected: FAIL (missing module).

- [ ] **Step 3: Implement banks.js**

The table comes from `docs/reference/bank-payroll-file-formats.md`: §1.6 gives the account lengths and branch rules, and §2.7 gives the codes that SCB SPN/SPS accept.

```js
// src/lib/bankExport/banks.js
// Receiving banks for SCB SPN/SPS payroll (reference doc §2.7) with account
// lengths and branch-derivation rules (§1.6, read from the KBank template).
// F3 = first 3 digits; zero-padded to 4 here because SCB wants exactly 4.
export const BANKS = [
  { code: '002', name: 'กรุงเทพ', lengths: [10], branch: ['F3'] },
  { code: '004', name: 'กสิกรไทย', lengths: [10], branch: ['F3'] },
  { code: '006', name: 'กรุงไทย', lengths: [10], branch: ['F3'] },
  { code: '011', name: 'ทหารไทยธนชาต (ttb)', lengths: [10], branch: ['F3'] },
  { code: '014', name: 'ไทยพาณิชย์', lengths: [10], branch: ['F3'] },
  { code: '017', name: 'ซิตี้แบงก์', lengths: [10], branch: ['0001'] },
  { code: '020', name: 'สแตนดาร์ดชาร์เตอร์ด', lengths: [10, 11], branch: ['F3', 'F3'] },
  { code: '022', name: 'ซีไอเอ็มบี ไทย', lengths: [10], branch: ['F3'] },
  { code: '024', name: 'ยูโอบี', lengths: [10], branch: ['F3'] },
  { code: '025', name: 'กรุงศรีอยุธยา', lengths: [10], branch: ['F3'] },
  { code: '030', name: 'ออมสิน', lengths: [12, 15], branch: ['999F', 'F4'] },
  { code: '031', name: 'HSBC', lengths: [11, 12], branch: ['0001', '0001'] },
  { code: '033', name: 'อาคารสงเคราะห์', lengths: [12], branch: ['F3'] },
  { code: '034', name: 'ธ.ก.ส.', lengths: [10, 12], branch: ['0000', '0000'] },
  { code: '066', name: 'อิสลามแห่งประเทศไทย', lengths: [10, 12], branch: ['F3', 'M3,3'] },
  { code: '067', name: 'ทิสโก้', lengths: [14], branch: ['F4'] },
  { code: '069', name: 'เกียรตินาคินภัทร', lengths: [10, 14], branch: ['F4', 'F4'] },
  { code: '070', name: 'ไอซีบีซี (ไทย)', lengths: [10, 14, 16], branch: ['F3', 'F3', 'F3'] },
  { code: '071', name: 'ไทยเครดิต', lengths: [10], branch: ['F3'] },
  { code: '073', name: 'แลนด์ แอนด์ เฮ้าส์', lengths: [10], branch: ['F4'] },
]

export const bankByCode = code => BANKS.find(b => b.code === code) || null

export function scbCheckDigitOk(acct) {
  const s = String(acct || '').replace(/-/g, '').trim()
  if (!/^\d{10}$/.test(s)) return false
  const w = [4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = w.reduce((t, wi, i) => t + ((Number(s[i]) * wi) % 10), 0)
  return (10 - (sum % 10)) % 10 === Number(s[9])
}

export function suggestBranch(code, acct) {
  const b = bankByCode(code)
  const s = String(acct || '')
  if (!b || !/^\d+$/.test(s)) return null
  const i = b.lengths.indexOf(s.length)
  if (i < 0) return null
  const rule = b.branch[i]
  if (rule === 'F3') return '0' + s.slice(0, 3)
  if (rule === 'F4') return s.slice(0, 4)
  if (rule === '999F') return '999' + s[0]
  if (rule === 'M3,3') return '0' + s.slice(2, 5)
  return rule
}

export function validateAccount(code, acct) {
  const s = String(acct || '')
  if (!/^\d+$/.test(s)) return 'กรอกเลขบัญชีเป็นตัวเลข'
  const b = bankByCode(code)
  if (b && !b.lengths.includes(s.length)) return `เลขบัญชี${b.name}ต้องมี ${b.lengths.join(' หรือ ')} หลัก`
  if (code === '014' && !scbCheckDigitOk(s)) return 'เลขบัญชีไทยพาณิชย์ไม่ถูกต้อง (เลขตรวจสอบไม่ตรง)'
  return null
}
```

- [ ] **Step 4: Run it and check that it passes**

Run: `npx vitest run src/lib/bankExport/banks.test.js`. Expected: PASS.

- [ ] **Step 5: Create WorkerPayFields.jsx**

```jsx
// src/pages/hr/WorkerPayFields.jsx
// Worker form section: employee code, pay type, daily wage, bank details,
// and amounts for every fixed_per_worker pay item.
import { BANKS, suggestBranch, validateAccount } from '../../lib/bankExport/banks.js'

export default function WorkerPayFields({ form, set, payItems = [], amounts = {}, setAmount }) {
  const fixed = payItems.filter(i => i.active && i.method === 'fixed_per_worker')
  const acctError = form.bank_code && form.bank_account_no ? validateAccount(form.bank_code, form.bank_account_no) : null
  const onAccount = v => {
    const digits = v.replace(/\D/g, '').slice(0, 25)
    set('bank_account_no', digits)
    const b = suggestBranch(form.bank_code, digits)
    if (b && !form.bank_branch_touched) set('bank_branch_code', b)
  }
  return (
    <div style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontWeight: 700 }}>💼 เงินเดือนและบัญชีรับเงิน</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label className="label">รหัสพนักงาน</label>
          <input className="input" value={form.employee_code || ''} onChange={e => set('employee_code', e.target.value.trim())} placeholder="เช่น EMP-001" />
        </div>
        <div>
          <label className="label">ประเภทการจ่าย</label>
          <select className="input" value={form.pay_type || 'monthly'} onChange={e => set('pay_type', e.target.value)}>
            <option value="monthly">รายเดือน</option>
            <option value="daily">รายวัน</option>
          </select>
        </div>
        {form.pay_type === 'daily' && (
          <div>
            <label className="label">ค่าแรงต่อวัน (บาท)</label>
            <input className="input" type="number" min="0" value={form.daily_wage ?? ''} onChange={e => set('daily_wage', e.target.value)} />
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label className="label">ธนาคาร</label>
          <select className="input" value={form.bank_code || ''} onChange={e => set('bank_code', e.target.value || null)}>
            <option value="">— ไม่ระบุ —</option>
            {BANKS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">เลขบัญชี</label>
          <input className="input" inputMode="numeric" value={form.bank_account_no || ''} onChange={e => onAccount(e.target.value)} />
          {acctError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{acctError}</div>}
        </div>
        <div>
          <label className="label">ชื่อบัญชี</label>
          <input className="input" value={form.bank_account_name || ''} onChange={e => set('bank_account_name', e.target.value)} placeholder="ว่างไว้ = ใช้ชื่อพนักงาน" />
        </div>
        <div>
          <label className="label">รหัสสาขา (4 หลัก)</label>
          <input className="input" inputMode="numeric" value={form.bank_branch_code || ''}
            onChange={e => { set('bank_branch_touched', true); set('bank_branch_code', e.target.value.replace(/\D/g, '').slice(0, 4)) }} />
        </div>
      </div>
      {fixed.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {fixed.map(i => (
            <div key={i.id}>
              <label className="label">{i.name} ({i.side === 'earning' ? 'เงินได้' : 'เงินหัก'}) / เดือน</label>
              <input className="input" type="number" min="0" value={amounts[i.id] ?? ''} onChange={e => setAmount(i.id, e.target.value)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Wire it into HR.jsx**

1. Add these to `EMPTY_WORKER`: `employee_code: '', pay_type: 'monthly', daily_wage: '', bank_code: '', bank_account_no: '', bank_account_name: '', bank_branch_code: ''`.
2. In `WorkerForm`:
   - Load the items and amounts, and keep amounts in local state:
     ```jsx
     const { data: payItems } = usePayItems()
     const { data: savedAmounts } = useWorkerPayAmounts(initial?.id)
     const [amounts, setAmounts] = useState({})
     useEffect(() => { if (savedAmounts) setAmounts(savedAmounts) }, [savedAmounts])
     ```
   - Render `<WorkerPayFields form={form} set={set} payItems={payItems || []} amounts={amounts} setAmount={(id, v) => setAmounts(a => ({ ...a, [id]: v }))} />` just above the `<div className="modal-footer">`.
   - Find the form's submit handler (`grep -n "onSave(" src/pages/HR.jsx`) and change the call to `onSave(form, idCardFile, amounts)`.
   - Before that call, add: `const acctErr = form.bank_code && form.bank_account_no ? validateAccount(form.bank_code, form.bank_account_no) : null; if (acctErr) { alert(acctErr); return }`.
   - Change the `dailyRate` hint: when `form.pay_type === 'daily'` show `form.daily_wage || '—'`, otherwise keep `/ 30`.
3. In `handleSaveWorker(form, idCardFile, amounts = {})`:
   - Add to `payload`:
     ```js
     employee_code: form.employee_code || null,
     pay_type: form.pay_type || 'monthly',
     daily_wage: form.pay_type === 'daily' ? (parseFloat(form.daily_wage) || 0) : null,
     bank_code: form.bank_code || null,
     bank_account_no: form.bank_account_no || null,
     bank_account_name: form.bank_account_name || null,
     bank_branch_code: form.bank_branch_code || null,
     ```
   - After the worker update or insert succeeds, set `const workerId = editWorker ? editWorker.id : data.id`. You need to hoist `data` out of the else-branch, for example `let savedId`. Then:
     ```js
     const rows = Object.entries(amounts).map(([pay_item_id, v]) => ({ worker_id: savedId, pay_item_id, amount: parseFloat(v) || 0 }))
     if (rows.length) {
       const { error: amtErr } = await supabase.from('worker_pay_item_amounts').upsert(rows, { onConflict: 'worker_id,pay_item_id' })
       if (amtErr) throw amtErr
     }
     ```
     `'worker_id,pay_item_id'` is the table's real primary key.
   - In the `catch`, before the existing alert: `if (e.message?.includes('workers_employee_code')) { alert('รหัสพนักงานนี้มีคนใช้แล้ว'); return }`.
4. Imports: `usePayItems, useWorkerPayAmounts` from `'../hooks/usePayroll.js'`, `WorkerPayFields` from `'./hr/WorkerPayFields.jsx'`, and `validateAccount` from `'../lib/bankExport/banks.js'`.
5. `bank_branch_touched` is UI-only. It never reaches `payload`, because the payload is built field by field.

- [ ] **Step 7: Build and test**

Run: `npx vitest run && npx vite build`. Expected: all pass and the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bankExport src/pages/hr/WorkerPayFields.jsx src/pages/HR.jsx
git commit -m "feat(payroll): worker employee code, pay type, bank details, fixed pay amounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Settings → โครงสร้างเงินเดือน (pay item editor)

**Files:**
- Create: `src/pages/hr/PayItemsEditor.jsx`
- Modify: `src/pages/Settings.jsx`: the `sections` array (~line 534) and the section render block, following the `{activeSection === 'travel' && isOwner && (...)}` pattern.

**Interfaces:**
- Consumes: `usePayItems()` (Task 6), `validatePayItems` and `SYSTEM_METHODS` (Task 1), table `pay_items` (RLS: admin write; DB trigger blocks deleting or changing the method of system items).
- Produces: `PayItemsEditor()`, a self-contained card with no props.

- [ ] **Step 1: Create PayItemsEditor.jsx**

```jsx
// src/pages/hr/PayItemsEditor.jsx
// Tenant pay structure: add / rename / hide / reorder items and pick how each
// is calculated. System items (base pay, OT, SSO, unpaid leave, advances) can be
// renamed, hidden and reordered but not deleted or re-methoded (DB trigger).
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { usePayItems } from '../../hooks/usePayroll.js'
import { validatePayItems, SYSTEM_METHODS } from '../../lib/payroll/calc.js'

const METHOD_LABEL = {
  base_pay: 'ระบบคิด: เงินเดือน/ค่าแรง', ot: 'ระบบคิด: OT', sso: 'ระบบคิด: ประกันสังคม',
  unpaid_leave: 'ระบบคิด: ลาไม่รับค่าจ้าง', advances: 'จากระบบเบิกล่วงหน้า',
  fixed_per_worker: 'ค่าคงที่รายคน', manual_monthly: 'กรอกทุกเดือน', percent_of_item: '% ของรายการอื่น',
}
const USER_METHODS = ['fixed_per_worker', 'manual_monthly', 'percent_of_item']

export default function PayItemsEditor() {
  const { data: items, refetch, loading } = usePayItems()
  const [busy, setBusy] = useState(false)
  if (loading || !items) return <div className="card">⏳ กำลังโหลด...</div>

  const save = async (id, patch) => {
    const next = items.map(i => i.id === id ? { ...i, ...patch } : i)
    if (validatePayItems(next.filter(i => i.active)).length) {
      alert('ตั้งค่าไม่ได้: รายการ % อ้างถึงรายการที่ไม่มี หรืออ้างกันเป็นวง')
      return
    }
    setBusy(true)
    const { error } = await supabase.from('pay_items').update(patch).eq('id', id)
    setBusy(false)
    if (error) alert('บันทึกไม่สำเร็จ: ' + error.message); else refetch()
  }
  const move = async (item, dir) => {
    const same = items.filter(i => i.side === item.side)
    const other = same[same.findIndex(i => i.id === item.id) + dir]
    if (!other) return
    setBusy(true)
    const a = await supabase.from('pay_items').update({ sort_order: other.sort_order }).eq('id', item.id)
    const b = await supabase.from('pay_items').update({ sort_order: item.sort_order }).eq('id', other.id)
    setBusy(false)
    if (a.error || b.error) alert('สลับลำดับไม่สำเร็จ: ' + (a.error || b.error).message); else refetch()
  }
  const add = async side => {
    const max = Math.max(0, ...items.filter(i => i.side === side).map(i => i.sort_order))
    const { error } = await supabase.from('pay_items').insert({
      name: side === 'earning' ? 'รายการเงินได้ใหม่' : 'รายการเงินหักใหม่', side, method: 'manual_monthly', sort_order: max + 1,
    })
    if (error) alert('เพิ่มไม่สำเร็จ: ' + error.message); else refetch()
  }
  const remove = async item => {
    const { error } = await supabase.from('pay_items').delete().eq('id', item.id)
    if (error) alert('ลบไม่สำเร็จ: ' + error.message); else refetch()
  }
  const refOptions = item => items.filter(i => i.id !== item.id && !['sso', 'advances'].includes(i.method))

  const row = item => {
    const isSystem = SYSTEM_METHODS.includes(item.method)
    return (
      <tr key={item.id} style={{ opacity: item.active ? 1 : 0.5 }}>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => move(item, -1)} aria-label="เลื่อนขึ้น">▲</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => move(item, 1)} aria-label="เลื่อนลง">▼</button>
        </td>
        <td>
          <input className="input input-sm" defaultValue={item.name}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== item.name) save(item.id, { name: v }) }} />
        </td>
        <td>
          {isSystem ? <span className="badge">{METHOD_LABEL[item.method]}</span> : (
            <select className="input input-sm" value={item.method}
              onChange={e => save(item.id, {
                method: e.target.value,
                params: e.target.value === 'percent_of_item' ? { percent: 5, of_item_id: items.find(i => i.method === 'base_pay')?.id } : {},
              })}>
              {USER_METHODS.map(m => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </select>
          )}
        </td>
        <td>
          {item.method === 'percent_of_item' && (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input className="input input-sm" type="number" style={{ width: 70 }} defaultValue={item.params?.percent}
                onBlur={e => save(item.id, { params: { ...item.params, percent: parseFloat(e.target.value) || 0 } })} />% ของ
              <select className="input input-sm" value={item.params?.of_item_id || ''} onChange={e => save(item.id, { params: { ...item.params, of_item_id: e.target.value } })}>
                {refOptions(item).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </span>
          )}
          {item.method === 'sso' && (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input className="input input-sm" type="number" style={{ width: 60 }} defaultValue={(item.params?.rate ?? 0.05) * 100}
                onBlur={e => save(item.id, { params: { ...item.params, rate: (parseFloat(e.target.value) || 0) / 100 } })} />% สูงสุด
              <input className="input input-sm" type="number" style={{ width: 80 }} defaultValue={item.params?.cap ?? 875}
                onBlur={e => save(item.id, { params: { ...item.params, cap: parseFloat(e.target.value) || 0 } })} /> บาท
            </span>
          )}
          {item.method === 'ot' && (
            <span>× <input className="input input-sm" type="number" step="0.5" style={{ width: 60 }} defaultValue={item.params?.multiplier ?? 1.5}
              onBlur={e => save(item.id, { params: { ...item.params, multiplier: parseFloat(e.target.value) || 1.5 } })} /> เท่า · ปัดขึ้นเป็นบาท</span>
          )}
        </td>
        <td>
          <select className="input input-sm" value={item.applies_to} onChange={e => save(item.id, { applies_to: e.target.value })}>
            <option value="all">ทุกคน</option><option value="monthly">รายเดือน</option><option value="daily">รายวัน</option>
          </select>
        </td>
        <td style={{ textAlign: 'center' }}>
          {item.side === 'earning' && <input type="checkbox" checked={item.sso_base} onChange={e => save(item.id, { sso_base: e.target.checked })} aria-label={`นับฐานประกันสังคม ${item.name}`} />}
        </td>
        <td style={{ textAlign: 'center' }}>
          <input type="checkbox" checked={item.active} onChange={e => save(item.id, { active: e.target.checked })} aria-label={`ใช้งาน ${item.name}`} />
        </td>
        <td>{!isSystem && <button className="btn btn-ghost btn-sm" onClick={() => remove(item)}>ลบ</button>}</td>
      </tr>
    )
  }

  const group = side => (
    <>
      <tr><td colSpan={8} style={{ fontWeight: 700, background: 'var(--bg)' }}>{side === 'earning' ? 'เงินได้' : 'เงินหัก'}</td></tr>
      {items.filter(i => i.side === side).map(row)}
    </>
  )

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="card-title">💼 โครงสร้างเงินเดือน</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => add('earning')}>+ รายการเงินได้</button>
          <button className="btn btn-ghost btn-sm" onClick={() => add('deduction')}>+ รายการเงินหัก</button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>มีผลกับการคำนวณครั้งถัดไป สลิปเดือนที่ผ่านมาไม่เปลี่ยน</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 820 }}>
          <thead><tr><th></th><th>ชื่อรายการ</th><th>วิธีคิด</th><th>ค่า</th><th>ใช้กับ</th><th>นับฐานประกันสังคม</th><th>ใช้งาน</th><th></th></tr></thead>
          <tbody>{group('earning')}{group('deduction')}</tbody>
        </table>
      </div>
    </div>
  )
}
```

Check the CSS names before relying on them: `grep -n "\.badge\b\|--text-muted\|--danger\|\.table\b\|input-sm\|btn-sm" src/index.css`. Use whatever the existing HR and Settings pages use.

- [ ] **Step 2: Add the section to Settings.jsx**

- In `sections`, after `bank_accounts`, add `{ id: 'payroll_items', label: '💼 โครงสร้างเงินเดือน', show: isAdminPlus && hasModuleAccess('payroll') },`.
- Render it with the other sections: `{activeSection === 'payroll_items' && isAdminPlus && hasModuleAccess('payroll') && <PayItemsEditor />}`.
- Import it: `import PayItemsEditor from './hr/PayItemsEditor.jsx'`.

- [ ] **Step 3: Build and test**

Run: `npx vitest run && npx vite build`. Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/pages/hr/PayItemsEditor.jsx src/pages/Settings.jsx
git commit -m "feat(payroll): settings card for the tenant's pay item structure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HR → เงินเดือน: month grid, calculate with diff preview, states; remove old payroll code

**Files:**
- Create: `src/pages/hr/PayrollMonth.jsx`
- Modify: `src/pages/HR.jsx`:
  - Remove `calcNet`, `EMPTY_SALARY`, `SalaryForm` and `SalarySlipModal` (lines ~181–363).
  - Remove `handleCalcFromAssign` and `handleConfirmCalc` (~722–830), plus the calc-preview state, the salary-form modal, the totals memos (~903–907) and the old payroll tab body.
  - Render `<PayrollMonth canEdit={canEdit} settingsSlot={...} />` for `innerTab === 'payroll'`.
- Delete: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes:
  - Task 6: `usePayrollMonth`, `calculateMonth`, `saveDraft`, `setManualLine`, `confirmMonth`, `unconfirmMonth`, `closeMonth`, `reopenMonth`.
  - Task 1: `periodLabel`, `MONTHS_TH`, `monthRange`.
  - `useUserRole().isAtLeast`, `fmt`, `Modal`.
- Produces: `PayrollMonth({ canEdit, settingsSlot })`. It holds two marker comments, `{/* slip button: Task 11 */}` and `{/* bank export: Task 12 */}`, which later tasks replace.

`settingsSlot` keeps the existing holiday-multiplier and require-check-in-confirmation controls. They currently sit in the payroll tab of HR.jsx (`multiplierVal`, `requireConfirmVal` and their handlers, ~lines 524–640). Move that JSX block as-is into a `const payrollSettings = (...)` in HR, so the handlers stay in HR, and pass it as `settingsSlot`.

- [ ] **Step 1: Create PayrollMonth.jsx**

```jsx
// src/pages/hr/PayrollMonth.jsx
// One month of payroll as a grid like the owner's sheet: one row per worker,
// one column per pay item. Draft → ยืนยัน → ปิดงวด. All money comes from the
// engine (lib/payroll); this file only displays and calls RPCs.
import { useMemo, useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { usePayrollMonth } from '../../hooks/usePayroll.js'
import { calculateMonth, saveDraft, setManualLine, confirmMonth, unconfirmMonth, closeMonth, reopenMonth } from '../../lib/payroll/load.js'
import { periodLabel, MONTHS_TH, monthRange } from '../../lib/payroll/period.js'
import { fmt } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'

const STATUS = {
  draft: { label: 'ร่าง', color: '#9a5b00' },
  confirmed: { label: 'ยืนยันแล้ว', color: '#1f5fa8' },
  closed: { label: 'ปิดงวดแล้ว', color: '#1f6b55' },
}
const WARN = { negative_net: 'ยอดสุทธิติดลบ', missing_daily_wage: 'ยังไม่ได้ตั้งค่าแรงรายวัน' }

export default function PayrollMonth({ canEdit, settingsSlot }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const { data, loading, error, refetch } = usePayrollMonth(year, month)
  const { isAtLeast } = useUserRole()
  const isOwner = isAtLeast('OWNER')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [paidDate, setPaidDate] = useState(monthRange(now.getFullYear(), now.getMonth() + 1).to)

  const status = data?.period?.status || 'draft'
  const items = useMemo(() => (data?.items || []).filter(i => i.active), [data])
  const records = data?.records || []
  const cell = (rec, item) => rec.salary_record_lines.filter(l => l.pay_item_id === item.id).reduce((s, l) => s + Number(l.amount), 0)
  const total = item => records.reduce((s, r) => s + cell(r, item), 0)
  const totalNet = records.reduce((s, r) => s + Number(r.net_pay || 0), 0)

  const run = async fn => {
    setBusy(true)
    try { await fn(); await refetch() }
    catch (e) { alert(e.message) }
    finally { setBusy(false) }
  }
  const onCalculate = () => run(async () => setPreview(await calculateMonth(year, month)))
  const onSavePreview = () => run(async () => { await saveDraft(year, month, preview.run); setPreview(null) })
  const onManual = (rec, item, value) => run(() => setManualLine(rec.id, item.id, null, value === '' ? null : (parseFloat(value) || 0)))
  const onReopen = () => { const r = prompt('เหตุผลที่เปิดงวดใหม่'); if (r) run(() => reopenMonth(year, month, r)) }
  const gaps = data?.assignGaps || []
  const onConfirm = () => {
    if (gaps.length && !confirm(`Assign ยังไม่ครบ ${gaps.length} คน (${gaps.map(g => g.name).join(', ')}) ยืนยันเงินเดือนต่อไหม`)) return
    run(() => confirmMonth(year, month))
  }
  const warnings = (preview?.run || []).filter(r => r.warnings.length)

  if (loading) return <div>⏳ กำลังโหลด...</div>
  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>โหลดเงินเดือนไม่สำเร็จ: {error}</div>

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {settingsSlot}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="input input-sm" value={month} onChange={e => { setMonth(+e.target.value); setPaidDate(monthRange(year, +e.target.value).to) }}>
          {MONTHS_TH.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input className="input input-sm" type="number" style={{ width: 90 }} value={year} onChange={e => setYear(+e.target.value)} />
        <span>{periodLabel(year, month)}</span>
        <span style={{ fontWeight: 700, color: STATUS[status].color }}>● {STATUS[status].label}</span>
        {status === 'draft' && data?.period?.reopen_reason && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>เปิดงวดใหม่: {data.period.reopen_reason}</span>}
        {canEdit && status === 'draft' && gaps.length > 0 && <span style={{ fontSize: 12, color: 'var(--danger)' }}>⚠️ Assign ยังไม่ครบ {gaps.length} คน</span>}
        <span style={{ flex: 1 }} />
        {canEdit && status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={onCalculate}>🧮 คำนวณ</button>}
        {canEdit && status === 'draft' && records.length > 0 && <button className="btn" disabled={busy} onClick={onConfirm}>✅ ยืนยันเงินเดือน</button>}
        {canEdit && status === 'confirmed' && <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => unconfirmMonth(year, month))}>↩️ กลับไปแก้ไข</button>}
        {canEdit && status === 'confirmed' && <button className="btn btn-primary" disabled={busy} onClick={() => setCloseOpen(true)}>🔒 ปิดงวด</button>}
        {isOwner && status === 'closed' && <button className="btn btn-ghost" disabled={busy} onClick={onReopen}>🔓 เปิดงวดใหม่</button>}
        {/* bank export: Task 12 */}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 300 + items.length * 110 }}>
          <thead>
            <tr>
              <th>ชื่อ</th>
              {items.map(i => <th key={i.id} style={{ textAlign: 'right' }}>{i.name}</th>)}
              <th style={{ textAlign: 'right' }}>จ่ายสุทธิ</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.map(r => (
              <tr key={r.id}>
                <td>{r.workers?.name}{r.workers?.nickname ? ` (${r.workers.nickname})` : ''}</td>
                {items.map(i => (
                  <td key={i.id} style={{ textAlign: 'right' }}>
                    {i.method === 'manual_monthly' && canEdit && status === 'draft'
                      ? <input className="input input-sm" style={{ width: 90, textAlign: 'right' }} defaultValue={cell(r, i) || ''}
                          onBlur={e => { if (String(cell(r, i) || '') !== e.target.value) onManual(r, i, e.target.value) }} />
                      : (cell(r, i) ? fmt(cell(r, i)) : '–')}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                <td>{/* slip button: Task 11 */}</td>
              </tr>
            ))}
            {!records.length && (
              <tr><td colSpan={items.length + 3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                {canEdit ? 'ยังไม่ได้คำนวณเดือนนี้ กด “คำนวณ”' : 'ยังไม่มีสลิปของเดือนนี้'}
              </td></tr>
            )}
          </tbody>
          {records.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>ยอดรวม</td>
                {items.map(i => <td key={i.id} style={{ textAlign: 'right' }}>{fmt(total(i))}</td>)}
                <td style={{ textAlign: 'right' }}>{fmt(totalNet)}</td><td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {preview && (
        <Modal title={`ตรวจก่อนบันทึก — ${periodLabel(year, month)}`} onClose={() => setPreview(null)} maxWidth={720}>
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            {preview.assignGaps.length > 0 && (
              <details open style={{ border: '1px solid var(--danger)', borderRadius: 6, padding: 8 }}>
                <summary style={{ color: 'var(--danger)', fontWeight: 700 }}>⚠️ Assign ยังไม่ครบ {preview.assignGaps.length} คน (เงินเดือนอาจไม่ถูก) ไปเติมที่หน้า Assign ก่อนได้</summary>
                {preview.assignGaps.map(g => (
                  <div key={g.worker_id} style={{ fontSize: 13 }}>
                    <b>{g.name}</b> {g.dates.length} วัน: {g.dates.slice(0, 8).map(d => `${+d.date.slice(8)}${d.missing.length === 1 ? (d.missing[0] === 'morning' ? '(เช้า)' : '(บ่าย)') : ''}`).join(', ')}{g.dates.length > 8 ? ' …' : ''}
                  </div>
                ))}
              </details>
            )}
            {warnings.map(r => <div key={r.worker_id} style={{ color: 'var(--danger)' }}>⚠️ {r.worker.name}: {r.warnings.map(w => WARN[w] || w).join(', ')}</div>)}
            {preview.diff.length === 0 ? <div>ไม่มีตัวเลขเปลี่ยน</div> : preview.diff.map(d => (
              <div key={d.worker_id}>
                <b>{d.name}</b>
                {d.changes.map(c => <div key={c.name} style={{ fontSize: 13 }}>{c.name}: {fmt(c.before)} → <b>{fmt(c.after)}</b></div>)}
              </div>
            ))}
            <div>รวมจ่ายสุทธิ {preview.run.length} คน: <b>{fmt(preview.run.reduce((s, r) => s + r.totals.net, 0))}</b> บาท</div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy} onClick={onSavePreview}>💾 บันทึก</button>
          </div>
        </Modal>
      )}

      {closeOpen && (
        <Modal title="ปิดงวด" onClose={() => setCloseOpen(false)} maxWidth={420}>
          <div className="modal-body">
            <p>ปิดงวดหลังโอนเงินเสร็จแล้ว หลังปิดจะแก้ไขไม่ได้ (เจ้าของเปิดใหม่ได้)</p>
            <label className="label">วันที่จ่าย</label>
            <input className="input" type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setCloseOpen(false)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy || !paidDate} onClick={() => run(async () => { await closeMonth(year, month, paidDate); setCloseOpen(false) })}>🔒 ปิดงวด</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Remove the old payroll code from HR.jsx and delete Payroll.jsx**

- Delete the blocks listed under **Files**, and drop the imports that become unused. Candidates: `mergeWorkerOT`, `fetchWorkerOTForRange`, `fetchCompanyHolidaysForRange`, `useSalary`, `usePreviousMonthSalaries`, `downloadPDF`, `SITE_TYPES`. Run `grep` on each before removing it.
- Remove the old worker email filter on salary records (HR.jsx ~816–821). RLS now returns only a worker's own `confirmed`/`closed` records.
- Run `git rm src/pages/Payroll.jsx`.
- Run `grep -rn "Payroll.jsx\|from './Payroll'\|calcNet\|SalarySlipModal\|handleCalcFromAssign" src`. Expected: no hits.
- Remove `useSalary` and `usePreviousMonthSalaries` from `useSupabase.js` only if `grep` shows no other users.

- [ ] **Step 3: Build and test**

Run: `npx vitest run && npx vite build`. Expected: pass, with no unresolved imports.

- [ ] **Step 4: Commit**

```bash
git add -A src/pages/hr/PayrollMonth.jsx src/pages/HR.jsx src/pages/Payroll.jsx src/hooks/useSupabase.js
git commit -m "feat(payroll): month grid with calculate preview, confirm/close/reopen; remove old payroll code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Advances tab (request, owner approve/reject, balances)

**Files:**
- Create: `src/pages/hr/AdvancesPanel.jsx`
- Modify: `src/pages/HR.jsx`. In `INNER_TABS` (~line 909), add `{ id: 'advances', label: '💸 เบิกล่วงหน้า' }` right after `payroll`, and render `{innerTab === 'advances' && <AdvancesPanel canEdit={canEdit} />}`.

**Interfaces:**
- Consumes: from Task 6, `useAdvances()`, `requestAdvance`, `approveAdvance` and `rejectAdvance`; from `useSupabase.js`, `useAllActiveWorkers`; `useUserRole()` (`{ role, user, loading, isAtLeast }`); `MONTHS_TH`; `fmt`.
- Produces: `AdvancesPanel({ canEdit })`.
  - Admins see everyone and can request on anyone's behalf.
  - Only the owner sees the approve/reject buttons.
  - A worker sees only their own requests (RLS) and requests for themself.

- [ ] **Step 1: Create AdvancesPanel.jsx**

```jsx
// src/pages/hr/AdvancesPanel.jsx
// เบิกล่วงหน้า: request → owner approves → deducted in installments by payroll.
// Balances count only closed months (what was actually paid).
import { useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useAdvances } from '../../hooks/usePayroll.js'
import { useAllActiveWorkers } from '../../hooks/useSupabase.js'
import { requestAdvance, approveAdvance, rejectAdvance } from '../../lib/payroll/load.js'
import { MONTHS_TH } from '../../lib/payroll/period.js'
import { fmt } from '../../lib/supabase.js'

const STATUS = {
  pending: ['รออนุมัติ', '#9a5b00'], approved: ['กำลังผ่อน', '#1f5fa8'],
  rejected: ['ไม่อนุมัติ', '#a33a2b'], settled: ['หักครบแล้ว', '#1f6b55'],
}

export default function AdvancesPanel({ canEdit }) {
  const { isAtLeast, user } = useUserRole()
  const isOwner = isAtLeast('OWNER')
  const { data: advances, refetch, loading } = useAdvances()
  const { data: workers } = useAllActiveWorkers()
  const now = new Date()
  const ownWorker = (workers || []).find(w => w.email && w.email === user?.email)
  const [form, setForm] = useState({ worker_id: '', title: 'เบิกล่วงหน้า', amount: '', installments: 1, start: `${now.getFullYear()}-${now.getMonth() + 1}` })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const amount = parseFloat(form.amount) || 0
  const per = Math.round(amount / form.installments * 100) / 100
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    return { v: `${d.getFullYear()}-${d.getMonth() + 1}`, l: `${MONTHS_TH[d.getMonth()]} ${d.getFullYear() + 543}` }
  })

  const submit = async e => {
    e.preventDefault()
    const worker_id = canEdit ? form.worker_id : ownWorker?.id
    if (!worker_id || amount <= 0) { alert('เลือกพนักงานและใส่จำนวนเงิน'); return }
    const [start_year, start_month] = form.start.split('-').map(Number)
    setBusy(true)
    try {
      await requestAdvance({ worker_id, title: form.title.trim() || 'เบิกล่วงหน้า', amount, installments: +form.installments, start_year, start_month, requested_by: user.email })
      setForm(f => ({ ...f, amount: '' }))
      refetch()
    } catch (err) { alert('ส่งคำขอไม่สำเร็จ: ' + err.message) }
    finally { setBusy(false) }
  }
  const act = async fn => {
    setBusy(true)
    try { await fn(); refetch() } catch (e) { alert(e.message) } finally { setBusy(false) }
  }
  const onReject = a => { const r = prompt('เหตุผลที่ไม่อนุมัติ'); if (r !== null) act(() => rejectAdvance(a.id, r)) }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <div className="card-title">ขอเบิกเงินล่วงหน้า</div>
        {canEdit && (
          <select className="input" value={form.worker_id} onChange={e => set('worker_id', e.target.value)}>
            <option value="">— เลือกพนักงาน —</option>
            {(workers || []).map(w => <option key={w.id} value={w.id}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</option>)}
          </select>
        )}
        {!canEdit && !ownWorker && <div style={{ color: 'var(--danger)' }}>บัญชีนี้ยังไม่ได้ผูกกับพนักงาน ติดต่อแอดมิน</div>}
        <input className="input" value={form.title} onChange={e => set('title', e.target.value)} placeholder="เบิกเรื่องอะไร" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input className="input" type="number" min="1" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="จำนวนเงิน" />
          <select className="input" value={form.installments} onChange={e => set('installments', +e.target.value)}>
            {[1, 2, 3, 4, 5, 6, 10, 12].map(n => <option key={n} value={n}>ผ่อน {n} เดือน</option>)}
          </select>
        </div>
        <select className="input" value={form.start} onChange={e => set('start', e.target.value)}>
          {months.map(m => <option key={m.v} value={m.v}>เริ่มหัก {m.l}</option>)}
        </select>
        {amount > 0 && <div style={{ fontSize: 13 }}>หักเดือนละ <b>{fmt(per)}</b> บาท × {form.installments} เดือน</div>}
        <button className="btn btn-primary" disabled={busy}>ส่งคำขอ</button>
      </form>

      <div className="card">
        <div className="card-title">รายการเบิก</div>
        {loading && <div>⏳</div>}
        {(advances || []).map(a => (
          <div key={a.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>{a.workers?.nickname || a.workers?.name} · {a.title} · {fmt(a.amount)} ({a.installments} งวด)</span>
              <span style={{ fontWeight: 700, color: STATUS[a.status][1] }}>{STATUS[a.status][0]}</span>
            </div>
            {['approved', 'settled'].includes(a.status) && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                หักแล้ว {a.paidInstallments}/{a.installments} งวด · {fmt(a.deducted)} · คงเหลือ {fmt(Math.max(0, a.remaining))}
              </div>
            )}
            {a.status === 'rejected' && a.reject_reason && <div style={{ fontSize: 13 }}>เหตุผล: {a.reject_reason}</div>}
            {a.status === 'pending' && isOwner && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => approveAdvance(a.id))}>อนุมัติ</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onReject(a)}>ไม่อนุมัติ</button>
              </div>
            )}
          </div>
        ))}
        {!loading && !(advances || []).length && <div style={{ color: 'var(--text-muted)' }}>ยังไม่มีรายการเบิก</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the tab, then build and test**

Add the tab in HR.jsx as described under **Files**, then run `npx vitest run && npx vite build`. Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/pages/hr/AdvancesPanel.jsx src/pages/HR.jsx
git commit -m "feat(payroll): advances tab with owner approval and installment balances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A5 landscape payslip

**Files:**
- Create: `src/pages/hr/Payslip.jsx`
- Modify: `src/lib/pdf.js` (`pdfOptions` and `downloadPDF` accept `format` and `orientation`), and `src/pages/hr/PayrollMonth.jsx` (replace the `{/* slip button: Task 11 */}` marker)
- Test: `src/lib/pdf.test.js`. Create it; if a file with that name already exists, add a new `describe` block to it.

**Interfaces:**
- Consumes:
  - `thaiBahtText(amount)` from `src/lib/thaiBahtText.js:41`
  - `periodLabel` and `MONTHS_TH`
  - `useTenant().tenant`: the company name, and the tax ID field (find it with `grep -n "tax_id\|taxId\|tax_number" src/hooks/useTenant.js src/pages/Settings.jsx`)
  - `bankByCode` (Task 7) and `downloadPDF`
- Produces:
  - `PayslipModal({ record, year, month, period, onClose })`, where `record` is a `salary_records` row with `workers(...)`, `facts` and `salary_record_lines`, as loaded by `loadPayrollMonth`
  - `PayslipSheet(...)`

- [ ] **Step 1: Write the failing pdfOptions test**

```js
// src/lib/pdf.test.js
import { describe, it, expect } from 'vitest'
import { pdfOptions } from './pdf.js'

describe('pdfOptions page size', () => {
  it('defaults to A4 portrait and accepts A5 landscape', () => {
    expect(pdfOptions().jsPDF).toMatchObject({ format: 'a4', orientation: 'portrait' })
    expect(pdfOptions({ format: 'a5', orientation: 'landscape' }).jsPDF).toMatchObject({ format: 'a5', orientation: 'landscape' })
  })
})
```

Run: `npx vitest run src/lib/pdf.test.js`. Expected: FAIL on the A5 assertion.

- [ ] **Step 2: Extend pdf.js**

Replace `pdfOptions` and `downloadPDF` with:

```js
export function pdfOptions({ margin = 10, scale = 2, filename, format = 'a4', orientation = 'portrait' } = {}) {
  return {
    margin:      [margin, margin, margin, margin],
    filename:    filename || 'document.pdf',
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale, useCORS: true, letterRendering: true, backgroundColor: '#ffffff' },
    jsPDF:       { unit: 'mm', format, orientation },
  }
}

export async function downloadPDF(elementId, filename, { margin = 10, scale = 2, format = 'a4', orientation = 'portrait' } = {}) {
  const html2pdf = (await import('html2pdf.js')).default
  const element = document.getElementById(elementId)
  if (!element) { console.error('element not found:', elementId); return }
  const { worker } = await buildPDF(html2pdf, element, pdfOptions({ margin, scale, filename, format, orientation }))
  await worker.save()
}
```

Then read `buildPDF` (pdf.js:32–60). If it hard-codes A4 dimensions for the text layer, switch it to the jsPDF page size (`pdf.internal.pageSize.getWidth()` and `getHeight()`). Run `npx vitest run src/lib` and expect a pass.

- [ ] **Step 3: Create Payslip.jsx**

```jsx
// src/pages/hr/Payslip.jsx
// A5 landscape payslip (mockup screen 1). Built only from the record's own
// lines (name snapshots), so an old month always prints as it was paid.
import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import { useTenant } from '../../hooks/useTenant.js'
import { supabase, fmt } from '../../lib/supabase.js'
import { downloadPDF } from '../../lib/pdf.js'
import { thaiBahtText } from '../../lib/thaiBahtText.js'
import { periodLabel, MONTHS_TH } from '../../lib/payroll/period.js'
import { bankByCode } from '../../lib/bankExport/banks.js'

const maskAcct = a => (a && a.length >= 4 ? `xxx-x-x${a.slice(-4, -1)}-x` : '—')
const thDate = d => { if (!d) return '—'; const [y, m, day] = d.split('-'); return `${+day}/${m}/${+y + 543}` }

function useYearToDate(workerId, year, month) {
  const [ytd, setYtd] = useState(null)
  useEffect(() => {
    let off = false
    supabase.from('salary_record_lines')
      .select('side, amount, pay_items(method), salary_records!inner(worker_id, year, month, payroll_periods!inner(status))')
      .eq('salary_records.worker_id', workerId).eq('salary_records.year', year).lte('salary_records.month', month)
      .eq('salary_records.payroll_periods.status', 'closed')
      .then(({ data }) => {
        if (off || !data) return
        setYtd({
          earnings: data.filter(l => l.side === 'earning').reduce((s, l) => s + Number(l.amount), 0),
          sso: data.filter(l => l.pay_items?.method === 'sso').reduce((s, l) => s + Number(l.amount), 0),
        })
      })
    return () => { off = true }
  }, [workerId, year, month])
  return ytd
}

const CSS = `
.payslip-a5{width:794px;height:560px;box-sizing:border-box;padding:26px 30px 20px;background:#fff;color:#1b1f1d;font-family:Sarabun,sans-serif;font-size:12.5px;line-height:1.45;display:grid;grid-template-rows:auto auto 1fr auto auto;gap:10px}
.payslip-a5 .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #1b1f1d;padding-bottom:8px}
.payslip-a5 .co{font-weight:700;font-size:15px}.payslip-a5 .co small{display:block;font-weight:400;font-size:11px;color:#555}
.payslip-a5 .tt{text-align:right}.payslip-a5 .tt b{font-size:16px;display:block}.payslip-a5 .tt span{font-size:11.5px;color:#444}
.payslip-a5 .who{display:grid;grid-template-columns:repeat(4,1fr);gap:2px 16px;font-size:11.5px}.payslip-a5 .who span{color:#666;margin-right:6px}
.payslip-a5 .money{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-content:start}
.payslip-a5 table{width:100%;border-collapse:collapse}.payslip-a5 th{text-align:left;font-size:11.5px;border-bottom:1px solid #1b1f1d;padding:2px 0}
.payslip-a5 td{padding:2px 0;border-bottom:1px dotted #c9cfcc}.payslip-a5 td small{color:#666;font-size:10.5px}
.payslip-a5 .num{text-align:right;font-variant-numeric:tabular-nums}.payslip-a5 .sum td{font-weight:700;border-top:1px solid #1b1f1d;border-bottom:none;padding-top:4px}
.payslip-a5 .facts{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:11px;color:#444;border-top:1px solid #c9cfcc;padding-top:6px}
.payslip-a5 .ft{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:16px;align-items:end}
.payslip-a5 .net{background:#1b1f1d;color:#fff;padding:6px 12px;border-radius:3px}.payslip-a5 .net .v{font-size:19px;font-weight:700}
.payslip-a5 .sg{text-align:center;font-size:11px;color:#444}.payslip-a5 .sg b{display:block;font-size:12.5px;color:#1b1f1d;border-bottom:1px solid #555;padding-bottom:3px;margin-bottom:3px}
`

export function PayslipSheet({ record, year, month, period }) {
  const { tenant } = useTenant()
  const w = record.workers || {}
  const lines = [...(record.salary_record_lines || [])].sort((a, b) => a.sort_order - b.sort_order)
  const earn = lines.filter(l => l.side === 'earning')
  const ded = lines.filter(l => l.side === 'deduction')
  const sum = ls => ls.reduce((s, l) => s + Number(l.amount), 0)
  const f = record.facts || {}
  const ytd = useYearToDate(record.worker_id, year, month)
  const row = l => (
    <tr key={l.id}>
      <td>{l.name}{l.quantity && l.rate ? <small> {l.quantity} × {fmt(l.rate)}</small> : null}{l.note ? <small> · {l.note}</small> : null}</td>
      <td className="num">{fmt(l.amount)}</td>
    </tr>
  )
  return (
    <div id="payslip-a5" className="payslip-a5">
      <style>{CSS}</style>
      <div className="hd">
        <div className="co">{tenant?.company_name}<small>{tenant?.tax_id ? `เลขประจำตัวผู้เสียภาษี ${tenant.tax_id}` : ''}</small></div>
        <div className="tt"><b>สลิปเงินเดือน</b><span>งวด {periodLabel(year, month)} · วันที่จ่าย {thDate(period?.paid_date || record.paid_date)}</span></div>
      </div>
      <div className="who">
        <div><span>ชื่อ</span>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</div>
        <div><span>รหัส</span>{w.employee_code || '—'}</div>
        <div><span>ตำแหน่ง</span>{w.position || '—'}</div>
        <div><span>บัญชี</span>{w.bank_code ? `${bankByCode(w.bank_code)?.name || w.bank_code} ${maskAcct(w.bank_account_no)}` : '—'}</div>
      </div>
      <div className="money">
        <table>
          <thead><tr><th>รายการเงินได้</th><th className="num">บาท</th></tr></thead>
          <tbody>{earn.map(row)}<tr className="sum"><td>รวมเงินได้</td><td className="num">{fmt(sum(earn))}</td></tr></tbody>
        </table>
        <table>
          <thead><tr><th>รายการเงินหัก</th><th className="num">บาท</th></tr></thead>
          <tbody>{ded.map(row)}<tr className="sum"><td>รวมเงินหัก</td><td className="num">{fmt(sum(ded))}</td></tr></tbody>
        </table>
      </div>
      <div className="facts">
        <span>วันทำงาน <b>{f.daysWorked ?? '—'}</b> วัน</span>
        <span>ลากิจ <b>{f.leavePersonalDays ?? 0}</b> วัน</span>
        <span>ลาป่วย <b>{f.leaveSickDays ?? 0}</b> วัน</span>
        <span>OT <b>{f.otHours ?? 0}</b> ชม.</span>
        {f.holidayShifts ? <span>กะวันหยุด <b>{f.holidayShifts}</b></span> : null}
        {ytd && <span>สะสมทั้งปี: เงินได้ <b>{fmt(ytd.earnings)}</b> · ประกันสังคม <b>{fmt(ytd.sso)}</b></span>}
      </div>
      <div className="ft">
        <div className="net">
          <div style={{ fontSize: 11, opacity: 0.8 }}>จ่ายสุทธิ</div>
          <div className="v">{fmt(record.net_pay)}</div>
          <div style={{ fontSize: 11 }}>({thaiBahtText(Number(record.net_pay))})</div>
        </div>
        <div className="sg"><b>{tenant?.company_name}</b>ผู้จ่ายเงิน</div>
        <div className="sg"><b>{w.bank_account_name || w.name}</b>ผู้รับเงิน</div>
      </div>
    </div>
  )
}

export default function PayslipModal({ record, year, month, period, onClose }) {
  const label = (record.workers?.nickname || record.workers?.name || 'slip').replace(/\s+/g, '_')
  const download = () => downloadPDF('payslip-a5', `สลิปเงินเดือน_${label}_${MONTHS_TH[month - 1]}${year + 543}.pdf`, { format: 'a5', orientation: 'landscape', margin: 0 })
  return (
    <Modal title={`สลิปเงินเดือน — ${record.workers?.name || ''}`} onClose={onClose} maxWidth={860}>
      <div className="modal-body" style={{ overflowX: 'auto' }}>
        <PayslipSheet record={record} year={year} month={month} period={period} />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={download}>⬇️ ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}
```

The payer name is the company name. The owner chose typed names over signature lines, and the company is the payer.

- [ ] **Step 4: Add the slip button to PayrollMonth**

- Add `const [slip, setSlip] = useState(null)`.
- Replace `{/* slip button: Task 11 */}` with `<button className="btn btn-ghost btn-sm" onClick={() => setSlip(r)} aria-label="สลิป">📄</button>`.
- Render `{slip && <PayslipModal record={slip} year={year} month={month} period={data?.period} onClose={() => setSlip(null)} />}` before the closing `</div>`.
- Import `PayslipModal from './Payslip.jsx'`.

- [ ] **Step 5: Build and test**

Run: `npx vitest run && npx vite build`. Expected: pass.
A live visual check against the mockup happens in Task 13 Step 5, because the tables don't exist on CHANG until then. Say so in the task report.

- [ ] **Step 6: Commit**

```bash
git add src/pages/hr/Payslip.jsx src/pages/hr/PayrollMonth.jsx src/lib/pdf.js src/lib/pdf.test.js
git commit -m "feat(payroll): A5 landscape payslip with YTD and Thai baht text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: SCB payroll file export (SPN/SPS/PAY) + bank settings

**Files:**
- Create: `src/lib/bankExport/scb.js`, `src/pages/hr/BankExportModal.jsx`, `src/pages/hr/BankExportSettings.jsx`
- Test: `src/lib/bankExport/scb.test.js`
- Modify:
  - `src/pages/hr/PayrollMonth.jsx`: replace the `{/* bank export: Task 12 */}` marker
  - `src/pages/Settings.jsx`: add a section
  - `src/lib/payroll/load.js`: add `bank_branch_code` to the `workers(...)` select

**Interfaces:**
- Consumes: `banks.js` (Task 7), `useBankSettings()` (Task 6), table `payroll_bank_settings` (PK `tenant_id`).
- Produces: `buildScbPayrollFile({ settings, valueDate, now, rows }) → { filename, content, total, count, errors:[{ref, name, message}] }`.
  - `settings = {product:'SPN'|'SPS'|'PAY', debit_account, fee_account, fee_charge:'OUR'|'BEN', system_ref}`
  - `valueDate = 'YYYY-MM-DD'`, `now = Date`
  - `rows = [{ref, name, bank_code, account, branch, amount, email}]`
  - Rows that fail validation are listed in `errors` and left out of `content`.
  - It throws on invalid settings or an invalid value date.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/bankExport/scb.test.js
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
    expect(lines[2].split('|')).toHaveLength(28)
    expect(lines[2]).toBe('TXNDET|EMP001|1234567890||004|0123|22580.00|01|OUR|N||N||นาย ประภากร ปายันต์||||N|||N|N||||N||')
    expect(lines[3]).toBe(`TXNDET|EMP002|${SCB_EMP}||014|0987|23109.50|01|OUR|N||Y|a@b.co|นาย พรชัย คอนแก้ว||||N|||Y|N||||E|a@b.co|`)
    expect(lines[4]).toBe('TRAILR|1|2|45689.50')
    expect(r.content.endsWith('45689.50')).toBe(true) // no newline after TRAILR
    expect(r.errors).toEqual([])
  })
  it('PAY uses branch 0111 and empty service type, SCB accounts only', () => {
    const r = buildScbPayrollFile({ settings: { ...settings, product: 'PAY' }, valueDate: '2026-10-30', now, rows })
    expect(r.errors).toEqual([{ ref: 'EMP001', name: rows[0].name, message: 'PAY จ่ายได้เฉพาะบัญชีไทยพาณิชย์' }])
    const txn = r.content.split('\r\n')[2].split('|')
    expect(txn[5]).toBe('0111')
    expect(txn[7]).toBe('')
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
    expect(r.content.split('\r\n')).toHaveLength(5)
  })
  it('rejects bad settings and value dates', () => {
    expect(() => buildScbPayrollFile({ settings: { ...settings, debit_account: '1234567890' }, valueDate: '2026-10-30', now, rows })).toThrow('บัญชีต้นทาง')
    expect(() => buildScbPayrollFile({ settings, valueDate: '2026-10-17', now, rows })).toThrow('SPN')
    expect(() => buildScbPayrollFile({ settings: { ...settings, product: 'SPS' }, valueDate: '2026-10-16', now, rows })).toThrow('ย้อนหลัง')
    expect(buildScbPayrollFile({ settings: { ...settings, product: 'SPS' }, valueDate: '2026-10-17', now, rows }).count).toBe(2)
  })
})
```

The test expects `1234567890` to be a valid KBank account: 10 digits, with no check digit for non-SCB banks. If `scbValid('111222333')` happens to produce a number that equals `1234567890`, that doesn't matter, because they are different strings.

Before implementing, verify the expected `TXNDET` strings field by field against `docs/reference/bank-payroll-file-formats.md` §2.4:

| Fields | Value |
|---|---|
| 1 | `TXNDET` |
| 2 | ref |
| 3 | account |
| 4 | empty |
| 5 | bank |
| 6 | branch |
| 7 | amount |
| 8 | `01` |
| 9 | fee |
| 10 | `N` |
| 11 | empty |
| 12 | email flag |
| 13 | email |
| 14 | name |
| 15–17 | empty |
| 18 | `N` |
| 19–20 | empty |
| 21 | advice flag |
| 22 | `N` |
| 23–25 | empty |
| 26 | `E`/`N` |
| 27 | email |
| 28 | remark (empty) |

- [ ] **Step 2: Run them and check that they fail**

Run: `npx vitest run src/lib/bankExport/scb.test.js`. Expected: FAIL (missing module).

- [ ] **Step 3: Implement scb.js**

```js
// src/lib/bankExport/scb.js
// SCB Business Anywhere (CPX) payroll upload file. Layout: reference doc §2.
// Pipe-delimited, UTF-8 without BOM, CRLF between lines, none after TRAILR.
import { scbCheckDigitOk, validateAccount } from './banks.js'

const pad = n => String(n).padStart(2, '0')
const money = n => (Math.round(Number(n) * 100) / 100).toFixed(2)
const BANNED = /[!"#$%&*+;<=>?@[\\\]^_`{|}~]/
const NEXT_DAY = ['SPN']

const stamp = d => `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function rowError(r, product) {
  if (!r.bank_code || !r.account) return 'ยังไม่มีเลขบัญชี'
  if (!r.name || BANNED.test(r.name) || r.name.length > 140 || r.name.startsWith(' ')) return 'ชื่อบัญชีมีอักขระที่ธนาคารไม่รับ'
  if (r.ref && (r.ref.length > 20 || r.ref.includes('|'))) return 'รหัสอ้างอิงยาวเกิน 20 ตัวหรือมี |'
  if (!(Number(r.amount) > 0)) return 'ยอดจ่ายต้องมากกว่า 0'
  if (product === 'PAY' && r.bank_code !== '014') return 'PAY จ่ายได้เฉพาะบัญชีไทยพาณิชย์'
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
  if (!scbCheckDigitOk(debit_account)) throw new Error('บัญชีต้นทาง (ไทยพาณิชย์) ไม่ถูกต้อง')
  if (!scbCheckDigitOk(fee_account)) throw new Error('บัญชีหักค่าธรรมเนียมไม่ถูกต้อง')
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
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx vitest run src/lib/bankExport`. Expected: PASS. If a `TXNDET` string differs, compare it field by field against §2.4 and fix the code, not the test.

- [ ] **Step 5: Create BankExportSettings.jsx and add it to Settings**

```jsx
// src/pages/hr/BankExportSettings.jsx
// One-time SCB setup for the payroll upload file (reference doc §2.8).
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useBankSettings } from '../../hooks/usePayroll.js'
import { scbCheckDigitOk } from '../../lib/bankExport/banks.js'

const EMPTY = { product: 'SPN', debit_account: '', fee_account: '', fee_charge: 'OUR', system_ref: '' }

export default function BankExportSettings() {
  const { data, refetch } = useBankSettings()
  const [f, setF] = useState(EMPTY)
  useEffect(() => { if (data) setF({ ...EMPTY, ...data }) }, [data])
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const save = async () => {
    const fee = f.fee_account || f.debit_account
    if (!scbCheckDigitOk(f.debit_account)) return alert('เลขบัญชีต้นทางไม่ถูกต้อง')
    if (!scbCheckDigitOk(fee)) return alert('เลขบัญชีหักค่าธรรมเนียมไม่ถูกต้อง')
    const row = { bank: 'scb', product: f.product, debit_account: f.debit_account, fee_account: fee, fee_charge: f.fee_charge, system_ref: f.system_ref || null, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('payroll_bank_settings').upsert(row, { onConflict: 'tenant_id' })
    if (error) alert('บันทึกไม่สำเร็จ: ' + error.message)
    else { alert('✅ บันทึกแล้ว'); refetch() }
  }
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
      <div className="card-title">🏦 ไฟล์จ่ายเงินเดือน SCB Business Anywhere</div>
      <label className="label">บริการ</label>
      <select className="input" value={f.product} onChange={e => set('product', e.target.value)}>
        <option value="SPN">Payroll – SMART โอนวันถัดไป (ทุกธนาคาร)</option>
        <option value="SPS">Payroll – SMART โอนวันเดียวกัน (ทุกธนาคาร)</option>
        <option value="PAY">Payroll (เฉพาะบัญชีไทยพาณิชย์)</option>
      </select>
      <label className="label">บัญชีต้นทาง (ไทยพาณิชย์ 10 หลัก)</label>
      <input className="input" inputMode="numeric" value={f.debit_account || ''} onChange={e => set('debit_account', e.target.value.replace(/\D/g, '').slice(0, 10))} />
      <label className="label">บัญชีหักค่าธรรมเนียม (ว่าง = บัญชีเดียวกัน)</label>
      <input className="input" inputMode="numeric" value={f.fee_account || ''} onChange={e => set('fee_account', e.target.value.replace(/\D/g, '').slice(0, 10))} />
      <label className="label">ใครจ่ายค่าธรรมเนียม</label>
      <select className="input" value={f.fee_charge} onChange={e => set('fee_charge', e.target.value)}>
        <option value="OUR">บริษัท</option><option value="BEN">ผู้รับเงิน</option>
      </select>
      <label className="label">รหัสบริษัท / System Reference ID (ถ้าธนาคารให้มา)</label>
      <input className="input" value={f.system_ref || ''} onChange={e => set('system_ref', e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 18))} />
      <button className="btn btn-primary" onClick={save}>💾 บันทึก</button>
    </div>
  )
}
```

In Settings.jsx:
- Add `{ id: 'payroll_bank', label: '🏦 ไฟล์จ่ายเงินเดือน (SCB)', show: isOwner && hasModuleAccess('payroll') },` after `payroll_items`.
- Render `{activeSection === 'payroll_bank' && isOwner && hasModuleAccess('payroll') && <BankExportSettings />}`.
- Import `BankExportSettings from './hr/BankExportSettings.jsx'`.

- [ ] **Step 6: Create BankExportModal.jsx and wire it into PayrollMonth**

```jsx
// src/pages/hr/BankExportModal.jsx
// Builds the SCB upload file for a confirmed/closed month. Workers that can't
// go in the file (no account, bad branch…) are listed so the admin pays them by hand.
import { useMemo, useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import { useBankSettings } from '../../hooks/usePayroll.js'
import { buildScbPayrollFile } from '../../lib/bankExport/scb.js'
import { fmt } from '../../lib/supabase.js'
import { monthRange } from '../../lib/payroll/period.js'

export default function BankExportModal({ records, year, month, onClose }) {
  const { data: settings, loading } = useBankSettings()
  const [valueDate, setValueDate] = useState(monthRange(year, month).to)
  const rows = useMemo(() => records.map(r => ({
    ref: (r.workers?.employee_code || '').slice(0, 20),
    name: r.workers?.bank_account_name || r.workers?.name,
    bank_code: r.workers?.bank_code || '',
    account: r.workers?.bank_account_no || '',
    branch: r.workers?.bank_branch_code || '',
    amount: Number(r.net_pay),
    email: '',
  })), [records])
  let result = null
  let fatal = null
  if (settings) {
    try { result = buildScbPayrollFile({ settings, valueDate, now: new Date(), rows }) }
    catch (e) { fatal = e.message }
  }
  const download = () => {
    const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' }) // JS strings → UTF-8, no BOM
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = result.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <Modal title="ไฟล์จ่ายเงินเดือน SCB" onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {loading && <div>⏳</div>}
        {!loading && !settings && <div>ยังไม่ได้ตั้งค่าบัญชีต้นทาง ไปที่ ตั้งค่า → ไฟล์จ่ายเงินเดือน (SCB)</div>}
        {settings && (
          <>
            <label className="label">วันที่โอน</label>
            <input className="input" type="date" value={valueDate} onChange={e => setValueDate(e.target.value)} />
            {fatal && <div style={{ color: 'var(--danger)' }}>{fatal}</div>}
            {result && <div>{result.count} คน · รวม <b>{fmt(result.total)}</b> บาท · บริการ {settings.product}</div>}
            {result?.errors.length > 0 && (
              <div>
                <b>ไม่ได้ใส่ในไฟล์ {result.errors.length} คน (ต้องโอนเอง):</b>
                {result.errors.map(e => <div key={`${e.ref}-${e.name}`}>• {e.name}: {e.message}</div>)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" disabled={!result || !result.count} onClick={download}>⬇️ ดาวน์โหลดไฟล์</button>
      </div>
    </Modal>
  )
}
```

In PayrollMonth.jsx:
- Add `const [exportOpen, setExportOpen] = useState(false)`.
- Replace `{/* bank export: Task 12 */}` with `{canEdit && ['confirmed', 'closed'].includes(status) && <button className="btn" onClick={() => setExportOpen(true)}>🏦 ไฟล์ธนาคาร</button>}`.
- Render `{exportOpen && <BankExportModal records={records} year={year} month={month} onClose={() => setExportOpen(false)} />}`.
- Import `BankExportModal from './BankExportModal.jsx'`.

In `src/lib/payroll/load.js`, change the `workers(...)` embed in the `salary_records` select to include `bank_branch_code`.

- [ ] **Step 7: Build, test and commit**

Run: `npx vitest run && npx vite build`. Expected: pass.

```bash
git add src/lib/bankExport src/pages/hr/BankExportModal.jsx src/pages/hr/BankExportSettings.jsx src/pages/hr/PayrollMonth.jsx src/pages/Settings.jsx src/lib/payroll/load.js
git commit -m "feat(payroll): SCB Business Anywhere payroll file (SPN/SPS/PAY) and settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Whole-branch review, apply, deploy, live check

**Files:**
- Modify: `src/changelog.json`. Bump the version per memory `project_document_templates_state.md` (deploy and changelog-bump rules) and add the Thai entry "ระบบเงินเดือนใหม่: ตั้งรายการเงินได้/เงินหักเอง, ปิดงวด, เบิกล่วงหน้าผ่อนได้, สลิป A5, ไฟล์โอนเงินเดือน SCB".

Step 3 needs the owner's OK. Use the `chang-ship` skill for the apply and deploy commands and its guards.

- [ ] **Step 1: Full verification**

Run: `TZ=Asia/Bangkok npx vitest run && npx vite build`
Expected: every test passes, including all 13 in `september2026.test.js`, and the build succeeds.

- [ ] **Step 2: Whole-branch review**

Dispatch one fresh reviewer, on the most capable model, over `git diff origin/main...HEAD` with the spec and this plan. Fix its findings, then rerun Step 1.

- [ ] **Step 3: Owner go-ahead, then apply the migrations in order**

Show the owner three things:
- the FacadeX mismatch list from Task 5;
- the old and new labor-cost totals from Task 4;
- the contribution check from Task 5 Step 1.

After they say go, apply these on CHANG in order with `apply_migration`: `2026-10-19-01-payroll-structure`, `-02-payroll-rpcs`, `-03-labor-cost-divide-30`, `-04-payroll-backfill`. Then run the real backfill:

```sql
SELECT t.company_name, payroll_backfill_lines(t.id, true) FROM tenants t;
```

Then check the results with `execute_sql`:

```sql
SELECT count(*) FROM salary_records r WHERE NOT EXISTS (SELECT 1 FROM salary_record_lines l WHERE l.salary_record_id = r.id) AND r.net_pay <> 0;  -- expect 0
SELECT r.id FROM salary_records r
 WHERE round(r.net_pay, 2) <> (SELECT round(COALESCE(sum(CASE WHEN side = 'earning' THEN amount ELSE -amount END), 0), 2) FROM salary_record_lines l WHERE l.salary_record_id = r.id);  -- expect 0 rows
SELECT has_function_privilege('anon', 'save_payroll_draft(int,int,jsonb)', 'execute');   -- expect false
SELECT tenant_id, count(*) FROM pay_items GROUP BY 1 HAVING count(*) < 11;               -- expect 0 rows
```

- [ ] **Step 4: Deploy the web app**

Follow the `chang-ship` skill: build, then `wrangler deploy`. Confirm the deployed bundle's Supabase URL is the CHANG project, not Tokyo.

- [ ] **Step 5: Live check in Chrome (FacadeX tenant, with the owner)**

1. Settings → โครงสร้างเงินเดือน shows 11 items in the sheet's order.
2. Edit three workers:
   - กร: employee code, SCB bank, account and branch, โทรศัพท์ 500, ค่าจอดรถ 1,000, ค่าบ้าน 1,512.
   - นิด: รายวัน, 200.
   - One foreign worker: has_social_security off.
3. HR → เงินเดือน → กันยายน 2026 shows the backfilled closed month, and 📄 opens an A5 slip. Compare it with the mockup.
4. ตุลาคม 2026:
   - คำนวณ. The preview lists every active worker, including anyone with no shifts.
   - Save. Type กยศ for one person, run คำนวณ again, and check that the กยศ value is kept.
5. Before confirming, check the Assign warning in the preview. Workers missing shifts are listed with their dates, and สมาชิกที่ซ่อนจาก Assign are not. Press ยืนยันเงินเดือน; it asks before continuing when gaps exist. Then log in as a worker account, check that the October slip is visible, and log back in as admin.
6. Settings → ไฟล์จ่ายเงินเดือน (SCB): set the debit account and product SPN.
7. Back on October → ไฟล์ธนาคาร. Read the list of excluded workers, then download the file.
8. The owner uploads the file in SCB Business Anywhere. Record the portal's validation result. If it rejects the file, copy the exact error and stop: that is a Task 12 bug.
9. Once accepted, ask the owner for the file (masked) and add it as a fixture to `scb.test.js` in a follow-up commit.
10. Reset the demo tenant with the platform-admin button. It must finish without `demo_reset_stuck`.

- [ ] **Step 6: Changelog, memory, vault**

```bash
git add src/changelog.json
git commit -m "chore: changelog for payroll rework

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Write the project memory `project_payroll_rework.md` covering:
- what shipped;
- the migrations applied;
- open items: the SCB first-upload result, KBank deferred, job 2 (LINE advances).

Mirror it to the Obsidian vault. Do not merge to main until the owner OKs the whole arc (memory `feedback_branch_merge_timing.md`).
