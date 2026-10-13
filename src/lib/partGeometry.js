// Pure drawing geometry for the BOM template part editor (overview, zoom, end markers).
// Numbers only: no markup, no DOM. Ported from the approved mockup (v24)
// docs/superpowers/mockups/2026-10-10-bom-part-editor-mockup.html — geomFrame / geomSash / renderPieces /
// drawOverview / drawZoom.
//
// Behaviour (owner-confirmed):
// - Flush joints in overview AND zoom: a butt end is shortened by the drawn thickness of the piece it
//   physically butts (its corner partner, partModel.partnerEnd), so joints touch exactly with no overlap.
//   Shortening is capped at a third of the piece run (mockup) so tiny drawings never invert.
// - Corner rule comes from the model: exactly one of the two pieces at a corner runs through.
// - Occlusion: pieces are returned in drawing order and the sash drawn last is the visible one —
//   outside view draws sash 1 then sash 0 (left sash on top); inside view mirrors x and draws sash 0
//   then sash 1 (right sash on top).
// - The two sashes overlap by exactly one stile width (the drawn hook_stile thickness).
// - Extra profile lines (line ≥ 1 of a position) are thin bars (max(3, 0.28 × thickness)) along the
//   piece's inner/lower edge, with their own run from their own ends.
// - Zoom of the frame part draws the frame only; zoom of the sash part draws the sashes side by side and
//   carries the opening text `ช่องเปิดวงกบ {W − 2×side} × {H − top − bottom} มม.` (butt distances).
//
// Drawn thickness: the model stores no profile widths, so — like the mockup — thickness is a drawing
// constant: overview frame t = max(10, 4.5% of the drawn short side), sash = 0.8 t; zoom frame 30 px,
// sash 26 px (capped at 20% of the drawn short side). An optional `widthOf(family) → mm | null` makes the
// OVERVIEW true to scale per position (line 0's family × drawing scale, min 2 px); positions it cannot
// resolve keep the constant. The zoom is a schematic for clicking markers and always uses the constants.
//
// Mapping mockup → repo: frameTop→frame_top, frameBot→frame_bottom, frameSide→frame_side,
// sashTop→sash_top, sashBot→sash_bottom, lockStile→key_stile, hookStile→hook_stile.
// Mockup aspect quirk not ported: the zoom keeps the window's aspect ratio (the mockup stretched it).
import { LAYOUTS, partnerEnd, pieceCount } from './partModel.js'

const OVERVIEW_BOX = { w: 520, h: 360 }
const ZOOM_BOX = { w: 520, h: 340 }

