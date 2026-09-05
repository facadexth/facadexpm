// ============================================================
// Pure-JS mirror of record_stock_movement()'s weighted-average-cost
// math (supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql)
// -- used to preview the effect of a purchase_in/transfer_in movement
// client-side before the RPC actually posts it. Keep in lockstep with
// the SQL function's formula; if one changes, change both.
// ============================================================

/**
 * New weighted-average cost after adding incomingQty units at
 * incomingUnitCost to an existing balance of oldQty @ oldWac. Matches
 * docs/superpowers/specs/2026-09-01-inventory-module-design.md's
 * Business Logic > Purchasing formula.
 */
export function computeWeightedAverageCost(oldQty, oldWac, incomingQty, incomingUnitCost) {
  const newQty = oldQty + incomingQty
  if (newQty === 0) return 0
  return (oldQty * oldWac + incomingQty * incomingUnitCost) / newQty
}

/** Converts a quantity in an alternate unit to the item's base unit
 *  using a fixed factor (aluminium-style, spec decision #3). */
export function convertToBaseUnit(quantity, factorToBase) {
  return quantity * factorToBase
}

/** Weight in kg of `rodCount` rods, each `lengthM` meters long, of a
 *  profile whose linear weight is `linearWeightKgPerM` kg per meter.
 *  Matches docs/superpowers/specs/2026-09-05-inventory-dual-unit-conversion-design.md's
 *  aluminum decision #3/#4. */
export function computeAluminumWeightKg(rodCount, lengthM, linearWeightKgPerM) {
  return rodCount * lengthM * linearWeightKgPerM
}

/** Area in sqm of `sheetCount` sheets, each `widthM` x `heightM` meters.
 *  Matches the same spec's glass decision #1. */
export function computeGlassAreaSqm(sheetCount, widthM, heightM) {
  return sheetCount * widthM * heightM
}

/** Approximate physical sheet count for a pooled area balance, per the
 *  same spec's decision #2 (a nominal estimate, not an exact lot count).
 *  Returns null when no reference size is configured, rather than
 *  dividing by zero/null and showing a meaningless number. */
export function estimateSheetCount(areaSqm, referenceAreaSqm) {
  if (!referenceAreaSqm) return null
  return areaSqm / referenceAreaSqm
}
