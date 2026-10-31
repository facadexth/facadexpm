// SVG markup (strings) for the millimetre drawing of every layout kind except sliding_2: glass / spandrel / frameless panes,
// pieces in the four D14 styles, mitre corners, opening symbols, hardware marks and dimension lines. Ported from the accepted
// mockup's Draw helpers (docs/reference/type-previews-mockup.html: bar / glass / vsym / arrow / dim). Pure.
// Inline attributes only (svg, rect, line, polyline, polygon, text): safe for attachmentPages.safeSvgDataUri.
import { fmtMm } from './partExpand.js'

export const INK = '#1f2328'
export const SASH_INK = '#2f4f6f'
export const DIM = '#6b7280'
const SYM = '#2563eb'
const GLASS = { glass: '#cfe8f5', fixed: '#b9d7e8', frameless: '#d6eef8' }
const SPANDREL = ['#aab4be', '#7d8894']
const HW = '#4b5563'
const FILL = { frame: '#c3cad1', sash: '#e4e9ee' }   // solid style (same tones as sliding_2's solid)
const EXTRA = '#6b8fd6'
const FRAME_PARTS = new Set(['frame', 'grid', 'track'])
const NS = 'vector-effect="non-scaling-stroke"'

const n2 = (n) => Math.round(n * 100) / 100
const rect = (x, y, w, h, attrs) => `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(Math.max(0, w))}" height="${n2(Math.max(0, h))}" ${attrs}/>`
const line = (x1, y1, x2, y2, attrs) => `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" ${attrs}/>`
const poly = (pts, attrs) => `<polyline points="${pts.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ')}" fill="none" ${attrs}/>`
const text = (x, y, s, size, fill, extra = '') => `<text x="${n2(x)}" y="${n2(y)}" font-size="${n2(size)}" fill="${fill}" text-anchor="middle"${extra}>${s}</text>`
const metres = (mm) => `${(mm / 1000).toFixed(2)} ม.`

export function glassSvg(g, style, sw) {
  const out = []
  if (g.kind === 'spandrel') {
    if (style === 'cad') out.push(rect(g.x, g.y, g.w, g.h, `data-kind="spandrel" fill="none" stroke="${DIM}" stroke-width="0.6" ${NS}`), rect(g.x + g.w * 0.06, g.y + g.h * 0.1, g.w * 0.88, g.h * 0.8, `fill="none" stroke="${DIM}" stroke-width="0.6" ${NS}`))
    else out.push(rect(g.x, g.y, g.w, g.h, `data-kind="spandrel" fill="${SPANDREL[0]}" stroke="none"`), rect(g.x + g.w * 0.06, g.y + g.h * 0.1, g.w * 0.88, g.h * 0.8, `fill="${SPANDREL[1]}" stroke="none"`))
    return out.join('')
  }
  const fill = g.kind === 'frameless' ? GLASS.frameless : g.fixed ? GLASS.fixed : GLASS.glass
  if (style === 'cad') out.push(rect(g.x, g.y, g.w, g.h, `data-kind="${g.kind}" fill="none" stroke="${DIM}" stroke-width="0.6" ${NS}`))
  else out.push(rect(g.x, g.y, g.w, g.h, `data-kind="${g.kind}" fill="${fill}" stroke="${g.kind === 'frameless' ? '#8bb8cc' : 'none'}"${g.kind === 'frameless' ? ` stroke-width="0.8" ${NS}` : ''}`))
  // owner 2026-10-15: the fixed mark sits in the glass corner, not the centre
  if (g.fixed) out.push(text(g.x + sw * 7, g.y + sw * 11, 'F', sw * 9, DIM))
  return out.join('')
}

