// src/pages/estimation/projectBomHelpers.js
// Pure helpers of the whole-project BOM screen: entries, piece-count guard, stock-length input, cut-optimizer
// view model and extruder-comparison view model. No React, no Supabase.
import { compareLengths } from '../../lib/cutOptimizer.js'
import { findVariant, pickLatest, resolveAluPrice } from '../../lib/aluPrice.js'
import { diffAgainst } from '../../lib/providerCompare.js'
import { piecesOf, evaluateLength, bestLength, rangeLengths } from '../../lib/cutPlan.js'

// The packer allocates one object per piece: above this many pieces the screen refuses to pack and says so.
export const MAX_PIECES = 20000
export const MAX_STOCK_LENGTH_M = 20
const EPS = 1e-9

// One entry per item that could be costed, in the shape buildProjectBom wants. Items with no cost result
// (no template) come back in `skipped`, never silently dropped.
export function buildEntries(items, costs) {
  const entries = []
  const skipped = []
  for (const item of items || []) {
    const r = (costs || {})[item.id]
    if (!r) { skipped.push({ opening_no: item.opening_no, name: item.item_name || null, reason: 'no_template' }); continue }
    entries.push({ item_id: item.id, item_name: item.item_name || '', opening_no: item.opening_no, quantity: item.quantity, finish_id: r.resolved.finish_id, bom: r.bom, addonBom: r.addonBom, addonBoms: r.addonBoms || [], extras: r.extras, unresolved: r.unresolved })
  }
  return { entries, skipped }
}

// Total pieces the packer would allocate (all resolved profile and grid lines x item quantity).
export function entriesPieceCount(entries) {
  let n = 0
  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    for (const bom of [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)]) {
      if (!bom) continue
      for (const l of [...bom.profileLines, ...bom.gridLines]) if (l.resolved && l.profile_id) n += (Number(l.quantity) || 0) * q
    }
  }
  return n
}

// { 'profileId|finishId': Set(seriesId) } -- the series the BOM lines were priced in (needed for series-level kg prices).
export function seriesByGroup(entries) {
  const m = {}
  for (const e of entries || []) {
    for (const bom of [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)]) {
      if (!bom) continue
      for (const l of [...bom.profileLines, ...bom.gridLines]) {
        if (!l.resolved || !l.profile_id) continue
        const k = `${l.profile_id}|${e.finish_id || ''}`
        ;(m[k] = m[k] || new Set()).add(l.series_id || '')
      }
    }
  }
  return m
}

// '' = blank (use the default), a positive number up to MAX_STOCK_LENGTH_M, else NaN (invalid).
export function parseStockLength(text) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN
  const n = Number(s)
  return n > 0 && n <= MAX_STOCK_LENGTH_M ? n : NaN
}

// What to do with estimation_project_stock for one (project, profile): existing = the row found by a fresh lookup.
export function stockWriteAction(existing, value) {
  if (Number.isNaN(value)) return { op: 'invalid' }
  if (value === null) return existing ? { op: 'delete', id: existing.id } : { op: 'none' }
  if (!existing) return { op: 'insert', value }
  return Number(existing.length_m) === value ? { op: 'none' } : { op: 'update', id: existing.id, value }
}

// Price of one WHOLE bar of length L (metres), or null. per_kg: the metre price x L. per_piece / both: never
// scaled from another length: the exact variant row of length L and its latest piece price at asOf, else null.
// seriesIds: the series the profile+colour was priced in. With more than one, the kg bar price is given only when
// every one of them resolves to the same metre price; otherwise null (never a guess from one of them).
export function makeBarPrice({ index, profile, finish, seriesIds, seriesId, asOf }) {
  const provider = profile && index.providers[profile.provider_id]
  if (!provider || !finish || !asOf) return () => null
  if (provider.price_basis === 'per_kg') {
    const ids = [...new Set(seriesIds ? seriesIds.filter(Boolean) : (seriesId ? [seriesId] : []))]
    const prices = (ids.length ? ids : [null]).map(id => resolveAluPrice({
      provider, series: id ? index.series[id] : null, profile, finish, variants: index.variants, asOf, kgPrices: index.kgPrices, piecePrices: index.piecePrices,
    }))
    const perM = prices.every(p => !p.unresolved && p.price_per_m > 0) && prices.every(p => Math.abs(p.price_per_m - prices[0].price_per_m) < 1e-9)
      ? prices[0].price_per_m : null
    return L => (perM == null ? null : perM * L)
  }
  return L => {
    const v = findVariant(index.variants, profile.id, finish.id, L)
    if (!v || Math.abs(Number(v.length_m) - L) > EPS) return null
    const row = pickLatest(index.piecePrices, asOf, r => r.variant_id === v.id)
    return row ? Number(row.price_per_piece) : null
  }
}

