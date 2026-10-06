// Pure helpers for the "credit note referenced from a PO" flow.
// selection = { [poItemId]: { checked: boolean, qty: string|number } }  (qty in the PO unit)
// lookups   = { inventoryItems: [], aluminumProfiles: [], unitFactors: [] }
import { poItemToCreditLine } from './creditNotePrefill.js'
import { computePoItemBaseQty } from './inventoryCost.js'
import { round2 } from './creditNoteCalc.js'

export const poItemTotal = it => {
  const qty = Number(it.quantity)
  const lt = it.line_total == null || it.line_total === '' ? NaN : Number(it.line_total)
  if (Number.isFinite(lt)) return lt
  return qty * Number(it.unit_price || 0) * (1 - (Number(it.discount_pct) || 0) / 100)
}

/** Unit price after the item's discount, in the PO unit. */
export function poItemNetUnitPrice(it) {
  const qty = Number(it.quantity)
  return qty > 0 ? round2(poItemTotal(it) / qty) : round2(Number(it.unit_price || 0) * (1 - (Number(it.discount_pct) || 0) / 100))
}

function convFor(item, lookups) {
  if (!item.inventory_item_id) return null
  const invItem = (lookups?.inventoryItems || []).find(i => i.id === item.inventory_item_id)
  if (!invItem) return null
  const profile = item.aluminum_profile_id ? (lookups?.aluminumProfiles || []).find(p => p.id === item.aluminum_profile_id) : null
  const factor = (lookups?.unitFactors || []).find(f => f.inventory_item_id === item.inventory_item_id && f.unit_name === item.unit)
  return { ...computePoItemBaseQty(item, invItem, profile, factor), baseUnit: invItem.base_unit }
}

/** true when a stock line cannot be converted to the base unit (aluminium w/o profile, glass w/o size, unknown item). Record-only lines (no inventory item) are fine. */
export function poItemBlocked(it, lookups) {
  if (!it.inventory_item_id) return false
  const c = convFor(it, lookups)
  return !c || c.unconverted === true
}

/** Credit line for one PO item at a returned quantity (PO unit). */
export function creditLineForPoItem(it, returnQty, lookups) {
  const q = Number(returnQty)
  const full = Number(it.quantity)
  const total = q === full ? poItemTotal(it) : (full > 0 ? poItemTotal(it) / full : 0) * q
  const scaled = { ...it, quantity: q, line_total: total }
  return poItemToCreditLine(scaled, convFor(scaled, lookups))
}

export function defaultSelection(po, checked = false, lookups = null) {
  return Object.fromEntries((po?.purchase_order_items || []).map(it => [it.id, { checked: checked && !(lookups && poItemBlocked(it, lookups)), qty: String(it.quantity) }]))
}

/** Ticked rows -> credit lines (base units for stock lines). Invalid rows are skipped. */
export function buildCreditLinesFromPo(po, selection, lookups) {
  const lines = []
  for (const it of po?.purchase_order_items || []) {
    const s = selection?.[it.id]
    if (!s?.checked) continue
    if (poItemBlocked(it, lookups)) continue
    const q = Number(s.qty)
    if (!(q > 0) || q > Number(it.quantity)) continue
    lines.push({ ...creditLineForPoItem(it, q, lookups), po_item_id: it.id })
  }
  return lines
}

/** Errors for ticked rows whose returned qty is not 0 < qty <= ordered. */
export function validateReturnQty(selection, po, lookups = null) {
  const errors = []
  for (const it of po?.purchase_order_items || []) {
    const s = selection?.[it.id]
    if (!s?.checked) continue
    if (lookups && poItemBlocked(it, lookups)) { errors.push({ itemId: it.id, description: it.description, reason: 'unconvertible' }); continue }
    const q = Number(s.qty)
    if (!(q > 0)) errors.push({ itemId: it.id, description: it.description, reason: 'not_positive' })
    else if (q > Number(it.quantity)) errors.push({ itemId: it.id, description: it.description, reason: 'above_ordered' })
  }
  return errors
}

/**
 * Rebuild a selection from a saved draft's lines (stored in base units for stock lines).
 * Returns null if any saved line can't be matched to a PO item (-> caller falls back to manual).
 */
export function selectionFromSavedLines(po, savedLines, lookups) {
  const sel = defaultSelection(po, false, lookups)
  const used = new Set()
  for (const l of savedLines) {
    const it = (po?.purchase_order_items || []).find(x => !used.has(x.id)
      && (x.inventory_item_id || null) === (l.inventory_item_id || null)
      && (x.description || '') === (l.description || ''))
    if (!it) return null
    used.add(it.id)
    const fullLine = creditLineForPoItem(it, Number(it.quantity), lookups)
    const ratio = Number(fullLine.quantity) > 0 ? Number(l.quantity) / Number(fullLine.quantity) : 0
    const qty = Math.round(Number(it.quantity) * ratio * 10000) / 10000
    sel[it.id] = { checked: !poItemBlocked(it, lookups), qty: String(qty) }
  }
  return sel
}

const fmtN = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })
const fmtM = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Data for the confirm warning dialog (rendered by the page). */
export function describeCreditNoteConfirm({ docNumber, siteName, lines, amount, docDate, expenseDate, shortfalls = [], itemNameById = {} }) {
  const month = (expenseDate || docDate || '').slice(0, 7)
  const stock = (lines || []).filter(l => l.inventory_item_id)
    .map(l => ({ name: itemNameById[l.inventory_item_id] || l.description, qty: Number(l.quantity), unit: l.unit || '' }))
  return {
    docNumber, siteName, stock, amountText: fmtM(amount), month,
    stockTexts: stock.map(s => `${s.name} × ${fmtN(s.qty)} ${s.unit}`.trim()),
    shortTexts: shortfalls.map(s => `${itemNameById[s.inventory_item_id] || s.inventory_item_id}: ต้องการคืน ${fmtN(s.requested)} แต่คงเหลือ ${fmtN(s.onHand)}`),
  }
}
