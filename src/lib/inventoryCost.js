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

/** Resolves a stock_movements row's reference_type/reference_id into a
 *  human-readable Thai label, given lookup arrays for the referenced
 *  tables. Falls back to a generic type-only label when the referenced
 *  row was deleted, and to '—' when there's no reference at all. */
export function resolveMovementReference(movement, { pos = [], invoices = [], sites = [] } = {}) {
  const { reference_type, reference_id } = movement
  if (reference_type === 'purchase_order') {
    const po = pos.find(p => p.id === reference_id)
    return po ? `PO ${po.po_number}` : 'ใบสั่งซื้อ'
  }
  if (reference_type === 'invoice') {
    const invoice = invoices.find(i => i.id === reference_id)
    return invoice ? `ใบแจ้งหนี้ ${invoice.invoice_number}` : 'ใบแจ้งหนี้'
  }
  if (reference_type === 'site_completion') {
    const site = sites.find(s => s.id === reference_id)
    return site ? `โอนจาก ${site.name}` : 'โอนจากไซท์งาน'
  }
  if (reference_type === 'manual_adjustment') return 'ปรับยอด'
  if (reference_type === 'quotation') return movement.notes ? `ใบเสนอราคา ${movement.notes}` : 'ใบเสนอราคา'
  return reference_type || '—'
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

/**
 * Computes the finished-goods "produce and sell" movements for one
 * invoice's billed quotation lines -- redesigned 2026-09-25 (artifact
 * comment thread on the ตัดสต็อก explainer, docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md)
 * away from the original "1 quotation line = 1.0 ชุด of the WHOLE
 * contract, drawn down fractionally across every invoice against it"
 * model. That model left a large, confusing leftover balance sitting
 * against the contract after every invoice, and a contract billed over
 * 100% showed up as a negative balance with no clean story. Instead:
 * each invoice PRODUCES exactly what it's about to SELL, right then --
 * one self-contained, self-balancing รับเข้า+ขายออก pair per billed
 * line per invoice, both valued the same (materialPct% of THAT
 * invoice's own billed amount, never the quotation's full value).
 * Quantity is always 1 ("made and sold 1 batch this invoice"); nothing
 * accumulates or depletes across invoices, so the >100%-billed edge
 * case the original design had to warn about can no longer happen --
 * there is no shared balance left to overdraw.
 *
 * @param {object} params
 * @param {Array<{quotationItemId: string|null, quotationNumber: string, sortOrder: number, description: string, invoiceItemLineTotal: number}>} params.billedLines
 * @param {number} params.materialPct - 0-100, the SAME %ต้นทุนวัสดุ the raw-material deduction step already uses for this invoice
 * @returns {{ steps: Array<{ quotationItemId: string, code: string, name: string, value: number }> }}
 */
export function computeFinishedGoodsProductionPlan({ billedLines, materialPct }) {
  const steps = []
  for (const line of billedLines || []) {
    if (!line.quotationItemId) continue
    if (!(line.invoiceItemLineTotal > 0)) continue
    const code = `${line.quotationNumber}-${line.sortOrder + 1}`
    const value = line.invoiceItemLineTotal * (materialPct / 100)
    steps.push({ quotationItemId: line.quotationItemId, code, name: line.description, value })
  }
  return { steps }
}

/**
 * Builds one stock-card row per matching inventory item for the
 * statutory รายงานสินค้าและวัตถุดิบ (and its finished-goods-only /
 * raw-material-only variants) -- opening balance as of just before
 * dateFrom, qty/value in and out within [dateFrom, dateTo], and the
 * resulting closing balance. See
 * docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md's
 * Report 1/2/3.
 *
 * Movement direction: purchase_in/transfer_in/sale_reversal are always
 * "in" (quantity stored positive); transfer_out/sale_out are always
 * "out" (quantity stored positive). 'adjustment' stores a SIGNED delta
 * (record_stock_movement computes p_quantity - old_qty) -- a positive
 * adjustment.quantity is "in", a negative one is "out".
 *
 * @param {object} params
 * @param {Array<{inventory_item_id: string, movement_type: string, quantity: number, unit_cost: number|null, created_at: string, notes: string|null}>} params.movements
 * @param {Array<{id: string, code: string|null, name: string, base_unit: string, item_kind: string, category_id: string|null}>} params.items
 * @param {string} params.dateFrom - 'YYYY-MM-DD', inclusive
 * @param {string} params.dateTo - 'YYYY-MM-DD', inclusive
 * @param {'all'|'finished_goods'|'raw_material'} params.itemKindFilter
 * @param {string|null} params.categoryId - filter to one category, or null for all
 * @returns {Array<{itemId: string, code: string, name: string, unit: string, openingQty: number, openingValue: number, inQty: number, inValue: number, outQty: number, outValue: number, closingQty: number, closingValue: number, movements: Array<{date: string, type: string, referenceType: string|null, referenceId: string|null, notes: string|null, qty: number, unitCost: number, value: number, direction: 'in'|'out'}>}>}
 */
export function computeStockLedgerReport({ movements, items, dateFrom, dateTo, itemKindFilter, categoryId }) {
  const dateFromMs = new Date(`${dateFrom}T00:00:00`).getTime()
  const dateToMs = new Date(`${dateTo}T23:59:59`).getTime()
  const itemsById = new Map((items || []).map(it => [it.id, it]))

  const matchesFilter = (item) => {
    if (!item) return false
    if (itemKindFilter !== 'all' && item.item_kind !== itemKindFilter) return false
    if (categoryId && item.category_id !== categoryId) return false
    return true
  }
  const direction = (m) => {
    if (m.movement_type === 'purchase_in' || m.movement_type === 'transfer_in' || m.movement_type === 'sale_reversal') return 'in'
    if (m.movement_type === 'transfer_out' || m.movement_type === 'sale_out') return 'out'
    return m.quantity >= 0 ? 'in' : 'out' // adjustment: signed delta
  }

  const rowsByItem = new Map()
  const getRow = (itemId) => {
    if (!rowsByItem.has(itemId)) {
      const item = itemsById.get(itemId)
      rowsByItem.set(itemId, {
        itemId, code: item?.code || '', name: item?.name || '', unit: item?.base_unit || '',
        openingQty: 0, openingValue: 0, inQty: 0, inValue: 0, outQty: 0, outValue: 0,
        closingQty: 0, closingValue: 0, movements: [],
      })
    }
    return rowsByItem.get(itemId)
  }

  for (const mv of movements || []) {
    const item = itemsById.get(mv.inventory_item_id)
    if (!matchesFilter(item)) continue
    const ts = new Date(mv.created_at).getTime()
    if (ts > dateToMs) continue

    const d = direction(mv)
    const magnitude = Math.abs(mv.quantity)
    const signedQty = d === 'in' ? magnitude : -magnitude
    const value = signedQty * (mv.unit_cost || 0)
    const row = getRow(mv.inventory_item_id)

    if (ts < dateFromMs) {
      row.openingQty += signedQty
      row.openingValue += value
    } else {
      if (d === 'in') { row.inQty += magnitude; row.inValue += magnitude * (mv.unit_cost || 0) }
      else { row.outQty += magnitude; row.outValue += magnitude * (mv.unit_cost || 0) }
      row.movements.push({ date: mv.created_at, type: mv.movement_type, referenceType: mv.reference_type || null, referenceId: mv.reference_id || null, notes: mv.notes || null, qty: magnitude, unitCost: mv.unit_cost || 0, value: magnitude * (mv.unit_cost || 0), direction: d })
    }
  }

  for (const row of rowsByItem.values()) {
    row.closingQty = row.openingQty + row.inQty - row.outQty
    row.closingValue = row.openingValue + row.inValue - row.outValue
    row.movements.sort((a, b) => new Date(a.date) - new Date(b.date))
  }

  return Array.from(rowsByItem.values()).sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name))
}
