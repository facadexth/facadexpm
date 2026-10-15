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
    } else if (l.inventory_item_id) {
      // The site is never typed: it comes from the selected purchase orders (buildSiteLookup).
      if (!l.site_id) errs.push(`รายการที่ ${n}: เลือกใบสั่งซื้อหรือการรับของก่อน (ไซท์ของสต็อกมาจากใบสั่งซื้อ)`)
      if (!(num(l.base_qty) > 0)) errs.push(`รายการที่ ${n}: กรอกจำนวนในหน่วยหลัก`)
    }
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

/** Which site a stock line belongs to, from the purchase orders the invoice is matched to (the form has no
 *  site field, owner decision 2026-10-15): the site of the one PO that ordered the item; when the item is on
 *  POs of different sites or on none of them, the site of the first selected PO.
 *  `pos` = [{ site_id, purchase_order_items: [{ inventory_item_id }] }] in selection order. */
export function buildSiteLookup(pos) {
  const sitesByItem = new Map()
  for (const po of pos || []) {
    for (const it of po?.purchase_order_items || []) {
      if (!it?.inventory_item_id) continue
      if (!sitesByItem.has(it.inventory_item_id)) sitesByItem.set(it.inventory_item_id, new Set())
      sitesByItem.get(it.inventory_item_id).add(po.site_id || '')
    }
  }
  const siteByItem = new Map()
  for (const [item, sites] of sitesByItem) if (sites.size === 1) siteByItem.set(item, [...sites][0])
  return { siteByItem, fallbackSite: (pos || [])[0]?.site_id || '' }
}

/** Receipts (delivery-kind invoice) seen as POs for buildSiteLookup: the receipt's PO site and the items it received. */
export function posFromReceipts(receipts) {
  return (receipts || []).map(r => ({
    site_id: r?.purchase_orders?.site_id || '',
    purchase_order_items: (r?.po_receipt_items || []).map(ri => ri?.purchase_order_items).filter(Boolean),
  }))
}

export function deriveLineSite(inventoryItemId, lookup) {
  if (!inventoryItemId || !lookup) return ''
  return lookup.siteByItem?.get(inventoryItemId) || lookup.fallbackSite || ''
}

/** Re-derive the site of every stock line from the current selection. Returns the same array (and the same
 *  line objects) when nothing changes, so a state update can be skipped. No selection = nothing touched. */
export function applySitesToLines(lines, lookup) {
  if (!lookup || !lookup.fallbackSite) return lines
  let changed = false
  const out = lines.map(l => {
    if (!l.inventory_item_id) return l
    const site = deriveLineSite(l.inventory_item_id, lookup)
    if (!site || site === l.site_id) return l
    changed = true
    return { ...l, site_id: site }
  })
  return changed ? out : lines
}

/** Recompute a line after a change. `lookups` = { itemById: Map, unitFactors: [], siteLookup (buildSiteLookup) }.
 *  - the site is derived from the selected POs (deriveLineSite); without a selection a stored site is kept;
 *  - changing the stock item always drops a typed base quantity (base_manual false) and recomputes;
 *  - a typed (manual) base is kept when qty/unit change, but flagged base_stale so the UI says so. */
export function applyLineChange(line, patch, { itemById, unitFactors, siteLookup, commonSite } = {}) {
  const next = { ...line, ...patch }
  if (!next.inventory_item_id) return { ...next, site_id: '', base_qty: '', base_manual: false, base_stale: false }
  const itemChanged = 'inventory_item_id' in patch && patch.inventory_item_id !== line.inventory_item_id
  if (itemChanged) { next.base_manual = false; next.base_stale = false }
  const derived = deriveLineSite(next.inventory_item_id, siteLookup) || commonSite || ''
  if (derived) next.site_id = derived
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

/** The form as emitted to save / preview: only the selected kind's ids (an initial form may carry both). */
export function normalizeLinkKind(form) {
  return form.link_kind === 'delivery' ? { ...form, link_kind: 'delivery', po_ids: [] } : { ...form, link_kind: 'po', receipt_ids: [] }
}
