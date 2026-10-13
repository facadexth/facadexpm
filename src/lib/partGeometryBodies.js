// Per-layout drawing bodies of the part editor, in millimetres (frame at [0,W] × [0,H], y down, outside view).
// Ported from the accepted mockup docs/reference/type-previews-mockup.html (BODY.grid / cw / door / casement / awning /
// sliding / sliding3 / slidingFixed / rail / fold, sashBox, frame4, gridBars) with the same formulas. Pure: no I/O.
//
// A body gets a context `c` (built by partGeometry.overviewSpecs) and returns
//   { specs, glass, symbols, marks, dims }
// specs[i] = { key, piece, orient:'h'|'v', fx, fy, len, thick, run?, flip?, mside? } — the FULL run of one piece (both ends
//   through); partGeometry shortens butt ends by the drawn thickness of the corner partner, like sliding_2's overview.
//   run 'fixed' = draw exactly this run whatever the stored end modes (tee transoms R-3a, mullions, free lines, mitred sashes).
//   flip = the piece's end 0 is on its right (a rail whose joint partner v[0] stands on the right of the sash).
//   mside = which side of a mitred sash the member is (the SVG draws its 45° corner lines).
// glass[i] = { x, y, w, h, fixed, kind: 'glass'|'spandrel'|'frameless', part?, partIdx? }
// symbols[i] = { kind: 'v_hinge'|'slide'|'fold'|'none'|'arrow'|'split', x, y, w, h, hinge, dashed, dir, part?, partIdx? }
//   (outside view; 'arrow' spans x..x+w and points `dir`; 'split' is a dashed vertical at x from y to y+h)
// marks[i] = hardware / drawing marks: rect kinds { kind, x, y, w, h } (closer, pivot, hinge, handle, patch, pull,
//   floor_lock, hanger, floor_guide, silicone) or line kinds { kind, x1, y1, x2, y2 } (floor_line, unit_joint). Drawing-only (G9).
// cells[i] (curtain_wall only) = { x, y, w, h, r, c, kind } the whole cell, for click-to-cycle (Task 10).
// dims[i] = extra dimension lines { kind: 'leaf'|'side', x1, y1, x2, y2, value, label } (W and H are added by the caller).
import { cellKinds } from './layoutCells.js'
import { foldSymbols } from './partSymbols.js'
import { sequenceOf, isMirrored } from './partModel.js'

const FIXED = { run: 'fixed' }
const H_ = (key, piece, fx, fy, len, thick, o = {}) => ({ key, piece, orient: 'h', fx, fy, len, thick, ...o })
const V_ = (key, piece, fx, fy, len, thick, o = {}) => ({ key, piece, orient: 'v', fx, fy, len, thick, ...o })

// Drawing constants when widthOf cannot resolve a profile (the mockup's PW): frame 45, mullion/transom 60 (curtain wall 65),
// sash 50, door stile/rail 100, track 60 (folding head) / 80 (hanging rail).
export function defaultThick(kind, key, params) {
  if (key === 'mullion' || key === 'transom') return kind === 'curtain_wall' ? 65 : 60
  if (key === 'frame_bottom' && params?.door) return 18
  if (key.startsWith('frame_') || key === 'sill' || key === 'track_side') return 45
  if (key === 'track_top') return 60
  if (key === 'track_bottom') return 30
  if (key === 'track_rail') return 80
  if (key === 'track_cover') return 25
  if (key.startsWith('plate_')) return 30
  if (key.startsWith('cover_')) return 20
  if (key === 'sill_cover' || key.startsWith('leaf_cover')) return 15
  if (key.startsWith('leaf_') && kind === 'swing_door') return 100
  return 50
}

