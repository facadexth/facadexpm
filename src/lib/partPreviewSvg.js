// src/lib/partPreviewSvg.js
// The item preview / quotation-attachment drawing of a part-editor template (layout_kind): the editor's overview
// (partGeometry.overviewSpecs: frame, sashes with the visible sash drawn last, thin extra bars, flush butt joints)
// serialised as a self-contained SVG string with literal colours, plus width/height dimension lines in the legacy
// previewSvgString format (metres, "1.80 ม."). No selection highlight. Pure.
//
// Safe by construction for attachmentPages.safeSvgDataUri (it is later shown as a data-URI <img>): only svg, rect,
// line and text elements, inline fill/stroke attributes, no style elements, markers, scripts or on* attributes.
//
// The drawing depends on: the model, widthMm, heightMm, view, style and the drawn profile widths (drawnWidths) —
// widthOf is the same openingCost.widthOfFor lookup the part editor's overview passes, so the item / quotation drawing
// is the editor's live overview (Ruling PE-9). `buttOf` is accepted for interface symmetry but the geometry ignores
// it: the overview shortens a butt end by the DRAWN thickness of the piece it butts, never by catalog butt distances.
//
// Task 8: every other layout kind is drawn from the millimetre overview (partGeometry → partGeometryBodies) by
// partSvgSymbols.js: glass / F labels / spandrels, pieces in the four D14 styles (double default, lengths, solid, cad with
// non-scaling 1.3 strokes), mitre corners, V / slide / fold symbols (dashed = opens away from the viewer), hardware marks
// and dimensions; viewBox in mm, width/height in px. sliding_2 keeps the frozen output below byte for byte for 'double' and
// 'solid' ('lengths' adds piece lengths, 'cad' draws outlines only).
import { overviewSpecs } from './partGeometry.js'
import { glassSvg, pieceSvg, symbolSvg, markSvg, dimSvg as mmDimSvg } from './partSvgSymbols.js'
import { LAYOUTS } from './partModel.js'
import { expandParts } from './partExpand.js'
import { computeComponentLength } from './bomEngine.js'
import { layoutAddons } from './addonModel.js'

const INK = '#1f2328'
const SASH_INK = '#2f4f6f'
const DIM = '#6b7280'
const GLASS = '#cfe8f5'
const EXTRA = '#6b8fd6'
const FILL = {
  double: { frame: '#ffffff', sash: '#ffffff' },
  solid: { frame: '#c3cad1', sash: '#e4e9ee' },
}
const STYLES = ['double', 'lengths', 'solid', 'cad']
const MARGIN = 12      // left / top
const DIM_ROOM = 30    // right / bottom: the dimension line (16 px out) + its ticks
const n2 = n => Math.round(n * 100) / 100
const metres = mm => `${(mm / 1000).toFixed(2)} ม.`

// Legacy previewSvgString dimension markup (same strokes, ticks, font and text placement).
function dimSvg(d, text) {
  const vertical = d.kind === 'height'
  const tick = vertical
    ? `<line x1="${n2(d.x1 - 6)}" y1="${n2(d.y1)}" x2="${n2(d.x1 + 6)}" y2="${n2(d.y1)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2 - 6)}" y1="${n2(d.y2)}" x2="${n2(d.x2 + 6)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>`
    : `<line x1="${n2(d.x1)}" y1="${n2(d.y1 - 6)}" x2="${n2(d.x1)}" y2="${n2(d.y1 + 6)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2)}" y1="${n2(d.y2 - 6)}" x2="${n2(d.x2)}" y2="${n2(d.y2 + 6)}" stroke="${DIM}" stroke-width=".8"/>`
  const cx = (d.x1 + d.x2) / 2
  const cy = (d.y1 + d.y2) / 2
  const label = vertical
    ? `<text x="${n2(d.x1 - 5)}" y="${n2(cy)}" font-size="11" fill="${DIM}" text-anchor="middle" transform="rotate(-90 ${n2(d.x1 - 5)} ${n2(cy)})">${text}</text>`
    : `<text x="${n2(cx)}" y="${n2(d.y1 - 4)}" font-size="11" fill="${DIM}" text-anchor="middle">${text}</text>`
  return `<line x1="${n2(d.x1)}" y1="${n2(d.y1)}" x2="${n2(d.x2)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>${tick}${label}`
}

