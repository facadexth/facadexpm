// Pure editor state for the BOM template part editor. No I/O, no React.
//
// Model shape:
// {
//   layout_kind: 'sliding_2',
//   parts: [{ key: 'frame'|'sash', name, count, overlap_mode, overlap_mm }],
//   lines: { [positionKey]: [ {
//     profile_family, length_rule_type, length_deduction_mm, deduction_auto,
//     length_factor, quantity_value, thickness_role,
//     ends: [ [end0, end1], ... one pair per piece ]   // end = { mode:'through'|'butt', to:{key,line}|null, deduction_mm:number|null }
//   } ] },
//   names: { [positionKey]: name }
// }
// Position keys: frame_top, frame_bottom, frame_side, sash_top, sash_bottom, key_stile, hook_stile.
// Corner rule: at every corner exactly one piece runs through and the other butts.
// Line pairing rule: line i of a position pairs ONLY with line i of its corner partner position;
// a partner without line i is free-standing (extra profiles like covers/trims): nothing is flipped, no validation.
// A butt end with to:null is legal only when deduction_mm is set (partExpand reports no_butt_target otherwise).
// All functions are immutable: they return new models and never touch their input.

export const LAYOUTS = {
  sliding_2: {
    parts: [
      { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0,
        positions: ['frame_top', 'frame_bottom', 'frame_side'] },
      { key: 'sash', name: 'บานเลื่อน', count: 2, overlap_mode: 'auto_hook', overlap_mm: 0,
        positions: ['sash_top', 'sash_bottom', 'key_stile', 'hook_stile'] },
    ],
    positions: {
      frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน' },
      frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง' },
      frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'] },
      sash_top: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนบน' },
      sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนล่าง' },
      key_stile: { part: 'sash', orient: 'v', per: 1, name: 'เสากุญแจ' },
      hook_stile: { part: 'sash', orient: 'v', per: 1, name: 'เสาเกี่ยว' },
    },
    order: ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'key_stile', 'hook_stile'],
  },
}

// Upper bound of a part's count (the drawing and per-piece ends grow with it; a typo like 5000 must not explode the model).
export const MAX_PART_COUNT = 10

const clone = (x) => JSON.parse(JSON.stringify(x))
const layoutOf = (model) => LAYOUTS[model.layout_kind]
const posOf = (model, key) => layoutOf(model).positions[key]
const partCount = (model, partKey) => model.parts.find((p) => p.key === partKey)?.count ?? 1

export function pieceCount(model, key) {
  const pos = posOf(model, key)
  return pos.per * partCount(model, pos.part)
}

const END = (mode, to = null) => ({ mode, to, deduction_mm: null })

// The position/line a given end butts into by default.
export function defaultTarget(key, end) {
  switch (key) {
    case 'frame_top':
    case 'frame_bottom': return { key: 'frame_side', line: 0 }
    case 'sash_top':
    case 'sash_bottom': return { key: end === 0 ? 'hook_stile' : 'key_stile', line: 0 }
    default: return null
  }
}

function defaultPair(key) {
  switch (key) {
    case 'frame_top':
    case 'frame_bottom':
    case 'sash_top':
    case 'sash_bottom':
      return [END('butt', defaultTarget(key, 0)), END('butt', defaultTarget(key, 1))]
    default:
      return [END('through'), END('through')]
  }
}

function defaultLine(key) {
  const base = { profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, deduction_auto: false, length_factor: 1, quantity_value: 1, thickness_role: null, ends: [] }
  switch (key) {
    case 'frame_side': return { ...base, length_rule_type: 'height' }
    case 'sash_top':
    case 'sash_bottom': return { ...base, length_rule_type: 'width_minus', length_factor: 0.5, deduction_auto: true, thickness_role: 'sash' }
    case 'key_stile':
    case 'hook_stile': return { ...base, length_rule_type: 'height_minus', deduction_auto: true, thickness_role: 'sash' }
    default: return base
  }
}

