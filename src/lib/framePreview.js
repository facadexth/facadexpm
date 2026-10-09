// src/lib/framePreview.js
// Geometry for the type/add-on preview: a double-line frame (outer + inner rectangle), double-line
// interior members taken from the template grid, joint seams at the corners (which bars run full length),
// dimension labels, and an inside or outside view. Pure -- a screen draws it, previewSvgString() serialises it.
// Every option added in Phase 2b is optional and defaults to the Phase 2a drawing exactly.
import { resolveGrid } from './bomEngine.js'

const BOX_W = 280
const BOX_H = 220
const MARGIN = 40
const MEMBER_GAP = 4
const MAX_PANELS = 12
export const ADDON_POSITIONS = ['top', 'bottom', 'left', 'right']

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

// frame_mm: the visible width of the frame profile in mm (from the catalog). With it the drawn frame is that
// wide at scale (customers see how much of the view the frame takes); without it the Phase 2a 4..10 px rule applies.
function drawUnit(kind, template, w_m, h_m, panel_count, scale, x, y, opts) {
  const outer = { x, y, w: w_m * scale, h: h_m * scale }
  const short = Math.min(outer.w, outer.h)
  const t = opts.frame_mm > 0
    ? Math.min(clamp((opts.frame_mm / 1000) * scale, 2, 60), short / 3)
    : Math.min(clamp(0.045 * short, 4, 10), short / 3)
  const inner = { x: outer.x + t, y: outer.y + t, w: outer.w - 2 * t, h: outer.h - 2 * t }

  const columnsWanted = safePanels(panel_count)
  const { cells, columnCount } = resolveGrid({ ...template, grid_row_weights: safeWeights(template) }, { width_m: w_m, height_m: h_m, panel_count: columnsWanted })
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

  // Seams: where the secondary bars end against the main bars (the main bars run through the corners).
  const seams = opts.main_axis === 'horizontal'
    ? [[outer.x, inner.y, inner.x, inner.y], [inner.x + inner.w, inner.y, outer.x + outer.w, inner.y],
       [outer.x, inner.y + inner.h, inner.x, inner.y + inner.h], [inner.x + inner.w, inner.y + inner.h, outer.x + outer.w, inner.y + inner.h]]
    : [[inner.x, outer.y, inner.x, inner.y], [inner.x + inner.w, outer.y, inner.x + inner.w, inner.y],
       [inner.x, inner.y + inner.h, inner.x, outer.y + outer.h], [inner.x + inner.w, inner.y + inner.h, inner.x + inner.w, outer.y + outer.h]]
  const seamLines = seams.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }))

  // Decoration by the template's preview_kind: a sliding handle + travel arrow, or a swing arc + knob.
  const decor = []
  const kind2 = template && template.preview_kind
  if (kind2 === 'slide' && columnCount > 1) {
    const hx = inner.x + inner.w / columnCount
    decor.push({ type: 'line', x1: hx, y1: inner.y + inner.h * 0.42, x2: hx, y2: inner.y + inner.h * 0.58, heavy: true })
    decor.push({ type: 'polyline', points: [[inner.x + inner.w * 0.1, inner.y + inner.h * 0.82], [inner.x + inner.w * 0.1 + inner.w / columnCount * 0.6, inner.y + inner.h * 0.82]], arrow: true })
  } else if (kind2 === 'swing') {
    decor.push({ type: 'polyline', points: [[inner.x + inner.w, inner.y], [inner.x, inner.y + inner.h / 2], [inner.x + inner.w, inner.y + inner.h]], dashed: true })
    decor.push({ type: 'circle', cx: inner.x + inner.w - t * 1.4, cy: inner.y + inner.h / 2, r: Math.max(2.2, t * 0.35) })
  }
  return { kind, outer, inner, lines, seams: seamLines, decor }
}

// World rectangle of the add-on in metres, main at (0,0). offset_m runs along the shared side (null = centred).
function addonRect(position, offset, w, h, aw, ah) {
  const along = (len, alen) => (Number.isFinite(offset) && offset !== null ? offset : (len - alen) / 2)
  if (position === 'bottom') return { x: along(w, aw), y: h }
  if (position === 'left') return { x: -aw, y: along(h, ah) }
  if (position === 'right') return { x: w, y: along(h, ah) }
  return { x: along(w, aw), y: -ah }                              // 'top' (default)
}

const mirrorX = (x, W) => W - x
function mirrorPreview(p) {
  const W = p.viewBox.width
  const rect = r => ({ ...r, x: mirrorX(r.x + r.w, W) })
  const seg = l => ({ ...l, x1: mirrorX(l.x1, W), x2: mirrorX(l.x2, W) })
  return {
    ...p, view: 'in',
    units: p.units.map(u => ({
      ...u, outer: rect(u.outer), inner: rect(u.inner), lines: u.lines.map(seg), seams: u.seams.map(seg),
      decor: u.decor.map(d => (d.type === 'circle' ? { ...d, cx: mirrorX(d.cx, W) } : d.type === 'polyline' ? { ...d, points: d.points.map(([x, y]) => [mirrorX(x, W), y]) } : seg(d))),
    })),
    dims: p.dims.map(seg),
    labels: p.labels.map(l => ({ ...l, x: mirrorX(l.x, W) })),
  }
}