const rect = (x, y, w, h, attrs) => `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" ${attrs}/>`

// The catalogue widths the overview actually draws with: [[positionKey, line-0 family, width mm | null]] sorted by key
// (overviewSpecs reads only line 0's family per position; a missing or non-positive width falls back to the constant).
export function drawnWidths(model, widthOf) {
  const lines = (model && model.lines) || {}
  return Object.keys(lines).sort().map(key => {
    const fam = lines[key]?.[0]?.profile_family || ''
    const w = fam && typeof widthOf === 'function' ? Number(widthOf(fam)) : NaN
    return [key, fam, Number.isFinite(w) && w > 0 ? w : null]
  })
}

// The cut length (mm) of every drawn piece of line 0, { [positionKey]: [mm per piece] }, from an expansion of the model
// (expandParts components + sources) at W × H — what costing prices, not the drawn length (R-F3). Pieces without a row
// (no family, unresolved) are left out, and so are free-line positions (corner 'free' on the position or its part:
// hanging-door rails, ตบธรณี, curtain-wall plates / covers, door beads), whose drawn strip is decorative.
// exp: an expandParts result already at hand (the editor's view), else it is expanded here with buttOf / widthOf.
export function cutLengthsByPiece({ model, buttOf, widthOf, widthMm, heightMm, exp = null }) {
  const layout = model && LAYOUTS[model.layout_kind]
  const W = Number(widthMm), H = Number(heightMm)
  if (!layout || !(W > 0) || !(H > 0)) return {}
  const e = exp || expandParts({ model, buttOf: typeof buttOf === 'function' ? buttOf : () => null, widthOf })
  const out = {}
  e.components.forEach((c, i) => {
    const src = e.sources?.[i]
    if (!src || src.line !== 0) return
    const pos = layout.positions[src.key]
    if (!pos || pos.corner === 'free' || layout.parts.find((p) => p.key === pos.part)?.corner === 'free') return
    const mm = Math.max(0, computeComponentLength(c.length_rule_type, c.length_deduction_mm, W / 1000, H / 1000, c.length_factor, c.end_deduction_mm) * 1000)
    const arr = (out[src.key] = out[src.key] || [])
    for (const piece of src.pieces) arr[piece] = mm
  })
  return out
}

/**
 * @param {{ model, widthMm, heightMm, view?: 'out'|'in', buttOf?, widthOf?, style?: 'double'|'solid', lengthsByPiece? }} args
 * lengthsByPiece ('lengths' style, every kind but sliding_2): { [key]: number[] } or (key, piece) => mm — the cut length
 * printed on each piece (cutLengthsByPiece); without it the style prints no lengths.
 * @returns {string|null} null when there is nothing to draw (no drawable model or no size).
 */
