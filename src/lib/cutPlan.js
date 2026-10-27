// src/lib/cutPlan.js
// Whole-project cut planning with piece provenance (which item, which part, how each end is cut), stock offcuts used
// before new bars, custom-length search and the 1-ton custom-order minimum. Pure. Kerf rules from cutOptimizer.js.
import { kerfM } from './cutOptimizer.js'

const EPS = 1e-9
const bomsOf = e => [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)].filter(Boolean)
const mm = n => Math.round(Number(n) * 1000) / 1000

export function piecesOf(entries) {
  const out = new Map()
  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    for (const bom of bomsOf(e)) for (const l of [...bom.profileLines, ...bom.gridLines]) {
      if (!l.resolved || !l.profile_id) continue
      const style = l.cut_style || 'square'
      const ends = style === 'square' ? 0 : (Number(l.cut_ends) === 1 ? 1 : 2)
      const end_a = ends >= 1 ? style : 'square'
      const end_b = ends === 2 ? style : 'square'
      const piece = {
        length_m: mm(l.length_m), opening_no: e.opening_no, item_id: e.item_id ?? null, item_name: e.item_name || '', role_name: l.role_name || '',
        end_a, end_b, kerf_style: end_a === 'miter45' || end_b === 'miter45' ? 'miter45' : 'square',
        notch: style === 'notch' ? { joint_name: l.joint_name || null, width_mm: l.notch_width_mm ?? null, depth_mm: l.notch_depth_mm ?? null } : null,
      }
      const key = `${l.profile_id}|${e.finish_id || ''}`
      if (!out.has(key)) out.set(key, [])
      const list = out.get(key)
      const n = (Number(l.quantity) || 0) * q
      for (let i = 0; i < n; i++) list.push({ ...piece })
    }
  }
  return out
}

const fits = (bar, p, settings) => bar.left_m + EPS >= p.length_m + kerfM(p.kerf_style, settings) || (bar.left_m + EPS >= p.length_m && bar.pieces.length === 0)
const place = (bar, p, settings) => { bar.left_m = Math.max(0, bar.left_m - p.length_m - kerfM(p.kerf_style, settings)); bar.pieces.push(p) }

// Longest piece first. Offcuts (shortest first, so small leftovers get used up) are tried before new bars.
export function packWithOffcuts(pieces, barLengthM, settings, offcuts) {
  const sorted = [...(pieces || [])].sort((a, b) => b.length_m - a.length_m)
  const offBars = [...(offcuts || [])].sort((a, b) => a.length_m - b.length_m)
    .map(o => ({ length_m: Number(o.length_m), left_m: Number(o.length_m), pieces: [], offcut: { id: o.id, code: o.code, length_m: Number(o.length_m) } }))
  const bars = []
  const unplaced = []
  for (const p of sorted) {
    if (p.length_m > barLengthM + EPS && !offBars.some(b => fits(b, p, settings))) { unplaced.push(p); continue }
    const ob = offBars.find(b => fits(b, p, settings))
    if (ob) { place(ob, p, settings); continue }
    const b = bars.find(x => fits(x, p, settings))
    if (b) place(b, p, settings)
    else { const nb = { length_m: barLengthM, left_m: barLengthM, pieces: [] }; place(nb, p, settings); bars.push(nb) }
  }
  return { offcutBars: offBars.filter(b => b.pieces.length), bars, unplaced }
}

const barSig = b => b.pieces.map(p => `${p.opening_no}|${p.role_name}|${p.length_m}|${p.end_a}|${p.end_b}`).join(';') + `#${b.length_m}`
export function groupIdenticalBars(bars) {
  const out = []
  const idx = new Map()
  ;(bars || []).forEach((bar, i) => {
    const s = barSig(bar)
    if (idx.has(s)) { const g = out[idx.get(s)]; g.count++; g.nos.push(i + 1) }
    else { idx.set(s, out.length); out.push({ bar, count: 1, nos: [i + 1] }) }
  })
  return out
}