// Distinct variant lengths of the profile in that colour plus the current stock length, ascending.
// rangeM (optional): the custom-order lengths of a project job (cutPlan.js rangeLengths), merged in.
export function candidateLengths(index, profileId, finishId, stockLengthM, rangeM) {
  const set = new Set()
  for (const v of index.variants || []) if (v.profile_id === profileId && v.finish_id === finishId && Number(v.length_m) > 0) set.add(Number(v.length_m))
  if (Number(stockLengthM) > 0) set.add(Number(stockLengthM))
  for (const L of rangeM || []) if (Number(L) > 0) set.add(Number(L))
  return [...set].sort((a, b) => a - b)
}

// View model of the cut optimizer for one profile group (an item of buildProjectBom().profiles).
export function optimizerView({ group, index, settings, asOf, seriesIds, rangeM }) {
  const profile = index.profiles[group.profile_id]
  const finish = group.finish_id ? index.finishes[group.finish_id] : null
  const barPrice = makeBarPrice({ index, profile, finish, seriesIds: seriesIds || [], asOf })
  const lengths = candidateLengths(index, group.profile_id, group.finish_id, group.stock_length_m, rangeM)
  const result = compareLengths({ cuts: group.cuts, lengths, settings, barPrice })
  const rows = result.rows.map(r => {
    const infeasible = r.feasible === false
    return {
      length_m: r.length_m, isCurrent: Math.abs(r.length_m - group.stock_length_m) < EPS,
      status: infeasible ? 'infeasible' : 'ok',
      unplaced: infeasible ? r.unplaced : [],
      count: infeasible ? null : r.count, scrap_m: infeasible ? null : r.scrap_m, reusable_m: infeasible ? null : r.reusable_m,
      waste_pct: infeasible ? null : r.waste_pct, cost: infeasible ? null : r.cost,
      best: !!result.best && result.best.length_m === r.length_m,
    }
  })
  return { rows, basis: result.basis, hasCuts: group.cuts.length > 0 }
}

// ---- Cut plan (cutPlan.js buildCutPlan) inputs and the custom-length summary ----

// { 'profileId|finishId': { profile_id, finish_id (null when blank), die_no, name, finish_name } } for EVERY group the
// cut plan will have (same lines and key as cutPlan.js piecesOf). The plan's issue payload sends these ids to the DB.
export function cutGroupInfo(entries, index) {
  const info = {}
  for (const e of entries || []) {
    for (const bom of [e.bom, e.addonBom, ...(e.addonBoms || []).map(a => a && a.bom)]) {
      if (!bom) continue
      for (const l of [...bom.profileLines, ...bom.gridLines]) {
        if (!l.resolved || !l.profile_id) continue
        const k = `${l.profile_id}|${e.finish_id || ''}`
        if (info[k]) continue
        const profile = (index.profiles || {})[l.profile_id]
        const finish = e.finish_id ? (index.finishes || {})[e.finish_id] : null
        info[k] = { profile_id: l.profile_id, finish_id: e.finish_id || null, die_no: profile ? profile.drawing_no || null : null,
          name: profile ? profile.name : '?', finish_name: finish ? finish.name : null }
      }
    }
  }
  return info
}

// kg per metre of each group's profile, null when the catalogue has none.
export function cutGroupKgPerM(groupInfo, index) {
  const out = {}
  for (const [k, g] of Object.entries(groupInfo || {})) {
    const w = Number(((index.profiles || {})[g.profile_id] || {}).linear_weight_kg_per_m)
    out[k] = w > 0 ? w : null
  }
  return out
}

// The stock-length basis of section 1 (buildProjectBom), the same one the cut plan uses so the two never disagree:
// a normal job buys the market bar only (settings.stock_length_m, no overrides); a project job uses its per-profile
// lengths. The project-wide stock length (projectM) is never used.
export function bomStockBasis(cutMode, projectStock) {
  return { byProfile: cutMode === 'custom' && projectStock ? projectStock.byProfile || {} : {}, projectM: null }
}

// Per-profile stock lengths (estimation_project_stock) onto every group of that profile.
export function cutGroupOverrides(groupInfo, byProfile) {
  const out = {}
  for (const [k, g] of Object.entries(groupInfo || {})) if (byProfile && Number(byProfile[g.profile_id]) > 0) out[k] = Number(byProfile[g.profile_id])
  return out
}

// Price per kg of each group (custom lengths cost the same per kg as stock bars): the price of 1 m / kg per m.
export function cutGroupPricePerKg({ groupInfo, index, seriesMap, asOf, kgPerM }) {
  const out = {}
  for (const [k, g] of Object.entries(groupInfo || {})) {
    const kg = Number((kgPerM || {})[k])
    const profile = (index.profiles || {})[g.profile_id]
    const finish = g.finish_id ? (index.finishes || {})[g.finish_id] : null
    const perM = kg > 0 ? makeBarPrice({ index, profile, finish, seriesIds: (seriesMap || {})[k] || [], asOf })(1) : null
    out[k] = perM != null && perM > 0 ? perM / kg : null
  }
  return out
}