// eslint-disable-next-line no-unused-vars
export function partSvgString({ model, widthMm, heightMm, view = 'out', buttOf, widthOf, style = 'double', lengthsByPiece = null, addons = null, overrides = null } = {}) {
  const W = Number(widthMm), H = Number(heightMm)
  if (!(W > 0) || !(H > 0)) return null
  const ov = overviewSpecs({ model, widthMm: W, heightMm: H, view: view === 'in' ? 'in' : 'out', widthOf })
  if (!ov.pieces.length) return null
  const ao = addonGeometry(ov.box, addons, W, H, view === 'in' ? 'in' : 'out')
  if (ov.box.units === 'mm') return mmSvg(ov, STYLES.includes(style) ? style : 'double', lengthLookup(lengthsByPiece), ao)
  const fills = FILL[style] || FILL.double
  const b = ov.box

  // Glass: the frame opening, behind everything (the sash bars cover it; only the panes stay visible).
  const mainOf = key => ov.pieces.find(p => p.key === key && p.role === 'main')
  const side = mainOf('frame_side')?.w || 0
  const top = mainOf('frame_top')?.h || 0
  const bottom = mainOf('frame_bottom')?.h || 0
  const parts = [rect(b.frameX + side, b.frameY + top, Math.max(0, b.frameW - 2 * side), Math.max(0, b.frameH - top - bottom), `fill="${GLASS}" stroke="none"`)]

  for (const p of ov.pieces) {
    const sash = !p.key.startsWith('frame_')
    if (p.role === 'extra') parts.push(rect(p.x, p.y, p.w, p.h, `fill="${EXTRA}" stroke="none"`))
    else parts.push(rect(p.x, p.y, p.w, p.h, `fill="${style === 'cad' ? 'none' : sash ? fills.sash : fills.frame}" stroke="${sash ? SASH_INK : INK}" stroke-width="1.2"`))
    if (style === 'lengths' && p.role === 'main') parts.push(lengthText(p, ov.box.scale))
  }
  if (ao) {
    const t = Math.max(side, top, bottom) || null
    parts.push(addonSvg(ao, { t, sw: 1.2, ns: '', style, fills, outline: 2 }))
    for (const d of addonDims(ao, 16, AO_DIM_STEP)) parts.push(dimSvg(d, metres(d.value)))
    const vx = b.frameX - MARGIN - ao.ext.left, vy = b.frameY - MARGIN - ao.ext.top
    const vw = b.frameW + MARGIN + DIM_ROOM + ao.ext.left + ao.ext.right + (ao.axes.ys.length > 2 ? AO_DIM_STEP : 0)
    const vh = b.frameH + MARGIN + DIM_ROOM + ao.ext.top + ao.ext.bottom + AO_TEXT_ROOM + (ao.axes.xs.length > 2 ? AO_DIM_STEP : 0)
    parts.push(`<text x="${n2(vx + vw / 2)}" y="${n2(vy + vh - 6)}" font-size="11" fill="${DIM}" text-anchor="middle">${overallText(ao)}</text>`)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(vw)}" height="${n2(vh)}" viewBox="${n2(vx)} ${n2(vy)} ${n2(vw)} ${n2(vh)}">${parts.join('')}</svg>`
  }
  for (const d of ov.dims) parts.push(dimSvg(d, metres(d.value)))

  const vx = n2(b.frameX - MARGIN), vy = n2(b.frameY - MARGIN)
  const vw = n2(b.frameW + MARGIN + DIM_ROOM), vh = n2(b.frameH + MARGIN + DIM_ROOM)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">${parts.join('')}</svg>`
}

// sliding_2 'lengths': the drawn length in mm (pixel length ÷ scale) on each main piece.
function lengthText(p, scale) {
  const cx = n2(p.x + p.w / 2), cy = n2(p.y + p.h / 2)
  const rot = p.h > p.w ? ` transform="rotate(-90 ${cx} ${cy})"` : ''
  return `<text x="${cx}" y="${n2(cy + 3)}" font-size="8" fill="${INK}" text-anchor="middle"${rot}>${Math.round(Math.max(p.w, p.h) / (scale || 1))}</text>`
}

// (key, piece) -> mm | null, from a lengthsByPiece map or function.
export function lengthLookup(lengths) {
  if (typeof lengths === 'function') return (key, piece) => { const v = lengths(key, piece); return typeof v === 'number' && Number.isFinite(v) ? v : null }
  if (lengths && typeof lengths === 'object') return (key, piece) => { const v = lengths[key]?.[piece]; return typeof v === 'number' && Number.isFinite(v) ? v : null }
  return () => null
}