// A mitred sash member (owner 2026-10-31: corners cut 45°, nothing else at the corner): the four members are laid out full
// length and overlap at the corners, so each is drawn as a trapezoid — outer edge full length, inner edge short by the
// member's own thickness, the 45° cut as the end. A rect there left the square-end lines inside every corner. null = a rect.
function mitreShape(p) {
  if (!p.mitre || !p.mside) return null
  const { x, y, w, h } = p
  if (p.mside === 'top') return [[x, y], [x + w, y], [x + w - h, y + h], [x + h, y + h]]
  if (p.mside === 'bottom') return [[x, y + h], [x + w, y + h], [x + w - h, y], [x + h, y]]
  if (p.mside === 'left') return [[x, y], [x + w, y + w], [x + w, y + h - w], [x, y + h]]
  if (p.mside === 'right') return [[x + w, y], [x, y + w], [x, y + h - w], [x + w, y + h]]
  return null
}
const polygon = (pts, attrs) => `<polygon points="${pts.map(([px, py]) => `${n2(px)},${n2(py)}`).join(' ')}" ${attrs}/>`

// A piece in one of the four D14 styles (mockup Draw._bar): double = white with a 1.3 px outline (default, quotations),
// lengths = double + the piece's CUT length (R-F3: `lengthMm`, from the expanded rows — partPreviewSvg.cutLengthsByPiece;
// no label when it is not given, e.g. an unpriced piece or a decorative free-line strip), solid = filled tones without
// outline, cad = outline only.
export function pieceSvg(p, style, sw, lengthMm = null) {
  if (p.role === 'extra') return rect(p.x, p.y, p.w, p.h, `data-role="extra" fill="${EXTRA}" stroke="none"`)
  const sash = !FRAME_PARTS.has(p.part)
  const ink = sash ? SASH_INK : INK
  const out = []
  const shape = mitreShape(p)
  const draw = shape ? attrs => polygon(shape, `data-kind="mitre" ${attrs}`) : attrs => rect(p.x, p.y, p.w, p.h, attrs)
  if (style === 'solid') out.push(draw(`data-role="piece" fill="${sash ? FILL.sash : FILL.frame}" stroke="none"`))
  else out.push(draw(`data-role="piece" fill="${style === 'cad' ? 'none' : '#ffffff'}" stroke="${ink}" stroke-width="1.3" ${NS}`))
  if (style === 'lengths' && typeof lengthMm === 'number' && Number.isFinite(lengthMm)) {
    const L = Math.round(lengthMm), cx = p.x + p.w / 2, cy = p.y + p.h / 2, ty = cy + sw * 2.5
    const rot = p.h > p.w ? ` transform="rotate(-90 ${n2(cx)} ${n2(cy)})"` : ''
    out.push(text(cx, ty, String(L), sw * 6.5, INK, `${rot} paint-order="stroke" stroke="#ffffff" stroke-width="${n2(sw * 1.2)}"`))
  }
  return out.join('')
}

// Opening symbols (mockup vsym / arrow): V with its apex on the hinge side, dashed when the sash opens away from the viewer;
// slide arrows across the pane; fold stack arrows and the dashed split line.
function arrowSvg(x0, y, dir, len, sw) {
  const a = sw * 5, x2 = x0 + dir * len, attrs = `stroke="${SYM}" stroke-width="${n2(sw * 1.1)}" stroke-linecap="round"`
  return line(x0, y, x2, y, attrs) + line(x2 - dir * a, y - a * 0.7, x2, y, attrs) + line(x2 - dir * a, y + a * 0.7, x2, y, attrs)
}

