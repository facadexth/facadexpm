// PO line / totals math. Moved verbatim from PurchaseOrders.jsx, which imports it from here.
// Mirrored server-side by receive_po_with_deposits and _po_goods_subtotal -- change all three together.
import { VAT_RATE } from './invoiceCalc.js'

export function poLineTotal(item) {
  const gross = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
  const discountPct = parseFloat(item.discount_pct) || 0
  return gross * (1 - discountPct / 100)
}

/** priceIncludesVat: the entered prices ARE the grand total; subtotal = total / 1.07. */
export function calcPoTotals(items, hasVat, priceIncludesVat) {
  const rawTotal = (items || []).reduce((s, it) => s + (it.line_total != null ? it.line_total : poLineTotal(it)), 0)
  if (!hasVat) return { subtotal: rawTotal, vat: 0, total: rawTotal }
  if (priceIncludesVat) {
    const total = Math.round(rawTotal * 100) / 100
    const subtotal = Math.round((total / (1 + VAT_RATE)) * 100) / 100
    const vat = Math.round((total - subtotal) * 100) / 100
    return { subtotal, vat, total }
  }
  const subtotal = rawTotal
  const vat = Math.round(subtotal * VAT_RATE * 100) / 100
  const total = Math.round((subtotal + vat) * 100) / 100
  return { subtotal, vat, total }
}