// Mockup frame4: sides full height, head / bottom full width (their default butt ends make them run between the sides).
function frame4(c, { top = 'frame_top', bottom = 'frame_bottom', side = 'frame_side' } = {}) {
  const { W, H, th } = c
  const out = []
  if (c.has(top)) out.push(H_(top, 0, 0, 0, W, th(top)))
  if (bottom && c.has(bottom)) out.push(H_(bottom, 0, 0, H - th(bottom), W, th(bottom)))
  if (c.has(side)) out.push(V_(side, 0, 0, 0, H, th(side)), V_(side, 1, W - th(side), 0, H, th(side)))
  return out
}

// Mockup sashBox: stiles full height, rails full width (butt ends shortened by the caller), or a mitred box (all four full,
// corners cut 45°). k = { top, bottom, piece, left: [key, piece], right: [key, piece] }. Returns specs + the glass rect.
function sashBox(c, r, k, { mitre = false, flip = false } = {}) {
  const { th } = c
  const tt = th(k.top), tb = th(k.bottom), sl = th(k.left[0]), sr = th(k.right[0])
  const o = (side) => (mitre ? { run: 'fixed', mside: side } : {})
  const specs = [
    V_(k.left[0], k.left[1], r.x, r.y, r.h, sl, o('left')),
    V_(k.right[0], k.right[1], r.x + r.w - sr, r.y, r.h, sr, o('right')),
    H_(k.top, k.piece, r.x, r.y, r.w, tt, { ...o('top'), ...(flip ? { flip } : {}) }),
    H_(k.bottom, k.piece, r.x, r.y + r.h - tb, r.w, tb, { ...o('bottom'), ...(flip ? { flip } : {}) }),
  ]
  return { specs, inner: { x: r.x + sl, y: r.y + tt, w: r.w - sl - sr, h: r.h - tt - tb } }
}

const symAt = (c, partKey, idx, rect, part = partKey) => ({ ...c.sym(partKey, idx), ...rect, part, partIdx: idx })
const sideDim = (x1, x2, y, label, value) => ({ kind: 'leaf', x1, y1: y, x2, y2: y, value, label })
const perLeafLabel = (v) => `${Math.round(v)} ต่อบาน`

// Mockup gridBars: mullions run the full inner height, transoms span one cell (mullion face to mullion face, R-3a).
// Transom piece index is column-major (i·(R−1) + j−1), like the mockup's loop.
function gridBars(c, R, C) {
  const { W, H, th } = c
  const s = th('frame_side'), t = th('frame_top'), b = th('frame_bottom')
  const m = th('mullion'), tm = c.has('transom') ? th('transom') : m
  const x0 = s, y0 = t, iw = W - 2 * s, ih = H - t - b
  const cw = (iw - (C - 1) * m) / C, ch = (ih - (R - 1) * tm) / R
  const specs = frame4(c)
  if (c.has('mullion')) for (let i = 1; i < C; i++) specs.push(V_('mullion', i - 1, x0 + i * cw + (i - 1) * m, y0, ih, m, FIXED))
  if (c.has('transom')) for (let i = 0; i < C; i++) for (let j = 1; j < R; j++) specs.push(H_('transom', i * (R - 1) + j - 1, x0 + i * (cw + m), y0 + j * ch + (j - 1) * tm, cw, tm, FIXED))
  return { specs, cell: (i, j) => ({ x: x0 + i * (cw + m), y: y0 + j * (ch + tm), w: cw, h: ch }) }
}

const empty = () => ({ specs: [], glass: [], symbols: [], marks: [], dims: [] })
const MITRE_KEYS = (k) => ({ top: 'sash_top', bottom: 'sash_bottom', piece: k, left: ['sash_side', 2 * k], right: ['sash_side', 2 * k + 1] })

function fixed_grid(c) {
  const R = c.int('rows', 1), C = c.int('cols', 1)
  const g = gridBars(c, R, C)
  const out = { ...empty(), specs: g.specs }
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) out.glass.push({ ...g.cell(i, j), fixed: true, kind: 'glass' })
  return out
}

