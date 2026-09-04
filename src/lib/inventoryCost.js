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
