// src/lib/aluCatalogPricing.js
// Catalog-backed pricing for bomEngine: picks the profile for (series, family, thickness), prices it
// with the extruder's price basis as of a date, and prices hardware and hardware sets from the part
// price history. Pure: callers load the catalog tables once (useEstimationCatalog) and pass them in.
// Spec: 2026-10-08-aluminium-cost-catalog-design.md, Decision 7.
import { resolveAluPrice, resolvePartPrice } from './aluPrice.js'

function byId(list) {
  const m = {}
  for (const r of list || []) m[r.id] = r
  return m
}

function groupBy(list, key) {
  const m = {}
  for (const r of list || []) (m[r[key]] = m[r[key]] || []).push(r)
  return m
}

export function buildCatalogIndex(rows = {}) {
  return {
    providers: byId(rows.providers),
    series: byId(rows.series),
    profiles: byId(rows.profiles),
    finishes: byId(rows.finishes),
    parts: byId(rows.parts),
    seriesProfilesBySeries: groupBy(rows.seriesProfiles, 'series_id'),
    setItemsBySet: groupBy(rows.setItems, 'set_id'),
    variants: rows.variants || [],
    kgPrices: rows.kgPrices || [],
    piecePrices: rows.piecePrices || [],
    partPrices: rows.partPrices || [],
  }
}

// A series offers a profile in a role (family) through alu_series_profiles; the thickness lives on the
// profile row. The DB does not stop two profiles matching one tuple, so pick the lowest id and say so.
export function resolveCatalogProfile(index, seriesId, family, thicknessMm) {
  const links = (index.seriesProfilesBySeries[seriesId] || []).filter(l => l.family === family)
  const matches = links
    .map(l => index.profiles[l.profile_id])
    .filter(p => p && p.active !== false && Number(p.thickness_mm) === Number(thicknessMm))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
  if (!matches.length) return { profile: null, ambiguous: false }
  return { profile: matches[0], ambiguous: matches.length > 1 }
}

export function makeCatalogPricing({ index, seriesId, finishId, asOf }) {
  const series = index.series[seriesId] || null
  const finish = index.finishes[finishId] || null

  return {
    kind: 'catalog',

    profileLine({ role_name, family, length_m, quantity, thickness_mm }) {
      const base = {
        role_name, family, series_id: seriesId || null, thickness_mm, length_m, quantity,
        weight_kg: 0, cost: 0, resolved: false, reason: null, ambiguous: false, price_row_id: null,
      }
      if (!series) return { ...base, reason: 'no_series' }
      if (!finish) return { ...base, reason: 'no_finish' }
      const { profile, ambiguous } = resolveCatalogProfile(index, seriesId, family, thickness_mm)
      if (!profile) return { ...base, reason: 'no_profile' }
      const provider = index.providers[profile.provider_id]
      if (!provider) return { ...base, profile_id: profile.id, reason: 'no_provider' }
      if (finish.provider_id !== profile.provider_id) return { ...base, profile_id: profile.id, reason: 'finish_other_provider' }
      const price = resolveAluPrice({
        provider, series, profile, finish, variants: index.variants, asOf,
        kgPrices: index.kgPrices, piecePrices: index.piecePrices,
      })
      if (price.unresolved) return { ...base, profile_id: profile.id, reason: price.reason }
      return {
        ...base, profile_id: profile.id, ambiguous, resolved: true, basis: price.basis,
        price_per_m: price.price_per_m,
        weight_kg: length_m * quantity * Number(profile.linear_weight_kg_per_m),
        cost: length_m * quantity * price.price_per_m,
        price_row_id: price.row_id ?? null,
      }
    },

    // h is a bom_template_hardware row. A priced catalog part wins; otherwise the reference price stays.
    hardwarePrice(h) {
      if (h.part_id) {
        const p = resolvePartPrice({ partId: h.part_id, asOf, partPrices: index.partPrices })
        if (p) return { unit_price: p.net_price, source: 'part', price_row_id: p.row.id }
      }
      return { unit_price: Number(h.reference_unit_price) || 0, source: 'reference', price_row_id: null }
    },

    setLines(setId) {
      if (!setId) return []
      return (index.setItemsBySet[setId] || []).map(item => {
        const part = index.parts[item.part_id]
        const p = resolvePartPrice({ partId: item.part_id, asOf, partPrices: index.partPrices })
        const quantity = Number(item.quantity)
        return {
          name: part ? part.name : '?', code: part ? part.code : null, quantity,
          unit_price: p ? p.net_price : 0, cost: p ? quantity * p.net_price : 0,
          resolved: !!p, price_row_id: p ? p.row.id : null,
        }
      })
    },
  }
}
