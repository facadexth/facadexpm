// Rules for the "ตามความคืบหน้า" (progress) invoice mode and the per-line checks against
// BOQ + cards. Pure functions only. Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md.
// Weight is always a % of price: line value = qty x unit price x Σ weight of the phases delivered.
import { round2 } from './depositCalc.js'

// Units billed in whole numbers only; every other unit (and no unit) accepts decimals.
export const COUNT_UNITS = ['ชุด', 'งาน', 'ชิ้น', 'ตัว', 'บาน', 'จุด', 'เครื่อง', 'อัน', 'แผ่น', 'ต้น']

export function isCountUnit(unit) {
  if (unit == null) return false
  return COUNT_UNITS.includes(String(unit).trim())
}

// Σ pct of the chosen phases (0 when the item has no split rows for them)
export function phaseWeight(splits, phaseIds) {
  const ids = new Set(phaseIds || [])
  return round2((splits || []).reduce((s, r) => (ids.has(r.phase_id) ? s + (Number(r.pct) || 0) : s), 0))
}

// qty already billed for (item, phase) on earlier invoices; void invoices do not count
export function deliveredBefore(phaseDraws, boqItemId, phaseId) {
  return (phaseDraws || []).reduce((s, d) => (
    d.boq_item_id === boqItemId && d.phase_id === phaseId && d.invoice_status !== 'void'
      ? s + (Number(d.qty) || 0) : s
  ), 0)
}

// done qty of (item, phase) from the cards; null when any matching card has no quantity
export function doneQty(cards, boqItemId, phaseId) {
  let sum = 0
  for (const c of cards || []) {
    if (c.boq_item_id !== boqItemId || c.phase_id !== phaseId) continue
    if (c.progress_mode !== 'quantity' || c.planned_qty == null) return null
    sum += Number(c.done_qty) || 0
  }
  return sum
}

export function progressLineAmount({ qty, unitPrice, weightPct }) {
  return round2((Number(qty) || 0) * (Number(unitPrice) || 0) * (Number(weightPct) || 0) / 100)
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

// Reason codes: block = fraction_count_unit, card_no_qty; warn = the rest.
export function checkLine({ unit, qty, unitPrice, boqQty, boqUnitPrice, priceMultiplier, billedPct, phaseWeightPct, cardDoneQty }) {
  const reasons = []
  const q = Number(qty) || 0
  const hasBoq = boqQty != null
  const w = Number(phaseWeightPct) || 0

  if (isCountUnit(unit) && !Number.isInteger(q)) reasons.push('fraction_count_unit')
  if (cardDoneQty == null) {
    reasons.push('card_no_qty')
  }

  if (boqUnitPrice != null) {
    const expected = round2(Number(boqUnitPrice) * (priceMultiplier == null ? 1 : Number(priceMultiplier)))
    if (!near(Number(unitPrice) || 0, expected, 0.01)) reasons.push('price_mismatch')
  }

  // qty typed as BOQ qty x % (26 x 80% = 20.8): always warned, and it explains both the qty
  // and the % difference, so it replaces qty_not_card and weight_mismatch for this line
  const qtyIsPct = hasBoq && w > 0 && cardDoneQty != null && !near(q, Number(cardDoneQty), 0.001)
    && near(q, Number(boqQty) * w / 100, 0.001)
  if (qtyIsPct) {
    reasons.push('qty_is_pct_of_boq')
  } else {
    if (cardDoneQty != null && !near(q, Number(cardDoneQty), 0.001)) reasons.push('qty_not_card')
    if (w > 0 && billedPct != null && !near(Number(billedPct), w, 0.01)) reasons.push('weight_mismatch')
  }
  if (hasBoq && w === 0) reasons.push('no_weight')

  const level = reasons.some(r => r === 'fraction_count_unit' || r === 'card_no_qty') ? 'block'
    : reasons.length ? 'warn' : 'ok'
  return { level, reasons }
}

// qty of (item, phase) already covered by easy/advanced billing. Earlier billing (billedFraction
// of the item's value) is assumed to have used up the phases in sort order: a phase with weight w
// and cumulative weight c before it is delivered for clamp((f*100 - c) / w, 0, 1) of the BOQ qty.
export function legacyDeliveredQty({ billedFraction, phaseOrder, phaseId, boqQty }) {
  const f = Number(billedFraction) || 0
  if (f <= 0) return 0
  let c = 0
  for (const p of phaseOrder || []) {
    const w = Number(p.pct) || 0
    if (p.phase_id === phaseId) {
      if (w <= 0) return 0
      const frac = Math.min(1, Math.max(0, (f * 100 - c) / w))
      return round2((Number(boqQty) || 0) * frac)
    }
    c += w
  }
  return 0
}
