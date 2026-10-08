// Supplier tax invoice form <-> RPC payload mapping (pure; the component only holds state).
// The RPCs do not validate shapes before use, so the payload is built exactly and never carries
// NaN / Infinity / '' as a number (those become null, or are stopped by validateFormForSave first).

import { lineBase } from './supplierTaxInvoice.js'
import { round2 } from './depositMath.js'
import { VAT_RATE } from './invoiceCalc.js'

let keySeq = 0
const nextKey = () => ++keySeq

const isBlank = v => v === '' || v == null
/** '' / null / non-finite -> null, otherwise the number. */
const num = v => {
  if (isBlank(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const emptyLine = () => ({ key: nextKey(), description: '', qty: '1', unit: '', unit_price: '', discount_pct: '0', inventory_item_id: '', site_id: '', base_qty: '', base_manual: false, base_stale: false })

export function emptyTaxInvoiceForm(today) {
  return { supplier_id: '', invoice_no: '', invoice_date: today, net_before_vat: '', vat: '', match_note: '', lines: [], po_ids: [], link_kind: 'po', receipt_ids: [] }
}

/** row = a full invoice row (useSupplierTaxInvoice), items and pos embedded.
 *  base_manual starts true for a saved base quantity (we cannot compute here); the form calls
 *  reconcileBaseManual() once the item/unit lookups are loaded. */
export function formFromInvoice(row) {
  const rl = (row.supplier_tax_invoice_receipts || []).filter(l => l.active)
  return {
    supplier_id: row.supplier_id, invoice_no: row.invoice_no, invoice_date: row.invoice_date,
    net_before_vat: String(row.net_before_vat ?? ''), vat: String(row.vat ?? ''), match_note: row.match_note || '',
    lines: [...(row.supplier_tax_invoice_items || [])].sort((a, b) => a.sort_order - b.sort_order).map(i => ({
      key: nextKey(), description: i.description, qty: String(i.qty), unit: i.unit || '', unit_price: String(i.unit_price),
      discount_pct: String(i.discount_pct ?? 0), inventory_item_id: i.inventory_item_id || '', site_id: i.site_id || '',
      base_qty: i.base_qty != null ? String(i.base_qty) : '', base_manual: i.base_qty != null, base_stale: false,
    })),
    po_ids: (row.supplier_tax_invoice_pos || []).filter(l => l.active).map(l => l.po_id),
    link_kind: rl.length ? 'delivery' : 'po', receipt_ids: rl.map(l => l.receipt_id),
  }
}

export function toRpcPayload(form) {
  return {
    header: {
      supplier_id: form.supplier_id, invoice_no: String(form.invoice_no || '').trim(), invoice_date: form.invoice_date,
      net_before_vat: num(form.net_before_vat), vat: num(form.vat) ?? 0, match_note: String(form.match_note || '').trim(),
    },
    items: (form.lines || []).map(l => {
      const stock = !!l.inventory_item_id
      return {
        description: String(l.description || '').trim(), qty: num(l.qty), unit: String(l.unit || '').trim(),
        unit_price: num(l.unit_price) ?? 0, discount_pct: num(l.discount_pct) ?? 0,
        inventory_item_id: stock ? l.inventory_item_id : null, site_id: stock ? (l.site_id || null) : null,
        base_qty: stock ? num(l.base_qty) : null,
      }
    }),
    poIds: [...(form.po_ids || [])],
    receiptIds: [...(form.receipt_ids || [])], linkKind: form.link_kind === 'delivery' ? 'delivery' : 'po',
  }
}

const badNumber = v => !isBlank(v) && num(v) === null

export function validateFormForSave(form) {
  const errs = []
  if (!form.supplier_id) errs.push('เลือกซัพพลายเออร์')
  if (!String(form.invoice_no || '').trim()) errs.push('กรอกเลขที่ใบกำกับ')
  if (!form.invoice_date) errs.push('กรอกวันที่ใบกำกับ')
  if (isBlank(form.net_before_vat) || num(form.net_before_vat) === null || !(num(form.net_before_vat) >= 0)) errs.push('กรอกยอดก่อน VAT')
  if (badNumber(form.vat) || (num(form.vat) ?? 0) < 0) errs.push('VAT ไม่ถูกต้อง')
  ;(form.lines || []).forEach((l, i) => {
    const n = i + 1
    if (!String(l.description || '').trim() || !(num(l.qty) > 0)) errs.push(`รายการที่ ${n}: กรอกรายละเอียดและจำนวนมากกว่า 0`)
    else if (badNumber(l.unit_price) || (num(l.unit_price) ?? 0) < 0 || badNumber(l.discount_pct) || (num(l.discount_pct) ?? 0) < 0 || (num(l.discount_pct) ?? 0) > 100) {
      errs.push(`รายการที่ ${n}: ราคาหรือส่วนลดไม่ถูกต้อง`)
    } else if (l.inventory_item_id && (!l.site_id || !(num(l.base_qty) > 0))) errs.push(`รายการที่ ${n}: เลือกไซท์งาน และกรอกจำนวนในหน่วยหลัก`)
  })
  return errs
}

/** The PO rows, but only when they were fetched for `supplierId` (useReceivedPosForSupplier tags its data).
 *  null = not loaded yet / stale data from a previous supplier / no supplier. */
export function poRowsFor(result, supplierId) {
  if (!supplierId || !result || result.supplierId !== supplierId) return null
  return result.rows || []
}

/** VAT text for a net amount ('' when the net is blank or not a finite number). */
export function computeAutoVat(net) {
  if (net === '' || net == null) return ''
  const n = Number(net)
  return Number.isFinite(n) && n >= 0 ? String(round2(n * VAT_RATE)) : ''
}

/** Recompute a line after a change. `lookups` = { itemById: Map, unitFactors: [], commonSite }.
 *  - changing the stock item always drops a typed base quantity (base_manual false) and recomputes;
 *  - a typed (manual) base is kept when qty/unit change, but flagged base_stale so the UI says so. */
export function applyLineChange(line, patch, { itemById, unitFactors, commonSite } = {}) {
  const next = { ...line, ...patch }
  if (!next.inventory_item_id) return { ...next, site_id: '', base_qty: '', base_manual: false, base_stale: false }
  const itemChanged = 'inventory_item_id' in patch && patch.inventory_item_id !== line.inventory_item_id
  if (itemChanged) { next.base_manual = false; next.base_stale = false }
  if (!next.site_id && commonSite) next.site_id = commonSite
  if (!next.base_manual) {
    const factor = (unitFactors || []).find(f => f.inventory_item_id === next.inventory_item_id && f.unit_name === next.unit) || null
    const r = lineBase(next, itemById?.get(next.inventory_item_id), factor)
    next.base_qty = r.unconverted || r.baseQty == null ? '' : String(r.baseQty)
    next.base_stale = false
  } else if (('qty' in patch && patch.qty !== line.qty) || ('unit' in patch && patch.unit !== line.unit)) {
    next.base_stale = true
  }
  return next
}

/** After loading a saved invoice: a stored base quantity only counts as "typed by hand" when it differs from
 *  what the conversion gives now (otherwise later qty/unit edits recompute it as usual). */
export function reconcileBaseManual(lines, { itemById, unitFactors } = {}) {
  return (lines || []).map(l => {
    if (!l.inventory_item_id || !l.base_manual) return l
    const item = itemById?.get(l.inventory_item_id)
    if (!item) return l
    const factor = (unitFactors || []).find(f => f.inventory_item_id === l.inventory_item_id && f.unit_name === l.unit) || null
    const r = lineBase(l, item, factor)
    const auto = !r.unconverted && r.baseQty != null && Math.abs(r.baseQty - Number(l.base_qty)) < 1e-9
    return auto ? { ...l, base_manual: false } : l
  })
}

/** po_ids that are not among the loaded POs (edited/cancelled meanwhile): must be shown, never dropped silently. */
export function missingPoIds(poIds, poRows) {
  if (!poRows) return []
  const have = new Set(poRows.map(p => p.id))
  return (poIds || []).filter(id => !have.has(id))
}

/** receipt_ids not among the loaded receipts (must be shown, never dropped silently). */
export function missingReceiptIds(ids, rows) {
  if (!rows) return []
  const have = new Set(rows.map(r => r.id))
  return (ids || []).filter(id => !have.has(id))
}
