// src/lib/cutOptimizer.js
// Whole-project cut planning: pack the cuts of one profile onto stock bars (first-fit decreasing, saw kerf
// charged per cut), and compare candidate bar lengths to find the one wasting least. Pure.
// cuts: [{ length_m, quantity, style }] with style 'square' | 'notch' | 'miter45' (miter45 uses the wider kerf).

const EPS = 1e-9

export const kerfM = (style, settings) => (style === 'miter45' ? settings.kerf_miter_mm : settings.kerf_square_mm) / 1000

// Longest piece first; a piece goes on the first bar with room for it plus its kerf.
// A piece longer than the bar can never be placed: it is returned in `unplaced`, never dropped silently.
export function packBars(cuts, barLengthM, settings) {
  const pieces = []
  for (const c of cuts || []) {
    const len = Number(c.length_m)
    const qty = Math.floor(Number(c.quantity))
    if (!(len > 0) || !(qty > 0)) continue
    for (let i = 0; i < qty; i++) pieces.push({ len, kerf: kerfM(c.style, settings) })
  }
  pieces.sort((a, b) => b.len - a.len)
  const bars = []
  const unplaced = []
  for (const p of pieces) {
    if (p.len > barLengthM + EPS) { unplaced.push(p.len); continue }
    const bar = bars.find(b => b.left + EPS >= p.len + p.kerf)
    if (bar) { bar.left -= p.len + p.kerf; bar.pieces.push(p.len) }
    else bars.push({ left: barLengthM - p.len - p.kerf, pieces: [p.len] })
  }
  // The last cut on a bar needs no trailing kerf, so a bar that came out a hair negative is clamped, not rejected.
  for (const b of bars) b.left = Math.max(0, b.left)
  return { bars, unplaced }
}

// Offcuts at least minKeepM long are reusable stock; shorter ones are scrap.
export function summarizePacking(packed, barLengthM, minKeepM) {
  const count = packed.bars.length
  const cut_m = packed.bars.reduce((s, b) => s + b.pieces.reduce((a, x) => a + x, 0), 0)
  let reusable_m = 0
  let scrap_m = 0
  for (const b of packed.bars) (b.left + EPS >= minKeepM && b.left > 0 ? (reusable_m += b.left) : (scrap_m += b.left))
  const stock_m = count * barLengthM
  return { count, cut_m, stock_m, reusable_m, scrap_m, waste_pct: stock_m > 0 ? (100 * (stock_m - cut_m)) / stock_m : 0, unplaced: packed.unplaced }
}

// Tries every candidate length. barPrice(L) is the price of one whole bar (or null when unknown).
// Best = lowest total cost when every feasible row is priced, otherwise least scrap; ties: fewer bars, then shorter bar.
// Kept offcuts do NOT reduce the cost (conservative ruling); they are only reported.
export function compareLengths({ cuts, lengths, settings, barPrice }) {
  const rows = (lengths || []).map(L => {
    const packed = packBars(cuts, L, settings)
    const s = summarizePacking(packed, L, settings.min_keep_offcut_m)
    const price = barPrice ? barPrice(L) : null
    const feasible = s.unplaced.length === 0 && s.count > 0
    const per = packed.bars.map(b => b.pieces.length)
    return { length_m: L, ...s, feasible, cost: feasible && price != null ? price * s.count : null,
      per_bar_min: per.length ? Math.min(...per) : 0, per_bar_max: per.length ? Math.max(...per) : 0 }
  })
  const ok = rows.filter(r => r.feasible)
  const priced = ok.length > 0 && ok.every(r => r.cost != null)
  const key = r => (priced ? r.cost : r.scrap_m)
  const best = [...ok].sort((a, b) => key(a) - key(b) || a.count - b.count || a.length_m - b.length_m)[0] || null
  return { rows, best, basis: best ? (priced ? 'cost' : 'scrap') : null }
}
