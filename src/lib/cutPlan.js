// src/lib/cutPlan.js
// Whole-project cut planning with piece provenance (which item, which part, how each end is cut), stock offcuts used
// before new bars, custom-length search and the 1-ton custom-order minimum. Pure. Kerf rules from cutOptimizer.js.
import { kerfM } from './cutOptimizer.js'

const EPS = 1e-9
const bomsOf = e => [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)].filter(Boolean)
const mm = n => Math.round(Number(n) * 1000) / 1000

// A bar's remainder goes back to offcut stock when it is at least the minimum keep length (float noise allowed).
export const isKeepRemainder = (left_m, minKeepM) => left_m + EPS >= minKeepM

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

// One piece's identity: item, part, length, both ends and the notch (joint and size). Shared by barSig and
// planSignature, so bars of different items or notch sizes are never one row and a notch-only edit changes the plan.
const pieceSig = p => `${p.item_id ?? ''}|${p.opening_no}|${p.role_name}|${p.length_m}|${p.end_a}|${p.end_b}|` +
  (p.notch ? `${p.notch.joint_name ?? ''}:${p.notch.width_mm ?? ''}x${p.notch.depth_mm ?? ''}` : '')
const barSig = b => b.pieces.map(pieceSig).join(';') + `#${b.length_m}`
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

export function rangeLengths(settings) {
  const a = Number(settings.custom_len_min_m), b = Number(settings.custom_len_max_m), s = Number(settings.custom_len_step_m)
  if (!(a > 0 && b >= a && s > 0)) return []
  const out = []
  for (let i = 0; out.length < 400; i++) { const x = mm(a + i * s); if (x > b + EPS) break; out.push(x) }
  return out
}

export function evaluateLength(pieces, L, settings, offcuts, kgPerM) {
  const packed = packWithOffcuts(pieces, L, settings, offcuts)
  let keep = 0, scrap = 0
  for (const b of [...packed.offcutBars, ...packed.bars]) (isKeepRemainder(b.left_m, settings.min_keep_offcut_m) ? (keep += b.left_m) : (scrap += b.left_m))
  return { length_m: L, newBars: packed.bars.length, kg: packed.bars.length * L * (Number(kgPerM) || 0), scrap_m: scrap, keep_m: keep,
    feasible: packed.unplaced.length === 0, packed }
}

const better = (a, b) => !b || a.kg < b.kg - 1e-6 || (Math.abs(a.kg - b.kg) < 1e-6 && (a.scrap_m < b.scrap_m - EPS ||
  (Math.abs(a.scrap_m - b.scrap_m) < EPS && (a.newBars < b.newBars || (a.newBars === b.newBars && a.length_m < b.length_m)))))

export function bestLength(pieces, candidates, settings, offcuts, kgPerM) {
  let best = null
  for (const L of [...new Set(candidates)]) { const ev = evaluateLength(pieces, L, settings, offcuts, kgPerM); if (ev.feasible && better(ev, best)) best = ev }
  return best
}

export function chooseLengths({ groups, mode, settings, kgPerM, offcutsByGroup, overrides }) {
  const stockL = Number(settings.stock_length_m)
  const stockPick = g => ({ length_m: stockL, custom: false, eval: evaluateLength(g.pieces, stockL, settings, (offcutsByGroup || {})[g.key] || [], (kgPerM || {})[g.key]) })
  const byGroup = {}
  if (mode !== 'custom') { for (const g of groups || []) byGroup[g.key] = stockPick(g); return { byGroup, customKg: 0, moqMet: true, reason: null } }
  const cands = [stockL, ...rangeLengths(settings)]
  let customKg = 0
  for (const g of groups || []) {
    const off = (offcutsByGroup || {})[g.key] || []
    const kg = (kgPerM || {})[g.key]
    // No weight known: every length would cost 0 kg, so stay on stock and keep it out of the minimum-order total.
    if (!(Number(kg) > 0)) { byGroup[g.key] = { ...stockPick(g), no_weight: true }; continue }
    const ov = overrides && overrides[g.key]
    const forced = ov ? evaluateLength(g.pieces, Number(ov), settings, off, kg) : null
    const overrideRejected = !!forced && !forced.feasible
    const ev = forced && forced.feasible ? forced : bestLength(g.pieces, cands, settings, off, kg)
    if (!ev) { byGroup[g.key] = { ...stockPick(g), overrideRejected }; continue }
    const custom = Math.abs(ev.length_m - stockL) > EPS
    if (custom) customKg += ev.kg
    byGroup[g.key] = { length_m: ev.length_m, custom, eval: ev, overrideRejected }
  }
  if (customKg > 0 && customKg < Number(settings.custom_moq_kg)) {
    for (const g of groups || []) byGroup[g.key] = { ...stockPick(g), ...(byGroup[g.key].no_weight ? { no_weight: true } : {}), overrideRejected: !!byGroup[g.key].overrideRejected }
    return { byGroup, customKg, moqMet: false, reason: 'moq' }
  }
  return { byGroup, customKg, moqMet: true, reason: null }
}

export function planSignature(entries) {
  const rows = []
  for (const [key, ps] of piecesOf(entries)) for (const p of ps) rows.push(`${key}|${pieceSig(p)}`)
  return rows.sort().join('\n')
}

// Remainders under 50 mm are saw loss, not offcuts (no sticker).
export const MIN_OFFCUT_M = 0.05

export function buildCutPlan({ entries, mode, settings, kgPerM, offcutsByGroup, overrides, groupInfo }) {
  const pieces = piecesOf(entries)
  const groups = [...pieces.entries()].map(([key, ps]) => ({ key, pieces: ps }))
  const chosen = chooseLengths({ groups, mode, settings, kgPerM, offcutsByGroup, overrides })
  const out = groups.map(g => {
    const c = chosen.byGroup[g.key]
    const { offcutBars, bars, unplaced } = c.eval.packed
    const newOffcuts = []
    const add = (bar, ref) => {
      if (bar.left_m + EPS < MIN_OFFCUT_M) return
      const last = bar.pieces[bar.pieces.length - 1]
      newOffcuts.push({ key: `${g.key}#${ref}`, bar_ref: ref, length_m: mm(bar.left_m), end_a: last && last.end_b !== 'notch' ? last.end_b : 'square', keep: isKeepRemainder(bar.left_m, settings.min_keep_offcut_m) })
    }
    offcutBars.forEach(b => add(b, b.offcut.code))
    bars.forEach((b, i) => add(b, String(i + 1)))
    return { key: g.key, ...(groupInfo || {})[g.key], length_m: c.length_m, custom: c.custom, no_weight: !!c.no_weight, overrideRejected: !!c.overrideRejected, offcutBars, bars, unplaced, kg: c.eval.kg, newOffcuts }
  })
  return { signature: planSignature(entries), mode, customKg: chosen.customKg, moqMet: chosen.moqMet, reason: chosen.reason, groups: out }
}

// flippedKeys = offcut keys whose keep default the user flipped (ticked "ไม่เก็บ" on a kept one, or unticked it on a dropped one)
export function issuePayload(plan, flippedKeys) {
  const flipped = flippedKeys || new Set()
  const used = []
  const created = []
  for (const g of plan.groups) {
    for (const b of g.offcutBars) used.push(b.offcut.id)
    for (const o of g.newOffcuts) if (o.keep !== flipped.has(o.key)) created.push({ key: o.key, profile_id: g.profile_id, finish_id: g.finish_id || null, length_m: o.length_m, end_a: o.end_a })
  }
  return { p_signature: plan.signature, p_plan: plan, p_used_offcut_ids: used, p_new_offcuts: created }
}
