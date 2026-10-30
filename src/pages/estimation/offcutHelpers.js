// src/pages/estimation/offcutHelpers.js
// Pure views of the offcut stock for one project's cut sheet: the two tabs of the offcut panel, which job used an
// offcut, and why a void is refused. offcuts = alu_offcuts rows (every status), plans = alu_cut_plans rows (both are
// loaded whole by useOffcuts / useCutPlans, so no query is needed here).

const groupKeyOf = o => `${o.profile_id}|${o.finish_id || ''}`
const byCode = (a, b) => String(a.code).localeCompare(String(b.code))

// use: offcuts from OTHER jobs this project's plan may take -- in stock in one of the project's profile+finish groups,
// or already taken by its issued plan -- never the ones its own issued plan made. made: every offcut the issued plan
// made, whatever its status now.
export function offcutTabs({ offcuts, groupInfo, issuedPlanId }) {
  const use = []
  const made = []
  for (const o of offcuts || []) {
    if (issuedPlanId && o.source_plan_id === issuedPlanId) { made.push(o); continue }
    if (issuedPlanId && o.status === 'used' && o.used_plan_id === issuedPlanId) { use.push(o); continue }
    if (o.status === 'in_stock' && groupInfo && groupInfo[groupKeyOf(o)]) use.push(o)
  }
  return { use: use.sort(byCode), made: made.sort(byCode) }
}

// The issued plan that took a used offcut: its project's name (null when not visible), its issue date and the items
// whose pieces were cut from the offcut. null when the offcut is not used.
export function offcutConsumer(offcut, plans, projectNames) {
  if (!offcut || offcut.status !== 'used' || !offcut.used_plan_id) return null
  const p = (plans || []).find(r => r.id === offcut.used_plan_id)
  if (!p) return { projectName: null, issued_at: null, openings: [] }
  const openings = []
  for (const g of (p.plan && p.plan.groups) || []) {
    for (const b of g.offcutBars || []) {
      if (!b.offcut || b.offcut.id !== offcut.id) continue
      for (const pc of b.pieces || []) if (!openings.includes(pc.opening_no)) openings.push(pc.opening_no)
    }
  }
  return { projectName: (projectNames || {})[p.project_id] || null, issued_at: p.issued_at || null, openings }
}

// Why void_cut_plan refuses planId: the offcuts it made that another plan has used, and those plans (once each).
export function voidBlockers({ offcuts, plans, planId, projectNames }) {
  const used = (offcuts || []).filter(o => o.source_plan_id === planId && o.status === 'used').sort(byCode)
  const consumers = []
  for (const o of used) {
    if (consumers.some(c => c.plan_id === o.used_plan_id)) continue
    const c = offcutConsumer(o, plans, projectNames)
    consumers.push({ plan_id: o.used_plan_id, projectName: c ? c.projectName : null, issued_at: c ? c.issued_at : null })
  }
  return { codes: used.map(o => o.code), consumers }
}

// The text void_cut_plan raises when another job has used an offcut this plan made.
export const USED_BY_OTHER_JOB = 'ถูกงานอื่นใช้ไปแล้ว'

// The cut-sheet error to show: a void refused because another job used this plan's offcuts gets voidBlockers attached
// (planId = the issued plan); any other error, including other void failures, is returned as it is.
export function cutErrorWithBlockers({ error, offcuts, plans, planId, projectNames }) {
  if (!error || error.action !== 'void' || !planId || !String(error.message || '').includes(USED_BY_OTHER_JOB)) return error
  return { ...error, blockers: voidBlockers({ offcuts, plans, planId, projectNames }) }
}

// "OC-0002, OC-0003" up to 3 codes; more as "OC-0002 … OC-0007" (the mockup's form).
export function codesText(codes) {
  const c = codes || []
  return c.length <= 3 ? c.join(', ') : `${c[0]} … ${c[c.length - 1]}`
}
