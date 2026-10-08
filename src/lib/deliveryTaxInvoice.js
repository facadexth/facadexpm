// ============================================================
// Supplier tax invoice per delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ) -- pure logic.
// Mirrors supabase/migrations/2026-10-09-05 (_sti_check_delivery match rule; save_supplier_tax_invoice_receipt_draft
// eligibility). The RPCs are the authority; this is preview / UI only.
// Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md
// ============================================================
import { round2 } from './depositMath.js'
import { matchTolerance, withinTolerance } from './supplierTaxInvoice.js'
import { emptyLine } from './taxInvoiceForm.js'
import { exVatUnitPrice } from './poDocumentExtraction.js'
import { PO_MODE_LOCKED_TEXT, PO_DELIVERY_DISCOUNT_SAVE_TEXT } from './deliveryTaxInvoiceText.js'

const finite = v => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v))
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)
const mode = v => (v === 'delivery' ? 'delivery' : 'po')

export const receiptLabel = (poNumber, seq) => `${poNumber || '?'}-R${seq}`

/** Invoice net vs Σ goods_subtotal; if that fails, invoice total vs Σ(goods_subtotal + goods_vat). Same tolerance as today. */
export function evaluateDeliveryMatch({ netBeforeVat, grandTotal, receipts, lineAmounts }) {
  const rs = receipts || []
  const valid = rs.length > 0 && finite(netBeforeVat) && finite(grandTotal) && (lineAmounts || []).every(finite)
    && rs.every(r => finite(r.goods_subtotal) && finite(r.goods_vat ?? 0))
  if (!valid) {
    return { invalid: true, sum: NaN, sumIncl: NaN, diffExcl: NaN, diffIncl: NaN, basis: 'none', diff: NaN, tolerance: NaN, matchOk: false, linesSum: NaN, linesOk: false }
  }
  const net = round2(Number(netBeforeVat)), total = round2(Number(grandTotal))
  const sum = round2(rs.reduce((s, r) => s + Number(r.goods_subtotal), 0))
  const sumIncl = round2(rs.reduce((s, r) => s + Number(r.goods_subtotal) + Number(r.goods_vat || 0), 0))
  const diffExcl = round2(net - sum), diffIncl = round2(total - sumIncl)
  const linesSum = round2((lineAmounts || []).reduce((s, x) => s + Number(x), 0))
  let basis = 'none', diff = diffExcl, tolerance = matchTolerance(sum)
  if (withinTolerance(diffExcl, sum)) basis = 'excl'
  else if (withinTolerance(diffIncl, sumIncl)) { basis = 'incl'; diff = diffIncl; tolerance = matchTolerance(sumIncl) }
  return { invalid: false, sum, sumIncl, diffExcl, diffIncl, basis, diff, tolerance, matchOk: basis !== 'none', linesSum, linesOk: withinTolerance(round2(linesSum - net), net) }
}

/** Running total of the ticked receipts for the picker: count, Σ goods_subtotal, Σ (goods_subtotal + goods_vat). */
export function receiptSelectionTotals(receipts) {
  const rs = receipts || []
  return {
    count: rs.length,
    sum: round2(rs.reduce((s, r) => s + (Number(r.goods_subtotal) || 0), 0)),
    sumIncl: round2(rs.reduce((s, r) => s + (Number(r.goods_subtotal) || 0) + (Number(r.goods_vat) || 0), 0)),
  }
}

/** Map<receipt_id, {invoice_id, invoice_no, status}> from active supplier_tax_invoice_receipts rows. */
export function buildActiveReceiptLinkMap(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (r.active === false) continue
    m.set(r.receipt_id, { invoice_id: r.invoice_id, invoice_no: r.supplier_tax_invoices?.invoice_no || '', status: r.supplier_tax_invoices?.status || '' })
  }
  return m
}

export function receiptEligibility(receipt, { supplierId, links, invoiceId } = {}) {
  const p = receipt?.purchase_orders
  if (!p || p.supplier_id !== supplierId) return 'wrong_supplier'
  if (p.tax_invoice_mode !== 'delivery') return 'not_delivery'
  const l = links?.get?.(receipt.id)
  if (l && l.invoice_id !== invoiceId) return 'linked_elsewhere'
  return 'ok'
}