export function symbolSvg(s, sw) {
  const dash = `stroke-dasharray="${n2(sw * 4)} ${n2(sw * 3)}"`
  if (s.kind === 'v_hinge' || s.kind === 'fold') {
    const { x, y, w, h } = s
    let pts
    if (s.hinge === 'left') pts = [[x + w, y], [x, y + h / 2], [x + w, y + h]]
    else if (s.hinge === 'right') pts = [[x, y], [x + w, y + h / 2], [x, y + h]]
    else if (s.hinge === 'top') pts = [[x, y + h], [x + w / 2, y], [x + w, y + h]]
    else pts = [[x, y], [x + w / 2, y + h], [x + w, y]]
    return poly(pts, `stroke="${SYM}" stroke-width="${n2(sw * 0.9)}" stroke-linejoin="round"${s.dashed ? ' ' + dash : ''}`)
  }
  if (s.kind === 'slide' && s.dir) return arrowSvg(s.x + s.w / 2 - s.dir * s.w * 0.18, s.y + s.h * 0.5, s.dir, s.w * 0.36, sw)
  if (s.kind === 'arrow' && s.dir) return arrowSvg(s.dir > 0 ? s.x : s.x + s.w, s.y, s.dir, s.w, sw)
  if (s.kind === 'split') return line(s.x, s.y, s.x, s.y + s.h, `data-kind="split" stroke="${SYM}" stroke-width="${n2(sw * 0.8)}" ${dash}`)
  return ''
}

// Hardware / drawing marks (drawing-only, G9): small filled rects, the head closer box with its caption, the dashed floor line
// of sill-less doors, and the unit joints of unitized walls as thin double lines.
export function markSvg(k, sw) {
  if (k.kind === 'floor_line') return line(k.x1, k.y1, k.x2, k.y2, `data-kind="floor_line" stroke="${DIM}" stroke-width="${n2(sw * 0.6)}" stroke-dasharray="${n2(sw * 4)} ${n2(sw * 3)}"`)
  if (k.kind === 'unit_joint') {
    const v = k.x1 === k.x2, o = sw * 0.6, a = `data-kind="unit_joint" stroke="${INK}" stroke-width="${n2(sw * 0.25)}"`
    return v ? line(k.x1 - o, k.y1, k.x2 - o, k.y2, a) + line(k.x1 + o, k.y1, k.x2 + o, k.y2, a) : line(k.x1, k.y1 - o, k.x2, k.y2 - o, a) + line(k.x1, k.y1 + o, k.x2, k.y2 + o, a)
  }
  if (k.kind === 'closer') return rect(k.x, k.y, k.w, k.h, `data-kind="closer" fill="#e5e7eb" stroke="${INK}" stroke-width="0.8" ${NS}`) + text(k.x + k.w / 2, k.y + k.h * 0.75, 'door closer', Math.min(sw * 5.5, k.h * 0.8), INK)
  if (k.kind === 'silicone') return rect(k.x, k.y, k.w, k.h, `data-kind="silicone" fill="#9ca3af" stroke="none"`)
  return rect(k.x, k.y, k.w, k.h, `data-kind="${k.kind}" fill="${HW}" stroke="none"`)
}

// Dimension lines (mockup dim): W and H in metres like sliding_2's legacy format, the per-leaf dimension in millimetres.
export function dimSvg(d, sw) {
  const v = d.kind === 'height', t = sw * 3, a = `stroke="${DIM}" stroke-width="${n2(sw * 0.5)}"`
  const ticks = v
    ? line(d.x1 - t, d.y1, d.x1 + t, d.y1, a) + line(d.x2 - t, d.y2, d.x2 + t, d.y2, a)
    : line(d.x1, d.y1 - t, d.x1, d.y1 + t, a) + line(d.x2, d.y2 - t, d.x2, d.y2 + t, a)
  const label = d.label || (d.kind === 'width' || d.kind === 'height' ? metres(d.value) : fmtMm(d.value, 0))
  const tx = v ? d.x1 + sw * 5 : (d.x1 + d.x2) / 2, ty = v ? (d.y1 + d.y2) / 2 : d.y1 - sw * 2
  const rot = v ? ` transform="rotate(-90 ${n2(tx)} ${n2(ty)})"` : ''
  return line(d.x1, d.y1, d.x2, d.y2, a) + ticks + text(tx, ty, label, sw * 8, DIM, rot)
}