// opts (all optional): main_axis 'vertical' | 'horizontal' (default vertical: the left/right bars run full height),
// view 'out' | 'in', frame_mm, part_labels { top, bottom, left, right } (text placed on the main unit's four bars),
// addon { template, width_m, height_m, panel_count, position, offset_m, frame_mm }.
export function buildFramePreview({ template, width_m, height_m, panel_count, addon, main_axis, view, frame_mm, part_labels }) {
  if (!template || !positive(width_m) || !positive(height_m)) return null
  const addonOk = addon && addon.template && positive(addon.width_m) && positive(addon.height_m)
  const position = addonOk && ADDON_POSITIONS.includes(addon.position) ? addon.position : 'top'
  const axis = main_axis === 'horizontal' ? 'horizontal' : 'vertical'

  const ar = addonOk ? addonRect(position, addon.offset_m == null ? null : Number(addon.offset_m), width_m, height_m, addon.width_m, addon.height_m) : null
  const minX = addonOk ? Math.min(0, ar.x) : 0
  const minY = addonOk ? Math.min(0, ar.y) : 0
  const totalW = (addonOk ? Math.max(width_m, ar.x + addon.width_m) : width_m) - minX
  const totalH = (addonOk ? Math.max(height_m, ar.y + addon.height_m) : height_m) - minY
  const scale = Math.min(BOX_W / totalW, BOX_H / totalH)
  const px = v => MARGIN + (v - minX) * scale
  const py = v => MARGIN + (v - minY) * scale

  const units = []
  if (addonOk) units.push(drawUnit('addon', addon.template, addon.width_m, addon.height_m, addon.panel_count, scale, px(ar.x), py(ar.y), { main_axis: axis, frame_mm: addon.frame_mm }))
  units.push(drawUnit('main', template, width_m, height_m, panel_count, scale, px(0), py(0), { main_axis: axis, frame_mm }))

  const main = units[units.length - 1]
  const o = main.outer
  const dims = [
    { kind: 'width', unit: 'main', x1: o.x, y1: position === 'bottom' && addonOk ? o.y - 20 : o.y + o.h + 20, x2: o.x + o.w, y2: position === 'bottom' && addonOk ? o.y - 20 : o.y + o.h + 20, text: metres(width_m) },
    { kind: 'height', unit: 'main', x1: position === 'right' && addonOk ? o.x - 20 : o.x + o.w + 20, y1: o.y, x2: position === 'right' && addonOk ? o.x - 20 : o.x + o.w + 20, y2: o.y + o.h, text: metres(height_m) },
  ]
  if (addonOk) {
    const a = units[0].outer
    const wy = position === 'bottom' ? a.y + a.h + 20 : a.y - 20
    dims.push({ kind: 'width', unit: 'addon', x1: a.x, y1: wy, x2: a.x + a.w, y2: wy, text: metres(addon.width_m) })
    const hx = position === 'left' ? a.x - 20 : a.x + a.w + 20
    dims.push({ kind: 'height', unit: 'addon', x1: hx, y1: a.y, x2: hx, y2: a.y + a.h, text: metres(addon.height_m) })
  }

  const labels = []
  if (part_labels) {
    const t = main.inner.x - o.x
    if (part_labels.top) labels.push({ side: 'top', x: o.x + o.w / 2, y: o.y + t * 0.8, text: part_labels.top, rotate: false })
    if (part_labels.bottom) labels.push({ side: 'bottom', x: o.x + o.w / 2, y: o.y + o.h - t * 0.2, text: part_labels.bottom, rotate: false })
    if (part_labels.left) labels.push({ side: 'left', x: o.x + t * 0.8, y: o.y + o.h / 2, text: part_labels.left, rotate: true })
    if (part_labels.right) labels.push({ side: 'right', x: o.x + o.w - t * 0.2, y: o.y + o.h / 2, text: part_labels.right, rotate: true })
  }

  const out = { viewBox: { width: totalW * scale + 2 * MARGIN, height: totalH * scale + 2 * MARGIN }, units, dims, labels, scale, view: 'out', main_axis: axis }
  return view === 'in' ? mirrorPreview(out) : out
}

// ---- serialising -------------------------------------------------------------------------------------------
// A self-contained SVG string with literal colours (no CSS variables), so it can be stored with the item and
// attached to a quotation. style: 'double' | 'solid' | 'cad'; part labels are drawn whenever the preview has them.
const INK = '#1f2328'
const FRAME = '#d6dbe0'
const GLASS = '#cfe8f5'
const DIM = '#6b7280'
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = n => Math.round(n * 100) / 100