const byOldest = (a, b) => String(a.received_date || '').localeCompare(String(b.received_date || ''))
  || String(a.purchase_orders?.po_number || '').localeCompare(String(b.purchase_orders?.po_number || ''))
  || (Number(a.seq) || 0) - (Number(b.seq) || 0)

export function receiptPickerRows({ receipts, supplierId, links, invoiceId }) {
  const sorted = [...(receipts || [])].sort(byOldest)
  const opts = { supplierId, links, invoiceId }
  return {
    available: sorted.filter(r => receiptEligibility(r, opts) === 'ok'),
    linkedElsewhere: sorted.filter(r => receiptEligibility(r, opts) === 'linked_elsewhere').map(r => ({ receipt: r, link: links.get(r.id) })),
  }
}

/** "รอใบกำกับ": a delivery PO's receipt with NO active link (a draft link counts as linked). null until both are loaded. */
export function receiptsAwaitingInvoice(receipts, links) {
  if (!receipts || !links) return null
  const groups = new Map()
  for (const r of [...receipts].sort(byOldest)) {
    if (r.purchase_orders?.tax_invoice_mode !== 'delivery' || links.has(r.id)) continue
    const k = r.purchase_orders.supplier_id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  return [...groups.entries()].map(([supplierId, rows]) => ({ supplierId, rows }))
    .sort((a, b) => byOldest(a.rows[0], b.rows[0]))
}

export function receiptTaxInvoiceStatus(receiptId, links) {
  if (!links) return { kind: null, text: '' }
  const l = links.get(receiptId)
  if (l) return { kind: 'linked', text: `ใบกำกับ ${l.invoice_no}${l.status === 'draft' ? ' (ร่าง)' : ''}`, invoiceId: l.invoice_id }
  return { kind: 'awaiting', text: 'รอใบกำกับ' }
}

export const defaultTaxInvoiceMode = supplier => mode(supplier?.default_tax_invoice_mode)

/** PO form: the mode after a supplier pick / readiness change. A hand-picked mode (form.tax_invoice_mode_touched, kept in
 *  the form state so it survives the useDraftForm restore) always wins; a supplier not in the list yet (just created
 *  inline) has the column default 'po'. */
export const poModeForSupplier = (form, supplier) => (form?.tax_invoice_mode_touched ? mode(form.tax_invoice_mode) : defaultTaxInvoiceMode(supplier))

/** '' or the save-time warning for a delivery PO with a discount (negative) line: such a PO cannot be received lot by lot. */
export function poDeliveryDiscountWarning(form, lineTotalOf) {
  if (mode(form?.tax_invoice_mode) !== 'delivery') return ''
  return (form.items || []).some(it => String(it.description || '').trim() && Number(lineTotalOf(it)) < 0) ? PO_DELIVERY_DISCOUNT_SAVE_TEXT : ''
}

/** The tax-invoice form's PO-kind selection minus delivery-mode POs (stale drafts): { keep, delivery } id lists. */
export function splitDeliveryPoIds(poIds, poRows) {
  const byId = new Map((poRows || []).map(p => [p.id, p]))
  const delivery = (poIds || []).filter(id => byId.get(id)?.tax_invoice_mode === 'delivery')
  return { keep: (poIds || []).filter(id => !delivery.includes(id)), delivery }
}

/** Only send the column when it exists: on an edited row that carries it, or on a new row once the migration is live. */
export function poModePayload(form, editRow, ready) {
  if (editRow) return has(editRow, 'tax_invoice_mode') ? { tax_invoice_mode: mode(form?.tax_invoice_mode) } : {}
  return ready === true ? { tax_invoice_mode: mode(form?.tax_invoice_mode) } : {}
}
export function supplierModePayload(form, editItem, ready) {
  if (editItem) return has(editItem, 'default_tax_invoice_mode') ? { default_tax_invoice_mode: mode(form?.default_tax_invoice_mode) } : {}
  return ready === true ? { default_tax_invoice_mode: mode(form?.default_tax_invoice_mode) } : {}
}

/** Mirror of po_tax_invoice_mode_guard: changeable only while draft/ordered, no receipt, no active PO-level link. */
export function poModeLockedText(po, moneyIndex, poLinks) {
  if (!po || !['draft', 'ordered'].includes(po.status)) return PO_MODE_LOCKED_TEXT
  if ((moneyIndex?.get?.(po.id)?.receiptIds?.size || 0) > 0) return PO_MODE_LOCKED_TEXT
  if (poLinks?.get?.(po.id)) return PO_MODE_LOCKED_TEXT
  return ''
}

export function deliveryPoBadge(po, moneyIndex, receiptLinks) {
  if (!po || po.tax_invoice_mode !== 'delivery' || !moneyIndex || !receiptLinks) return { kind: null, text: '' }
  const ids = [...(moneyIndex.get(po.id)?.receiptIds || [])]
  const awaiting = ids.filter(id => !receiptLinks.has(id)).length
  if (awaiting > 0) return { kind: 'awaiting', text: `รอใบกำกับ ${awaiting} ล็อต` }
  if (ids.length > 0) return { kind: 'linked', text: `ใบกำกับครบ ${ids.length} ล็อต` }
  return { kind: 'delivery', text: 'ใบกำกับต่อการส่งของ' }
}

/** New tax-invoice form for one receipt: lines from the PO lines received (ex-VAT prices), net/VAT from the receipt. */
export function formForReceipt(receipt, today) {
  const p = receipt?.purchase_orders || {}
  const incl = !!(p.has_vat && p.price_includes_vat)
  const lines = (receipt?.po_receipt_items || []).map(ri => {
    const it = ri.purchase_order_items || {}
    const stock = !!it.inventory_item_id
    const hasBase = stock && ri.base_qty != null && Number(ri.base_qty) > 0
    return {
      ...emptyLine(),
      description: it.description || '', qty: String(ri.quantity ?? it.quantity ?? ''), unit: it.unit || '',
      unit_price: String(exVatUnitPrice(Number(it.unit_price) || 0, incl)), discount_pct: String(it.discount_pct ?? 0),
      inventory_item_id: stock ? it.inventory_item_id : '', site_id: stock ? (p.site_id || '') : '',
      base_qty: hasBase ? String(ri.base_qty) : '', base_manual: hasBase, base_stale: false,
    }
  })
  return {
    supplier_id: p.supplier_id || '', invoice_no: '', invoice_date: receipt?.received_date || today,
    net_before_vat: receipt?.goods_subtotal != null ? String(receipt.goods_subtotal) : '',
    vat: receipt?.goods_vat != null ? String(receipt.goods_vat) : '',
    match_note: '', lines, po_ids: [], link_kind: 'delivery', receipt_ids: receipt?.id ? [receipt.id] : [],
  }
}

const pickLinks = (row, list) => (row?.status === 'void' ? list || [] : (list || []).filter(l => l.active))
export const linkKindOf = row => ((row?.supplier_tax_invoice_receipts || []).length ? 'delivery' : 'po')

/** Base the list page compares match_diff with: Σ receipt goods (+VAT when matched on the inclusive basis), else Σ PO subtotals. */
export function invoiceMatchBase(row) {
  const rl = pickLinks(row, row?.supplier_tax_invoice_receipts)
  if (rl.length) {
    const incl = (row.post_result?.checks || []).some(c => c.code === 'match_vat_inclusive')
    return round2(rl.reduce((s, l) => s + (Number(l.goods_subtotal) || 0) + (incl ? Number(l.goods_vat) || 0 : 0), 0))
  }
  return pickLinks(row, row?.supplier_tax_invoice_pos).reduce((s, l) => s + (Number(l.po_subtotal) || 0), 0)
}

/** Navigation state for 'supplier_tax_invoices' that opens a new invoice for one receipt (consumed by the invoice page). */
export function invoiceHandoff(po, receiptId) {
  if (!po || !receiptId) return null
  return { newForReceipt: { receiptId, poId: po.id, supplierId: po.supplier_id } }
}
