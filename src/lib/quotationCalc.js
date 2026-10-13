// ============================================================
// Quotation totals math -- see
// docs/superpowers/specs/2026-08-22-quotation-module-design.md.
//
// Mirrors PurchaseOrders.jsx's calcPoTotals (subtotal/VAT math and the
// priceIncludesVat back-out), extracted into a tested lib module instead
// of staying inline, plus one addition: a single header-level discount
// (flat amount or percent, mutually exclusive) applied to the raw
// line-item sum BEFORE the VAT branching runs, so it uniformly reduces
// whichever figure is meaningful (VAT-inclusive total or pre-VAT
// subtotal) without needing separate discount logic per VAT mode.
// ============================================================

export const VAT_RATE = 0.07

export function lineTotal(item) {
  return (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** Material/labor subtotals across item lines, for the split-pricing-mode
 *  summary (editor + printed document). Note/item_description rows and
 *  missing values contribute zero. */
export function sumMaterialLabor(items) {
  return (items || []).reduce((acc, it) => {
    const qty = parseFloat(it.quantity) || 0
    acc.material += qty * (parseFloat(it.unit_price_material) || 0)
    acc.labor += qty * (parseFloat(it.unit_price_labor) || 0)
    return acc
  }, { material: 0, labor: 0 })
}

/**
 * @param {Array} items - quotation line items ({ line_total } or
 *   { quantity, unit_price })
 * @param {{ hasVat: boolean, priceIncludesVat: boolean, discountAmount:
 *   number|string, discountPct: number|string }} opts - discountPct takes
 *   precedence over discountAmount if both are somehow set (the UI keeps
 *   them mutually exclusive; this is just a defined tie-break, not
 *   expected to matter in practice)
 * @returns {{ rawTotal: number, discount: number, subtotal: number,
 *   vat: number, total: number }}
 */
export function calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct } = {}) {
  const rawTotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : lineTotal(it)), 0)

  const discountedRaw = discountPct
    ? Math.max(0, rawTotal * (1 - (parseFloat(discountPct) || 0) / 100))
    : Math.max(0, rawTotal - (parseFloat(discountAmount) || 0))
  const discount = round2(rawTotal - discountedRaw)

  if (!hasVat) {
    const total = round2(discountedRaw)
    return { rawTotal, discount, subtotal: total, vat: 0, total }
  }
  if (priceIncludesVat) {
    const total = round2(discountedRaw)
    const subtotal = round2(total / (1 + VAT_RATE))
    const vat = round2(total - subtotal)
    return { rawTotal, discount, subtotal, vat, total }
  }
  const subtotal = round2(discountedRaw)
  const vat = round2(subtotal * VAT_RATE)
  const total = round2(subtotal + vat)
  return { rawTotal, discount, subtotal, vat, total }
}

/** Revision snapshots written before 2026-10-14 stored each line without
 *  its item_type, so a note / item_description row came back looking like
 *  a billable item with quantity 0 and price 0.00 (and no running number)
 *  in the past-revision viewer. A row that carries its item_type is kept
 *  as is; a legacy row with no quantity, no unit and no price can only
 *  have been a description line, so it is read back as item_description
 *  (a note and an item_description are indistinguishable in old data --
 *  item_description is the closer fit, since it sits under the item above
 *  it). Anything else is a real item. Never mutates its input. */
export function normalizeSnapshotItems(items) {
  return (items || []).map(it => {
    if (it.item_type) return it
    const blank = !(parseFloat(it.quantity) || 0) && !(parseFloat(it.unit_price) || 0)
      && !(parseFloat(it.unit_price_material) || 0) && !(parseFloat(it.unit_price_labor) || 0)
      && !(it.unit || '').trim()
    return { ...it, item_type: blank ? 'item_description' : 'item' }
  })
}