export function previewSvgString(p, { style = 'double', finishColor = '#f4f4f2' } = {}) {
  if (!p) return ''
  const frameFill = style === 'cad' ? 'none' : style === 'solid' ? finishColor : FRAME
  const glassFill = style === 'cad' ? 'none' : GLASS
  const parts = []
  for (const u of p.units) {
    parts.push(`<rect x="${n2(u.outer.x)}" y="${n2(u.outer.y)}" width="${n2(u.outer.w)}" height="${n2(u.outer.h)}" fill="${frameFill}" stroke="${INK}" stroke-width="1.2"/>`)
    parts.push(`<rect x="${n2(u.inner.x)}" y="${n2(u.inner.y)}" width="${n2(u.inner.w)}" height="${n2(u.inner.h)}" fill="${glassFill}" stroke="${INK}" stroke-width="1"/>`)
    for (const l of u.lines) parts.push(`<line x1="${n2(l.x1)}" y1="${n2(l.y1)}" x2="${n2(l.x2)}" y2="${n2(l.y2)}" stroke="${INK}" stroke-width="1"/>`)
    for (const l of u.seams) parts.push(`<line x1="${n2(l.x1)}" y1="${n2(l.y1)}" x2="${n2(l.x2)}" y2="${n2(l.y2)}" stroke="${INK}" stroke-width="1.2"/>`)
    for (const d of u.decor) {
      if (d.type === 'circle') parts.push(`<circle cx="${n2(d.cx)}" cy="${n2(d.cy)}" r="${n2(d.r)}" fill="${INK}"/>`)
      else if (d.type === 'polyline') parts.push(`<polyline points="${d.points.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ')}" fill="none" stroke="${INK}" stroke-width="0.9"${d.dashed ? ' stroke-dasharray="4 3"' : ''}/>`)
      else parts.push(`<line x1="${n2(d.x1)}" y1="${n2(d.y1)}" x2="${n2(d.x2)}" y2="${n2(d.y2)}" stroke="${INK}" stroke-width="${d.heavy ? 3 : 1}" stroke-linecap="round"/>`)
    }
  }
  for (const d of p.dims) {
    const vertical = d.kind === 'height'
    const tick = vertical ? `<line x1="${n2(d.x1 - 6)}" y1="${n2(d.y1)}" x2="${n2(d.x1 + 6)}" y2="${n2(d.y1)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2 - 6)}" y1="${n2(d.y2)}" x2="${n2(d.x2 + 6)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>`
      : `<line x1="${n2(d.x1)}" y1="${n2(d.y1 - 6)}" x2="${n2(d.x1)}" y2="${n2(d.y1 + 6)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2)}" y1="${n2(d.y2 - 6)}" x2="${n2(d.x2)}" y2="${n2(d.y2 + 6)}" stroke="${DIM}" stroke-width=".8"/>`
    parts.push(`<line x1="${n2(d.x1)}" y1="${n2(d.y1)}" x2="${n2(d.x2)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>${tick}`)
    const cx = (d.x1 + d.x2) / 2
    const cy = (d.y1 + d.y2) / 2
    parts.push(vertical
      ? `<text x="${n2(d.x1 - 5)}" y="${n2(cy)}" font-size="11" fill="${DIM}" text-anchor="middle" transform="rotate(-90 ${n2(d.x1 - 5)} ${n2(cy)})">${esc(d.text)}</text>`
      : `<text x="${n2(cx)}" y="${n2(d.y1 - 4)}" font-size="11" fill="${DIM}" text-anchor="middle">${esc(d.text)}</text>`)
  }
  for (const l of p.labels || []) {
    parts.push(`<text x="${n2(l.x)}" y="${n2(l.y)}" font-size="9" fill="${INK}" text-anchor="middle"${l.rotate ? ` transform="rotate(-90 ${n2(l.x)} ${n2(l.y)})"` : ''}>${esc(l.text)}</text>`)
  }
  const w = n2(p.viewBox.width)
  const h = n2(p.viewBox.height)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
}

// Cheap signature of every input that changes the saved drawing; the item stores it with the snapshot so a
// later edit can be detected ("the saved preview is older than the item").
export function previewSignature({ template_id, width_m, height_m, panel_count, addon_template_id, addon_width_m, addon_height_m, addon_panel_count, addon_position, addon_offset_m, main_axis }) {
  return JSON.stringify([template_id ?? null, width_m ?? null, height_m ?? null, panel_count ?? 1, addon_template_id ?? null, addon_width_m ?? null, addon_height_m ?? null, addon_panel_count ?? 1, addon_position ?? null, addon_offset_m ?? 0, main_axis ?? 'vertical'])
}
