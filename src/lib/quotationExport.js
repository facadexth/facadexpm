// src/lib/quotationExport.js
// Plans an export of an estimation price structure into the standard quotation tables. Pure: no I/O.
import { buildItemDescription } from './descriptionFormat'

const num = v => Number(v) || 0

// rows: priceProject rows (id = opening id). items: [{ id, opening_no, item_name? }].
// Returns { lines, skipped }. Only resolved rows are exported.
export function buildLines({ rows, items, descriptionCtxById, descriptionFormat, split }) {
  const byId = new Map((items || []).map(i => [i.id, i]))
  const lines = []
  const skipped = []
  ;(rows || []).forEach((r, index) => {
    const it = byId.get(r.id) || {}
    if (!r.resolved || r.price == null) { skipped.push({ openingId: r.id, opening_no: it.opening_no ?? null }); return }
    const ctx = (descriptionCtxById || {})[r.id] || {}
    const name = it.item_name ?? ctx.item_name ?? ''
    const title = `${it.opening_no ?? ''} ${name}`.trim() || `รายการ ${index + 1}`
    const price = num(r.price)
    const quantity = num(r.quantity)
    let material = null, labour = null
    if (split && split.enabled) {
      material = Math.round(price * num(split.materialPct) / 100)
      labour = price - material
    }
    lines.push({
      openingId: r.id,
      item: { description: title, unit: 'ชุด', quantity, unit_price: price, unit_price_material: material, unit_price_labor: labour, line_total: price * quantity, item_type: 'item' },
      desc: { description: buildItemDescription(ctx, descriptionFormat), unit: null, quantity: 0, unit_price: 0, unit_price_material: null, unit_price_labor: null, line_total: 0, item_type: 'item_description' },
    })
  })
  return { lines, skipped }
}

export const revisionLabel = (revision, subNo) => `R${revision}-${subNo}`

export function nextSubNo(snapshots, quotationId, revision) {
  let max = 0
  for (const s of snapshots || []) {
    if (s.kind === 'sent' && s.quotation_id === quotationId && s.revision === revision) max = Math.max(max, s.sub_no || 0)
  }
  return max + 1
}

// Sort rule: generated pairs take sort_order 0.. in the project's item order (item row, then description row);
// pairs kept because an invoice references them follow; user-added rows come last in their existing relative order.
// existingRowIds: Set of quotation_items ids that still exist. invoiceRefs: Set of ids referenced by invoice_items.
export function planPush({ quotation, link, existingLines = [], newLines = [], existingRowIds = new Set(), invoiceRefs = new Set(), userRows = [], snapshots = [] }) {
  let action, bumpRevision = false, newRevision, setStatus = null, needsAcceptedConfirm = false, statusWarning = false
  if (!quotation) { action = 'create'; newRevision = 1 }
  else {
    const rev = quotation.revision || 1
    if (quotation.status === 'draft') { action = 'overwrite'; newRevision = rev }
    else {
      action = 'pullback_overwrite'; bumpRevision = true; newRevision = rev + 1; setStatus = 'draft'
      needsAcceptedConfirm = quotation.status === 'accepted'
      statusWarning = quotation.status === 'rejected' || quotation.status === 'expired'
    }
  }
  const subNo = quotation ? nextSubNo(snapshots, quotation.id, newRevision) : 1

  const existingBy = new Map(existingLines.map(e => [e.openingId, e]))
  const newIds = new Set(newLines.map(l => l.openingId))
  const updates = [], inserts = [], deletes = [], keeps = []
  let order = 0
  for (const l of newLines) {
    const e = existingBy.get(l.openingId) || {}
    for (const [kind, idKey, values] of [['item', 'itemRowId', l.item], ['desc', 'descRowId', l.desc]]) {
      const id = e[idKey]
      const sort_order = order++
      if (id && existingRowIds.has(id)) updates.push({ id, openingId: l.openingId, kind, values, sort_order })
      else inserts.push({ openingId: l.openingId, kind, values, sort_order })
    }
  }
  for (const e of existingLines) {
    if (newIds.has(e.openingId)) continue
    const live = [e.itemRowId, e.descRowId].filter(id => id && existingRowIds.has(id))
    if (!live.length) continue
    if (live.some(id => invoiceRefs.has(id))) {
      keeps.push({ openingId: e.openingId, itemRowId: e.itemRowId, descRowId: e.descRowId, rowIds: live, reason: 'มีใบแจ้งหนี้อ้างอิงรายการนี้ จึงเก็บไว้ในใบเสนอราคา', sort_order: order })
      live.forEach(() => { order++ })
    } else live.forEach(id => deletes.push({ id, openingId: e.openingId }))
  }
  const userRowOrder = []
  for (const u of [...userRows].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const sort_order = order++
    if (u.sort_order !== sort_order) userRowOrder.push({ id: u.id, sort_order })
  }
  return { action, bumpRevision, newRevision, setStatus, needsAcceptedConfirm, statusWarning, subNo, updates, inserts, deletes, keeps, userRowOrder }
}

// The exact quotation_revisions.snapshot shape written by Quotations.jsx handleSave.
export function snapshotFor(q, items) {
  return {
    client_id: q.client_id, client_name: q.clients?.name || null,
    date: q.date, valid_until: q.valid_until,
    has_vat: q.has_vat, price_includes_vat: q.price_includes_vat,
    discount_amount: q.discount_amount, discount_pct: q.discount_pct,
    pricing_mode: q.pricing_mode || 'combined',
    payment_terms: q.payment_terms, notes: q.notes,
    bank_account: q.bank_accounts || null,
    items: (items || []).map(it => ({
      description: it.description, unit: it.unit, quantity: it.quantity, unit_price: it.unit_price,
      unit_price_material: it.unit_price_material, unit_price_labor: it.unit_price_labor, line_total: it.line_total,
    })),
  }
}
