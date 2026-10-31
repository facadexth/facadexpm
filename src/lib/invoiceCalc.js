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
    const target = u.cumulativePct + (budget / u.unitQty) * 100
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

/** Material/labor subtotals across invoice item rows, for the split-pricing
 *  summary (create-invoice modal + printed document). Mirrors
 *  quotationCalc.js's sumMaterialLabor, keyed on draw_qty instead of
 *  quantity -- invoice items don't have a quantity field, only the drawn
 *  amount for this billing round. */
export function sumMaterialLabor(items) {
  return (items || []).reduce((acc, it) => {
    const qty = parseFloat(it.draw_qty) || 0
    acc.material += qty * (parseFloat(it.unit_price_material) || 0)
    acc.labor += qty * (parseFloat(it.unit_price_labor) || 0)
    return acc
  }, { material: 0, labor: 0 })
}

// depositTaxOffset -- pre-VAT value already taxed via an earlier deposit
// invoice on the SAME quotation (see client-deposit-tracking design spec).
// A deposit invoice charges VAT on its own value at receipt time; if a
// later progress/final invoice for the same quotation then charges VAT
// again on its FULL billed value, the deposit-covered slice gets taxed
// twice. VAT here is levied only on the portion of THIS invoice's value
// that hasn't already had VAT charged on it once -- the item-level
// subtotal shown on the document stays the full billed value regardless
// (it's a record of work delivered, not of what's newly taxable).
export function calcInvoiceTotals(invoiceItems, { hasVat, priceIncludesVat, depositTaxOffset = 0 } = {}) {
  const subtotalRaw = (invoiceItems || []).reduce((s, it) => s + it.line_total, 0)

  if (!hasVat) {
    const total = round2(subtotalRaw)
    return { subtotal: total, vat: 0, total }
  }
  const taxableSubtotal = Math.max(0, subtotalRaw - depositTaxOffset)
  if (priceIncludesVat) {
    // subtotalRaw is VAT-inclusive across the full billed items; strip VAT
    // only off the taxable slice, then add the (already-taxed) deposit
    // slice back in at face value for both subtotal and total.
    const taxablePortionExVat = round2(taxableSubtotal / (1 + VAT_RATE))
    const vat = round2(taxableSubtotal - taxablePortionExVat)
    const subtotal = round2(subtotalRaw - vat)
    const total = round2(subtotalRaw)
    return { subtotal, vat, total }
  }
  const subtotal = round2(subtotalRaw)
  const vat = round2(taxableSubtotal * VAT_RATE)
  const total = round2(subtotal + vat)
  return { subtotal, vat, total }
}

// ---- tax offset of an invoice that CHOSE its deposit deduction (invoices.deposit_deduction_amount) ----
// VAT / withholding base excludes only the value this invoice actually deducts as deposit (deposit already taxed when
// it was received). "No deduction" = VAT on the full value. It can never exceed the deposit tax still unused on the
// quotation (`available`, from earlier deposit invoices minus what earlier progress invoices already used).

/** The tax offset a new invoice takes: what it deducts, capped by the deposit tax still unused. */
export function chosenTaxOffset(deductionAmount, availableOffset) {
  return round2(Math.min(Math.max(0, Number(deductionAmount) || 0), Math.max(0, Number(availableOffset) || 0)))
}

/**
 * The offset a STORED invoice used, read back from its own vat (the same reverse-engineering the quotation-level
 * helper applies to earlier invoices). 0 when the quotation has no VAT.
 */
export function invoiceTaxOffsetUsed(invoice) {
  if (!invoice?.has_vat) return 0
  const subtotal = parseFloat(invoice.subtotal) || 0
  const vat = parseFloat(invoice.vat) || 0
  const total = parseFloat(invoice.total) || 0
  const taxableUsed = invoice.price_includes_vat ? vat * (1 + VAT_RATE) / VAT_RATE : vat / VAT_RATE
  const rawBilled = invoice.price_includes_vat ? total : subtotal
  return round2(Math.max(0, rawBilled - taxableUsed))
}

/**
 * The amount the invoice document bills ("ยอดใบกำกับ"). An invoice that chose its deposit deduction shows the deposit
 * taken off BEFORE VAT: (subtotal - deposit) + VAT = stored total (subtotal + vat) - deposit. Older invoices and deposit
 * invoices keep their stored total. The stored `total` itself is never rewritten, so the tax-offset bookkeeping that
 * reads it back (getQuotationDepositTaxOffset, invoiceTaxOffsetUsed) keeps working.
 */
export function invoiceBillingTotal(invoice) {
  const total = parseFloat(invoice?.total) || 0
  if (!invoice || invoice.is_deposit || invoice.deposit_deduction_amount == null) return total
  const deposit = Math.max(0, parseFloat(invoice.deposit_deduction_amount) || 0)
  return round2(Math.max(0, total - deposit))
}

/**
 * Offset to use for an invoice that already exists: one that chose its deduction (deposit_deduction_amount set) uses
 * exactly what it took when created; an older invoice keeps the previous behaviour (`legacyOffset` = whatever deposit
 * tax is still unused on the quotation right now).
 */
export function effectiveInvoiceTaxOffset(invoice, legacyOffset) {
  if (invoice?.deposit_deduction_amount != null) return invoiceTaxOffsetUsed(invoice)
  return Math.max(0, Number(legacyOffset) || 0)
}