// awning_grid / casement_n: one mitred sash per cell (row-major sash index), V apex at the hinge.
function sashGrid(c, R, C) {
  const g = gridBars(c, R, C)
  const out = { ...empty(), specs: g.specs }
  const n = c.count('sash_top')
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
    const k = j * C + i
    const cell = g.cell(i, j)
    if (k >= n) { out.glass.push({ ...cell, fixed: false, kind: 'glass' }); continue }
    const box = sashBox(c, cell, MITRE_KEYS(k), { mitre: true })
    out.specs.push(...box.specs)
    out.glass.push({ ...box.inner, fixed: false, kind: 'glass', part: 'sash', partIdx: k })
    out.symbols.push(symAt(c, 'sash', k, box.inner))
  }
  return out
}
const awning_grid = (c) => sashGrid(c, c.int('rows', 1), c.int('cols', 1))
const casement_n = (c) => sashGrid(c, 1, c.int('n', 1))

// Sliding sashes on tracks: rects left to right, drawn back track first (front last, so it covers the hook overlap).
// sashOf(i) = { part, idx, top, bottom, left: [key, piece], right: [key, piece], flip } of the i-th sash from the left.
function slidingSashes(c, rects, sashOf) {
  const out = []
  const tr = (i) => { const s = sashOf(i); return c.track(s.part, s.idx) }
  const order = rects.map((r, i) => i).sort((a, b) => (tr(b) - tr(a)) || a - b)
  for (const i of order) {
    const s = sashOf(i)
    const box = sashBox(c, rects[i], { top: s.top, bottom: s.bottom, piece: s.idx, left: s.left, right: s.right }, { flip: s.flip })
    out.push({ s, box })
  }
  return out
}

function slidingBody(c, rects, sashOf, frameExtras = []) {
  const out = { ...empty(), specs: [...frame4(c), ...frameExtras] }
  for (const { s, box } of slidingSashes(c, rects, sashOf)) {
    out.specs.push(...box.specs)
    out.glass.push({ ...box.inner, fixed: c.fixed(s.part, s.idx), kind: 'glass', part: s.part, partIdx: s.idx })
    out.symbols.push(symAt(c, s.part, s.idx, box.inner))
  }
  return out
}

// sliding_n / sliding_3track (R-F1): the sashes are the instances of the layout's sequence parts, left to right
// (partModel.sequenceOf, reversed when mirrored). Sash width (inner + (n−1)·overlap) / n, sash i at x = side + i·(width − overlap)
// (mockup sliding). Each part's rails / stiles come from its own rail joint (v = [left stile, right stile] as defined);
// a mirrored row (3-track fixed on the right) swaps them, so its rails' end 0 stands on the right (flip).
function evenSliding(c) {
  const { W, H, th, layout, model } = c
  const row = sequenceOf(model) || []
  const n = row.length
  if (n < 1) return { ...empty(), specs: frame4(c) }
  const s = th('frame_side'), t = th('frame_top'), b = th('frame_bottom'), ov = th(c.roles.hook)
  const iw = W - 2 * s, pw = (iw + (n - 1) * ov) / n
  const rects = Array.from({ length: n }, (_, i) => ({ x: s + i * (pw - ov), y: t, w: pw, h: H - t - b }))
  const mirror = isMirrored(model)
  const sashOf = (i) => {
    const { part, idx } = row[i]
    const keys = layout.parts.find((p) => p.key === part)?.positions || []
    const [top, bottom] = keys.filter((k) => layout.positions[k].orient === 'h')
    const v = layout.joints.find((j) => j.h === top)?.v || []
    const [l, r] = mirror ? [v[1], v[0]] : [v[0], v[1]]
    return { part, idx, top, bottom, left: [l, idx], right: [r, idx], flip: mirror }
  }
  return slidingBody(c, rects, sashOf)
}
const sliding_n = (c) => evenSliding(c)
const sliding_3track = (c) => evenSliding(c)

