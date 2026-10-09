// src/lib/providerCompare.js
// "Compare extruders" for a whole project: recompute the ALUMINIUM cost of every item as if it were built in a
// candidate extruder's series and colour. Read-only: nothing in the project changes. Pure.
// Candidate = { providerId, seriesId, finishId } (the screen lets the owner pick the series + colour per candidate).
// Items keep their size, template and thickness (frame and sash); a candidate series that lacks a thickness or
// profile makes those lines unresolved, and the row says how many lines could not be priced.
// Built on costOpening so joints, role thickness and inheritance behave exactly as in the item form.
import { costOpening } from './openingCost.js'

// ctx: { project, items, templatesById, componentsByTemplate, jointsByTemplate, typesById, infillTypesById, index, settings, candidates, asOf }
export function compareProviders(ctx) {
  const { items, templatesById, index } = ctx
  return (ctx.candidates || []).map(cand => {
    let aluminium = 0
    let unresolvedLines = 0
    let itemsPriced = 0
    for (const item of items || []) {
      const template = (templatesById || {})[item.template_id]
      if (!template) continue
      // the same item, forced onto the candidate series + colour; hardware is not part of this comparison
      const forced = { ...item, series_id: cand.seriesId, alu_finish_id: cand.finishId, no_hardware_set: true, hardware_set_id: null }
      const addonTemplate = item.addon_template_id ? (templatesById || {})[item.addon_template_id] : null
      const r = costOpening({
        item: forced, project: ctx.project, template, addonTemplate,
        componentsByTemplate: ctx.componentsByTemplate, hardwareByTemplate: {}, jointsByTemplate: ctx.jointsByTemplate,
        typesById: ctx.typesById, infillTypesById: ctx.infillTypesById, index, settings: ctx.settings, asOf: ctx.asOf,
      })
      const lines = [...r.bom.profileLines, ...r.bom.gridLines, ...(r.addonBom ? [...r.addonBom.profileLines, ...r.addonBom.gridLines] : [])]
      const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1
      aluminium += lines.reduce((s, l) => s + l.cost, 0) * qty
      unresolvedLines += lines.filter(l => !l.resolved).length * qty
      itemsPriced += 1
    }
    return { ...cand, aluminium, unresolvedLines, itemsPriced, complete: unresolvedLines === 0 && itemsPriced > 0 }
  })
}

// Difference against the project's own extruder row; null when either side is incomplete (never a fake saving).
export function diffAgainst(base, row) {
  if (!base || !row || !base.complete || !row.complete || !(base.aluminium > 0)) return null
  const amount = row.aluminium - base.aluminium
  return { amount, pct: (100 * amount) / base.aluminium }
}
