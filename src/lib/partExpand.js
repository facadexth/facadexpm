// Compiles the part-editor model (see partModel.js) into the flat component rows bomEngine already understands.
// Pure: no I/O. buttOf(family) / widthOf(family) return mm or null.
// Length per row = (base − pre + overlap) × factor − endDed, where
//   pre     = AUTO[rule.auto] (line.deduction_auto) else line.length_deduction_mm  (width_minus / height_minus only)
//   overlap = overlap unit × rule.overlapCount, for positions with rule.overlap 'hook'
//   endDed  = sum of the butt ends' deductions (0 for every end of a part whose corner is 'mitre').
//   rule.minus / rule.plusWidth (position keys): Σ b(line 0) − Σ w(line 0) taken AFTER the factor (sliding_2 sill guard).
//             An end deduction cannot be negative (bomEngine clamps it), so the term is folded into length_deduction_mm
//             divided by the factor: length_deduction_mm = pre − overlap + (Σb(minus) − Σw(plusWidth)) / factor.
// Positions read by rule.auto / rule.overlap go through the layout's roles (layoutRegistry.rolesOf).
import { LAYOUTS, pieceCount, validateCorners, lineFamily } from './partModel.js'
import { exprParams, rolesOf } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'

const r6 = (x) => Math.round(x * 1e6) / 1e6
const DEDUCTING_RULES = new Set(['width_minus', 'height_minus'])

// rule.auto -> { frame, grid }: `frame` = butt distances of the frame members the piece sits between,
// `grid` = { label, n, role } intermediate bars (n × width of role line 0) for grid layouts.
// b(role) = butt distance of the role's line 0 (0 when the layout/model has no such position, R-P3); p(name) = param.
// A frame-only auto: the sum of `count × b(role)` terms.
const bSum = (...terms) => ({ b }) => ({ frame: terms.reduce((sum, [role, n]) => sum + n * b(role), 0), grid: null })
// A grid auto: `frame` terms plus (param − 1) intermediate bars of `role`, measured across `label` ('cols' | 'rows').
// `delta` = bars relative to the param: -1 (intermediate bars) by default, +1 for the curtain wall (bars incl. both ends).
const gridAuto = (frameFn, label, param, role, delta = -1) => (ctx) => ({ frame: frameFn(ctx).frame, grid: { label, n: ctx.p(param) + delta, delta, role } })
// sb = sideButt (add-on dividers, AO-2): a given mm replaces that side's frame butt; left/right are the two frame_side ends.
const SIDES = ({ b, sb }) => ({ frame: (sb.left ?? b('frame_side')) + (sb.right ?? b('frame_side')), grid: null })
const TOP_BOTTOM = ({ b, sb }) => ({ frame: (sb.top ?? b('frame_top')) + (sb.bottom ?? b('frame_bottom')), grid: null })
const AUTO = {
  frame_sides: SIDES,
  sides_only: SIDES,
  frame_top_bottom: TOP_BOTTOM,
  frame_top: ({ b, sb }) => ({ frame: sb.top ?? b('frame_top'), grid: null }),
  grid_cols: gridAuto(SIDES, 'cols', 'cols', 'mullion'),
  grid_n: gridAuto(SIDES, 'cols', 'n', 'mullion'),   // casement_n: columns = n
  grid_rows: gridAuto(TOP_BOTTOM, 'rows', 'rows', 'transom'),
  track: bSum(['track', 1]),   // hanging_door: the track rail's butt distance, once
  track_top_bottom: bSum(['track_top', 1], ['track_bottom', 1]),
  track_sides: bSum(['track_side', 2]),
  cw_cols: gridAuto(() => ({ frame: 0 }), 'cols', 'cols', 'mullion', 1),   // curtain_wall: (cols+1)·w(mullion)
  cw_rows: gridAuto(() => ({ frame: 0 }), 'rows', 'rows', 'transom', 1),   // curtain_wall: (rows+1)·w(transom)
}

function validModel(model) {
  return !!(model && typeof model === 'object' && LAYOUTS[model.layout_kind] && model.lines && typeof model.lines === 'object' && Array.isArray(model.parts))
}

// Only finite numbers survive; anything else falls back to the frame member's butt.
function cleanSideButt(sideButt) {
  const sb = {}
  for (const k of ['top', 'bottom', 'left', 'right']) {
    const v = sideButt?.[k]
    if (v != null && v !== '' && Number.isFinite(Number(v))) sb[k] = Number(v)
  }
  return sb
}

