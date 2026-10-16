// Pure model for inline add-ons ("ช่องแสง") on a main window. No I/O, no React, no imports.
//
// Add-on shape: { mode: 'merge'|'attach', kind: 'fixed'|'awning', position: 'top'|'bottom'|'left'|'right',
//   len_mm, thick_mm, offset_mm, align: 'start'|'end', rows, cols, fake_rows, fake_cols (ซอยหลอก per pane, 1 = none) }
// merge = shares the main frame (ร่วมวงกบ); attach = its own frame beside the main (แยกวงกบ).
// Piece row shape = the migration's column names (piece_key, profile_family, ref_input, length_factor, deduction_mm,
//   qty_rule, qty_fixed, thickness_role, note, sort_order) plus mode, kind, position (position is null for attach rows).
// Geometry: the main window sits at (0,0) with size widthMm x heightMm; add-ons stack outward per side in list order,
//   so top/left add-ons sit at negative y/x. Along its own edge an add-on is flush (align) with the start (top/left) or
//   end (bottom/right) of the whole stack = main plus the perpendicular add-ons; offset_mm shifts it inward from there. All functions are immutable: they never touch their inputs.
// Validators return the first Thai problem string, or null when everything is fine. Callers coerce strings to numbers first.

export const ADDON_MODES = ['merge', 'attach']
export const ADDON_KINDS = ['fixed', 'awning']
export const ADDON_POSITIONS = ['top', 'bottom', 'left', 'right']
export const ADDON_MODE_LABEL = { merge: 'ร่วมวงกบ', attach: 'แยกวงกบ' }
export const ADDON_KIND_LABEL = { fixed: 'ติดตาย', awning: 'กระทุ้ง' }
export const ADDON_POSITION_LABEL = { top: 'บน', bottom: 'ล่าง', left: 'ซ้าย', right: 'ขวา' }
export const ADDON_ALIGNS = ['start', 'end']
export const ALIGN_LABEL = { lr: { start: 'เสมอบน', end: 'เสมอล่าง' }, tb: { start: 'เสมอซ้าย', end: 'เสมอขวา' } }
export const alignLabel = (a) => (isHorizontal(a && a.position) ? ALIGN_LABEL.tb : ALIGN_LABEL.lr)
export const MAX_ADDONS = 6
export const MAX_ROWS = 6
export const MAX_COLS = 12
export const MAX_FAKE = 12   // fake dividers (ซอยหลอก) per glass pane, each direction
export const MAX_LEN_MM = 20000

export const PIECE_KEYS = {
  merge: ['ext', 'divider', 'main_facing', 'ao_frame_side', 'ao_bead', 'ao_frame_far', 'mullion', 'rail'],
  attach: ['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'rail'],
}
export const PIECE_LABEL = {
  ext: 'เฟรมบานหลักข้างช่องแสง (ยาวขึ้น/เปลี่ยน profile)',
  divider: 'คานกั้น',
  main_facing: 'เฟรมบานหลักด้านที่ติดช่องแสง (หมายเหตุ/เปลี่ยน profile)',
  ao_frame_side: 'เฟรมข้างช่องแสง (แปะทับ)',
  ao_bead: 'คิ้วเท',
  ao_frame_far: 'เฟรมด้านไกลของช่องแสง',
  frame_top: 'เฟรมบน',
  frame_bottom: 'เฟรมล่าง',
  frame_side: 'เฟรมข้าง',
  mullion: 'ซอยกลางตั้ง',
  rail: 'ซอยกลางนอน',
}
export const REF_LABEL = { w: 'กว้าง ช่องแสง', h: 'สูง ช่องแสง', len: 'ความยาวตามแนวขอบ ช่องแสง', mw: 'กว้างช่องหลัก', mh: 'สูงช่องหลัก', tw: 'กว้างรวมทั้งชุด', th: 'สูงรวมทั้งชุด' }
export const REF_INPUTS = { merge: ['w', 'h', 'len', 'mw', 'mh', 'tw', 'th'], attach: ['w', 'h'] }
export const QTY_RULES = ['fixed', 'cols-1', 'rows-1', 'cols', 'rows', 'rows*cols']

const isHorizontal = (position) => position === 'top' || position === 'bottom'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v))

export function newAddon({ mode = 'merge', kind = 'fixed', position = 'top', mainWidthMm, mainHeightMm }) {
  const len_mm = isHorizontal(position) ? mainWidthMm : mainHeightMm
  return { mode, kind, position, len_mm, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3, fake_rows: 1, fake_cols: 1 }
}

export function addonDims(a) {
  return isHorizontal(a.position) ? { w: a.len_mm, h: a.thick_mm } : { w: a.thick_mm, h: a.len_mm }
}

