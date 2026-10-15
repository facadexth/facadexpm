// src/lib/providerCompare.js
// "Compare extruders" for a whole project: recompute the ALUMINIUM cost of every item as if it were built in a
// candidate extruder's series and colour. Read-only: nothing in the project changes. Pure.
// Candidate = { providerId, seriesId, finishId } (the screen lets the owner pick the series + colour per candidate).
// Items keep their size, template and thickness (frame and sash); a candidate series that lacks a thickness or
// profile makes those lines unresolved, and the row says how many lines could not be priced.
// Built on costOpening so joints, role thickness and inheritance behave exactly as in the item form.
import { costOpening, costBoms, isAddonIssue } from './openingCost.js'

// ctx: { project, items, templatesById, componentsByTemplate, jointsByTemplate, partModelByTemplate?, addonPiecesByTemplate?,
//        itemAddonsByOpening?, addonPiecesError?, itemAddonsError?, typesById, infillTypesById, index, settings, candidates, asOf }
export function compareProviders(ctx) {
  const { items, templatesById, index } = ctx
  return (ctx.candidates || []).map(cand => {
    // early return if seriesId or finishId is missing
    if (!cand.seriesId || !cand.finishId) {
      return { ...cand, aluminium: 0, unresolvedLines: 1, itemsPriced: 0, complete: false }
    }

    let aluminium = 0
    let unresolvedLines = 0
    let itemsPriced = 0
    const failedItems = []   // items costOpening threw on: shown as "คิดราคาไม่ได้", never crash the whole tab
    for (const item of items || []) {
      const template = (templatesById || {})[item.template_id]
      if (!template) { unresolvedLines += Number(item.quantity) > 0 ? Number(item.quantity) : 1; continue }
      // the same item, forced onto the candidate series + colour; hardware is not part of this comparison
      const forced = { ...item, series_id: cand.seriesId, alu_finish_id: cand.finishId, no_hardware_set: true, hardware_set_id: null }
      const addonTemplate = item.addon_template_id ? (templatesById || {})[item.addon_template_id] : null
      try {
        const r = costOpening({
          item: forced, project: ctx.project, template, addonTemplate,
          componentsByTemplate: ctx.componentsByTemplate, hardwareByTemplate: {}, jointsByTemplate: ctx.jointsByTemplate, partModelByTemplate: ctx.partModelByTemplate,
          addonPiecesByTemplate: ctx.addonPiecesByTemplate, itemAddonsByOpening: ctx.itemAddonsByOpening, addonPiecesError: ctx.addonPiecesError, itemAddonsError: ctx.itemAddonsError,
          typesById: ctx.typesById, infillTypesById: ctx.infillTypesById, index, settings: ctx.settings, asOf: ctx.asOf,
        })
        const lines = costBoms(r).flatMap(b => [...b.profileLines, ...b.gridLines])
        const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1
        aluminium += lines.reduce((s, l) => s + l.cost, 0) * qty
        unresolvedLines += lines.filter(l => !l.resolved).length * qty
        // also count unresolved dimensions and joints
        unresolvedLines += (r.unresolved || []).filter(u => u.reason === 'no_dimension' || u.reason === 'unknown_addon_template' || u.reason === 'unknown_infill' || u.source === 'joint' || isAddonIssue(u)).length * qty
        itemsPriced += 1
      } catch (e) {
        const q = Number(item.quantity) > 0 ? Number(item.quantity) : 1
        unresolvedLines += q
        failedItems.push({ id: item.id, opening_no: item.opening_no, text: 'คิดราคาไม่ได้' })
      }
    }
    return { ...cand, aluminium, unresolvedLines, itemsPriced, failedItems, complete: unresolvedLines === 0 && itemsPriced > 0 }
  })
}

// Difference against the project's own extruder row; null when either side is incomplete (never a fake saving).
export function diffAgainst(base, row) {
  if (!base || !row || !base.complete || !row.complete || !(base.aluminium > 0)) return null
  const amount = row.aluminium - base.aluminium
  return { amount, pct: (100 * amount) / base.aluminium }
}