// sliding_2_fixed_2 (mockup slidingFixed, equal sashes as the data's ¼ rails): hooks overlap at the two fixed/sliding
// meetings, the two sliding sashes meet key to key in the middle. stile_a = left stile, stile_b = right stile of every sash.
function sliding_2_fixed_2(c) {
  const { W, H, th } = c
  const s = th('frame_side'), t = th('frame_top'), b = th('frame_bottom'), ov = th(c.roles.hook)
  const iw = W - 2 * s, pw = (iw + 2 * ov) / 4, h = H - t - b
  const xs = [s, s + pw - ov, s + 2 * pw - ov, s + 3 * pw - 2 * ov]
  const n = Math.min(4, c.count('sash_top'))
  const rects = xs.slice(0, n).map((x) => ({ x, y: t, w: pw, h }))
  // ตบธรณี (free, W × 0.5 in costing): drawn as a thin strip on the sill's inner edge
  const sill = c.has('sill_cover') ? [H_('sill_cover', 0, s, H - b, iw, Math.min(th('sill_cover'), b), FIXED)] : []
  return slidingBody(c, rects, (i) => ({ part: 'sash', idx: i, top: 'sash_top', bottom: 'sash_bottom', left: ['stile_a', i], right: ['stile_b', i], flip: false }), sill)
}

// Mockup door (swing): leaves = inner W / leaves, hinge stile on the hinge side; pivot → closer box in the head + top/bottom
// pivots, hinged → 3 hinge ticks; handle on the handle stile; no sill → sides to the floor and a dashed floor line.
function swing_door(c) {
  const { W, H, th, sw } = c
  const sill = c.has('sill')
  const out = { ...empty(), specs: frame4(c, { bottom: sill ? 'sill' : null }) }
  const s = th('frame_side'), t = th('frame_top'), sb = sill ? th('sill') : 0
  const x0 = s, y0 = t, iw = W - 2 * s, ih = H - t - sb - (sill ? 0 : 10)
  const L = c.count('leaf_rail_top')
  if (L < 1) return out
  const lw = iw / L, st = th('leaf_stile_hinge')
  for (let i = 0; i < L; i++) {
    const sym = c.sym('leaf', i)
    const hl = sym.hinge !== 'right'
    const r = { x: x0 + i * lw, y: y0, w: lw, h: ih }
    const hinge = ['leaf_stile_hinge', i], handle = ['leaf_stile_handle', i]
    const box = sashBox(c, r, { top: 'leaf_rail_top', bottom: 'leaf_rail_bottom', piece: i, left: hl ? hinge : handle, right: hl ? handle : hinge }, { flip: !hl })
    out.specs.push(...box.specs)
    out.glass.push({ ...box.inner, fixed: false, kind: 'glass', part: 'leaf', partIdx: i })
    out.symbols.push(symAt(c, 'leaf', i, box.inner))
    const hx = hl ? r.x + st * 0.5 : r.x + lw - st * 0.5
    if (c.params.pivot) {
      out.marks.push({ kind: 'closer', x: r.x + lw / 2 - lw * 0.18, y: y0 - t * 0.8, w: lw * 0.36, h: t * 0.6 })
      out.marks.push({ kind: 'pivot', x: hx - sw * 2.5, y: y0 - sw * 2.5, w: sw * 5, h: sw * 5 }, { kind: 'pivot', x: hx - sw * 2.5, y: y0 + ih - sw * 2.5, w: sw * 5, h: sw * 5 })
    } else {
      for (const hy of [0.12, 0.5, 0.88]) out.marks.push({ kind: 'hinge', x: hx - sw * 2, y: y0 + ih * hy - sw * 8, w: sw * 4, h: sw * 16 })
    }
    const kx = hl ? r.x + lw - st * 0.5 : r.x + st * 0.5
    out.marks.push({ kind: 'handle', x: kx - sw * 2.5, y: y0 + ih * 0.5 - sw * 14, w: sw * 5, h: sw * 28 })
  }
  if (!sill) out.marks.push({ kind: 'floor_line', x1: s, y1: H, x2: W - s, y2: H })
  if (L > 1) out.dims.push(sideDim(x0, x0 + lw, 0, perLeafLabel(lw), lw))
  return out
}

