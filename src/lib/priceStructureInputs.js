// Assembles priceProject's inputs from estimation items, the costItems() map and the project row. Pure.
import { costBreakdown } from './priceStructure.js'

const num = v => { const x = typeof v === 'string' && v.trim() === '' ? 0 : Number(v); return Number.isFinite(x) ? x : 0 }
const ZERO = { alu: 0, hardware: 0, glass: 0, labour: 0, other: 0, aluWeightKg: 0 }

// Blank means "follow the project's profit %"; 0 is a real value.
function itemProfit(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

export function buildPriceInputs({ items, costs, project }) { // eslint-disable-line no-unused-vars
  return (items || []).map(it => {
    const cost = costs ? costs[it.id] : null
    const width = num(it.width_m)
    const height = num(it.height_m)
    const costMissing = cost === null || cost === undefined
    const unresolved = costMissing || (Array.isArray(cost.unresolved) && cost.unresolved.length > 0) || !(width > 0) || !(height > 0)
    return {
      id: it.id,
      quantity: Math.max(0, num(it.quantity)),
      width_m: width,
      height_m: height,
      breakdown: costMissing ? { ...ZERO } : costBreakdown(cost),
      fireBarrier: num(it.fire_barrier_cost),
      bracket: num(it.bracket_cost),
      bendAlu: num(it.bend_alu_cost),
      bendGlass: num(it.bend_glass_cost),
      profitPct: itemProfit(it.profit_pct),
      unresolved,
    }
  })
}

export function projectFactors(project) {
  const p = project || {}
  const step = num(p.round_step)
  return {
    wastePct: num(p.waste_pct),
    profitPct: num(p.profit_pct),
    pmPct: num(p.pm_pct),
    transportTotal: num(p.transport_total),
    roundStep: step > 0 ? step : 100,
  }
}
