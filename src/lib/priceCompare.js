// src/lib/priceCompare.js
// Compares the offer (last 'sent' snapshot) with the prices agreed in the quotation. Pure: no I/O.
// Cost base comes from the snapshot only (never live costs). Items are per set (unit).
import { realProfitPct } from './priceStructure.js'

const num = v => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const VAT_DIVISOR = 1.07

export function nextAgreedSubNo(snapshots, quotationId, revision) {
  let max = 0
  for (const s of snapshots || []) {
    if (s.kind === 'agreed' && s.quotation_id === quotationId && s.revision === revision) max = Math.max(max, s.sub_no || 0)
  }
  return max + 1
}

const lineTotalOf = r => (r.line_total != null && r.line_total !== '' ? num(r.line_total) : num(r.unit_price) * num(r.quantity))

// snapshot: the last 'sent' snapshot row. quotation: the quotations row. lines: estimation_quotation_lines rows.
// quotationItems: the quotation's current quotation_items rows. Returns null when there is no snapshot.
export function buildComparison({ snapshot, quotation, lines, quotationItems }) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null
  const q = quotation || {}
  const itemRows = (quotationItems || []).filter(r => r.item_type === 'item')
  const rowById = new Map(itemRows.map(r => [r.id, r]))
  const rowIdOfOpening = new Map((lines || []).map(l => [l.opening_id, l.item_row_id]))
  const mappedRowIds = new Set((lines || []).map(l => l.item_row_id).filter(Boolean))

  const subtotal = itemRows.reduce((s, r) => s + lineTotalOf(r), 0)
  let discount = 0
  // Same priority as calcQuotationTotals: a stored percentage wins over a stored amount.
  if (q.discount_pct) discount = subtotal * num(q.discount_pct) / 100
  else if (num(q.discount_amount) > 0) discount = num(q.discount_amount)
  // Capped at the subtotal so shares never exceed line totals. The discount-% base (and pro-rata base) deliberately
  // includes user-added rows: the bill discount applies to the whole quotation, not only to generated lines.
  discount = Math.min(discount, subtotal)
  const inclVat = !!q.price_includes_vat

  const rows = []
  const removed = []
  for (const s of snapshot.items) {
    if (s.unresolved) continue   // never exported, so nothing to compare
    const openingId = s.opening_id ?? s.id
    const row = rowById.get(rowIdOfOpening.get(openingId))
    if (!row) { removed.push({ openingId, name: s.opening_no ?? null }); continue }
    const quantity = num(row.quantity) > 0 ? num(row.quantity) : num(s.quantity)
    const agreedUnit = num(row.unit_price)
    const lineTotal = lineTotalOf(row)
    const share = subtotal > 0 ? discount * lineTotal / subtotal : 0
    const discountShare = quantity > 0 ? share / quantity : 0
    const afterDiscount = agreedUnit - discountShare
    const agreedNet = inclVat ? afterDiscount / VAT_DIVISOR : afterDiscount
    const offeredPrice = num(s.price)
    const diff = agreedNet - offeredPrice
    const v = num(s.v), w = num(s.w), z = num(s.z), pm = num(s.pm)
    const real = realProfitPct({ v, w, z, pm, agreedNet })
    const set = v > 0 ? num(s.profitPct) : null
    rows.push({
      openingId, name: s.opening_no ?? null, quantity, offeredPrice, agreedUnit, discountShare, agreedNet,
      diff, diffPct: offeredPrice > 0 ? diff / offeredPrice * 100 : null,
      setProfitPct: set, realProfitPct: real, profitDiffPts: real === null || set === null ? null : real - set,
      costBase: v + w + z + pm, v,
    })
  }

  const added = itemRows.filter(r => !mappedRowIds.has(r.id))

  const offeredTotal = rows.reduce((s, r) => s + r.offeredPrice * r.quantity, 0)
  const agreedTotal = rows.reduce((s, r) => s + r.agreedNet * r.quantity, 0)
  const withV = rows.filter(r => r.v > 0)
  const vSum = withV.reduce((s, r) => s + r.v * r.quantity, 0)
  const setProfitPct = vSum > 0 ? withV.reduce((s, r) => s + r.setProfitPct * r.v * r.quantity, 0) / vSum : null
  const realSum = vSum > 0 ? (withV.reduce((s, r) => s + (r.agreedNet - r.costBase) * r.quantity, 0)) / vSum * 100 : null
  return {
    rows, extras: { removed, added },
    summary: { offeredTotal, agreedTotal, reductionPct: offeredTotal > 0 ? (offeredTotal - agreedTotal) / offeredTotal * 100 : null, setProfitPct, realProfitPct: realSum },
  }
}

const SNAPSHOT_COLS = ['project_id', 'quotation_id', 'kind', 'revision', 'sub_no', 'price_as_of', 'factors', 'items', 'totals']

// The exact object inserted into estimation_price_snapshots for a comparison (column whitelist applied here).
export function buildAgreedSnapshotRow({ projectId, quotation, sentSnapshot, comparison, priorSnapshots }) {
  const rev = Number(quotation && quotation.revision)
  const revision = Number.isFinite(rev) && rev >= 1 ? Math.floor(rev) : 1
  const row = {
    project_id: projectId, quotation_id: quotation.id, kind: 'agreed', revision,
    sub_no: nextAgreedSubNo(priorSnapshots, quotation.id, revision),
    price_as_of: sentSnapshot.price_as_of || null, factors: sentSnapshot.factors || {},
    items: comparison.rows, totals: { ...comparison.summary, extras: comparison.extras },
  }
  return Object.fromEntries(SNAPSHOT_COLS.map(c => [c, row[c]]))
}
