// Compiles the part-editor model (see partModel.js) into the flat component rows bomEngine already understands.
// Pure: no I/O. buttOf(family) / widthOf(family) return mm or null.
import { LAYOUTS, pieceCount, validateCorners } from './partModel.js'

const r6 = (x) => Math.round(x * 1e6) / 1e6
const DEDUCTING_RULES = new Set(['width_minus', 'height_minus'])
const SASH_RAILS = new Set(['sash_top', 'sash_bottom'])

function validModel(model) {
  return !!(model && typeof model === 'object' && LAYOUTS[model.layout_kind] && model.lines && typeof model.lines === 'object' && Array.isArray(model.parts))
}

function makeCtx({ model, buttOf, widthOf }) {
  const layout = LAYOUTS[model.layout_kind]
  const issues = []
  const seen = new Set()
  const posName = (key) => model.names?.[key] || layout.positions[key]?.name || key
  const issue = (role_name, reason) => {
    const k = `${role_name}|${reason}`
    if (seen.has(k)) return
    seen.add(k)
    issues.push({ role_name, reason })
  }
  const famOf = (key, line) => model.lines[key]?.[line]?.profile_family || ''
  const butt = (fam) => {
    const v = fam ? buttOf(fam) : null
    return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
  }
  const partOf = (key) => model.parts.find((p) => p.key === layout.positions[key]?.part) || {}

  // Automatic pre-factor deduction; null when the position has none. `onMissing` is called for an unresolved lookup.
  function autoDed(key, onMissing) {
    const get = (k) => {
      const v = butt(famOf(k, 0))
      if (v == null) { onMissing(); return 0 }
      return v
    }
    if (SASH_RAILS.has(key)) return 2 * get('frame_side')
    if (key === 'key_stile' || key === 'hook_stile') return get('frame_top') + get('frame_bottom')
    return null
  }

  function overlap(key, line) {
    if (!SASH_RAILS.has(key) || line.length_rule_type !== 'width_minus') return 0
    const part = partOf(key)
    if (part.overlap_mode === 'auto_hook') {
      const fam = famOf('hook_stile', 0)
      return butt(fam) ?? (fam ? widthOf(fam) : null) ?? 0
    }
    return Number(part.overlap_mm) || 0
  }

  // Deduction before the factor, before overlap.
  function preDed(key, line, onMissing) {
    if (!DEDUCTING_RULES.has(line.length_rule_type)) return 0
    const a = line.deduction_auto ? autoDed(key, onMissing) : null
    return a != null ? a : Number(line.length_deduction_mm) || 0
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

  return { layout, issues, issue, posName, autoDed, overlap, preDed, endDed, pieceLabel }
}

export function expandParts({ model, buttOf, widthOf }) {
  if (!validModel(model)) return { components: [], issues: [{ role_name: '', reason: 'no_model' }] }
  const ctx = makeCtx({ model, buttOf, widthOf })
  const { layout, issue, posName } = ctx
  const components = []
  const keys = [...layout.order, ...Object.keys(model.lines).filter((k) => !layout.order.includes(k) && layout.positions[k])]

  for (const key of keys) {
    const lines = model.lines[key] || []
    const name = posName(key)
    const n = pieceCount(model, key)
    lines.forEach((line) => {
      if (!line.profile_family) { issue(name, 'no_profile_family'); return }
      const deducting = DEDUCTING_RULES.has(line.length_rule_type)
      const lengthDed = deducting ? r6(ctx.preDed(key, line, () => issue(name, 'no_butt_distance')) - ctx.overlap(key, line)) : 0

      const groups = []
      for (let piece = 0; piece < n; piece++) {
        const pair = line.ends?.[piece] || []
        let sum = 0
        for (const e of [0, 1]) {
          const d = ctx.endDed(pair[e])
          if (d.problem) issue(name, d.problem)
          sum += d.mm
        }
        const k = Math.round(sum * 100) / 100
        const g = groups.find((x) => x.key === k)
        if (g) g.count++
        else groups.push({ key: k, sum: r6(sum), count: 1, first: piece })
      }

      for (const g of groups) {
        components.push({
          role_name: groups.length > 1 ? `${name} ${ctx.pieceLabel(key, g.first)}` : name,
          profile_family: line.profile_family,
          length_rule_type: line.length_rule_type,
          length_deduction_mm: lengthDed,
          length_factor: line.length_factor ?? 1,
          end_deduction_mm: g.sum,
          quantity_basis: 'fixed',
          quantity_value: (Number(line.quantity_value) || 0) * g.count,
          thickness_role: line.thickness_role ?? null,
          sort_order: components.length,
          cut_style: 'square',
        })
      }
    })
  }

  for (const v of validateCorners(model)) issue(posName(v.key), 'corner_violation')
  return { components, issues: ctx.issues }
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
    steps.push('− หักวงกบ/ระยะหัก ' + fmtMm(d))
    cur -= d
    const o = ctx.overlap(key, line)
    if (o) { steps.push('+ ระยะซ้อนบาน ' + fmtMm(o)); cur += o }
  }
  const factor = line.length_factor ?? 1
  if (factor !== 1) { steps = ['(' + steps.join(' ') + ') × ' + factor]; cur *= factor }
  const lab = pos.orient === 'h' ? ['ซ้าย', 'ขวา'] : ['บน', 'ล่าง']
  const pair = line.ends?.[piece] || []
  for (const e of [0, 1]) {
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