// Every other layout kind: the millimetre overview, drawn back to front (glass, pieces, symbols, hardware, dimensions).
// ao: addonGeometry(...) or null (no add-ons: the frozen output).
function mmSvg(ov, style, lengthOf, ao = null) {
  const b = ov.box, sw = b.sw
  const parts = []
  for (const g of ov.glass) parts.push(glassSvg(g, style, sw))
  for (const p of ov.pieces) parts.push(pieceSvg(p, style, sw, p.role === 'main' ? lengthOf(p.key, p.piece) : null))
  for (const s of ov.symbols) parts.push(symbolSvg(s, sw))
  for (const k of ov.hardwareMarks) parts.push(markSvg(k, sw))
  if (ao) {
    const frames = ov.pieces.filter(p => p.role === 'main' && FRAME_PART.has(p.part)).map(p => Math.min(p.w, p.h)).filter(v => v > 0)
    parts.push(addonSvg(ao, { t: frames.length ? Math.min(...frames) : null, sw: 1.3, ns: ' vector-effect="non-scaling-stroke"', style, fills: style === 'solid' ? FILL.solid : FILL.double, mm: true, outline: 2 }))
  }
  if (ao) {
    for (const d of ov.dims) if (d.kind !== 'width' && d.kind !== 'height') parts.push(mmDimSvg(shiftDim(d, b, ao.ext), sw))
    for (const d of addonDims(ao, sw * 14, sw * 12)) parts.push(mmDimSvg(d, sw))
  } else {
    for (const d of ov.dims) parts.push(mmDimSvg(d, sw))
  }
  const px = Math.min(420 / b.frameW, 300 / b.frameH)
  const v = ao ? mmViewBox(b, ao) : b
  if (ao) parts.push(`<text x="${n2(v.x + v.w / 2)}" y="${n2(v.y + v.h - sw * 4)}" font-size="${n2(sw * 8)}" fill="${DIM}" text-anchor="middle">${overallText(ao)}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(v.w * px)}" height="${n2(v.h * px)}" viewBox="${n2(v.x)} ${n2(v.y)} ${n2(v.w)} ${n2(v.h)}">${parts.join('')}</svg>`
}

// ---------------------------------------------------------------- inline add-ons

const AO_POSITIONS = ['top', 'bottom', 'left', 'right']
const AO_TEXT_ROOM = 18      // px under the sliding_2 drawing for the overall size line
const AO_DIM_STEP = 18       // px between the chain dimension line and the whole-unit line (sliding_2 drawing)
const AO_MAX_GRID = 12       // grid bars drawn per direction
const AO_SYM = '#2563eb'
const FRAME_PART = new Set(['frame'])
const MIRROR = { left: 'right', right: 'left', top: 'top', bottom: 'bottom' }
const intIn = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v)) || lo))

// The drawable add-ons (numbers coerced; unknown mode / position or a non-positive size dropped), or [] for none.
function drawableAddons(addons) {
  if (!Array.isArray(addons)) return []
  return addons.filter(a => a && typeof a === 'object' && (a.mode === 'merge' || a.mode === 'attach') && AO_POSITIONS.includes(a.position)
    && Number(a.len_mm) > 0 && Number(a.thick_mm) > 0)
    .map(a => ({
      mode: a.mode, kind: a.kind === 'awning' ? 'awning' : 'fixed', position: a.position, len_mm: Number(a.len_mm), thick_mm: Number(a.thick_mm),
      offset_mm: Number(a.offset_mm) > 0 ? Number(a.offset_mm) : 0, align: a.align === 'end' ? 'end' : 'start', rows: intIn(a.rows, 1, 6), cols: intIn(a.cols, 1, AO_MAX_GRID),
    }))
}

// The add-on rectangles in the drawing's own units (box.scale per mm; mirrored for the inside view), the main frame box,
// how far they reach past it on each side, the mm envelope and the main size. null when there is nothing to draw.
function addonGeometry(box, addons, widthMm, heightMm, view) {
  const list = drawableAddons(addons)
  const sc = Number(box && box.scale) || 0
  if (!list.length || !(sc > 0)) return null
  const { rects, envelope } = layoutAddons({ widthMm, heightMm, addons: list })
  const frame = { x: box.frameX, y: box.frameY, w: box.frameW, h: box.frameH }
  const out = rects.filter(r => !r.main).map(r => {
    const a = list[r.i], w = r.w * sc, h = r.h * sc
    let x = frame.x + r.x * sc
    if (view === 'in') x = 2 * frame.x + frame.w - x - w
    return { a, side: view === 'in' ? MIRROR[a.position] : a.position, x, y: frame.y + r.y * sc, w, h }
  })
  const ext = {
    left: Math.max(0, frame.x - Math.min(...out.map(r => r.x))),
    top: Math.max(0, frame.y - Math.min(...out.map(r => r.y))),
    right: Math.max(0, Math.max(...out.map(r => r.x + r.w)) - (frame.x + frame.w)),
    bottom: Math.max(0, Math.max(...out.map(r => r.y + r.h)) - (frame.y + frame.h)),
  }
  // the dimension chain along each axis: the envelope edges, the frame edges and the edges of the add-ons on that axis
  const env = { x0: frame.x - ext.left, x1: frame.x + frame.w + ext.right, y0: frame.y - ext.top, y1: frame.y + frame.h + ext.bottom }
  const uniq = (vs, lo, hi) => [...new Set(vs.map(v => Math.round(v * 100) / 100))].filter(v => v >= lo - 0.01 && v <= hi + 0.01).sort((a, c) => a - c)
  const axes = {
    xs: uniq([env.x0, env.x1, frame.x, frame.x + frame.w, ...out.filter(r => r.side === 'left' || r.side === 'right').flatMap(r => [r.x, r.x + r.w])], env.x0, env.x1),
    ys: uniq([env.y0, env.y1, frame.y, frame.y + frame.h, ...out.filter(r => r.side === 'top' || r.side === 'bottom').flatMap(r => [r.y, r.y + r.h])], env.y0, env.y1),
    env, scale: sc,
  }
  return { rects: out, frame, ext, envelope, main: { w: widthMm, h: heightMm }, view, axes }
}

