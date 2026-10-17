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