// Per group: the stock-length baseline and the least-kg length over stock + the custom range, ignoring per-profile
// overrides and the minimum order (the plan applies those). best is null when the profile has no weight or no length cuts all.
export function lengthCompare({ entries, settings, kgPerM, offcutsByGroup }) {
  const stockL = Number(settings.stock_length_m)
  const cands = [stockL, ...rangeLengths(settings)]
  const brief = ev => ({ length_m: ev.length_m, newBars: ev.newBars, kg: ev.kg })
  const out = {}
  for (const [k, pieces] of piecesOf(entries)) {
    const off = (offcutsByGroup || {})[k] || []
    const kg = (kgPerM || {})[k]
    const base = evaluateLength(pieces, stockL, settings, off, kg)
    const best = Number(kg) > 0 ? bestLength(pieces, cands, settings, off, kg) : null
    out[k] = { base: brief(base), best: best ? brief(best) : null }
  }
  return out
}

// Rows and totals of CustomLengthSummary. prices = cutGroupPricePerKg; a row's cost is null when unpriced, and the
// baht saving is null when any group whose kg changed is unpriced (never a partial sum shown as the whole).
export function customLengthSummaryModel({ plan, compare, prices, kgPerM }) {
  let baseKg = 0, useKg = 0, savingBaht = 0
  const rows = (plan.groups || []).map(g => {
    const c = (compare || {})[g.key] || { base: null, best: null }
    const price = (prices || {})[g.key] ?? null
    const bKg = c.base ? c.base.kg : g.kg
    baseKg += bKg; useKg += g.kg
    if (Math.abs(bKg - g.kg) > 1e-6) savingBaht = price == null || savingBaht == null ? null : savingBaht + (bKg - g.kg) * price
    const best = c.best
    return {
      key: g.key, profile_id: g.profile_id, name: g.name, die_no: g.die_no, finish_name: g.finish_name,
      kgPerM: (kgPerM || {})[g.key] ?? null, baseBars: c.base ? c.base.newBars : null, baseKg: bKg,
      bestLength: best ? best.length_m : null, bestSavingKg: best && c.base && c.base.kg - best.kg > 1e-6 ? c.base.kg - best.kg : 0,
      useLength: g.length_m, custom: !!g.custom, newBars: g.bars.length, offcutBars: g.offcutBars.length, kg: g.kg,
      cost: price == null ? null : g.kg * price,
      no_weight: !!g.no_weight, overrideRejected: !!g.overrideRejected, unplaced: g.unplaced.length,
      // Below the minimum order every profile is on stock anyway: picking a custom length changes nothing.
      canUse: plan.reason !== 'moq' && !!best && Math.abs(best.length_m - g.length_m) > EPS,
    }
  })
  const cost = rows.every(r => r.cost != null) ? rows.reduce((s, r) => s + r.cost, 0) : null
  return { rows, baseKg, useKg, cost, savingKg: baseKg - useKg, savingBaht }
}

// "ใช้ทั้งหมด": one length per profile (stock overrides are per profile) -- the best of its heaviest colour group --
// skipping profiles with no best length or already on it.
export function bestLengthsByProfile(plan, compare) {
  const heaviest = new Map()
  for (const g of (plan && plan.groups) || []) {
    const c = (compare || {})[g.key]
    const w = c && c.base ? c.base.kg : g.kg
    const cur = heaviest.get(g.profile_id)
    if (!cur || w > cur.w) heaviest.set(g.profile_id, { g, c, w })
  }
  const out = []
  for (const [profile_id, { g, c }] of heaviest) {
    if (!c || !c.best || Math.abs(c.best.length_m - g.length_m) <= EPS) continue
    out.push({ profile_id, length_m: c.best.length_m })
  }
  return out
}

// Rows of the extruder comparison. results = compareProviders(...) rows (candidate fields + aluminium, complete,
// unresolvedLines); baseId = the project's main extruder. An incomplete row never shows a number or a difference.
export function comparisonRows(results, baseId) {
  const base = (results || []).find(r => r.providerId === baseId) || null
  return (results || []).map(r => {
    const isBase = r.providerId === baseId
    const d = isBase ? null : diffAgainst(base, r)
    return {
      providerId: r.providerId, seriesId: r.seriesId, finishId: r.finishId, isBase,
      complete: !!r.complete, aluminium: r.complete ? r.aluminium : null,
      diff: d, unresolvedLines: r.complete ? 0 : r.unresolvedLines,
      pending: !r.seriesId || !r.finishId,
      canApply: !isBase && !!r.complete && !!r.seriesId && !!r.finishId,
    }
  })
}

// Items that pin their own colour from an extruder other than providerId: they cannot be priced after the switch.
export function itemsWithForeignColour(items, index, providerId) {
  return (items || []).filter(i => {
    const f = i.alu_finish_id ? index.finishes[i.alu_finish_id] : null
    return !!f && f.provider_id !== providerId
  })
}
