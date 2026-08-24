// ============================================================
// Invoice progress-billing math -- see
// docs/superpowers/specs/2026-08-24-invoice-module-design.md.
//
// `units` is the in-memory shape of a quotation_item_units group for one
// quotation_item: [{ unitQty, cumulativePct, target? }]. There is only one
// underlying representation -- โหมดง่าย (waterfall over a scalar qty) and
// โหมดละเอียด (direct per-unit target edits) both read and write this same
// shape, which is why switching modes never changes the billed total.
// ============================================================

export const VAT_RATE = 0.07

function round2(n) {
  return Math.round(n * 100) / 100
}

// Countable pieces (ชุด, งาน) get one quotation_item_units row per physical
// unit, so โหมดละเอียด can fragment them (2.1, 2.2, ...). Continuous
// measures (large or fractional quantities, e.g. 45 ตร.ม.) stay a single
// row -- a display heuristic only, not a hard business rule; both cases
// use the identical row shape.
export function isCountable(quantity) {
  return Number.isInteger(quantity) && quantity > 0 && quantity <= 20
}

export function buildUnitSeedRows(quotationItem) {
  const q = quotationItem.quantity
  if (isCountable(q)) {
    return Array.from({ length: q }, (_, i) => ({
      quotation_item_id: quotationItem.id, unit_index: i, unit_qty: 1,
    }))
  }
  return [{ quotation_item_id: quotationItem.id, unit_index: 0, unit_qty: q }]
}

// Fills `qty` (expressed in the item's own physical unit -- ชุด, ตร.ม.,
// whatever) across `units` in array order, completing each unit's
// remaining capacity before moving to the next. Returns a new array with
// `target` set on every unit (already-complete units get target ==
// cumulativePct, i.e. no draw).
export function waterfall(units, qty) {
  let budget = qty
  return units.map(u => {
    if (u.cumulativePct >= 100) return { ...u, target: u.cumulativePct }
    const capacity = u.unitQty * (100 - u.cumulativePct) / 100
    if (budget <= 1e-9) return { ...u, target: u.cumulativePct }
    if (budget >= capacity - 1e-9) {
      budget -= capacity
      return { ...u, target: 100 }
    }
    const target = round2(u.cumulativePct + (budget / u.unitQty) * 100)
    budget = 0
    return { ...u, target }
  })
}

// Total remaining capacity across all units, in the item's own physical
// unit -- independent of `target`, used as the max for โหมดง่าย's quantity
// field and as the upper bound waterfall() can ever consume.
export function openQty(units) {
  return units.reduce((s, u) => s + u.unitQty * (100 - u.cumulativePct) / 100, 0)
}

// Total (target - cumulativePct) delta across all units, in the item's own
// physical unit -- what โหมดง่าย displays as its quantity field, derived
// live from whatever โหมดละเอียด last set.
export function drawQty(units) {
  return units.reduce((s, u) => {
    const t = u.target != null ? u.target : u.cumulativePct
    return s + (t - u.cumulativePct) / 100 * u.unitQty
  }, 0)
}

export function drawAmount(units, unitPrice) {
  return drawQty(units) * unitPrice
}

export function calcInvoiceTotals(invoiceItems, { hasVat, priceIncludesVat } = {}) {
  const subtotalRaw = (invoiceItems || []).reduce((s, it) => s + it.line_total, 0)

  if (!hasVat) {
    const total = round2(subtotalRaw)
    return { subtotal: total, vat: 0, total }
  }
  if (priceIncludesVat) {
    const total = round2(subtotalRaw)
    const subtotal = round2(total / (1 + VAT_RATE))
    const vat = round2(total - subtotal)
    return { subtotal, vat, total }
  }
  const subtotal = round2(subtotalRaw)
  const vat = round2(subtotal * VAT_RATE)
  const total = round2(subtotal + vat)
  return { subtotal, vat, total }
}
