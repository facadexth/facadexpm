// src/pages/bomTemplates/addon/addonView.js
// Pure view data for the add-on ("ช่องแสง") UI of the part editor (mockup v12: add-on box, overview add-ons, zoom card,
// piece table, effects). No React. Every length / quantity shown comes from addonExpand.expandAddons or
// addonModel (refValue, pieceQty, layoutAddons); the drawing helpers only place rectangles, they never price anything.
import {
  addonDims, layoutAddons, defaultAddonPieces, setKey, pieceQty, refValue, PIECE_LABEL,
  ADDON_MODE_LABEL, ADDON_KIND_LABEL, ADDON_POSITION_LABEL, ADDON_POSITIONS, REF_LABEL,
} from '../../../lib/addonModel.js'
import { expandAddons, pieceTotalM, piecesTotalM, explainAddonPiece } from '../../../lib/addonExpand.js'
import { reasonText } from '../../../lib/reasonText.js'
import { ISSUE_TEXT, fmt, posName } from '../partEditorView.js'

// mockup v12 wording (REFS_ALL / QOPTS)
export { REF_LABEL }
export const QTY_LABEL = { fixed: 'จำนวนคงที่', 'cols-1': 'จำนวนช่อง − 1', 'rows-1': 'จำนวนชั้น − 1', cols: 'จำนวนช่อง', rows: 'จำนวนชั้น', 'rows*cols': 'ชั้น × ช่อง' }
export const THICK_LABEL = { '': 'ตามกรอบ (เฟรม)', sash: 'ตามบาน (sash)' }

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const isH = (position) => position === 'top' || position === 'bottom'
const qtyOf = (r, a) => Number(pieceQty(r, a)) || 0
const MAX_GRID = 12   // bars drawn per direction (the quantity itself is never capped)

export const addonSummary = (a) =>
  `${ADDON_MODE_LABEL[a.mode] || a.mode} · ${ADDON_KIND_LABEL[a.kind] || a.kind} · ${ADDON_POSITION_LABEL[a.position] || a.position} · ` +
  `${fmt(a.len_mm, 0)} × ${fmt(a.thick_mm, 0)} มม. · ${a.rows} ชั้น × ${a.cols} ช่อง`

// ---------------------------------------------------------------- zoom drawing

// Grid bars (mullions vertical, rails horizontal) in the interior rect; mullions are split between the rails so no two
// rectangles overlap. qtyIndex numbers the bar within its key.
function gridPieces(out, rect, nMull, nRail, t) {
  const { x, y, w, h } = rect
  if (!(w > 0 && h > 0)) return
  const nm = Math.min(nMull, MAX_GRID), nr = Math.min(nRail, MAX_GRID)
  const gm = Math.min(t * 0.6, (w / (nm + 1)) * 0.5)
  const gr = Math.min(t * 0.6, (h / (nr + 1)) * 0.5)
  const railY = []
  for (let j = 1; j <= nr; j++) {
    const cy = y + (h * j) / (nr + 1)
    railY.push([cy - gr / 2, cy + gr / 2])
    out.push({ key: 'rail', qtyIndex: j - 1, role: 'grid', x, y: cy - gr / 2, w, h: gr })
  }
  const cuts = [y, ...railY.flat(), y + h]
  for (let i = 1; i <= nm; i++) {
    const cx = x + (w * i) / (nm + 1)
    for (let s = 0; s < cuts.length; s += 2) {
      if (cuts[s + 1] - cuts[s] > 0) out.push({ key: 'mullion', qtyIndex: i - 1, role: 'grid', x: cx - gm / 2, y: cuts[s], w: gm, h: cuts[s + 1] - cuts[s] })
    }
  }
}

