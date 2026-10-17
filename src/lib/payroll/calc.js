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