// Dimension lines of a drawing with add-ons (owner 2026-10-15: main unit, each additional unit and the whole unit).
// First line out from the envelope: the chain along the axis (the main unit and every add-on on that axis, each with
// its own size); a second line `step` further out: the whole unit, drawn only when the chain has more than one
// segment (otherwise main = whole and one line says it). Values in mm; positions in the drawing's units.
function addonDims(ao, gap, step) {
  const { xs, ys, env, scale } = ao.axes
  const mm = v => Math.round((v / scale) * 10) / 10
  const out = []
  const yA = env.y1 + gap, yB = yA + step
  for (let i = 1; i < xs.length; i++) out.push({ kind: 'width', x1: xs[i - 1], y1: yA, x2: xs[i], y2: yA, value: mm(xs[i] - xs[i - 1]) })
  if (xs.length > 2) out.push({ kind: 'width', x1: env.x0, y1: yB, x2: env.x1, y2: yB, value: mm(env.x1 - env.x0) })
  const xA = env.x1 + gap, xB = xA + step
  for (let i = 1; i < ys.length; i++) out.push({ kind: 'height', x1: xA, y1: ys[i - 1], x2: xA, y2: ys[i], value: mm(ys[i] - ys[i - 1]) })
  if (ys.length > 2) out.push({ kind: 'height', x1: xB, y1: env.y0, x2: xB, y2: env.y1, value: mm(env.y1 - env.y0) })
  return out
}

// The millimetre drawing's viewBox grown by the add-ons (and the overall size line); the box's own without add-ons.
// PreviewPanel lays the curtain-wall cell targets over the <img> in this same viewBox.
export function partViewBox({ box, addons = null, widthMm, heightMm, view = 'out' }) {
  const ao = addonGeometry(box, addons, Number(widthMm), Number(heightMm), view === 'in' ? 'in' : 'out')
  return ao ? mmViewBox(box, ao) : { x: box.x, y: box.y, w: box.w, h: box.h }
}
function mmViewBox(b, ao) {
  const ex = ao.axes.ys.length > 2 ? b.sw * 12 : 0, ey = ao.axes.xs.length > 2 ? b.sw * 12 : 0
  return { x: b.x - ao.ext.left, y: b.y - ao.ext.top, w: b.w + ao.ext.left + ao.ext.right + ex, h: b.h + ao.ext.top + ao.ext.bottom + b.sw * 14 + ey }
}

// A main dimension line outside the frame moves out past the add-ons on its side.
function shiftDim(d, b, ext) {
  const x0 = b.frameX, x1 = b.frameX + b.frameW, y0 = b.frameY, y1 = b.frameY + b.frameH
  const dx = d.x1 >= x1 && d.x2 >= x1 ? ext.right : d.x1 <= x0 && d.x2 <= x0 ? -ext.left : 0
  const dy = d.y1 >= y1 && d.y2 >= y1 ? ext.bottom : d.y1 <= y0 && d.y2 <= y0 ? -ext.top : 0
  return dx || dy ? { ...d, x1: d.x1 + dx, x2: d.x2 + dx, y1: d.y1 + dy, y2: d.y2 + dy } : d
}

