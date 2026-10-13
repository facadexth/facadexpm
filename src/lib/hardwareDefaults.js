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
