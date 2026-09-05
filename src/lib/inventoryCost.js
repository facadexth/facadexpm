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

/**
 * Computes the sequence of stock_movements to post for one invoice's
 * ratio-based COGS deduction (spec decisions 6-8). Pure function, no I/O --
 * the caller loads items/balances once and re-uses this for every invoice
 * in the queue, and for live-previewing edits before confirming.
 *
 * Sourcing per category: the invoice's own site first: if its balance in
 * that category covers the target, deduct proportionally by each item's
 * value share and stop. If not, drain the site's balance in that category
 * entirely, then attempt to cover the remainder from ส่วนกลาง via a
 * transfer_out (central) + transfer_in (site) + sale_out (site) triplet
 * per item, again proportional by value share. If even that's short,
 * deduct everything available and report the unmet amount as a shortfall
 * -- this function never fabricates stock and never throws for a
 * shortfall; it only reports it in categoryResults for the caller to warn
 * about.
 *
 * Items with no category_id can never participate (there's nothing to
 * assign their value to) -- this is intentional, not an oversight.
 *
 * Balances with zero (or non-positive) weighted_average_cost are excluded
 * from sourcing entirely, not treated as "free" stock -- a written-down
 * leftover balance still can't fund a deduction with real invoice value.
 *
 * @param {object} params
 * @param {number} params.invoiceSubtotal - the invoice's pre-VAT amount
 * @param {number} params.materialPct - 0-100
 * @param {Record<string, number>} params.categorySplits - { categoryId: pct }; need not sum to 100 here, the caller validates that before calling
 * @param {string} params.siteId - the invoice's site id
 * @param {string|null} params.centralSiteId - ส่วนกลาง's site id, or null if no such site exists yet
 * @param {Array<{id: string, category_id: string|null}>} params.items
 * @param {Array<{inventory_item_id: string, site_id: string, quantity_on_hand: number, weighted_average_cost: number}>} params.balances
 * @returns {{
 *   steps: Array<{type: 'sale_out'|'transfer_out'|'transfer_in', inventoryItemId: string, siteId: string, quantity: number, unitCost: number, categoryId: string}>,
 *   categoryResults: Array<{categoryId: string, targetValue: number, deductedValue: number, shortfall: number}>,
 *   totalTargetValue: number, totalDeductedValue: number, totalShortfall: number,
 * }}
 */
export function computeInvoiceDeductionPlan({ invoiceSubtotal, materialPct, categorySplits, siteId, centralSiteId, items, balances }) {
  const materialValue = invoiceSubtotal * (materialPct / 100)
  const steps = []
  const categoryResults = []

  for (const [categoryId, splitPct] of Object.entries(categorySplits || {})) {
    const targetValue = materialValue * (splitPct / 100)
    if (!(targetValue > 0)) {
      categoryResults.push({ categoryId, targetValue: 0, deductedValue: 0, shortfall: 0 })
      continue
    }

    const categoryItemIds = new Set(items.filter(it => it.category_id === categoryId).map(it => it.id))
    const valueOf = (b) => b.quantity_on_hand * b.weighted_average_cost
    const inCategory = (siteFilter) => (balances || []).filter(b =>
      b.site_id === siteFilter && categoryItemIds.has(b.inventory_item_id) && b.quantity_on_hand > 0 && b.weighted_average_cost > 0)

    const siteBalances = inCategory(siteId)
    const siteTotalValue = siteBalances.reduce((s, b) => s + valueOf(b), 0)

    let deductedValue = 0

    if (siteTotalValue >= targetValue) {
      for (const b of siteBalances) {
        const share = valueOf(b) / siteTotalValue
        const valueToTake = targetValue * share
        steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: valueToTake / b.weighted_average_cost, unitCost: b.weighted_average_cost, categoryId })
      }
      deductedValue = targetValue
    } else {
      for (const b of siteBalances) {
        steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: b.quantity_on_hand, unitCost: b.weighted_average_cost, categoryId })
      }
      deductedValue = siteTotalValue
      const remaining = targetValue - siteTotalValue

      if (remaining > 0 && centralSiteId && centralSiteId !== siteId) {
        const centralBalances = inCategory(centralSiteId)
        const centralTotalValue = centralBalances.reduce((s, b) => s + valueOf(b), 0)

        if (centralTotalValue > 0) {
          const transferValue = Math.min(remaining, centralTotalValue)
          for (const b of centralBalances) {
            const share = valueOf(b) / centralTotalValue
            const valueToTransfer = transferValue * share
            const qty = valueToTransfer / b.weighted_average_cost
            steps.push({ type: 'transfer_out', inventoryItemId: b.inventory_item_id, siteId: centralSiteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
            steps.push({ type: 'transfer_in', inventoryItemId: b.inventory_item_id, siteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
            steps.push({ type: 'sale_out', inventoryItemId: b.inventory_item_id, siteId, quantity: qty, unitCost: b.weighted_average_cost, categoryId })
          }
          deductedValue += transferValue
        }
      }
    }

    const shortfall = Math.max(0, targetValue - deductedValue)
    categoryResults.push({ categoryId, targetValue, deductedValue, shortfall })
  }

  return {
    steps,
    categoryResults,
    totalTargetValue: categoryResults.reduce((s, c) => s + c.targetValue, 0),
    totalDeductedValue: categoryResults.reduce((s, c) => s + c.deductedValue, 0),
    totalShortfall: categoryResults.reduce((s, c) => s + c.shortfall, 0),
  }
}
