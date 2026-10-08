// src/lib/framePreview.js
// Geometry for the type/add-on preview: a double-line frame (outer + inner rectangle), double-line
// interior members taken from the template grid, and dimension labels. Pure -- a screen draws the SVG.
import { resolveGrid } from './bomEngine.js'

const BOX_W = 280
const BOX_H = 220
const MARGIN = 40
const MEMBER_GAP = 4
const MAX_PANELS = 12

// Preview-only guards: a template without usable row weights draws equal rows (or one row), never NaN or a throw.
function safeWeights(template) {
  const w = template && template.grid_row_weights
  if (!Array.isArray(w) || w.length === 0) return [1]
  const ok = w.every(n => Number.isFinite(n) && n >= 0) && w.reduce((a, b) => a + b, 0) > 0
  return ok ? w : w.map(() => 1)
}
const safePanels = n => clamp(Math.floor(Number.isFinite(n) ? n : 1), 1, MAX_PANELS)

const positive = n => Number.isFinite(n) && n > 0
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const metres = n => `${n.toFixed(2)} ม.`

function drawUnit(kind, template, w_m, h_m, panel_count, scale, x, y) {
  const outer = { x, y, w: w_m * scale, h: h_m * scale }
  // frame thickness 4..10 px, but never more than a third of the short side so a very thin opening keeps a positive inner box
  const t = Math.min(clamp(0.045 * Math.min(outer.w, outer.h), 4, 10), Math.min(outer.w, outer.h) / 3)
  const inner = { x: outer.x + t, y: outer.y + t, w: outer.w - 2 * t, h: outer.h - 2 * t }

  const { cells, columnCount } = resolveGrid({ ...template, grid_row_weights: safeWeights(template) }, { width_m: w_m, height_m: h_m, panel_count: safePanels(panel_count) })
  const totalH = cells.reduce((s, c) => s + c.height_m, 0)
  const lines = []
  let acc = 0
  for (let i = 0; i < cells.length - 1; i++) {                 // horizontal members between rows
    acc += cells[i].height_m
    const yy = inner.y + inner.h * (acc / totalH)
    lines.push({ x1: inner.x, y1: yy - MEMBER_GAP / 2, x2: inner.x + inner.w, y2: yy - MEMBER_GAP / 2 })
    lines.push({ x1: inner.x, y1: yy + MEMBER_GAP / 2, x2: inner.x + inner.w, y2: yy + MEMBER_GAP / 2 })
  }
  for (let c = 1; c < columnCount; c++) {                      // vertical members between columns
    const xx = inner.x + inner.w * (c / columnCount)
    lines.push({ x1: xx - MEMBER_GAP / 2, y1: inner.y, x2: xx - MEMBER_GAP / 2, y2: inner.y + inner.h })
    lines.push({ x1: xx + MEMBER_GAP / 2, y1: inner.y, x2: xx + MEMBER_GAP / 2, y2: inner.y + inner.h })
  }
  return { kind, outer, inner, lines }
}

export function buildFramePreview({ template, width_m, height_m, panel_count, addon }) {
  if (!template || !positive(width_m) || !positive(height_m)) return null
  const addonOk = addon && addon.template && positive(addon.width_m) && positive(addon.height_m)

  const totalW = addonOk ? Math.max(width_m, addon.width_m) : width_m
  const totalH = addonOk ? height_m + addon.height_m : height_m
  const scale = Math.min(BOX_W / totalW, BOX_H / totalH)

  const units = []
  let y = MARGIN
  if (addonOk) {
    const ax = MARGIN + ((totalW - addon.width_m) / 2) * scale
    units.push(drawUnit('addon', addon.template, addon.width_m, addon.height_m, addon.panel_count, scale, ax, y))
    y += addon.height_m * scale
  }
  const mx = MARGIN + ((totalW - width_m) / 2) * scale
  units.push(drawUnit('main', template, width_m, height_m, panel_count, scale, mx, y))

  const main = units[units.length - 1]
  const dims = [
    { kind: 'width', unit: 'main', x1: main.outer.x, y1: main.outer.y + main.outer.h + 20, x2: main.outer.x + main.outer.w, y2: main.outer.y + main.outer.h + 20, text: metres(width_m) },
    { kind: 'height', unit: 'main', x1: main.outer.x + main.outer.w + 20, y1: main.outer.y, x2: main.outer.x + main.outer.w + 20, y2: main.outer.y + main.outer.h, text: metres(height_m) },
  ]
  if (addonOk) {
    const a = units[0]
    dims.push({ kind: 'height', unit: 'addon', x1: a.outer.x + a.outer.w + 20, y1: a.outer.y, x2: a.outer.x + a.outer.w + 20, y2: a.outer.y + a.outer.h, text: metres(addon.height_m) })
  }

  return { viewBox: { width: totalW * scale + 2 * MARGIN, height: totalH * scale + 2 * MARGIN }, units, dims, scale }
}
