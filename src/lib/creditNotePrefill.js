import { round2 } from './creditNoteCalc.js'

let pending = null
export const setCreditNotePrefill = p => { pending = p }
// Idempotent read (safe under React StrictMode double-invoke); clear after mount.
export const peekCreditNotePrefill = () => pending
export const clearCreditNotePrefill = () => { pending = null }

// PO line -> credit-note line; unit_price is what was actually paid (after discount).
// `conv` (optional) = { baseQty, baseUnit } from computePoItemBaseQty for a stock line:
// stock is deducted in the inventory item's base unit, so the line is expressed in it
// (money total unchanged: unit_price = line total / baseQty).
export function poItemToCreditLine(item, conv = null) {
  const qty = Number(item.quantity)
  const lineTotal = item.line_total == null || item.line_total === '' ? NaN : Number(item.line_total)
  const total = Number.isFinite(lineTotal) ? lineTotal
    : qty * Number(item.unit_price || 0) * (1 - (Number(item.discount_pct) || 0) / 100)
  const baseQty = conv ? Number(conv.baseQty) : NaN
  if (conv && baseQty > 0) {
    return {
      inventory_item_id: item.inventory_item_id, description: item.description,
      quantity: baseQty, unit: conv.baseUnit || item.unit, unit_price: total / baseQty, // unrounded: column is plain NUMERIC, so qty x price == line total
    }
  }
  let unit_price
  if (Number.isFinite(lineTotal) && qty > 0) unit_price = round2(lineTotal / qty)
  else unit_price = round2(Number(item.unit_price || 0) * (1 - (Number(item.discount_pct) || 0) / 100))
  return {
    inventory_item_id: item.inventory_item_id, description: item.description,
    quantity: item.quantity, unit: item.unit, unit_price,
  }
}