export function ensureEnds(model) {
  const next = clone(model)
  for (const key of Object.keys(next.lines)) {
    const n = pieceCount(next, key)
    next.lines[key].forEach((line, i) => {
      const ends = line.ends || []
      while (ends.length < n) {
        const src = i > 0 ? next.lines[key][0].ends[ends.length] : null
        ends.push(src ? clone(src) : defaultPair(key))
      }
      ends.length = n
      line.ends = ends
    })
  }
  return next
}

export function startModel(kind) {
  const layout = LAYOUTS[kind]
  if (!layout) throw new Error(`unknown layout ${kind}`)
  const model = {
    layout_kind: kind,
    parts: layout.parts.map(({ key, name, count, overlap_mode, overlap_mm }) => ({ key, name, count, overlap_mode, overlap_mm })),
    lines: {},
    names: {},
  }
  for (const key of layout.order) {
    model.lines[key] = [defaultLine(key)]
    model.names[key] = layout.positions[key].name
  }
  return ensureEnds(model)
}

// The corner partner of one end of one piece (an exact involution).
export function partnerEnd(key, piece, end) {
  switch (key) {
    case 'frame_top': return { key: 'frame_side', piece: end, end: 0 }
    case 'frame_bottom': return { key: 'frame_side', piece: end, end: 1 }
    case 'frame_side': return { key: end === 0 ? 'frame_top' : 'frame_bottom', piece: 0, end: piece }
    case 'sash_top': return { key: end === 0 ? 'hook_stile' : 'key_stile', piece, end: 0 }
    case 'sash_bottom': return { key: end === 0 ? 'hook_stile' : 'key_stile', piece, end: 1 }
    case 'hook_stile': return { key: end === 0 ? 'sash_top' : 'sash_bottom', piece, end: 0 }
    case 'key_stile': return { key: end === 0 ? 'sash_top' : 'sash_bottom', piece, end: 1 }
    default: return null
  }
}

export function setEndMode(model, key, lineIdx, piece, end, mode) {
  const next = ensureEnds(model)
  const lines = next.lines[key]
  const li = lineIdx
  const target = lines[li]?.ends[piece]?.[end]
  if (!target) return next
  target.mode = mode
  const pt = partnerEnd(key, piece, end)
  const pEnd = pt && next.lines[pt.key]?.[li]?.ends[pt.piece]?.[pt.end]
  if (mode === 'through') {
    target.to = null
    target.deduction_mm = null
    if (pEnd) {
      pEnd.mode = 'butt'
      pEnd.to = { key, line: li }
      pEnd.deduction_mm = null
    }
  } else {
    if (!target.to && pEnd) target.to = { key: pt.key, line: li }
    if (pEnd) {
      pEnd.mode = 'through'
      pEnd.to = null
      pEnd.deduction_mm = null
    }
  }
  return next
}

export function validateCorners(model) {
  const issues = []
  for (const key of Object.keys(model.lines)) {
    const n = pieceCount(model, key)
    model.lines[key].forEach((line, li) => {
      for (let piece = 0; piece < n; piece++) {
        for (const end of [0, 1]) {
          const pt = partnerEnd(key, piece, end)
          const pline = pt && model.lines[pt.key]?.[li]
          const a = line.ends[piece]?.[end]
          const b = pline?.ends[pt.piece]?.[pt.end]
          if (!a || !b) continue
          if (a.mode === 'through' && b.mode === 'through') issues.push({ key, piece, end, line: li, reason: 'both_through' })
          else if (a.mode === 'butt' && b.mode === 'butt') issues.push({ key, piece, end, line: li, reason: 'both_butt' })
        }
      }
    })
  }
  return issues
}

export function addLine(model, key) {
  const next = clone(model)
  next.lines[key].push(clone(next.lines[key][0]))
  return next
}