const fmt1 = (x) => x.toLocaleString('th-TH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

// Layout of a drawable model, or null (null/undefined/{}/unknown layout/missing lines or parts → empty specs).
function layoutOf(model) {
  const layout = model && typeof model === 'object' ? LAYOUTS[model.layout_kind] : null
  if (!layout || !model.lines || typeof model.lines !== 'object' || !Array.isArray(model.parts)) return null
  return layout
}

const emptyOverview = () => ({ box: { ...OVERVIEW_BOX, frameX: 0, frameY: 0, frameW: 0, frameH: 0, scale: 0 }, pieces: [], dims: [] })
const emptyZoom = () => ({ box: { ...ZOOM_BOX }, pieces: [], markers: [], title: '', opening: null })

const partOfKey = (layout, key) => layout.positions[key]?.part
const partRec = (model, partKey) => model.parts?.find((p) => p.key === partKey) || {}

export function pieceLabel(model, layout, key, piece) {
  const pos = layout.positions[key]
  const n = pieceCount(model, key)
  if (pos.labels && n === pos.labels.length) return pos.labels[piece]
  if (pos.part === 'sash') return 'บาน' + (piece % 2 ? 'ขวา' : 'ซ้าย')
  return n > 1 ? `ชิ้นที่ ${piece + 1}` : ''
}

// Piece run specs, [{ key, piece, orient, fx, fy, len, thick }] — mockup geomFrame.
function geomFrame(x0, y0, pw, ph, th) {
  const side = th('frame_side')
  return [
    { key: 'frame_top', piece: 0, orient: 'h', fx: x0, fy: y0, len: pw, thick: th('frame_top') },
    { key: 'frame_bottom', piece: 0, orient: 'h', fx: x0, fy: y0 + ph - th('frame_bottom'), len: pw, thick: th('frame_bottom') },
    { key: 'frame_side', piece: 0, orient: 'v', fx: x0, fy: y0, len: ph, thick: side },
    { key: 'frame_side', piece: 1, orient: 'v', fx: x0 + pw - side, fy: y0, len: ph, thick: side },
  ]
}

// Mockup geomSash: hook stile on the left (rail end 0), key stile on the right (rail end 1) for every sash.
function geomSash(sx, sy, sw, sh, th, k) {
  const key = th('key_stile')
  return [
    { key: 'sash_top', piece: k, orient: 'h', fx: sx, fy: sy, len: sw, thick: th('sash_top') },
    { key: 'sash_bottom', piece: k, orient: 'h', fx: sx, fy: sy + sh - th('sash_bottom'), len: sw, thick: th('sash_bottom') },
    { key: 'key_stile', piece: k, orient: 'v', fx: sx + sw - key, fy: sy, len: sh, thick: key },
    { key: 'hook_stile', piece: k, orient: 'v', fx: sx, fy: sy, len: sh, thick: th('hook_stile') },
  ]
}

const THROUGH = { mode: 'through', to: null, deduction_mm: null }

// Mockup renderPieces, minus markup: main rect + extra bars per spec, in drawing order.
function piecesOf({ model, layout, specs, th, X }) {
  const out = []
  for (const g of specs) {
    const lines = model.lines[g.key] || []
    const ins = (pair, e) => {
      const end = pair?.[e] || THROUGH
      if (end.mode !== 'butt') return 0
      const pt = partnerEnd(model, g.key, g.piece, e)
      const target = pt?.key || end.to?.key
      return Math.min(g.len / 3, target ? th(target) : 0)
    }
    const span = (pair) => {
      const a = ins(pair, 0), b = ins(pair, 1)
      return [a, Math.max(2, g.len - a - b)]
    }
    const label = [model.names?.[g.key] || layout.positions[g.key].name, pieceLabel(model, layout, g.key, g.piece)].filter(Boolean).join(' ')
    const base = { key: g.key, piece: g.piece, orient: g.orient, label }
    lines.forEach((line, li) => {
      const [s0, len] = span(line?.ends?.[g.piece])
      let x, y, w, h
      if (li === 0) {
        if (g.orient === 'h') { x = g.fx + s0; y = g.fy; w = len; h = g.thick } else { x = g.fx; y = g.fy + s0; w = g.thick; h = len }
      } else {
        const tk = Math.max(3, g.thick * 0.28)
        if (g.orient === 'h') { x = g.fx + s0; y = g.fy + g.thick - tk; w = len; h = tk } else { x = g.fx + g.thick - tk; y = g.fy + s0; w = tk; h = len }
      }
      out.push({ ...base, x: X(x, w), y, w, h, role: li === 0 ? 'main' : 'extra', line: li })
    })
  }
  return out
}

function thicknessFn(model, layout, defaults, widthOf, sc) {
  return (key) => {
    if (widthOf) {
      const fam = model.lines[key]?.[0]?.profile_family
      const mm = fam ? num(widthOf(fam)) : null
      if (mm != null && mm > 0) return Math.max(2, mm * sc)
    }
    return partOfKey(layout, key) === 'frame' ? defaults.frame : defaults.sash
  }
}

const sashOrder = (n, mirror) => (mirror ? [0, 1] : [1, 0]).filter((k) => k < n)

/**
 * Overview of the whole template at the test size.
 * @returns {{ box:{w,h,frameX,frameY,frameW,frameH,scale}, pieces:Array, dims:Array }}
 *   pieces[i] = { key, piece, orient, x, y, w, h, role:'main'|'extra', line, label } in drawing order
 *   (later pieces cover earlier ones); x is already mirrored for the inside view.
 */
// `buttOf` is accepted for interface symmetry with zoomSpecs but the overview does not need it.
export function overviewSpecs({ model, widthMm, heightMm, view = 'out', widthOf } = {}) {
  const layout = layoutOf(model)
  if (!layout) return emptyOverview()
  const W = Math.max(1, Number(widthMm) || 0), H = Math.max(1, Number(heightMm) || 0)
  const sc = Math.min(420 / W, 300 / H)
  const pw = W * sc, ph = H * sc
  const x0 = (OVERVIEW_BOX.w - pw) / 2 + 8, y0 = 18
  const t = Math.max(10, Math.min(pw, ph) * 0.045)
  const th = thicknessFn(model, layout, { frame: t, sash: t * 0.8 }, widthOf, sc)
  const mirror = view === 'in'
  const X = (x, w) => (mirror ? x0 * 2 + pw - x - w : x)

  const ix = x0 + th('frame_side'), iy = y0 + th('frame_top')
  const inW = pw - 2 * th('frame_side'), inH = ph - th('frame_top') - th('frame_bottom')
  const nSash = Math.min(2, pieceCount(model, 'sash_top'))
  const pwid = nSash === 2 ? inW / 2 + th('hook_stile') / 2 : inW
  let specs = geomFrame(x0, y0, pw, ph, th)
  for (const k of sashOrder(nSash, mirror)) specs = specs.concat(geomSash(ix + (k ? inW - pwid : 0), iy, pwid, inH, th, k))

  const pieces = piecesOf({ model, layout, specs, th, X })
  const dims = [
    { kind: 'width', x1: x0, y1: y0 + ph + 16, x2: x0 + pw, y2: y0 + ph + 16, tx: x0 + pw / 2, ty: y0 + ph + 30, anchor: 'middle', value: W },
    { kind: 'height', x1: x0 + pw + 16, y1: y0, x2: x0 + pw + 16, y2: y0 + ph, tx: x0 + pw + 22, ty: y0 + ph / 2, anchor: 'start', value: H },
  ]
  return { box: { ...OVERVIEW_BOX, frameX: x0, frameY: y0, frameW: pw, frameH: ph, scale: sc }, pieces, dims }
}

// Frame opening from the frame profiles' butt distances (mockup faceOf). Missing → 0, unresolved: true.
function openingOf(model, buttOf, W, H) {
  let unresolved = false
  const b = (key) => {
    const fam = model.lines[key]?.[0]?.profile_family
    const v = fam && buttOf ? num(buttOf(fam)) : null
    if (v == null) { unresolved = true; return 0 }
    return v
  }
  const widthMm = W - 2 * b('frame_side')
  const heightMm = H - b('frame_top') - b('frame_bottom')
  return { widthMm, heightMm, unresolved, text: `ช่องเปิดวงกบ ${fmt1(widthMm)} × ${fmt1(heightMm)} มม.` }
}

/**
 * Zoom of one part with clickable end markers on the selected position.
 * @param selected { key, line } (or a position key string); partKey defaults to the selected position's part.
 * @returns {{ box:{w,h}, pieces:Array, markers:Array<{key,piece,end,x,y,mode}>, title:string,
 *   opening:{widthMm,heightMm,unresolved,text}|null }}
 */
export function zoomSpecs({ model, partKey, selected, view = 'out', widthMm, heightMm, buttOf } = {}) {
  const layout = layoutOf(model)
  if (!layout) return emptyZoom()
  const sel = typeof selected === 'string' ? { key: selected, line: 0 } : (selected || null)
  const pk = partKey || (sel && partOfKey(layout, sel.key)) || 'frame'
  const W = Math.max(1, Number(widthMm) || 0), H = Math.max(1, Number(heightMm) || 0)
  const mirror = view === 'in'
  const X = (x, w) => (mirror ? ZOOM_BOX.w - x - w : x)
  let specs, th
  if (pk === 'frame') {
    const sc = Math.min(470 / W, 280 / H), pw = W * sc, ph = H * sc
    const t = Math.min(30, Math.min(pw, ph) * 0.2)
    th = () => t
    specs = geomFrame((ZOOM_BOX.w - pw) / 2, 25, pw, ph, th)
  } else {
    const gap = 30, n = Math.min(2, pieceCount(model, 'sash_top'))
    const sc = Math.min(215 / (W / 2), 290 / H), sw = (W / 2) * sc, sh = H * sc
    const s = Math.min(26, Math.min(sw, sh) * 0.2)
    th = () => s
    const total = n * sw + (n - 1) * gap, sx = (ZOOM_BOX.w - total) / 2
    specs = []
    for (let k = 0; k < n; k++) specs = specs.concat(geomSash(sx + k * (sw + gap), 25, sw, sh, th, k))
  }
  const pieces = piecesOf({ model, layout, specs, th, X })

  const markers = []
  if (sel && model.lines[sel.key]?.length) {
    const lines = model.lines[sel.key]
    const line = lines[Math.min(Math.max(0, sel.line || 0), lines.length - 1)]
    for (const g of specs) {
      if (g.key !== sel.key) continue
      const inset = Math.min(12, g.len / 4)
      const pts = g.orient === 'h'
        ? [[g.fx + inset, g.fy + g.thick / 2], [g.fx + g.len - inset, g.fy + g.thick / 2]]
        : [[g.fx + g.thick / 2, g.fy + inset], [g.fx + g.thick / 2, g.fy + g.len - inset]]
      pts.forEach(([x, y], e) => {
        const mode = line?.ends?.[g.piece]?.[e]?.mode === 'butt' ? 'butt' : 'through'
        markers.push({ key: g.key, piece: g.piece, end: e, x: X(x, 0), y, mode })
      })
    }
  }

  const part = partRec(model, pk)
  const partName = part.name || layout.parts.find((p) => p.key === pk)?.name || pk
  const count = part.count ?? 1
  const opening = pk === 'sash' ? openingOf(model, buttOf, W, H) : null
  let title = 'ภาพขยาย: ' + partName + (count > 1 ? ' × ' + count : '')
  if (sel && layout.positions[sel.key]) title += ' · ชิ้นที่เลือก: ' + (model.names?.[sel.key] || layout.positions[sel.key].name)
  if (opening) title += ' · ' + opening.text
  return { box: { ...ZOOM_BOX }, pieces, markers, title, opening }
}
