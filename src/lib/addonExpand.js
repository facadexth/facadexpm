// Expands inline add-ons ("ช่องแสง") into engine inputs. Pure: no I/O, never throws, never mutates its inputs.
//
// attach (แยกวงกบ): each add-on is its own synthetic opening with its own components.
// merge (ร่วมวงกบ): pieces join the main window: `overrides` / `sideButt` feed partExpand.expandParts, `components`
//   are added to the main BOM. ext → main frame members run longer (to the merge envelope) and may change family;
//   main_facing → a family override of the main member facing the add-on and/or a note; divider → its butt replaces
//   that side's frame butt in the main sash deductions (AO-2).
// Every piece component carries fixed_length_mm = max(0, ref − deduction); the engine applies length_factor.
// Issue reasons: no_profile_family, no_butt_distance, addon_out_of_range, addon_piece_too_small, addon_conflict,
// addon_deduction_zero (a costed 2·butt piece still at deduction 0 while the set's side family has a butt > 0).
import { defaultAddonPieces, setKey, refValue, pieceQty, addonDims, layoutAddons, extRef, sideFamilyOf, buttFamilyOf, deductionStillZero, PIECE_LABEL, REF_LABEL } from './addonModel.js'
import { LAYOUTS, rolesOf } from './layoutRegistry.js'

const r6 = (x) => Math.round(x * 1e6) / 1e6
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const isH = (position) => position === 'top' || position === 'bottom'
const POSITIONS = ['top', 'bottom', 'left', 'right']
const empty = () => ({ attach: [], merge: { overrides: {}, sideButt: {}, components: [], notes: [] }, glass: [], issues: [] })
const isAddon = (a) => !!(a && typeof a === 'object' && (a.mode === 'merge' || a.mode === 'attach') && POSITIONS.includes(a.position))
const roleName = (key, ai, note) => `${PIECE_LABEL[key] || key} (ช่องแสง ${ai + 1})` + (note ? ` [${note}]` : '')
const qtyOf = (r, a) => Number(pieceQty(r, a)) || 0

// The add-on's piece set: the template rows of its set, else the defaults (families null).
function piecesFor(a, pieceRows, layoutKind) {
  const k = setKey(a.mode, a.kind, a.position)
  const set = (Array.isArray(pieceRows) ? pieceRows : []).filter((r) => r && typeof r === 'object' && setKey(r.mode, r.kind, r.position) === k)
  const rows = set.length ? set : defaultAddonPieces({ mode: a.mode, kind: a.kind, position: a.position, layoutKind })
  return rows.map((r, i) => ({ r, i })).sort((x, y) => (num(x.r.sort_order) ?? x.i) - (num(y.r.sort_order) ?? y.i)).map((x) => x.r)
}

function makeCtx({ main, buttOf, layoutKind }) {
  const out = empty()
  const seen = new Set()
  const issue = (role_name, reason, addonIndex) => {
    const k = `${role_name}|${reason}|${addonIndex}`
    if (seen.has(k)) return
    seen.add(k)
    out.issues.push({ role_name, reason, addonIndex })
  }
  // Butt of a family in mm; a family with no butt distance ⇒ issue and 0; no family ⇒ 0.
  const buttMm = (fam, name, ai) => {
    if (!fam) return 0
    const v = num(typeof buttOf === 'function' ? buttOf(fam) : null)
    if (v == null) { issue(name, 'no_butt_distance', ai); return 0 }
    return v
  }
  // butt of a set's side family, no issue (the side piece reports its own); 0 when none. With pieceKey: the butt that
  // piece deducts (buttFamilyOf: far frame / bead deduct ext first, owner 2026-10-16 D3).
  const sideButt = (rows, pieceKey = null) => {
    const fam = pieceKey ? buttFamilyOf(rows, pieceKey) : sideFamilyOf(rows)
    return fam ? (num(typeof buttOf === 'function' ? buttOf(fam) : null) ?? 0) : 0
  }
  const m = { widthMm: num(main?.widthMm) ?? 0, heightMm: num(main?.heightMm) ?? 0 }
  return { out, issue, buttMm, sideButt, main: m, roles: rolesOf(LAYOUTS[layoutKind]) }
}

