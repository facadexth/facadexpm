// src/pages/estimation/projectBomHelpers.js
// Pure helpers of the whole-project BOM screen: entries, piece-count guard, stock-length input, cut-optimizer
// view model and extruder-comparison view model. No React, no Supabase.
import { compareLengths } from '../../lib/cutOptimizer.js'
import { findVariant, pickLatest, resolveAluPrice } from '../../lib/aluPrice.js'
import { diffAgainst } from '../../lib/providerCompare.js'

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
    entries.push({ opening_no: item.opening_no, quantity: item.quantity, finish_id: r.resolved.finish_id, bom: r.bom, addonBom: r.addonBom, extras: r.extras, unresolved: r.unresolved })
  }
  return { entries, skipped }
}

// Total pieces the packer would allocate (all resolved profile and grid lines x item quantity).
export function entriesPieceCount(entries) {
  let n = 0
  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    for (const bom of [e.bom, e.addonBom]) {
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
    for (const bom of [e.bom, e.addonBom]) {
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
export function candidateLengths(index, profileId, finishId, stockLengthM) {
  const set = new Set()
  for (const v of index.variants || []) if (v.profile_id === profileId && v.finish_id === finishId && Number(v.length_m) > 0) set.add(Number(v.length_m))
  if (Number(stockLengthM) > 0) set.add(Number(stockLengthM))
  return [...set].sort((a, b) => a - b)
}

// View model of the cut optimizer for one profile group (an item of buildProjectBom().profiles).
export function optimizerView({ group, index, settings, asOf, seriesIds }) {
  const profile = index.profiles[group.profile_id]
  const finish = group.finish_id ? index.finishes[group.finish_id] : null
  const barPrice = makeBarPrice({ index, profile, finish, seriesIds: seriesIds || [], asOf })
  const lengths = candidateLengths(index, group.profile_id, group.finish_id, group.stock_length_m)
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
