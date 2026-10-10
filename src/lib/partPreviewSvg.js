// src/lib/partPreviewSvg.js
// The item preview / quotation-attachment drawing of a part-editor template (layout_kind): the editor's overview
// (partGeometry.overviewSpecs: frame, sashes with the visible sash drawn last, thin extra bars, flush butt joints)
// serialised as a self-contained SVG string with literal colours, plus width/height dimension lines in the legacy
// previewSvgString format (metres, "1.80 ม."). No selection highlight. Pure.
//
// Safe by construction for attachmentPages.safeSvgDataUri (it is later shown as a data-URI <img>): only svg, rect,
// line and text elements, inline fill/stroke attributes, no style elements, markers, scripts or on* attributes.
//
// The drawing depends on: the model, widthMm, heightMm, view and style. `buttOf` is accepted for interface symmetry
// but the geometry ignores it — the overview shortens a butt end by the DRAWN thickness of the piece it butts
// (overviewSpecs is called without widthOf, so thicknesses are drawing constants), never by catalog butt distances.
import { overviewSpecs } from './partGeometry.js'

const INK = '#1f2328'
const SASH_INK = '#2f4f6f'
const DIM = '#6b7280'
const GLASS = '#cfe8f5'
const EXTRA = '#6b8fd6'
const FILL = {
  double: { frame: '#ffffff', sash: '#ffffff' },
  solid: { frame: '#c3cad1', sash: '#e4e9ee' },
}
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

/**
 * @param {{ model, widthMm, heightMm, view?: 'out'|'in', buttOf?, style?: 'double'|'solid' }} args
 * @returns {string|null} null when there is nothing to draw (no drawable model or no size).
 */
export function partSvgString({ model, widthMm, heightMm, view = 'out', buttOf, style = 'double' } = {}) {
  const W = Number(widthMm), H = Number(heightMm)
  if (!(W > 0) || !(H > 0)) return null
  const ov = overviewSpecs({ model, widthMm: W, heightMm: H, view: view === 'in' ? 'in' : 'out' })
  if (!ov.pieces.length) return null
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
    else parts.push(rect(p.x, p.y, p.w, p.h, `fill="${sash ? fills.sash : fills.frame}" stroke="${sash ? SASH_INK : INK}" stroke-width="1.2"`))
  }
  for (const d of ov.dims) parts.push(dimSvg(d, metres(d.value)))

  const vx = n2(b.frameX - MARGIN), vy = n2(b.frameY - MARGIN)
  const vw = n2(b.frameW + MARGIN + DIM_ROOM), vh = n2(b.frameH + MARGIN + DIM_ROOM)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">${parts.join('')}</svg>`
}
