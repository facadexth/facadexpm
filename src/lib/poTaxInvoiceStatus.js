// Pure helpers for how the PO page shows / respects supplier tax invoice links.
// links: Map<po_id,{invoice_id, invoice_no, status}> from useActiveTaxInvoiceLinks(), or null (not ready / migrations not applied).

import { mapTaxInvoiceRpcError } from './supplierTaxInvoice.js'

export function poTaxInvoiceBadge(po, links) {
  if (!links || !po) return { kind: null, text: '' }
  const l = links.get(po.id)
  if (l) return { kind: 'linked', text: `ใบกำกับ ${l.invoice_no}${l.status === 'draft' ? ' (ร่าง)' : ''}` }
  if (po.status === 'received' && po.stock_from_invoice && po.tax_invoice_mode !== 'delivery') return { kind: 'awaiting', text: 'รอใบกำกับ (สต็อกยังไม่เข้า)' }
  return { kind: null, text: '' }
}

/** Only send stock_from_invoice when it is safe: ticked on a new PO, or the column is known on the edited row. */
export function buildPoPayloadFlag(form, editRow) {
  if (editRow && Object.prototype.hasOwnProperty.call(editRow, 'stock_from_invoice')) return { stock_from_invoice: !!form.stock_from_invoice }
  if (!editRow && form.stock_from_invoice) return { stock_from_invoice: true }
  return {}
}

/** Explanation when a PO linked to an active tax invoice must not be edited (the PO edit is not atomic), else ''. */
export function poEditLockedText(po, links) {
  const l = links && po ? links.get(po.id) : null
  if (!l) return ''
  return `ใบสั่งซื้อนี้ผูกกับใบกำกับภาษี ${l.invoice_no} แก้ไขไม่ได้`
}

/** Thai text for the tax-invoice related errors the PO page can hit (PO/stock triggers, deadlock with a posting invoice),
 *  or null for any other error so the caller keeps its existing raw message. */
export function poTaxInvoiceErrorText(err) {
  const msg = String(err?.message || err?.details || err || '')
  if (err?.code === '40P01' || /deadlock detected/i.test(msg) || msg.includes('po_tax_invoiced') || msg.includes('po_stock_flag_locked')) return mapTaxInvoiceRpcError(err)
  return null
}