// Add-ons on the same side stack outward in list order; `envelope` is the bounding box of the main plus every rect.
export function layoutAddons({ widthMm, heightMm, addons }) {
  const list = addons || []
  const ext = { top: 0, bottom: 0, left: 0, right: 0 }
  for (const a of list) ext[a.position] += isHorizontal(a.position) ? addonDims(a).h : addonDims(a).w
  const used = { top: 0, bottom: 0, left: 0, right: 0 }
  const rects = [{ main: true, x: 0, y: 0, w: widthMm, h: heightMm }]
  list.forEach((a, i) => {
    const { w, h } = addonDims(a)
    const off = numOrNull(a.offset_mm) ?? 0
    const end = a.align === 'end'
    const gap = used[a.position]
    used[a.position] += isHorizontal(a.position) ? h : w
    const x = end ? widthMm + ext.right - w - off : -ext.left + off
    const y = end ? heightMm + ext.bottom - h - off : -ext.top + off
    if (a.position === 'top') rects.push({ i, x, y: -gap - h, w, h })
    else if (a.position === 'bottom') rects.push({ i, x, y: heightMm + gap, w, h })
    else if (a.position === 'left') rects.push({ i, x: -gap - w, y, w, h })
    else rects.push({ i, x: widthMm + gap, y, w, h })
  })
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { rects, envelope: { x0, y0, w: x1 - x0, h: y1 - y0 } }
}

// mm value of a named reference. tw/th = main plus this add-on only.
export function refValue(a, ref, main) {
  const { w, h } = addonDims(a)
  if (ref === 'w') return w
  if (ref === 'h') return h
  if (ref === 'len') return a.len_mm
  if (ref === 'mw') return main.widthMm
  if (ref === 'mh') return main.heightMm
  if (ref === 'tw') return main.widthMm + (isHorizontal(a.position) ? 0 : a.thick_mm)
  if (ref === 'th') return main.heightMm + (isHorizontal(a.position) ? a.thick_mm : 0)
  return 0
}

export const extRef = (position) => (isHorizontal(position) ? 'th' : 'tw')

export const setKey = (mode, kind, position) => `${mode}|${kind}|${mode === 'merge' ? position : ''}`

function row(mode, kind, position, i, piece_key, ref_input, deduction_mm, qty_rule, qty_fixed, note = null) {
  return {
    mode, kind, position, piece_key, profile_family: null, ref_input, length_factor: 1, deduction_mm,
    qty_rule, qty_fixed, thickness_role: null, note, sort_order: i,
  }
}

export function defaultAddonPieces({ mode, kind, position, layoutKind = 'sliding_2', buttMm = 0 }) {
  const b2 = 2 * buttMm
  const pos = mode === 'merge' ? position : null
  // spec: [piece_key, ref_input, deduction_mm, qty_rule, qty_fixed, note]
  let spec
  if (mode === 'attach') {
    spec = [
      ['frame_top', 'w', b2, 'fixed', 1], ['frame_bottom', 'w', b2, 'fixed', 1], ['frame_side', 'h', 0, 'fixed', 2],
      ['mullion', 'h', b2, 'cols-1', 0], ['rail', 'w', b2, 'rows-1', 0],
    ]
  } else if (layoutKind === 'sliding_2' && (position === 'top' || position === 'bottom')) {
    // ao_frame_side (owner 2026-10-16, Q5, D4): the overlay side (เฟรมข้างไม่ติดกล่อง แปะทับ) is only as long as the
    // sash = main unit height (mh), not the add-on height: series file J4, p15 A43, the 2-track side lies on the long
    // jamb only over the sliding cell. Whether anything is deducted from mh is still open (question G8).
    const top = position === 'top'
    spec = [
      ['ext', 'th', 0, 'fixed', 2], ['divider', 'len', b2, 'fixed', 0],
      ['main_facing', 'len', 0, 'fixed', 0, top ? 'ตบเรียบ (รองคิ้วเท)' : 'ตบร่อง'],
      ['ao_frame_side', 'mh', 0, 'fixed', 2], ['ao_bead', 'len', b2, 'fixed', top ? 1 : 0],
      ['ao_frame_far', 'len', b2, 'fixed', 1], ['mullion', 'h', b2, 'cols-1', 0], ['rail', 'len', b2, 'rows-1', 0],
    ]
  } else {
    spec = [
      ['ext', extRef(position), 0, 'fixed', 2], ['divider', 'len', b2, 'fixed', 1], ['main_facing', 'len', 0, 'fixed', 0],
      ['ao_frame_side', 'h', 0, 'fixed', 0], ['ao_bead', 'len', b2, 'fixed', 0], ['ao_frame_far', 'len', b2, 'fixed', 0],
      ['mullion', 'h', b2, 'cols-1', 0], ['rail', 'w', b2, 'rows-1', 0],
    ]
  }
  return spec.map((s, i) => row(mode, kind, pos, i, ...s))
}