// overrides = { [positionKey]: { family?, lengthMm? } } (add-ons): `family` replaces line 0's family for every reader.
function makeCtx({ model, buttOf, widthOf, overrides, sideButt }) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  const sb = cleanSideButt(sideButt)
  const layout = LAYOUTS[model.layout_kind]
  const roles = rolesOf(layout)
  const params = exprParams(model)
  const issues = []
  const seen = new Set()
  const posName = (key) => model.names?.[key] || layout.positions[key]?.name || key
  const issue = (role_name, reason) => {
    const k = `${role_name}|${reason}`
    if (seen.has(k)) return
    seen.add(k)
    issues.push({ role_name, reason })
  }
  // own family, else the layout's rule.familyFrom (line 0); an override family wins on line 0
  const famOf = (key, line) => (line === 0 && ov[key]?.family ? String(ov[key].family) : lineFamily(model, key, line))
  const fixedLength = (key, line) => {
    const v = line === 0 ? ov[key]?.lengthMm : null
    return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
  }
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  const butt = (fam) => (fam ? num(buttOf(fam)) : null)
  const width = (fam) => (fam ? num(widthOf?.(fam)) : null)
  const layoutPart = (key) => layout.parts.find((p) => p.key === layout.positions[key]?.part) || {}
  const partOf = (key) => model.parts.find((p) => p.key === layout.positions[key]?.part) || {}
  const ruleOf = (key) => layout.positions[key]?.rule || {}
  const isMitre = (key) => layoutPart(key).corner === 'mitre'
  const present = (k) => !!(layout.positions[k] && model.lines[k]?.length)

  // Automatic deduction split into its parts; null when the position has none. `onMissing(reason)` is called for an
  // unresolved lookup (no_butt_distance / no_profile_width), which then counts 0.
  function autoParts(key, onMissing) {
    const fn = Object.prototype.hasOwnProperty.call(AUTO, ruleOf(key).auto) ? AUTO[ruleOf(key).auto] : null
    if (!fn) return null
    const lookup = (role, read, reason) => {
      const k = roles[role]
      if (!present(k)) return 0
      const v = read(famOf(k, 0))
      if (v == null) { onMissing(reason); return 0 }
      return v
    }
    const b = (role) => lookup(role, butt, 'no_butt_distance')
    const p = (name) => (Number.isFinite(params[name]) ? params[name] : 1)
    const { frame, grid } = fn({ b, p, sb })
    if (!grid) return { frame, grid: null }
    const n = Math.max(0, grid.n)
    return { frame, grid: { label: grid.label, delta: grid.delta, n, w: n > 0 ? lookup(grid.role, width, 'no_profile_width') : 0 } }
  }

  function autoDed(key, onMissing) {
    const a = autoParts(key, onMissing)
    return a ? a.frame + (a.grid ? a.grid.n * a.grid.w : 0) : null
  }

  // One overlap of the part (auto = hook stile butt distance, else its width; manual = overlap_mm). A frame-part position
  // with rule.overlap 'hook' (sliding_2 sill guard) reads the hook position's part instead: the frame has no overlap.
  function overlapUnit(key) {
    const viaHook = ruleOf(key).overlap === 'hook' && layout.positions[key]?.part === 'frame' && layout.positions[roles.hook]
    const part = viaHook ? partOf(roles.hook) : partOf(key)
    if (part.overlap_mode === 'auto_hook') {
      const fam = famOf(roles.hook, 0)
      return butt(fam) ?? width(fam) ?? 0
    }
    return Number(part.overlap_mm) || 0
  }

  // Overlap added back before the factor: unit × rule.overlapCount (default 1).
  function overlap(key, line) {
    const rule = ruleOf(key)
    if (rule.overlap !== 'hook' || line.length_rule_type !== 'width_minus') return 0
    return r6(overlapUnit(key) * evalExpr(rule.overlapCount ?? 1, params))
  }

  // Deduction before the factor, before overlap.
  function preDed(key, line, onMissing) {
    if (!DEDUCTING_RULES.has(line.length_rule_type)) return 0
    const a = line.deduction_auto ? autoDed(key, onMissing) : null
    return a != null ? r6(a) : Number(line.length_deduction_mm) || 0
  }

  // After-factor terms of rule.minus (−b) / rule.plusWidth (+w): [{ key, kind: 'minus'|'plusWidth', mm }] (signed mm);
  // an absent position is skipped, an unresolved lookup is reported and counts 0.
  function afterTerms(key, onMissing) {
    const rule = ruleOf(key)
    const out = []
    const add = (keys, kind, read, reason, sign) => {
      for (const k of Array.isArray(keys) ? keys : []) {
        if (!present(k)) continue
        const v = read(famOf(k, 0))
        if (v == null) onMissing(reason)
        out.push({ key: k, kind, mm: v == null ? 0 : sign * v })
      }
    }
    add(rule.minus, 'minus', butt, 'no_butt_distance', -1)
    add(rule.plusWidth, 'plusWidth', width, 'no_profile_width', 1)
    return out
  }
  const afterFactor = (key, onMissing) => afterTerms(key, onMissing).reduce((s, t) => s + t.mm, 0)

  // The after-factor term expressed before the factor (folded into length_deduction_mm); 0 for a zero factor.
  function afterDed(key, line, onMissing) {
    const rule = ruleOf(key)
    if (!rule.minus && !rule.plusWidth) return 0
    const factor = Number(line.length_factor ?? 1)
    const t = afterFactor(key, onMissing)
    return factor ? r6(-t / factor) : 0
  }

  // { mm, problem: null|'no_butt_target'|'no_butt_distance' }
  function endDed(end) {
    if (!end || end.mode !== 'butt') return { mm: 0, problem: null }
    if (end.deduction_mm != null && Number.isFinite(Number(end.deduction_mm))) return { mm: Number(end.deduction_mm), problem: null }
    if (!end.to) return { mm: 0, problem: 'no_butt_target' }
    const v = butt(famOf(end.to.key, end.to.line))
    return v == null ? { mm: 0, problem: 'no_butt_distance' } : { mm: v, problem: null }
  }

  function pieceLabel(key, piece) {
    const pos = layout.positions[key]
    if (pos.labels && pieceCount(model, key) === pos.labels.length) return pos.labels[piece]
    if (pos.part === 'sash') return `บานที่ ${piece + 1}`
    return `ชิ้นที่ ${piece + 1}`
  }

  return { layout, roles, issues, issue, posName, famOf, fixedLength, autoParts, autoDed, overlapUnit, overlap, preDed, afterTerms, afterDed, endDed, pieceLabel, isMitre }
}