// One component for a piece with qty > 0, or null (with an issue when it cannot be priced).
function pieceComponent(r, a, ai, ctx, sortOrder, sideButtMm = 0) {
  const qty = qtyOf(r, a)
  if (qty <= 0) return null
  const name = roleName(r.piece_key, ai, r.note)
  if (!r.profile_family) { ctx.issue(name, 'no_profile_family', ai); return null }
  const raw = Number(refValue(a, r.ref_input, ctx.main)) - (num(r.deduction_mm) ?? 0)
  if (!(raw > 0)) { ctx.issue(name, 'addon_piece_too_small', ai); return null }
  if (deductionStillZero(r, sideButtMm)) ctx.issue(name, 'addon_deduction_zero', ai)
  return {
    role_name: name, profile_family: r.profile_family, length_rule_type: 'width', length_deduction_mm: 0,
    length_factor: num(r.length_factor) ?? 1, end_deduction_mm: 0, fixed_length_mm: r6(Math.max(0, raw)),
    quantity_basis: 'fixed', quantity_value: qty, thickness_role: r.thickness_role ?? null, sort_order: sortOrder,
    cut_style: 'square', addon_index: ai,
  }
}

// len + offset must fit the whole axis of the stack: the main edge plus every perpendicular add-on's thickness.
function checkRange(a, ai, ctx, list) {
  let axis = isH(a.position) ? ctx.main.widthMm : ctx.main.heightMm
  for (const o of list) if (isAddon(o) && isH(o.position) !== isH(a.position)) axis += Math.max(0, num(o.thick_mm) ?? 0)
  const thick = num(a.thick_mm)
  const end = (num(a.offset_mm) ?? 0) + (num(a.len_mm) ?? 0)
  if (thick == null || thick <= 0 || end > axis) ctx.issue(`ช่องแสง ${ai + 1}`, 'addon_out_of_range', ai)
}

function pushGlass(a, ai, b, ctx) {
  const { w, h } = addonDims(a)
  const rows = Math.max(1, Math.floor(num(a.rows) ?? 1))
  const cols = Math.max(1, Math.floor(num(a.cols) ?? 1))
  ctx.out.glass.push({
    addonIndex: ai, count: rows * cols,
    widthMm: r6(Math.max(0, ((num(w) ?? 0) - 2 * b) / cols)), heightMm: r6(Math.max(0, ((num(h) ?? 0) - 2 * b) / rows)),
  })
}

function expandAttach(a, ai, rows, ctx) {
  const components = []
  for (const r of rows) {
    const c = pieceComponent(r, a, ai, ctx, components.length, ctx.sideButt(rows, r.piece_key))
    if (c) components.push(c)
  }
  const { w, h } = addonDims(a)
  const cols = Math.max(1, Math.floor(num(a.cols) ?? 1))
  ctx.out.attach.push({ addonIndex: ai, opening: { width_m: (num(w) ?? 0) / 1000, height_m: (num(h) ?? 0) / 1000, panel_count: cols }, components })
  const side = rows.find((r) => r.piece_key === 'frame_side')
  pushGlass(a, ai, side ? ctx.buttMm(side.profile_family, roleName('frame_side', ai, side.note), ai) : 0, ctx)
}

// Merges a { lengthMm?, family? } patch into overrides[pos]: the first lengthMm and the first family win;
// a differing later family is an addon_conflict.
function mergeOverride(ctx, pos, { lengthMm, family }, name, ai) {
  const ov = ctx.out.merge.overrides
  const next = { ...(ov[pos] || {}) }
  if (lengthMm != null && next.lengthMm == null) next.lengthMm = lengthMm
  if (family) {
    if (next.family && next.family !== family) ctx.issue(name, 'addon_conflict', ai)
    else next.family = family
  }
  ov[pos] = next
}

function mergeMainPiece(r, a, ai, ctx, env) {
  const name = roleName(r.piece_key, ai, r.note)
  const { roles } = ctx
  if (r.piece_key === 'ext') {
    if (qtyOf(r, a) <= 0) return
    const span = isH(a.position) ? env.h : env.w
    const lengthMm = r6(span * (num(r.length_factor) ?? 1) - (num(r.deduction_mm) ?? 0))
    const targets = isH(a.position) ? [roles.frame_side] : [roles.frame_top, roles.frame_bottom]
    for (const pos of targets) mergeOverride(ctx, pos, { lengthMm, family: r.profile_family || undefined }, name, ai)
    return
  }
  // main_facing: never a component
  const facing = a.position === 'top' ? roles.frame_top : a.position === 'bottom' ? roles.frame_bottom : roles.frame_side
  if (r.profile_family) mergeOverride(ctx, facing, { family: r.profile_family }, name, ai)
  if (r.note) ctx.out.merge.notes.push({ addonIndex: ai, position: a.position, text: r.note })
}