// Pieces whose default deduction is 2·butt of the set's side family (defaultAddonPieces b2 rows).
export const TWO_BUTT_KEYS = {
  attach: ['frame_top', 'frame_bottom', 'mullion', 'rail'],
  merge: ['divider', 'ao_bead', 'ao_frame_far', 'mullion', 'rail'],
}
// The piece keys that carry a set's side family: attach frame_side; merge ao_frame_side, falling back to ext.
export const SIDE_KEYS = { attach: ['frame_side'], merge: ['ao_frame_side', 'ext'] }
export const isTwoButtPiece = (r) => !!(r && TWO_BUTT_KEYS[r.mode] && TWO_BUTT_KEYS[r.mode].includes(r.piece_key))

// The side family of one piece set (rows of one mode), or null.
export function sideFamilyOf(rows) {
  const list = (rows || []).filter(Boolean)
  const mode = list[0] && list[0].mode
  for (const key of SIDE_KEYS[mode] || []) {
    const r = list.find((x) => x.piece_key === key && x.profile_family)
    if (r) return r.profile_family
  }
  return null
}

// Every 2·butt piece whose deduction_mm is still 0 gets 2·buttMm; every other row is returned as is. A missing or
// non-positive butt changes nothing. Never mutates its input.
export function fillDefaultDeductions(rows, buttMm) {
  const b = numOrNull(buttMm)
  if (!(b > 0)) return rows
  return (rows || []).map((r) => (isTwoButtPiece(r) && Number(r.deduction_mm) === 0 ? { ...r, deduction_mm: Math.round(2 * b * 1e6) / 1e6 } : r))
}

// Pieces that deduct the butt of a different member than the set's side (owner 2026-10-16, Q4 answer ก, D3): on a
// merge add-on the far frame (ao_frame_far) and the คิ้วเท (ao_bead) butt between the extended long box (ext,
// กล่องร่องวิ่งยาว), not the overlay side (ao_frame_side); the overlay is only the fallback when ext has no family.
// The divider, mullions and rails keep the set's side family (divider: D2 still waits for the owner).
export const BUTT_SOURCE_KEYS = { merge: { ao_bead: ['ext', 'ao_frame_side'], ao_frame_far: ['ext', 'ao_frame_side'] } }
const buttKeysOf = (mode, pieceKey) => BUTT_SOURCE_KEYS[mode]?.[pieceKey] || SIDE_KEYS[mode] || []
const familyByKeys = (list, keys) => {
  for (const key of keys) {
    const r = list.find((x) => x.piece_key === key && x.profile_family)
    if (r) return r.profile_family
  }
  return null
}

// The family whose butt one piece of a set deducts (2·butt pieces): BUTT_SOURCE_KEYS, else the set's side family.
export function buttFamilyOf(rows, pieceKey) {
  const list = (rows || []).filter(Boolean)
  const mode = list[0] && list[0].mode
  return familyByKeys(list, buttKeysOf(mode, pieceKey))
}

// fillDefaultDeductions with each piece's own butt source (buttOf(family) -> mm | null). A 2·butt piece at 0 gets
// 2·b(its source). A far frame / bead still holding the fallback value 2·b(overlay) is moved to 2·b(ext) once ext has
// a family (the overlay was assigned first). Every other row is returned as is. Never mutates its input.
export function fillDeductionsBy(rows, buttOf) {
  const list = (rows || []).filter(Boolean)
  if (typeof buttOf !== 'function') return rows
  const mode = list[0] && list[0].mode
  const two = (fam) => { const b = fam ? numOrNull(buttOf(fam)) : null; return b > 0 ? Math.round(2 * b * 1e6) / 1e6 : null }
  return (rows || []).map((r) => {
    if (!isTwoButtPiece(r)) return r
    const keys = buttKeysOf(mode, r.piece_key)
    const want = two(familyByKeys(list, keys))
    if (want == null) return r
    const d = Number(r.deduction_mm)
    if (d === 0) return { ...r, deduction_mm: want }
    const ownSource = !!BUTT_SOURCE_KEYS[mode]?.[r.piece_key]   // only the ext-first pieces move off their fallback
    const fallback = ownSource ? two(familyByKeys(list, keys.slice(1))) : null
    return fallback != null && d === fallback && want !== fallback ? { ...r, deduction_mm: want } : r
  })
}

// A 2·butt piece still at deduction 0 while its set's side butt is > 0 (addon_deduction_zero).
export const deductionStillZero = (r, sideButtMm) =>
  isTwoButtPiece(r) && numOrNull(r.deduction_mm) === 0 && (numOrNull(sideButtMm) ?? 0) > 0