const overallText = ao => `รวม ${Math.round(ao.envelope.w)} × ${Math.round(ao.envelope.h)} มม.`

// u: { t: frame bar thickness (drawing units) | null, sw: stroke width, ns: extra stroke attribute, style, fills, mm?, outline }
function addonSvg(ao, u) {
  const out = []
  const cad = u.style === 'cad'
  const bar = (x, y, w, h) => {
    if (!(w > 0 && h > 0)) return
    if (u.mm && u.style === 'solid') out.push(rect(x, y, w, h, `fill="${u.fills.frame}" stroke="none"`))
    else out.push(rect(x, y, w, h, `fill="${cad ? 'none' : u.fills.frame}" stroke="${INK}" stroke-width="${u.sw}"${u.ns}`))
  }
  for (const r of ao.rects) {
    const t = Math.min(u.t > 0 ? u.t : Math.min(r.w, r.h) * 0.07, Math.min(r.w, r.h) / 4)
    // the sides with a frame bar: attach = all four; merge = all but the one against the main (its own frame member)
    const facing = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[r.side]
    const has = s => r.a.mode === 'attach' || s !== facing
    const inner = {
      x: r.x + (has('left') ? t : 0), y: r.y + (has('top') ? t : 0),
      w: r.w - (has('left') ? t : 0) - (has('right') ? t : 0), h: r.h - (has('top') ? t : 0) - (has('bottom') ? t : 0),
    }
    out.push(rect(inner.x, inner.y, Math.max(0, inner.w), Math.max(0, inner.h), cad ? `fill="none" stroke="${DIM}" stroke-width="0.6"${u.ns}` : `fill="${GLASS}" stroke="none"`))
    // verticals run through, horizontals sit between them
    if (has('left')) bar(r.x, r.y, t, r.h)
    if (has('right')) bar(r.x + r.w - t, r.y, t, r.h)
    if (has('top')) bar(inner.x, r.y, inner.w, t)
    if (has('bottom')) bar(inner.x, r.y + r.h - t, inner.w, t)
    // grid: cols − 1 mullions, rows − 1 rails across the glass
    const g = `stroke="${INK}" stroke-width="${u.sw}"${u.ns}`
    const { cols, rows } = r.a
    for (let i = 1; i < cols; i++) { const x = inner.x + (inner.w * i) / cols; out.push(`<line x1="${n2(x)}" y1="${n2(inner.y)}" x2="${n2(x)}" y2="${n2(inner.y + inner.h)}" ${g}/>`) }
    for (let j = 1; j < rows; j++) { const y = inner.y + (inner.h * j) / rows; out.push(`<line x1="${n2(inner.x)}" y1="${n2(y)}" x2="${n2(inner.x + inner.w)}" y2="${n2(y)}" ${g}/>`) }
    // awning: a V per pane, apex on the hinge (top); dashed from inside (it opens away from the viewer)
    if (r.a.kind === 'awning') {
      const dash = ao.view === 'in' ? ` stroke-dasharray="${n2(t * 0.6 || 4)} ${n2(t * 0.4 || 3)}"` : ''
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const cw = inner.w / cols, ch = inner.h / rows, x0 = inner.x + cw * i, y0 = inner.y + ch * j
        out.push(`<polyline points="${n2(x0)},${n2(y0 + ch)} ${n2(x0 + cw / 2)},${n2(y0)} ${n2(x0 + cw)},${n2(y0 + ch)}" fill="none" stroke="${AO_SYM}" stroke-width="${n2(u.sw * 0.7)}"${dash}${u.ns}/>`)
      }
    }
  }
  // one outer outline shared by the main unit and its merge add-ons (กรอบร่วม)
  const merge = ao.rects.filter(r => r.a.mode === 'merge')
  if (merge.length) {
    const all = [ao.frame, ...merge]
    const x0 = Math.min(...all.map(r => r.x)), y0 = Math.min(...all.map(r => r.y))
    const x1 = Math.max(...all.map(r => r.x + r.w)), y1 = Math.max(...all.map(r => r.y + r.h))
    out.push(rect(x0, y0, x1 - x0, y1 - y0, `fill="none" stroke="${INK}" stroke-width="${u.outline}"${u.ns}`))
  }
  return out.join('')
}
