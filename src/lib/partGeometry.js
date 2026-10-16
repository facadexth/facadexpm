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
//
// Task 8 (every other layout kind): overviewSpecs / zoomSpecs dispatch to the per-kind bodies of partGeometryBodies.js, drawn
// in MILLIMETRES (frame at [0,W] × [0,H], box.scale 1, box.viewBox the drawing's mm viewBox incl. margins), with the same
// flush-butt rule as below (a butt end is shortened by the drawn thickness of its corner partner; tee transoms, mullions,
// free lines and mitred sashes keep their body run). sliding_2 keeps the frozen pixel-box drawing below, byte for byte.
import { LAYOUTS, partnerEnd, pieceCount, trackOf, isFixedPiece, lineFamily, pieceLabel as modelPieceLabel } from './partModel.js'
import { exprParams, rolesOf } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'
import { symbolFor } from './partSymbols.js'
import { BODIES, defaultThick } from './partGeometryBodies.js'

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

// The piece suffix shown after the position name ('' when the position has one piece).
// sliding_2 keeps its frozen wording ("บานซ้าย"/"บานขวา"); every other kind is a thin adapter over partModel.pieceLabel
// (layout.pieceNames, mirror-aware, then labels): its "<name>" / "<name> n" fallbacks become '' / "ชิ้นที่ n".
export function pieceLabel(model, layout, key, piece) {
  const pos = layout.positions[key]
  const n = pieceCount(model, key)
  if (model.layout_kind !== 'sliding_2') {
    const full = modelPieceLabel(model, key, piece)
    const name = model.names?.[key] || pos.name
    if (full === name) return ''
    if (full === `${name} ${piece + 1}`) return `ชิ้นที่ ${piece + 1}`
    return full
  }
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

// Mockup geomSash: hook stile on the left (rail end 0), key stile on the right (rail end 1).
// `mirrored` (owner 2026-10-16, Q7, D7; Nakhon Nayok p15 (26)): the LEFT sash of a 2-sash unit is drawn the other way
// round, key stile on the left (at the jamb) and hook stile on the right, so the two hook stiles meet (and overlap, U8)
// in the middle and both key stiles stand at the jambs. Its rails get flip: end 0 (the hook end, joint v[0]) is on the
// right. Costing is unchanged: every sash still has one key + one hook stile.
function geomSash(sx, sy, sw, sh, th, k, mirrored = false) {
  const key = th('key_stile'), hook = th('hook_stile')
  const flip = mirrored ? { flip: true } : {}
  return [
    { key: 'sash_top', piece: k, orient: 'h', fx: sx, fy: sy, len: sw, thick: th('sash_top'), ...flip },
    { key: 'sash_bottom', piece: k, orient: 'h', fx: sx, fy: sy + sh - th('sash_bottom'), len: sw, thick: th('sash_bottom'), ...flip },
    { key: 'key_stile', piece: k, orient: 'v', fx: mirrored ? sx : sx + sw - key, fy: sy, len: sh, thick: key },
    { key: 'hook_stile', piece: k, orient: 'v', fx: mirrored ? sx + sw - hook : sx, fy: sy, len: sh, thick: hook },
  ]
}
// D7: in a 2-sash drawing sash 0 (the left one) is the mirrored one.
const mirroredSash = (k, n) => n === 2 && k === 0

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
    // g.flip: the piece's end 0 is on its right (the mirrored left sash's rails, D7)
    const span = (pair) => {
      const a = ins(pair, g.flip ? 1 : 0), b = ins(pair, g.flip ? 0 : 1)
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
  if (BODIES[model.layout_kind]) return overviewMm({ model, layout, widthMm, heightMm, view, widthOf })
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
  for (const k of sashOrder(nSash, mirror)) specs = specs.concat(geomSash(ix + (k ? inW - pwid : 0), iy, pwid, inH, th, k, mirroredSash(k, nSash)))

  const pieces = piecesOf({ model, layout, specs, th, X })
  const dims = [
    { kind: 'width', x1: x0, y1: y0 + ph + 16, x2: x0 + pw, y2: y0 + ph + 16, tx: x0 + pw / 2, ty: y0 + ph + 30, anchor: 'middle', value: W },
    { kind: 'height', x1: x0 + pw + 16, y1: y0, x2: x0 + pw + 16, y2: y0 + ph, tx: x0 + pw + 22, ty: y0 + ph / 2, anchor: 'start', value: H },
  ]
  const legacy = legacyExtras({ model, layout, pieces, nSash, mirror, X, sash: (k) => {
    const x = ix + (k ? inW - pwid : 0)
    const leftStile = mirroredSash(k, nSash) ? th('key_stile') : th('hook_stile')
    return { x: x + leftStile, y: iy + th('sash_top'), w: pwid - th('hook_stile') - th('key_stile'), h: inH - th('sash_top') - th('sash_bottom') }
  } })
  return { box: { ...OVERVIEW_BOX, frameX: x0, frameY: y0, frameW: pw, frameH: ph, scale: sc }, pieces, dims, ...legacy }
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
export function zoomSpecs({ model, partKey, partIdx, selected, view = 'out', widthMm, heightMm, buttOf, widthOf } = {}) {
  const layout = layoutOf(model)
  if (!layout) return emptyZoom()
  if (BODIES[model.layout_kind]) return zoomMm({ model, layout, partKey, partIdx, selected, view, widthMm, heightMm, widthOf })
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
    for (let k = 0; k < n; k++) specs = specs.concat(geomSash(sx + k * (sw + gap), 25, sw, sh, th, k, mirroredSash(k, n)))
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
      if (g.flip) pts.reverse()   // end 0 of a mirrored left sash's rail is on its right (D7)
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

// ---------------------------------------------------------------- Task 8: shared piece metadata

// { part, partIdx, track, mitre } of one piece: partIdx = piece ÷ (pieces per part instance); track only for parts that
// declare one (partModel.trackOf); mitre for members of a part whose corner is 'mitre' (free positions excepted).
function pieceMeta(model, layout, key, piece) {
  const pos = layout.positions[key]
  const lp = layout.parts.find((p) => p.key === pos.part) || {}
  let per = 1
  try { per = Math.max(1, Math.round(evalExpr(pos.per ?? 1, exprParams(model)))) } catch { per = 1 }
  const partIdx = Math.floor(piece / per)
  return { part: pos.part, partIdx, track: lp.track ? trackOf(model, pos.part, partIdx) : null, mitre: lp.corner === 'mitre' && pos.corner !== 'free' }
}

const swapHinge = (h) => (h === 'left' ? 'right' : h === 'right' ? 'left' : h)

// sliding_2 (frozen pixel box): metadata on the pieces + the sash panes and slide symbols, for the brief's common shape.
// The sliding_2 SVG does not draw these (its output is pinned byte for byte).
function legacyExtras({ model, layout, pieces, nSash, mirror, X, sash }) {
  for (const p of pieces) Object.assign(p, pieceMeta(model, layout, p.key, p.piece))
  const glass = [], symbols = []
  for (let k = 0; k < nSash; k++) {
    const r = sash(k)
    const g = { ...r, x: X(r.x, r.w) }
    glass.push({ ...g, fixed: isFixedPiece(model, 'sash', k), kind: 'glass', part: 'sash', partIdx: k })
    const s = symbolFor(model, 'sash', k, { view: mirror ? 'in' : 'out' })
    symbols.push({ ...s, ...g, dir: mirror ? -s.dir : s.dir, part: 'sash', partIdx: k })
  }
  return { glass, symbols, hardwareMarks: [] }
}

// ---------------------------------------------------------------- Task 8: millimetre drawing for every other kind

function sizeOf(widthMm, heightMm) {
  return { W: Math.max(1, Number(widthMm) || 0), H: Math.max(1, Number(heightMm) || 0) }
}

// The body context: drawn thickness per position (widthOf in mm, else the mockup constants), counts, symbols, params.
function bodyCtx(model, layout, W, H, widthOf, view) {
  const kind = model.layout_kind
  const ep = exprParams(model)
  const th = (key) => {
    if (widthOf) {
      const fam = lineFamily(model, key, 0)   // own family, else the layout's familyFrom
      const mm = fam ? num(widthOf(fam)) : null
      if (mm != null && mm > 0) return mm
    }
    return defaultThick(kind, key, model.params)
  }
  const has = (key) => !!(layout.positions[key] && model.lines[key]?.length)
  const count = (key) => {
    if (!has(key)) return 0
    try { return pieceCount(model, key) } catch { return 0 }
  }
  const partCount = (partKey) => {
    try { return Math.max(0, Math.min(10, Math.round(evalExpr(model.parts.find((p) => p.key === partKey)?.count ?? 1, ep)))) } catch { return 0 }
  }
  return {
    model, layout, kind, W, H, th, has, count, partCount,
    sw: Math.max(W, H) / 220,
    params: model.params || {},
    roles: rolesOf(layout),
    int: (k, dflt) => (Number.isFinite(ep[k]) ? Math.max(dflt, Math.round(ep[k])) : dflt),
    sym: (partKey, idx) => symbolFor(model, partKey, idx, { view }),   // hinge / dir are outside-view geometry; dashed follows the view
    fixed: (partKey, idx) => isFixedPiece(model, partKey, idx),
    track: (partKey, idx) => trackOf(model, partKey, idx),
  }
}

// Body specs -> pieces (one per piece per line, drawing order), the sliding_2 rule for butt ends, mirrored for the inside view.
function piecesMm(model, layout, specs, th, X) {
  const out = []
  for (const g of specs) {
    const lines = model.lines[g.key] || []
    const ins = (pair, e) => {
      if (g.run === 'fixed') return 0
      const end = pair?.[e] || THROUGH
      if (end.mode !== 'butt') return 0
      const pt = partnerEnd(model, g.key, g.piece, e)
      const target = pt?.key || end.to?.key
      return Math.min(g.len / 3, target ? th(target) : 0)
    }
    const name = model.names?.[g.key] || layout.positions[g.key].name
    const label = [name, pieceLabel(model, layout, g.key, g.piece)].filter(Boolean).join(' ')
    const meta = pieceMeta(model, layout, g.key, g.piece)
    lines.forEach((line, li) => {
      const pair = line?.ends?.[g.piece]
      const a = ins(pair, g.flip ? 1 : 0), b = ins(pair, g.flip ? 0 : 1)
      const len = Math.max(1, g.len - a - b)
      let x, y, w, h
      if (li === 0) {
        if (g.orient === 'h') { x = g.fx + a; y = g.fy; w = len; h = g.thick } else { x = g.fx; y = g.fy + a; w = g.thick; h = len }
      } else {
        const tk = Math.max(3, g.thick * 0.28)
        if (g.orient === 'h') { x = g.fx + a; y = g.fy + g.thick - tk; w = len; h = tk } else { x = g.fx + g.thick - tk; y = g.fy + a; w = tk; h = len }
      }
      const mx = X(x, w)
      const p = { key: g.key, piece: g.piece, orient: g.orient, x: mx.x, y, w, h, role: li === 0 ? 'main' : 'extra', line: li, label, ...meta }
      if (g.mside) p.mside = mx.mirror ? swapHinge(g.mside) : g.mside
      if (g.flip || mx.mirror) p.endsRight = !!g.flip !== mx.mirror   // end 0 drawn on the right
      out.push(p)
    })
  }
  return out
}

function overviewMm({ model, layout, widthMm, heightMm, view, widthOf }) {
  const { W, H } = sizeOf(widthMm, heightMm)
  const mirror = view === 'in'
  const c = bodyCtx(model, layout, W, H, widthOf, mirror ? 'in' : 'out')
  const X = (x, w) => ({ x: mirror ? W - x - w : x, mirror })
  const body = BODIES[model.layout_kind](c)
  const pieces = piecesMm(model, layout, body.specs, c.th, X)
  const mx = (r) => (mirror ? { ...r, x: W - r.x - r.w } : { ...r })
  const glass = body.glass.map(mx)
  const symbols = body.symbols.map((s) => (mirror ? { ...mx(s), hinge: swapHinge(s.hinge), dir: s.dir ? -s.dir : s.dir } : { ...s }))
  const hardwareMarks = body.marks.map((k) => (k.x1 !== undefined ? (mirror ? { ...k, x1: W - k.x1, x2: W - k.x2 } : { ...k }) : mx(k)))
  const cells = (body.cells || []).map(mx)   // curtain-wall cell click targets { x, y, w, h, r, c, kind }
  const sw = c.sw
  const dims = [
    { kind: 'width', x1: 0, y1: H + sw * 14, x2: W, y2: H + sw * 14, tx: W / 2, ty: H + sw * 14 + sw * 11, anchor: 'middle', value: W },
    { kind: 'height', x1: W + sw * 14, y1: 0, x2: W + sw * 14, y2: H, tx: W + sw * 17, ty: H / 2, anchor: 'start', value: H },
    ...body.dims.map((d) => {
      const x1 = mirror ? W - d.x2 : d.x1, x2 = mirror ? W - d.x1 : d.x2, y = d.y1 - sw * 8
      return { ...d, x1, x2, y1: y, y2: y, tx: (x1 + x2) / 2, ty: y - sw * 2, anchor: 'middle' }
    }),
  ]
  const xs = [0, W, ...pieces.flatMap((p) => [p.x, p.x + p.w])]
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const m = Math.max(W, H) * 0.12
  // box.x / box.y / box.w / box.h = the mm viewBox (margins for the dimension lines; hanging_door's rail widens it)
  return {
    box: { x: minX - m, y: -m, w: maxX - minX + 2 * m, h: H + 2 * m, frameX: 0, frameY: 0, frameW: W, frameH: H, scale: 1, sw, units: 'mm' },
    pieces, glass, symbols, hardwareMarks, dims, cells,
  }
}

// Zoom = the overview with every piece outside the chosen part instance faded to 0.25 (mockup openZoom: part tabs are
// model.parts × count, `partIdx` null = every instance of the part, `partKey` null = ทั้งชุด) and end markers on the
// selected position's pieces in that instance (mode 'mitre' for mitred members: their ends are cut 45°, not toggled).
function zoomMm({ model, layout, partKey, partIdx, selected, view, widthMm, heightMm, widthOf }) {
  const ov = overviewMm({ model, layout, widthMm, heightMm, view, widthOf })
  const sel = typeof selected === 'string' ? { key: selected, line: 0 } : (selected || null)
  const pk = partKey === undefined ? (sel && partOfKey(layout, sel.key)) || null : partKey
  const idx = Number.isInteger(partIdx) ? partIdx : null
  const inPart = (x) => !pk || (x.part === pk && (idx === null || x.partIdx === idx))
  const pieces = ov.pieces.map((p) => ({ ...p, opacity: inPart(p) ? 1 : 0.25, selected: !!sel && p.key === sel.key && p.line === (sel.line || 0) && inPart(p) }))
  const fade = (x) => ({ ...x, opacity: inPart(x) ? 1 : 0.25 })
  const markers = []
  if (sel && model.lines[sel.key]?.length) {
    const li = Math.min(Math.max(0, sel.line || 0), model.lines[sel.key].length - 1)
    for (const p of pieces) {
      if (!p.selected || p.line !== li) continue
      const len = p.orient === 'h' ? p.w : p.h
      const inset = Math.min(len / 4, ov.box.sw * 8)
      const pts = p.orient === 'h'
        ? [[p.x + inset, p.y + p.h / 2], [p.x + p.w - inset, p.y + p.h / 2]]
        : [[p.x + p.w / 2, p.y + inset], [p.x + p.w / 2, p.y + p.h - inset]]
      if (p.orient === 'h' && p.endsRight) pts.reverse()
      pts.forEach(([x, y], e) => {
        const mode = p.mitre ? 'mitre' : model.lines[sel.key][li]?.ends?.[p.piece]?.[e]?.mode === 'butt' ? 'butt' : 'through'
        markers.push({ key: p.key, piece: p.piece, end: e, x, y, mode })
      })
    }
  }
  const part = pk ? partRec(model, pk) : {}
  const partName = pk ? part.name || layout.parts.find((p) => p.key === pk)?.name || pk : 'ทั้งชุด'
  let count = 1
  try { count = pk ? Math.round(evalExpr(part.count ?? 1, exprParams(model))) : 1 } catch { count = 1 }
  let title = 'ภาพขยาย: ' + partName + (idx !== null ? ` ${idx + 1}` : count > 1 ? ' × ' + count : '')
  if (sel && layout.positions[sel.key]) title += ' · ชิ้นที่เลือก: ' + (model.names?.[sel.key] || layout.positions[sel.key].name)
  return {
    box: ov.box, pieces, glass: ov.glass.map(fade), symbols: ov.symbols.map(fade), hardwareMarks: ov.hardwareMarks.map((k) => ({ ...k, opacity: pk ? 0.25 : 1 })),
    dims: ov.dims, cells: ov.cells, markers, title, opening: null, partKey: pk, partIdx: idx,
  }
}