// overrides / sideButt: optional (add-ons, see addonExpand.js); absent ⇒ output unchanged.
export function expandParts({ model, buttOf, widthOf, overrides, sideButt }) {
  if (!validModel(model)) return { components: [], issues: [{ role_name: '', reason: 'no_model' }] }
  const ctx = makeCtx({ model, buttOf, widthOf, overrides, sideButt })
  const { layout, issue, posName } = ctx
  const components = []
  const sources = []   // parallel to components: { key, line, pieces } (which line and pieces each row came from)
  const keys = [...layout.order, ...Object.keys(model.lines).filter((k) => !layout.order.includes(k) && layout.positions[k])]

  for (const key of keys) {
    const lines = model.lines[key] || []
    const name = posName(key)
    const n = pieceCount(model, key)
    lines.forEach((line, li) => {
      if (n === 0) return   // no piece (sliding_n middle sashes at n = 2, a grid with one column): nothing to price
      const family = ctx.famOf(key, li)
      const fixed = ctx.fixedLength(key, li)
      if (!family) { issue(name, 'no_profile_family'); return }
      const deducting = DEDUCTING_RULES.has(line.length_rule_type)
      const onMissing = (reason) => issue(name, reason)
      const lengthDed = deducting ? r6(ctx.preDed(key, line, onMissing) - ctx.overlap(key, line) + ctx.afterDed(key, line, onMissing)) : 0
      const mitre = ctx.isMitre(key)

      const groups = []
      for (let piece = 0; piece < n; piece++) {
        const pair = line.ends?.[piece] || []
        let sum = 0
        for (const e of mitre ? [] : [0, 1]) {   // a mitred part's ends are cut 45°: no end deduction, stale ends ignored
          const d = ctx.endDed(pair[e])
          if (d.problem) issue(name, d.problem)
          sum += d.mm
        }
        const k = Math.round(sum * 100) / 100
        const g = groups.find((x) => x.key === k)
        if (g) { g.count++; g.pieces.push(piece) }
        else groups.push({ key: k, sum: r6(sum), count: 1, first: piece, pieces: [piece] })
      }

      for (const g of groups) {
        sources.push({ key, line: li, pieces: g.pieces })
        components.push({
          role_name: groups.length > 1 ? `${name} ${ctx.pieceLabel(key, g.first)}` : name,
          profile_family: family,
          length_rule_type: line.length_rule_type,
          length_deduction_mm: lengthDed,
          length_factor: line.length_factor ?? 1,
          end_deduction_mm: g.sum,
          quantity_basis: 'fixed',
          quantity_value: (Number(line.quantity_value) || 0) * g.count,
          thickness_role: line.thickness_role ?? null,
          sort_order: components.length,
          cut_style: mitre ? 'miter45' : 'square',   // templateSave / DB cut_style vocabulary
          ...(fixed != null ? { fixed_length_mm: fixed } : {}),
        })
      }
    })
  }

  for (const v of validateCorners(model)) issue(posName(v.key), 'corner_violation')
  return { components, issues: ctx.issues, sources }
}