// Mockup door (frameless, D6): glass leaves in the head + sides frame, patch fittings flush top and bottom on the hinge side,
// a stainless pull handle and a floor lock near the free edge, dashed floor line (no threshold).
function frameless_door(c) {
  const { W, H, th, sw } = c
  const out = { ...empty(), specs: frame4(c, { bottom: null }) }
  const s = th('frame_side'), t = c.has('frame_top') ? th('frame_top') : 0
  const x0 = s, y0 = t, iw = W - 2 * s, ih = H - t - 10
  const L = c.partCount('leaf')
  const lw = L > 0 ? iw / L : iw
  for (let i = 0; i < L; i++) {
    const sym = c.sym('leaf', i)
    const hl = sym.hinge !== 'right'
    const x = x0 + i * lw
    const gx = x + (i ? 6 : 0), gw = lw - (L > 1 ? 6 : 0)
    const g = { x: gx, y: y0, w: gw, h: ih }
    out.glass.push({ ...g, fixed: false, kind: 'frameless', part: 'leaf', partIdx: i })
    const pw = gw * 0.22, ph = sw * 9, px = hl ? gx : gx + gw - pw
    out.marks.push({ kind: 'patch', x: px, y: y0, w: pw, h: ph }, { kind: 'patch', x: px, y: y0 + ih - ph, w: pw, h: ph })
    const bx = hl ? gx + gw * 0.86 : gx + gw * 0.14, bw = sw * 3
    out.marks.push({ kind: 'pull', x: bx - bw / 2, y: y0 + ih * 0.33, w: bw, h: ih * 0.34 })
    out.marks.push({ kind: 'floor_lock', x: bx - sw * 5, y: y0 + ih - sw * 7, w: sw * 10, h: sw * 7 })
    out.symbols.push(symAt(c, 'leaf', i, g))
  }
  out.marks.push({ kind: 'floor_line', x1: s, y1: H, x2: W - s, y2: H })
  if (L > 1) out.dims.push(sideDim(x0, x0 + lw, 0, perLeafLabel(lw), lw))
  return out
}

// Mockup rail: the track runs past the opening by a quarter of W each side (factor-2 rail drawn as 1.5·W), sides below it,
// leaves hang from it (hanger marks), a small floor guide; arrows: single →, double outward from the middle.
function hanging_door(c) {
  const { W, H, th, sw } = c
  const out = empty()
  const trk = th('track_rail'), cov = c.has('track_cover') ? th('track_cover') : 0
  if (c.has('track_rail')) out.specs.push(H_('track_rail', 0, -W * 0.25, 0, W * 1.5, trk, FIXED))
  if (c.has('track_cover')) out.specs.push(H_('track_cover', 0, -W * 0.25, trk, W * 1.5, cov, FIXED))
  const y1 = trk + cov, f = th('frame_side')
  if (c.has('frame_side')) out.specs.push(V_('frame_side', 0, 0, y1, H - y1, f, FIXED), V_('frame_side', 1, W - f, y1, H - y1, f, FIXED))
  const L = c.count('leaf_rail_top')
  const iw = W - 2 * f, lw = L > 0 ? iw / L : iw
  for (let i = 0; i < L; i++) {
    const r = { x: f + i * lw, y: y1, w: lw, h: H - y1 - 10 }
    const box = sashBox(c, r, { top: 'leaf_rail_top', bottom: 'leaf_rail_bottom', piece: i, left: ['leaf_stile_a', i], right: ['leaf_stile_b', i] })
    out.specs.push(...box.specs)
    out.glass.push({ ...box.inner, fixed: false, kind: 'glass', part: 'leaf', partIdx: i })
    out.symbols.push(symAt(c, 'leaf', i, box.inner))
    for (const hx of [0.2, 0.8]) out.marks.push({ kind: 'hanger', x: r.x + lw * hx - sw * 3, y: y1 - sw * 4, w: sw * 6, h: sw * 8 })
  }
  out.marks.push({ kind: 'floor_guide', x: W * 0.5 - 30, y: H - 10, w: 60, h: 10 })
  if (L > 1) out.dims.push(sideDim(f, f + lw, 0, perLeafLabel(lw), lw))
  return out
}

