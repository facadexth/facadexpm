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

/**
 * @param {{ model, widthMm, heightMm, view?: 'out'|'in', buttOf?, widthOf?, style?: 'double'|'solid' }} args
 * @returns {string|null} null when there is nothing to draw (no drawable model or no size).
 */
// eslint-disable-next-line no-unused-vars
export function partSvgString({ model, widthMm, heightMm, view = 'out', buttOf, widthOf, style = 'double' } = {}) {
  const W = Number(widthMm), H = Number(heightMm)
  if (!(W > 0) || !(H > 0)) return null
  const ov = overviewSpecs({ model, widthMm: W, heightMm: H, view: view === 'in' ? 'in' : 'out', widthOf })
  if (!ov.pieces.length) return null
  if (ov.box.units === 'mm') return mmSvg(ov, STYLES.includes(style) ? style : 'double')
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

// Every other layout kind: the millimetre overview, drawn back to front (glass, pieces, symbols, hardware, dimensions).
function mmSvg(ov, style) {
  const b = ov.box, sw = b.sw
  const parts = []
  for (const g of ov.glass) parts.push(glassSvg(g, style, sw))
  for (const p of ov.pieces) parts.push(pieceSvg(p, style, sw))
  for (const s of ov.symbols) parts.push(symbolSvg(s, sw))
  for (const k of ov.hardwareMarks) parts.push(markSvg(k, sw))
  for (const d of ov.dims) parts.push(mmDimSvg(d, sw))
  const px = Math.min(420 / b.frameW, 300 / b.frameH)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(b.w * px)}" height="${n2(b.h * px)}" viewBox="${n2(b.x)} ${n2(b.y)} ${n2(b.w)} ${n2(b.h)}">${parts.join('')}</svg>`
}
