// ============================================================
// Supplier credit note math -- pure, mirrored by the SQL RPCs
// (supabase/migrations/2026-10-06-02-credit-note-rpcs.sql) only for
// the expense status mapping; totals are computed client-side and
// stored on the credit note row, the RPC trusts them.
// ============================================================

export const SETTLEMENT_LABELS = {
  owed: 'รอรับคืน',
  offset: 'หักกับยอดจ่ายครั้งหน้า',
  refunded: 'รับคืนแล้ว',
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function computeCreditNoteTotals(lines, { vatEnabled = true, vatRate = 0.07, priceIncludesVat = false } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0))
  if (!vatEnabled) return { amount_no_vat: subtotal, vat: 0, amount: subtotal }
  if (priceIncludesVat) {
    const net = round2(subtotal / (1 + vatRate))
    return { amount_no_vat: net, vat: round2(subtotal - net), amount: subtotal }
  }
  const vat = round2(subtotal * vatRate)
  return { amount_no_vat: subtotal, vat, amount: round2(subtotal + vat) }
}

export function findStockShortfalls(lines, onHandByItemId) {
  const requested = {}
  for (const l of lines) {
    if (!l.inventory_item_id) continue
    requested[l.inventory_item_id] = (requested[l.inventory_item_id] || 0) + num(l.quantity)
  }
  return Object.entries(requested)
    .map(([id, req]) => ({ inventory_item_id: id, requested: req, onHand: num(onHandByItemId[id]) }))
    .filter(r => r.requested > r.onHand)
}

export function expenseStatusForSettlement(settlement) {
  return settlement === 'owed' ? 'pending' : 'paid'
}

/** Rebuild the VAT flags of a stored note (they are not persisted). */
export function inferVatFlags(note) {
  const vatEnabled = Number(note.vat) > 0
  const subtotal = (note.supplier_credit_note_items || note.items || [])
    .reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0)
  const priceIncludesVat = vatEnabled && Math.abs(subtotal - Number(note.amount)) < 0.01
  return { vatEnabled, priceIncludesVat }
}