// Mockup fold: track frame, n = nL + nR equal leaves, V per leaf (partSymbols.foldSymbols), hinge ticks on every edge
// between two leaves of the same side, stack arrows, a dashed split line when both sides have leaves.
function folding_door(c) {
  const { W, H, th, sw } = c
  const out = { ...empty(), specs: frame4(c, { top: 'track_top', bottom: 'track_bottom', side: 'track_side' }) }
  const f = th('track_side'), trk = th('track_top'), bt = th('track_bottom')
  const n = c.count('leaf_top')
  if (n < 1) return out
  const nL = Math.min(n, c.int('nL', 0)), iw = W - 2 * f, pw = iw / n, lh = H - trk - bt
  const tk = (key) => Math.min(th(key), pw / 4)
  for (let i = 0; i < n; i++) {
    const r = { x: f + i * pw, y: trk, w: pw, h: lh }
    const box = sashBox(c, r, { top: 'leaf_top', bottom: 'leaf_bottom', piece: i, left: ['leaf_side', 2 * i], right: ['leaf_side', 2 * i + 1] })
    out.specs.push(...box.specs)
    const cv = tk('leaf_cover_v'), ch = tk('leaf_cover_h')
    if (c.has('leaf_cover_v')) out.specs.push(V_('leaf_cover_v', 2 * i, r.x, r.y, r.h, cv, FIXED), V_('leaf_cover_v', 2 * i + 1, r.x + pw - cv, r.y, r.h, cv, FIXED))
    if (c.has('leaf_cover_h')) out.specs.push(H_('leaf_cover_h', 2 * i, box.inner.x, box.inner.y, box.inner.w, ch, FIXED), H_('leaf_cover_h', 2 * i + 1, box.inner.x, box.inner.y + box.inner.h - ch, box.inner.w, ch, FIXED))
    out.glass.push({ ...box.inner, fixed: false, kind: 'glass', part: 'leaf', partIdx: i })
    out.symbols.push(symAt(c, 'leaf', i, box.inner))
    const sameSide = i + 1 < n && (i + 1 < nL || i >= nL)
    if (sameSide) for (const hy of [0.15, 0.5, 0.85]) out.marks.push({ kind: 'hinge', x: r.x + pw - sw * 2, y: trk + lh * hy - sw * 7, w: sw * 4, h: sw * 14 })
  }
  const fs = foldSymbols(c.model)
  const y = trk + lh * 0.5 + sw * 24
  for (const a of fs.arrows) {
    const len = a.count * pw * 0.5
    const x = a.dir < 0 ? f + a.count * pw * 0.7 - len : f + a.from * pw + a.count * pw * 0.3
    out.symbols.push({ kind: 'arrow', x, y, w: len, h: 0, dir: a.dir, hinge: null, dashed: false })
  }
  if (fs.split) out.symbols.push({ kind: 'split', x: f + nL * pw, y: trk, w: 0, h: lh, dir: 0, hinge: null, dashed: true })
  out.dims.push(sideDim(f, f + pw, 0, perLeafLabel(pw), pw))
  return out
}

