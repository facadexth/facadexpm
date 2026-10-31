// ============================================================
// Company phase template -- pure helpers, no React/DOM.
// Stored in app_settings key 'phase_template' as JSON
// [{ name, sort_order, weight }]. The parse rules mirror the DB function
// phase_template_weights(): missing / invalid JSON / not an array / empty ->
// the built-in 7 phases; names trimmed, blank names dropped, a weight that is
// not a number counts as 0.
// ============================================================
import { PHASE_TEMPLATE } from './ganttTimeline.js'

export const PHASE_TEMPLATE_KEY = 'phase_template'
// Extra named templates offered next to the company template when a site starts its Gantt:
// JSON [{ key, label, rows: [{ name, weight }] }]. Only set for companies that need one
// (FacadeX "งานอลูมิเนียม"); missing / invalid -> [] and the Gantt shows the single button.
export const PHASE_TEMPLATES_EXTRA_KEY = 'phase_templates_extra'

export const DEFAULT_PHASE_TEMPLATE = PHASE_TEMPLATE.map((t) => ({ name: t.name, sort_order: t.sort_order, weight: t.billing_weight_pct }))

const round2 = (n) => Math.round(n * 100) / 100
const numWeight = (w) => {
  const n = typeof w === 'number' ? w : Number(String(w ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

/** raw app_settings value -> template rows (ordered, sort_order 1..n). */
export function parsePhaseTemplate(raw) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_PHASE_TEMPLATE
  let json
  try { json = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return DEFAULT_PHASE_TEMPLATE }
  if (!Array.isArray(json) || json.length === 0) return DEFAULT_PHASE_TEMPLATE
  const rows = json
    .map((e, i) => ({ name: String(e?.name ?? '').trim(), sort_order: Number(e?.sort_order) || i + 1, weight: numWeight(e?.weight) }))
    .filter((r) => r.name !== '')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r, i) => ({ ...r, sort_order: i + 1 }))
  return rows.length ? rows : DEFAULT_PHASE_TEMPLATE
}

/** raw 'phase_templates_extra' value -> [{ key, label, rows }]; bad entries dropped. */
export function parseExtraTemplates(raw) {
  if (raw == null || String(raw).trim() === '') return []
  let json
  try { json = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (!Array.isArray(json)) return []
  return json.flatMap((t, i) => {
    const label = String(t?.label ?? '').trim()
    if (!label || !Array.isArray(t?.rows) || !t.rows.length) return []
    const rows = parsePhaseTemplate(t.rows)
    if (rows === DEFAULT_PHASE_TEMPLATE) return []
    return [{ key: String(t.key ?? `extra${i}`), label, rows }]
  })
}

/** editor rows -> the JSON string saved to app_settings. */
export function serializePhaseTemplate(rows) {
  return JSON.stringify(rows.map((r, i) => ({ name: String(r.name ?? '').trim(), sort_order: i + 1, weight: numWeight(r.weight) })))
}

export const templateTotal = (rows) => round2(rows.reduce((s, r) => s + numWeight(r.weight), 0))

/** [] when the template can be saved; otherwise the reasons (Thai). */
export function templateProblems(rows) {
  const out = []
  if (!rows.length) out.push('ต้องมีอย่างน้อย 1 เฟส')
  const total = templateTotal(rows)
  if (Math.abs(total - 100) > 0.001) out.push(`รวมต้องได้ 100% (ตอนนี้ ${total}%)`)
  if (rows.some((r) => String(r.name ?? '').trim() === '')) out.push('ชื่อเฟสว่าง')
  if (rows.some((r) => numWeight(r.weight) < 0)) out.push('น้ำหนักต้องไม่ติดลบ')
  const seen = new Set()
  for (const r of rows) {
    const n = String(r.name ?? '').trim()
    if (!n) continue
    if (seen.has(n)) { out.push(`ชื่อเฟสซ้ำ: ${n}`); break }
    seen.add(n)
  }
  return out
}

/** Swap row i with its neighbour (dir -1 up / +1 down); same array when at the edge. */
export function moveTemplateRow(rows, i, dir) {
  const j = i + dir
  if (j < 0 || j >= rows.length) return rows
  const next = rows.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next.map((r, k) => ({ ...r, sort_order: k + 1 }))
}

/** site_phases insert rows for the Gantt "apply template" button. */
export const templateToPhaseRows = (rows) => rows.map((r, i) => ({ name: r.name, sort_order: i + 1, billing_weight_pct: numWeight(r.weight) }))

/**
 * "ใช้น้ำหนักจากแม่แบบ": the site's contract phases (not VO, not issue) matched to
 * the template by trimmed name. rows = what the compare dialog shows; updates = the
 * site_phases patches to write (matched and different); totalAfter = contract total
 * after the update (a hint that the site's weights may no longer sum to 100).
 */
export function compareWeightsWithTemplate(phases, template) {
  const byName = new Map(template.map((t) => [t.name.trim(), numWeight(t.weight)]))
  const rows = []
  const updates = []
  let totalAfter = 0
  for (const p of phases) {
    if (p.is_vo || p.is_issue_phase) continue
    const current = Number(p.billing_weight_pct) || 0
    const tpl = byName.has(String(p.name ?? '').trim()) ? byName.get(String(p.name ?? '').trim()) : null
    const changed = tpl != null && tpl !== current
    rows.push({ phaseId: p.id, name: p.name, current, template: tpl, changed })
    if (changed) updates.push({ id: p.id, billing_weight_pct: tpl })
    totalAfter += tpl != null ? tpl : current
  }
  return { rows, updates, totalAfter: round2(totalAfter) }
}