function expandMerge(a, ai, rows, ctx, env) {
  const { merge } = ctx.out
  for (const r of rows) {
    if (r.piece_key === 'ext' || r.piece_key === 'main_facing') { mergeMainPiece(r, a, ai, ctx, env); continue }
    const c = pieceComponent(r, a, ai, ctx, merge.components.length, ctx.sideButt(rows, r.piece_key))
    if (!c) continue
    merge.components.push(c)
    if (r.piece_key === 'divider') merge.sideButt[a.position] = ctx.buttMm(r.profile_family, c.role_name, ai)
  }
  const side = rows.find((r) => r.piece_key === 'ao_frame_side' && qtyOf(r, a) > 0 && r.profile_family)
  const ext = rows.find((r) => r.piece_key === 'ext' && r.profile_family)
  const src = side || ext
  pushGlass(a, ai, src ? ctx.buttMm(src.profile_family, roleName(src.piece_key, ai, src.note), ai) : 0, ctx)
}

export function expandAddons(input) {
  const { addons, pieceRows, main, buttOf, layoutKind } = input && typeof input === 'object' ? input : {}
  const ctx = makeCtx({ main, buttOf, layoutKind })
  const list = Array.isArray(addons) ? addons : []
  const mergeList = list.filter((a) => isAddon(a) && a.mode === 'merge')
  const env = mergeList.length
    ? layoutAddons({ widthMm: ctx.main.widthMm, heightMm: ctx.main.heightMm, addons: mergeList }).envelope
    : { w: ctx.main.widthMm, h: ctx.main.heightMm }
  list.forEach((a, ai) => {
    if (!isAddon(a)) return
    checkRange(a, ai, ctx, list)
    const rows = piecesFor(a, pieceRows, layoutKind)
    if (a.mode === 'attach') expandAttach(a, ai, rows, ctx)
    else expandMerge(a, ai, rows, ctx, env)
  })
  return ctx.out
}

// Metres of one expanded piece component: fixed_length_mm × length_factor (as bomEngine applies it) × quantity / 1000,
// 6 dp. null for no component. piecesTotalM sums a list (nulls skipped).
export function pieceTotalM(c) {
  if (!c) return null
  const len = num(c.fixed_length_mm)
  if (len == null) return null
  return r6((len * (num(c.length_factor) ?? 1) * (Number(c.quantity_value) || 0)) / 1000)
}
export const piecesTotalM = (list) => r6((list || []).reduce((s, c) => s + (pieceTotalM(c) ?? 0), 0))

const f1 = (x) => {
  const [i, d] = Math.abs(x).toFixed(1).split('.')
  return (x < 0 ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d
}

// "ที่มา" of one piece row of one add-on (the add-on alone, as the zoom shows it), the same arithmetic as
// pieceComponent / mergeMainPiece: (ref − deduction) × factor for a bar, envelope span × factor − deduction for ext
// (with its old length). null for main_facing (never a bar of its own).
export function explainAddonPiece({ row, addon, main }) {
  const r = row || {}
  const a = addon
  if (!a || !r.piece_key || r.piece_key === 'main_facing') return null
  const m = { widthMm: num(main?.widthMm) ?? 0, heightMm: num(main?.heightMm) ?? 0 }
  const factor = num(r.length_factor) ?? 1
  const ded = num(r.deduction_mm) ?? 0
  const qty = qtyOf(r, a)
  const tail = (len) => ` = ${f1(len)} มม. × ${qty} ท่อน = ${(r6((len * qty) / 1000)).toFixed(2)} ม.`
  if (r.piece_key === 'ext') {
    const ref = extRef(a.position)
    const span = Number(refValue(a, ref, m))
    const len = r6(span * factor - ded)
    const was = isH(a.position) ? m.heightMm : m.widthMm
    return `${REF_LABEL[ref]} ${f1(span)}` + (factor !== 1 ? ` × ${factor}` : '') + (ded ? ` − หัก ${f1(ded)}` : '') + tail(len) +
      ` (เดิม ${f1(was)} มม. ยืดขึ้น ${f1(r6(len - was))})`
  }
  const base = Number(refValue(a, r.ref_input, m))
  const raw = base - ded
  let expr = `${REF_LABEL[r.ref_input] || r.ref_input} ${f1(base)}` + (ded ? ` − หัก ${f1(ded)}` : '')
  if (!(raw > 0)) return `${expr} = ${f1(raw)} มม. (สั้นกว่าระยะหัก คิดไม่ได้)`
  if (factor !== 1) expr = `(${expr}) × ${factor}`
  return expr + tail(r6(raw * factor))
}
