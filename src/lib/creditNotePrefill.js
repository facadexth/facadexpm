import { round2 } from './creditNoteCalc.js'

let pending = null
export const setCreditNotePrefill = p => { pending = p }
// Idempotent read (safe under React StrictMode double-invoke); clear after mount.
export const peekCreditNotePrefill = () => pending
export const clearCreditNotePrefill = () => { pending = null }

// PO line -> credit-note line; unit_price is what was actually paid (after discount).
export function poItemToCreditLine(item) {
  const qty = Number(item.quantity)
  const lineTotal = item.line_total == null || item.line_total === '' ? NaN : Number(item.line_total)
  let unit_price
  if (Number.isFinite(lineTotal) && qty > 0) unit_price = round2(lineTotal / qty)
  else unit_price = round2(Number(item.unit_price || 0) * (1 - (Number(item.discount_pct) || 0) / 100))
  return {
    inventory_item_id: item.inventory_item_id, description: item.description,
    quantity: item.quantity, unit: item.unit, unit_price,
  }
}
