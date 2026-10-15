// src/lib/hardwareDefaults.js
// The hardware a layout declares (layout.hardware: [{ name, per: 'sash'|'unit', qty }]) turned into the starting
// hardware lines of a NEW template. Pure. 'sash' lines are multiplied by the model's real (clamped) sash/leaf count,
// 'unit' lines are evaluated once. qty is a number or an expression over the layout params (exprParams of the
// started model). A line whose expression cannot be evaluated is skipped and reported, never inserted; a line that
// evaluates to 0 or less (the other pivot set) is simply left out.
import { startModel, sequenceOf, MAX_PART_COUNT } from './partModel.js'
import { layoutOf, exprParams } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'

// The part a 'per sash' line counts: the layout's sash / leaf part (awning cells for curtain_wall use per 'unit').
const SASH_PART_KEYS = ['sash', 'leaf']

function sashCount(model, layout, p) {
  // sliding_n / sliding_3track: the sashes are the parts of the layout's sequence row (left / middle / right)
  const seq = sequenceOf(model)
  if (seq) return seq.length
  const part = layout.parts.find(x => SASH_PART_KEYS.includes(x.key))
  if (!part) return 1
  const n = Math.round(evalExpr(part.count, p))
  return Number.isFinite(n) ? Math.min(MAX_PART_COUNT, Math.max(0, n)) : 0
}

// { rows: [{ name, quantity, per, part_id: null, source: 'layout_default' }], skipped: [{ name, reason }] }
export function hardwareDefaultsPlan(kind, params = {}) {
  const layout = layoutOf(kind)
  const model = startModel(kind, params)   // params = the model's resolved params (startModel fills any missing with defaults)
  const p = exprParams(model)
  const rows = []
  const skipped = []
  for (const h of layout.hardware || []) {
    try {
      let quantity = Number(evalExpr(h.qty, p))
      if (!Number.isFinite(quantity)) throw new Error('not_a_number')
      if (h.per === 'sash') quantity *= sashCount(model, layout, p)
      if (quantity > 0) rows.push({ name: h.name, quantity, per: h.per, part_id: null, source: 'layout_default' })
    } catch (e) {
      skipped.push({ name: h.name, reason: (e && e.message) || String(e) })
    }
  }
  return { rows, skipped }
}

export const hardwareDefaults = (kind, params) => hardwareDefaultsPlan(kind, params).rows

// bom_template_hardware insert rows (real columns only: per / source are dropped; the owner picks the part later).
export function hardwareDefaultRows(kind, params, startAt = 0) {
  return hardwareDefaults(kind, params).map((r, i) => ({
    name: r.name, reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: r.quantity, part_id: null, sort_order: startAt + i,
  }))
}

// The template's hardware rows as THIS item uses them. The layout's hardware is evaluated twice — with the template's
// params and with the item's (modelForItem) — and only the DIFFERENCE is applied, so a quantity the owner edited on the
// template survives: a row of the same name gets quantity_value + delta (dropped at 0 or less), a layout line the
// template has no row for (its default was 0, e.g. กุญแจ on a window template) is added unpriced (part_id null →
// no_hardware_price, never a silent 0). Rows the owner added by hand (names the layout does not declare) are untouched.
// Same models, a non-layout template or a refused model → the rows unchanged.
export function itemHardwareRows(rows, baseModel, itemModel) {
  const list = rows || []
  if (!baseModel || baseModel.error || !itemModel || itemModel.error || baseModel === itemModel || !itemModel.layout_kind) return list
  const kind = itemModel.layout_kind
  if (kind !== baseModel.layout_kind) return list
  const before = Object.fromEntries(hardwareDefaults(kind, baseModel.params || {}).map(r => [r.name, r.quantity]))
  const after = Object.fromEntries(hardwareDefaults(kind, itemModel.params || {}).map(r => [r.name, r.quantity]))
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const delta = {}
  for (const n of names) {
    const d = (after[n] || 0) - (before[n] || 0)
    if (d !== 0) delta[n] = d
  }
  if (!Object.keys(delta).length) return list
  const out = []
  const seen = new Set()
  for (const h of list) {
    if (!(h.name in delta) || h.quantity_basis !== 'fixed') { out.push(h); continue }
    seen.add(h.name)
    const q = (Number(h.quantity_value) || 0) + delta[h.name]
    if (q > 0) out.push({ ...h, quantity_value: q, source: 'item_option' })
  }
  for (const n of Object.keys(delta)) {
    if (seen.has(n) || delta[n] <= 0) continue
    out.push({ name: n, reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: delta[n], part_id: null, inventory_item_id: null, source: 'item_option' })
  }
  return out
}