export function removeLine(model, key, idx) {
  if (model.lines[key].length <= 1) return clone(model)
  const next = clone(model)
  next.lines[key].splice(idx, 1)
  for (const k of Object.keys(next.lines)) {
    for (const line of next.lines[k]) {
      for (const pair of line.ends) {
        for (const e of pair) {
          if (e.to && e.to.key === key) {
            if (e.to.line === idx) e.to = next.lines[key].length ? { key, line: 0 } : null
            else if (e.to.line > idx) e.to = { key, line: e.to.line - 1 }
          }
        }
      }
    }
  }
  return next
}

// Part-count field commit: only a whole number >= 1 changes the model (setPartCount -> ensureEnds trims/extends ends).
// A blank, 0, negative, fractional or non-numeric entry returns the SAME model, so retyping never trims the pieces.
export function commitPartCount(model, partKey, value) {
  const n = typeof value === 'number' ? value : numOrNull(value)
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_PART_COUNT) return model
  if (model.parts.find((p) => p.key === partKey)?.count === n) return model
  return setPartCount(model, partKey, n)
}

export function setPartCount(model, partKey, count) {
  const next = clone(model)
  const n = Math.max(1, Math.floor(Number(count)) || 1)
  if (n > MAX_PART_COUNT) return ensureEnds(next)   // ignored: the count stays as it was
  next.parts.find((p) => p.key === partKey).count = n
  return ensureEnds(next)
}

export function groupsOf(lengthsMm, perPiece = 1) {
  const m = new Map()
  for (const x of lengthsMm) {
    const len = Math.round(x * 10) / 10
    m.set(len, (m.get(len) || 0) + perPiece)
  }
  return [...m.entries()].map(([len, n]) => ({ len, n })).sort((a, b) => b.len - a.len)
}

// ---------------------------------------------------------------- editor state helpers (UI)

// A numeric input's text -> a real Number, or null when blank / not a number. Never a string (validateModel needs numbers).
export function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Selection = { key, line }. Clamps to an existing position/line of the model (first position, line 0 otherwise).
export function clampSelection(model, sel) {
  const layout = model && LAYOUTS[model.layout_kind]
  if (!layout) return { key: null, line: 0 }
  const key = sel && model.lines?.[sel.key] ? sel.key : layout.order.find((k) => model.lines?.[k]) || null
  const n = key ? model.lines[key].length : 0
  const line = sel && sel.key === key && Number.isInteger(sel.line) && sel.line >= 0 && sel.line < n ? sel.line : 0
  return { key, line }
}

export function updateLine(model, key, lineIdx, patch) {
  const next = clone(model)
  const line = next.lines[key]?.[lineIdx]
  if (line) Object.assign(line, clone(patch))
  return next
}

export function updatePart(model, partKey, patch) {
  const next = clone(model)
  const part = next.parts.find((p) => p.key === partKey)
  if (part) Object.assign(part, clone(patch))
  return next
}

export function setPositionName(model, key, name) {
  const next = clone(model)
  next.names = { ...(next.names || {}), [key]: name }
  return next
}

// Patch one end of one piece ({ to } resets the deduction to the target's default; { deduction_mm } overrides it).
export function updateEnd(model, key, lineIdx, piece, end, patch) {
  const next = ensureEnds(model)
  const e = next.lines[key]?.[lineIdx]?.ends[piece]?.[end]
  if (!e) return next
  if ('to' in patch) { e.to = patch.to ? { key: patch.to.key, line: patch.to.line } : null; e.deduction_mm = null }
  if ('deduction_mm' in patch) e.deduction_mm = numOrNull(patch.deduction_mm)
  return next
}

// "+ เพิ่มโปรไฟล์ในตำแหน่งนี้": copy line 0 and select the new line.
export function addLineAndSelect(model, key) {
  const next = addLine(model, key)
  return { model: next, sel: { key, line: next.lines[key].length - 1 } }
}

// Remove a line and select line 0 of the same position (mockup).
export function removeLineAndSelect(model, key, idx) {
  return { model: removeLine(model, key, idx), sel: { key, line: 0 } }
}