// Mockup cw: mullions (cols+1) full height, transoms ((rows+1)·cols) mullion face to mullion face, cells glass / awning (mitred
// sash + V apex top) / spandrel; the free pressure plate and cover lines are drawn thin on the outer members (plate_h on the
// first mullion, cover_h on the last, plate_w on the top transom row, cover_w on the bottom row); unitized → unit joints.
function curtain_wall(c) {
  const { W, H, th } = c
  const R = c.int('rows', 1), C = c.int('cols', 1)
  const m = th('mullion'), tr = th('transom')
  const cw = (W - (C + 1) * m) / C, ch = (H - (R + 1) * tr) / R
  const out = { ...empty(), cells: [] }
  if (c.has('mullion')) for (let i = 0; i <= C; i++) out.specs.push(V_('mullion', i, i * (cw + m), 0, H, m, FIXED))
  if (c.has('transom')) for (let i = 0; i < C; i++) for (let j = 0; j <= R; j++) out.specs.push(H_('transom', i * (R + 1) + j, m + i * (cw + m), j * (ch + tr), cw, tr, FIXED))
  const thin = (key, host) => Math.min(th(key), host)
  const freeV = (key, x) => { if (c.has(key)) { const t = thin(key, m); out.specs.push(V_(key, 0, x + (m - t) / 2, 0, H, t, FIXED)) } }
  const freeH = (key, y) => { if (c.has(key)) { const t = thin(key, tr); out.specs.push(H_(key, 0, 0, y + (tr - t) / 2, W, t, FIXED)) } }
  freeV('plate_h', 0)
  freeV('cover_h', C * (cw + m))
  freeH('plate_w', 0)
  freeH('cover_w', R * (ch + tr))
  const kinds = cellKinds(c.model)
  const nSash = c.count('sash_top')
  let a = 0
  for (let r = 0; r < R; r++) for (let col = 0; col < C; col++) {
    const cell = { x: m + col * (cw + m), y: tr + r * (ch + tr), w: cw, h: ch }
    const kind = kinds[`${r},${col}`] || 'glass'
    out.cells.push({ ...cell, r, c: col, kind })   // click target of the cell (editor / item preview cycle its kind)
    if (kind === 'spandrel') { out.glass.push({ ...cell, fixed: false, kind: 'spandrel' }); continue }
    if (kind !== 'awning') { out.glass.push({ ...cell, fixed: true, kind: 'glass' }); continue }
    const k = a++
    if (k >= nSash) { out.glass.push({ ...cell, fixed: false, kind: 'glass' }); out.symbols.push(symAt(c, 'sash', k, cell, 'awning')); continue }
    const box = sashBox(c, cell, MITRE_KEYS(k), { mitre: true })
    out.specs.push(...box.specs)
    out.glass.push({ ...box.inner, fixed: false, kind: 'glass', part: 'awning', partIdx: k })
    // the layout's symbol entry is keyed 'sash' (partSymbols reads layout.symbol[partKey]); the part itself is 'awning'
    out.symbols.push(symAt(c, 'sash', k, box.inner, 'awning'))
  }
  if (c.params.unitized) {
    for (let i = 1; i <= C; i++) out.marks.push({ kind: 'unit_joint', x1: i * (cw + m) + m / 2, y1: 0, x2: i * (cw + m) + m / 2, y2: H })
    for (let j = 1; j <= R; j++) out.marks.push({ kind: 'unit_joint', x1: 0, y1: j * (ch + tr) + tr / 2, x2: W, y2: j * (ch + tr) + tr / 2 })
  }
  return out
}

// Mockup cw (frameless): frame ring, cols full-height panes with 12 mm silicone joints between them.
function frameless_wall(c) {
  const { W, H, th } = c
  const out = { ...empty(), specs: frame4(c) }
  const s = th('frame_side'), t = th('frame_top'), b = th('frame_bottom')
  const C = c.partCount('pane'), g = 12
  if (C < 1) return out
  const iw = W - 2 * s, ih = H - t - b, cw = (iw - (C - 1) * g) / C
  for (let i = 0; i < C; i++) out.glass.push({ x: s + i * (cw + g), y: t, w: cw, h: ih, fixed: c.fixed('pane', i), kind: 'frameless', part: 'pane', partIdx: i })
  for (let i = 0; i < C - 1; i++) out.marks.push({ kind: 'silicone', x: s + (i + 1) * cw + i * g, y: t, w: g, h: ih })
  return out
}

export const BODIES = {
  fixed_grid, awning_grid, casement_n, sliding_n, sliding_3track, sliding_2_fixed_2,
  swing_door, frameless_door, hanging_door, folding_door, curtain_wall, frameless_wall,
}