// Rectangles per piece key whose qty > 0, tiling the add-on rectangle (0,0)-(w·scale, h·scale) of its real orientation.
// attach: own frame (sides through, top/bottom between) + grid. merge: drawn for a top add-on (main below), then turned to
// the real side: ext stubs (the main's frame members running past the add-on) outermost, overlay sides inside them, far
// frame on the outer edge, facing member / divider / bead stacked on the edge against the main, grid inside.
export function zoomPieces({ addon, rows, scale = 1 }) {
  const a = addon
  if (!a || !ADDON_POSITIONS.includes(a.position)) return []
  const s = num(scale) || 0
  const d = addonDims(a)
  const W = (num(d.w) || 0) * s, H = (num(d.h) || 0) * s
  if (!(W > 0 && H > 0)) return []
  const q = {}
  for (const r of rows || []) if (r && q[r.piece_key] == null) q[r.piece_key] = qtyOf(r, a)
  const n = (k) => q[k] || 0
  const out = []
  if (a.mode === 'attach') {
    const t = Math.min(W, H) * 0.07
    const l = n('frame_side') >= 1 ? t : 0, rgt = n('frame_side') >= 2 ? t : 0
    if (l) out.push({ key: 'frame_side', qtyIndex: 0, role: 'frame', x: 0, y: 0, w: t, h: H })
    if (rgt) out.push({ key: 'frame_side', qtyIndex: 1, role: 'frame', x: W - t, y: 0, w: t, h: H })
    const top = n('frame_top') ? t : 0, bot = n('frame_bottom') ? t : 0
    if (top) out.push({ key: 'frame_top', qtyIndex: 0, role: 'frame', x: l, y: 0, w: W - l - rgt, h: t })
    if (bot) out.push({ key: 'frame_bottom', qtyIndex: 0, role: 'frame', x: l, y: H - t, w: W - l - rgt, h: t })
    gridPieces(out, { x: l, y: top, w: W - l - rgt, h: H - top - bot }, n('mullion'), n('rail'), t)
    return out
  }
  const L = isH(a.position) ? W : H, T = isH(a.position) ? H : W   // canonical: along the edge × across, main at y = T
  const t = Math.min(L, T) * 0.07
  const canon = []
  let x0 = 0, x1 = L
  const side = (key, idx) => {
    if (n(key) > idx) {
      if (idx === 0) { canon.push({ key, qtyIndex: 0, x: x0, y: 0, w: t, h: T }); x0 += t }
      else { canon.push({ key, qtyIndex: 1, x: x1 - t, y: 0, w: t, h: T }); x1 -= t }
    }
  }
  side('ext', 0); side('ext', 1); side('ao_frame_side', 0); side('ao_frame_side', 1)
  let y0 = 0, y1 = T
  if (n('ao_frame_far')) { canon.push({ key: 'ao_frame_far', qtyIndex: 0, x: x0, y: 0, w: x1 - x0, h: t }); y0 = t }
  for (const key of ['main_facing', 'divider', 'ao_bead']) {
    if (n(key)) { canon.push({ key, qtyIndex: 0, x: x0, y: y1 - t, w: x1 - x0, h: t }); y1 -= t }
  }
  const turn = (r) => {
    if (a.position === 'top') return { ...r }
    if (a.position === 'bottom') return { ...r, y: T - r.y - r.h }
    if (a.position === 'left') return { ...r, x: r.y, y: r.x, w: r.h, h: r.w }
    return { ...r, x: T - r.y - r.h, y: r.x, w: r.h, h: r.w }
  }
  const role = (k) => (k === 'ext' || k === 'main_facing' ? 'main' : 'frame')
  for (const r of canon) out.push({ ...turn(r), role: role(r.key) })
  gridPieces(out, turn({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), n('mullion'), n('rail'), t)
  return out
}

// ---------------------------------------------------------------- overview

// Preview add-on rectangles in the overview's pixel space (partGeometry overviewSpecs box: frameX/Y/W/H + scale px/mm),
// mirrored for the inside view, plus the viewBox that holds the overview box and every add-on.
export function overviewAddonRects({ box, addons, widthMm, heightMm, view = 'out' }) {
  const base = { x: 0, y: 0, w: box.w, h: box.h }
  const list = addons || []
  if (!list.length) return { rects: [], viewBox: base }
  const sc = num(box.scale) || 0
  const { rects } = layoutAddons({ widthMm, heightMm, addons: list })
  const out = rects.filter((r) => !r.main).map((r) => {
    const a = list[r.i]
    const w = r.w * sc, h = r.h * sc
    let x = box.frameX + r.x * sc
    if (view === 'in') x = box.frameX * 2 + box.frameW - x - w
    return { i: r.i, x, y: box.frameY + r.y * sc, w, h, mode: a.mode, kind: a.kind, position: a.position, rows: a.rows, cols: a.cols }
  })
  const m = 8
  const xs = [0, ...out.map((r) => r.x - m)], ys = [0, ...out.map((r) => r.y - m)]
  const xe = [box.w, ...out.map((r) => r.x + r.w + m)], ye = [box.h, ...out.map((r) => r.y + r.h + m)]
  const vx = Math.min(...xs), vy = Math.min(...ys)
  // one outer frame shared by the main unit and its merge add-ons (mockup renderPreview "กรอบร่วม")
  const shared = [{ x: box.frameX, y: box.frameY, w: box.frameW, h: box.frameH }, ...out.filter((r) => r.mode === 'merge')]
  const fx = Math.min(...shared.map((r) => r.x)), fy = Math.min(...shared.map((r) => r.y))
  const frameBox = { x: fx, y: fy, w: Math.max(...shared.map((r) => r.x + r.w)) - fx, h: Math.max(...shared.map((r) => r.y + r.h)) - fy }
  const env = layoutAddons({ widthMm, heightMm, addons: list }).envelope
  const TEXT = 20   // room under the drawing for the overall size line
  return {
    rects: out, frameBox, envelopeMm: { w: env.w, h: env.h },
    viewBox: { x: vx, y: vy, w: Math.max(...xe) - vx, h: Math.max(...ye) - vy + TEXT },
  }
}

// Preview add-ons whose length still equals the old main edge follow a change of the test size (mockup __peSize).
export function followMainSize(list, prev, next) {
  if (!list || !list.length || (prev.w === next.w && prev.h === next.h)) return list
  let changed = false
  const out = list.map((a) => {
    const [from, to] = isH(a.position) ? [prev.w, next.w] : [prev.h, next.h]
    if (from === to || a.len_mm !== from) return a
    changed = true
    return { ...a, len_mm: to }
  })
  return changed ? out : list
}

// ---------------------------------------------------------------- piece sets ({ [setKey]: { rows, dirty } })

export function setRowsFor(addonSets, addon, layoutKind) {
  const key = setKey(addon.mode, addon.kind, addon.position)
  const set = (addonSets || {})[key]
  if (set && set.rows && set.rows.length) return { key, rows: set.rows, isDefault: false, dirty: !!set.dirty }
  const rows = defaultAddonPieces({ mode: addon.mode, kind: addon.kind, position: addon.position, layoutKind, buttMm: 0 })
  return { key, rows, isDefault: true, dirty: false }
}

// The first edit of a default set copies the defaults; every edit marks the set dirty. Never mutates its input.
export function editSetRow(addonSets, addon, layoutKind, idx, patch) {
  const { key, rows } = setRowsFor(addonSets, addon, layoutKind)
  const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
  return { ...(addonSets || {}), [key]: { rows: next, dirty: true } }
}

export const allPieceRows = (addonSets) => Object.values(addonSets || {}).flatMap((s) => (s && s.rows) || [])

// ---------------------------------------------------------------- table + effects (from expandAddons)

// Glass / panes of the add-on alone (expandAddons(...).glass): count, per-pane size, rows × cols.
export function glassInfo({ addon, rows, main, buttOf, layoutKind }) {
  const g = expandAddons({ addons: [addon], pieceRows: rows, main, buttOf, layoutKind }).glass[0]
  return g ? { count: g.count, widthMm: g.widthMm, heightMm: g.heightMm, rows: addon.rows, cols: addon.cols } : null
}

// Metres of every bar in the table (addonExpand.piecesTotalM over the rows' own components).
export const tableTotalM = (lines) => piecesTotalM((lines || []).map((l) => l.comp))

const issueText = (reason) => (reason === 'no_profile_family' ? ISSUE_TEXT.no_profile_family : reasonText(reason))

function overrideText(model, overrides) {
  return Object.entries(overrides).map(([pos, o]) =>
    `${posName(model, pos)}: ` + [o.lengthMm != null ? `ยาว ${fmt(o.lengthMm)} มม.` : null, o.family ? `โปรไฟล์ ${o.family}` : null].filter(Boolean).join(' · '))
}

// One line per row of the set: the row's own expansion (the add-on with just that row), so each length / qty / issue
// belongs to that row. ext / main_facing are not bars of their own: they show their effect on the main unit.
export function pieceTableRows({ addon, rows, main, buttOf, layoutKind, model }) {
  return (rows || []).map((r, i) => {
    const exp = expandAddons({ addons: [addon], pieceRows: [r], main, buttOf, layoutKind })
    const comp = (exp.attach[0]?.components || [])[0] || exp.merge.components[0] || null
    const issues = exp.issues.filter((x) => x.reason !== 'addon_out_of_range').map((x) => issueText(x.reason))
    const base = {
      i, key: r.piece_key, label: PIECE_LABEL[r.piece_key] || r.piece_key, family: r.profile_family || null,
      ref: r.ref_input, refLabel: REF_LABEL[r.ref_input] || r.ref_input, factor: num(r.length_factor), ded: num(r.deduction_mm),
      qtyRule: r.qty_rule, qtyLabel: QTY_LABEL[r.qty_rule] || r.qty_rule, qty: comp ? comp.quantity_value : qtyOf(r, addon),
      length: comp ? comp.fixed_length_mm : null, totalM: pieceTotalM(comp), comp, explain: explainAddonPiece({ row: r, addon, main }), effect: null, unresolved: issues.length ? [...new Set(issues)].join(' · ') : null,
    }
    if (r.piece_key === 'ext' || r.piece_key === 'main_facing') {
      const parts = [...overrideText(model, exp.merge.overrides), ...exp.merge.notes.map((nt) => `หมายเหตุ: ${nt.text}`)]
      return { ...base, length: null, totalM: null, comp: null, unresolved: null, effect: parts.length ? parts.join(' · ') : 'ไม่มีผลกับชิ้นหลัก' }
    }
    return base
  })
}

// The whole preview list with every set (saved / edited, else defaults): main-unit overrides, notes, added bars,
// glass and issues, all as returned by expandAddons.
export function addonEffects({ addons, addonSets, main, buttOf, layoutKind, model }) {
  const exp = expandAddons({ addons, pieceRows: allPieceRows(addonSets), main, buttOf, layoutKind })
  const overrides = Object.entries(exp.merge.overrides).map(([key, o]) => ({ key, name: posName(model, key), lengthMm: o.lengthMm ?? null, family: o.family || null }))
  const comps = [...exp.merge.components, ...exp.attach.flatMap((u) => u.components)]
    .map((c) => ({ name: c.role_name, family: c.profile_family, length: c.fixed_length_mm, factor: c.length_factor, qty: c.quantity_value, addonIndex: c.addon_index }))
  const issues = exp.issues.map((x) => ({ name: x.role_name, text: issueText(x.reason) }))
  return { overrides, notes: exp.merge.notes, components: comps, glass: exp.glass, issues }
}

export const refOptions = (addon, refs, main) => refs.map((k) => ({ value: k, label: `${REF_LABEL[k] || k} (${fmt(refValue(addon, k, main))} มม.)` }))
