// src/lib/priceStructure.js
// Price structure of an estimation project (owner's ELSY sheet). Pure: no I/O, no React.
//   V = all cost categories   W = aluminium x waste%   X = V x profit%   Y = V + W + X
//   Z = project transport allocated by share of Y x quantity   PM = ceil(Y x pm%)
//   per set = Y + Z + PM   price = per set rounded UP to the step   per sqm = per set / (w x h)
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const sum = (rows, k) => (rows || []).reduce((s, r) => s + n(r[k]), 0)

// The engine's own template waste is deliberately left out (Ruling P3-2): the project's waste % applies instead.
export function costBreakdown(cost) {
  const boms = [cost && cost.bom, cost && cost.addonBom].filter(Boolean)
  const profile = b => [...(b.profileLines || []), ...(b.gridLines || [])]
  return {
    alu: boms.reduce((s, b) => s + sum(profile(b), 'cost'), 0),
    hardware: boms.reduce((s, b) => s + sum(b.hardwareLines, 'cost') + sum(b.hardwareSetLines, 'cost'), 0),
    glass: boms.reduce((s, b) => s + n(b.infillCost), 0),
    labour: boms.reduce((s, b) => s + n(b.laborCost), 0),
    other: boms.reduce((s, b) => s + n(b.siliconeCost) + n(b.feltCost) + n(b.extraLinesCost), 0) + n(cost && cost.extras && cost.extras.cost),
    aluWeightKg: boms.reduce((s, b) => s + sum(profile(b), 'weight_kg'), 0),
  }
}

export function priceItem({ breakdown, fireBarrier, bracket, bendAlu, bendGlass, profitPct, wastePct }) {
  const b = breakdown || {}
  const v = n(b.alu) + n(b.hardware) + n(b.glass) + n(b.labour) + n(b.other) + n(fireBarrier) + n(bracket) + n(bendAlu) + n(bendGlass)
  const w = n(b.alu) * n(wastePct) / 100
  const x = v * n(profitPct) / 100
  return { v, w, x, y: v + w + x }
}

export function priceProject({ items, factors }) {
  const f = factors || {}
  const step = n(f.roundStep) > 0 ? n(f.roundStep) : 100
  const base = (items || []).map(it => {
    const resolved = !it.unresolved
    const profitPct = it.profitPct === null || it.profitPct === undefined || it.profitPct === '' ? n(f.profitPct) : n(it.profitPct)
    const p = resolved ? priceItem({ breakdown: it.breakdown, fireBarrier: it.fireBarrier, bracket: it.bracket, bendAlu: it.bendAlu, bendGlass: it.bendGlass, profitPct, wastePct: f.wastePct }) : { v: 0, w: 0, x: 0, y: 0 }
    return { it, resolved, profitPct, ...p, qty: Math.max(0, n(it.quantity)) }
  })
  const basis = base.reduce((s, r) => s + (r.resolved ? r.y * r.qty : 0), 0)
  const rows = base.map(r => {
    const { it } = r
    const extraCosts = { fireBarrier: n(it.fireBarrier), bracket: n(it.bracket), bendAlu: n(it.bendAlu), bendGlass: n(it.bendGlass) }
    const aluWeightKg = n(it.breakdown && it.breakdown.aluWeightKg)
    if (!r.resolved) return { id: it.id, quantity: r.qty, resolved: false, v: 0, w: 0, x: 0, y: 0, z: 0, pm: 0, perSet: 0, price: null, perSqm: null, lineTotal: 0, profitPct: r.profitPct, breakdown: it.breakdown, extraCosts, aluWeightKg }
    const z = basis > 0 && r.qty > 0 ? n(f.transportTotal) * (r.y * r.qty / basis) / r.qty : 0
    const pm = Math.ceil(r.y * n(f.pmPct) / 100 - 1e-9)
    const perSet = r.y + z + pm
    const price = Math.ceil(perSet / step - 1e-9) * step
    const area = n(it.width_m) * n(it.height_m)
    return { id: it.id, quantity: r.qty, resolved: true, v: r.v, w: r.w, x: r.x, y: r.y, z, pm, perSet, price, perSqm: area > 0 ? perSet / area : null, lineTotal: price * r.qty, profitPct: r.profitPct, breakdown: it.breakdown, extraCosts, aluWeightKg }
  })
  const ok = rows.filter(r => r.resolved)
  const net = ok.reduce((s, r) => s + r.aluWeightKg * r.quantity, 0)
  return {
    rows,
    totals: {
      lineTotal: ok.reduce((s, r) => s + r.lineTotal, 0),
      sumV: ok.reduce((s, r) => s + r.v * r.quantity, 0), sumW: ok.reduce((s, r) => s + r.w * r.quantity, 0),
      sumX: ok.reduce((s, r) => s + r.x * r.quantity, 0), sumZ: ok.reduce((s, r) => s + r.z * r.quantity, 0),
      sumPm: ok.reduce((s, r) => s + r.pm * r.quantity, 0),
      aluWeightNet: net, aluWeightWithWaste: net * (1 + n(f.wastePct) / 100),
    },
  }
}

// Real profit on the same base the set profit uses: (net price - (V+W+Z+PM)) / V, in percent.
export function realProfitPct({ v, w, z, pm, agreedNet }) {
  if (!(n(v) > 0)) return null
  return (n(agreedNet) - (n(v) + n(w) + n(z) + n(pm))) / n(v) * 100
}