export function pieceQty(r, a) {
  const rows = a.rows
  const cols = a.cols
  switch (r.qty_rule) {
    case 'fixed': return r.qty_fixed
    case 'cols-1': return Math.max(0, cols - 1)
    case 'rows-1': return Math.max(0, rows - 1)
    case 'cols': return cols
    case 'rows': return rows
    case 'rows*cols': return rows * cols
    default: return 0
  }
}

const intIn = (v, lo, hi) => isNum(v) && Number.isInteger(v) && v >= lo && v <= hi

function validateOneAddon(a, n) {
  const at = `ช่องแสงที่ ${n}`
  if (!a || typeof a !== 'object') return `${at} ข้อมูลไม่ถูกต้อง`
  if (!ADDON_MODES.includes(a.mode)) return `${at} ต้องเลือกร่วมวงกบหรือแยกวงกบ`
  if (!ADDON_KINDS.includes(a.kind)) return `${at} ต้องเลือกติดตายหรือกระทุ้ง`
  if (!ADDON_POSITIONS.includes(a.position)) return `${at} ต้องเลือกตำแหน่ง บน ล่าง ซ้าย หรือขวา`
  if (!isNum(a.len_mm) || a.len_mm <= 0 || a.len_mm > MAX_LEN_MM) return `${at} ความยาวต้องมากกว่า 0 และไม่เกิน ${MAX_LEN_MM} มม.`
  if (!isNum(a.thick_mm) || a.thick_mm <= 0 || a.thick_mm > MAX_LEN_MM) return `${at} ความสูงช่องแสงต้องมากกว่า 0 และไม่เกิน ${MAX_LEN_MM} มม.`
  if (!isNum(a.offset_mm) || a.offset_mm < 0 || a.offset_mm > MAX_LEN_MM) return `${at} ระยะเลื่อนต้องไม่ติดลบ`
  if (a.align != null && !ADDON_ALIGNS.includes(a.align)) return `${at} ต้องเลือกแนวเสมอให้ถูกต้อง`
  if (!intIn(a.rows, 1, MAX_ROWS)) return `${at} จำนวนแถวต้องเป็นจำนวนเต็ม 1 ถึง ${MAX_ROWS}`
  if (!intIn(a.cols, 1, MAX_COLS)) return `${at} จำนวนช่องต้องเป็นจำนวนเต็ม 1 ถึง ${MAX_COLS}`
  // fake dividers are optional on the object (older rows, legacy conversions): absent = none
  if (a.fake_rows != null && !intIn(a.fake_rows, 1, MAX_FAKE)) return `${at} ซอยหลอกแนวนอนต้องเป็นจำนวนเต็ม 1 ถึง ${MAX_FAKE}`
  if (a.fake_cols != null && !intIn(a.fake_cols, 1, MAX_FAKE)) return `${at} ซอยหลอกแนวตั้งต้องเป็นจำนวนเต็ม 1 ถึง ${MAX_FAKE}`
  return null
}

export function validateAddons(addons, main) { // eslint-disable-line no-unused-vars
  const list = addons || []
  if (list.length > MAX_ADDONS) return `ช่องแสงได้ไม่เกิน ${MAX_ADDONS} ชิ้นต่อรายการ`
  for (let i = 0; i < list.length; i++) {
    const p = validateOneAddon(list[i], i + 1)
    if (p) return p
  }
  return null
}

function validateOneRow(r, n) {
  const at = `ชิ้นส่วนที่ ${n}`
  if (!r || !ADDON_MODES.includes(r.mode)) return `${at} ไม่ทราบรูปแบบวงกบ`
  if (!PIECE_KEYS[r.mode].includes(r.piece_key)) return `${at} ไม่ใช่ชิ้นส่วนของรูปแบบนี้`
  if (!REF_INPUTS[r.mode].includes(r.ref_input)) return `${at} ใช้ค่าอ้างอิงนี้ไม่ได้ในรูปแบบนี้`
  if (!isNum(r.length_factor) || r.length_factor <= 0) return `${at} ตัวคูณความยาวต้องมากกว่า 0`
  if (!isNum(r.deduction_mm) || r.deduction_mm < 0) return `${at} ค่าหักต้องไม่ติดลบ`
  if (!QTY_RULES.includes(r.qty_rule)) return `${at} กฎจำนวนไม่ถูกต้อง`
  if (r.qty_fixed != null && (!isNum(r.qty_fixed) || r.qty_fixed < 0 || r.qty_fixed > 1000)) return `${at} จำนวนต้องอยู่ระหว่าง 0 ถึง 1000`
  if (r.note != null && String(r.note).length > 120) return `${at} หมายเหตุยาวเกิน 120 ตัวอักษร`
  return null
}

export function validatePieceRows(rows) {
  const list = rows || []
  for (let i = 0; i < list.length; i++) {
    const p = validateOneRow(list[i], i + 1)
    if (p) return p
  }
  return null
}