// The deductions of one profile line as the expander applies them (for the editor's fields):
// { pre: deduction before the factor, hasAuto: the position has an automatic deduction, overlap: sash overlap added back }.
export function lineDeductions({ model, buttOf, widthOf, key, lineIdx }) {
  if (!validModel(model)) return { pre: 0, hasAuto: false, overlap: 0 }
  const ctx = makeCtx({ model, buttOf, widthOf })
  const line = model.lines[key]?.[lineIdx]
  if (!line) return { pre: 0, hasAuto: false, overlap: 0 }
  const hasAuto = ctx.autoDed(key, () => {}) != null
  return { pre: ctx.preDed(key, line, () => {}), hasAuto, overlap: ctx.overlap(key, line) }
}

// One overlap of the sash part (auto = hook stile butt distance, else width; manual = overlap_mm), read from the first
// position with rule.overlap 'hook' (before × overlapCount). 0 when the layout has none.
export function sashOverlap({ model, buttOf, widthOf }) {
  if (!validModel(model)) return 0
  const ctx = makeCtx({ model, buttOf, widthOf })
  const key = ctx.layout.order.find((k) => ctx.layout.positions[k]?.rule?.overlap === 'hook')
  return key ? ctx.overlapUnit(key) : 0
}

// Default deduction of one end (override, else the butted profile's butt distance); { mm, problem }.
export function endDeduction({ model, buttOf, widthOf, end }) {
  if (!validModel(model)) return { mm: 0, problem: null }
  return makeCtx({ model, buttOf, widthOf }).endDed(end)
}

// Locale-free "1,234.5" (one decimal by default) so output is deterministic.
export function fmtMm(x, d = 1) {
  const neg = x < 0
  const [int, frac] = Math.abs(x).toFixed(d).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '')
}

// The "ที่มา" line for one piece, same wording as the approved mockup.
export function explainPiece({ model, buttOf, widthOf, key, lineIdx, piece, widthMm, heightMm }) {
  if (!validModel(model)) return ''
  const ctx = makeCtx({ model, buttOf, widthOf })
  const line = model.lines[key]?.[lineIdx]
  const pos = ctx.layout.positions[key]
  if (!line || !pos) return ''
  const rule = line.length_rule_type
  const isW = rule === 'width' || rule === 'width_minus'
  const base = rule === 'perimeter' ? 2 * (widthMm + heightMm) : isW ? widthMm : heightMm
  let steps = [(rule === 'perimeter' ? 'เส้นรอบรูป ' : isW ? 'กว้าง ' : 'สูง ') + fmtMm(base)]
  let cur = base
  if (DEDUCTING_RULES.has(rule)) {
    const d = ctx.preDed(key, line, () => {})
    const a = line.deduction_auto ? ctx.autoParts(key, () => {}) : null
    if (a?.grid && a.grid.n > 0) {
      steps.push('− หักวงกบ/ระยะหัก ' + fmtMm(a.frame))
      steps.push(`− ซอยกลาง (${a.grid.label}${a.grid.delta > 0 ? '+' : '−'}1) × กว้าง ${a.grid.n} × ${fmtMm(a.grid.w)}`)
    } else {
      steps.push('− หักวงกบ/ระยะหัก ' + fmtMm(d))
    }
    cur -= d
    const o = ctx.overlap(key, line)
    if (o) { steps.push('+ ระยะซ้อนบาน ' + fmtMm(o)); cur += o }
  }
  const factor = line.length_factor ?? 1
  if (factor !== 1) { steps = ['(' + steps.join(' ') + ') × ' + r6(factor)]; cur *= factor }
  if (DEDUCTING_RULES.has(rule) && factor) {   // rule.minus / rule.plusWidth: after the factor (sliding_2 sill guard)
    for (const t of ctx.afterTerms(key, () => {})) {
      steps.push(`${t.mm < 0 ? '−' : '+'} ${t.kind === 'minus' ? 'หัก' : 'กว้าง'} ${ctx.posName(t.key)} ${fmtMm(Math.abs(t.mm))}`)
      cur += t.mm
    }
  }
  const lab = pos.orient === 'h' ? ['ซ้าย', 'ขวา'] : ['บน', 'ล่าง']
  const pair = line.ends?.[piece] || []
  if (ctx.isMitre(key)) steps.push('(เข้ามุม 45°)')
  for (const e of ctx.isMitre(key) ? [] : [0, 1]) {
    const end = pair[e]
    if (end?.mode === 'butt') {
      const d = ctx.endDed(end).mm
      let target = 'ระบุเอง'
      if (end.to) target = ctx.posName(end.to.key) + ((model.lines[end.to.key]?.length || 0) > 1 ? ` โปรไฟล์ที่ ${end.to.line + 1}` : '')
      steps.push(`− ปลาย${lab[e]} ชน ${target} ${fmtMm(d)}`)
      cur -= d
    } else {
      steps.push(`ปลาย${lab[e]} วิ่งสุด`)
    }
  }
  return steps.join(' ') + ' = ' + fmtMm(Math.max(0, cur)) + ' มม.'
}
