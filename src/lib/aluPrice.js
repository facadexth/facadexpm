// ============================================================
// Pure price resolution for the aluminium cost catalog. No I/O: callers load
// the catalog tables once and pass the rows in. asOf and effective_from are
// 'YYYY-MM-DD' strings, which compare correctly as plain strings.
// Spec: docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md
// (Prices; Decision 7).
// ============================================================

export function pickLatest(rows, asOf, predicate = () => true) {
  let best = null
  for (const r of rows || []) {
    if (!predicate(r) || r.effective_from > asOf) continue
    if (!best || r.effective_from > best.effective_from) best = r
  }
  return best
}

// Precedence is by specificity (profile > series > provider x colour);
// inside one level the newest row on or before asOf wins.
export function resolveKgPrice({ provider, finish, series, profile, asOf, kgPrices }) {
  const base = r => r.provider_id === provider.id && r.finish_id === finish.id
  const levels = [
    ['profile', profile && (r => base(r) && r.profile_id === profile.id)],
    ['series', series && (r => base(r) && r.series_id === series.id && !r.profile_id)],
    ['provider_finish', r => base(r) && !r.series_id && !r.profile_id],
  ]
  for (const [source, predicate] of levels) {
    if (!predicate) continue
    const row = pickLatest(kgPrices, asOf, predicate)
    if (row) return { price_per_kg: Number(row.price_per_kg), source, row }
  }
  return null
}

// A profile in a colour can be sold in several stock lengths; take the one
// that matches the profile's standard length, else the longest.
export function findVariant(variants, profileId, finishId, preferLengthM) {
  const candidates = (variants || []).filter(v => v.profile_id === profileId && v.finish_id === finishId)
  if (!candidates.length) return null
  const exact = preferLengthM != null ? candidates.find(v => Number(v.length_m) === Number(preferLengthM)) : null
  return exact || [...candidates].sort((a, b) => Number(b.length_m) - Number(a.length_m))[0]
}

export function resolveAluPrice({ provider, series, profile, finish, variants, asOf, kgPrices, piecePrices }) {
  const basis = provider.price_basis
  const triedKg = basis !== 'per_piece'
  const triedPiece = basis !== 'per_kg'

  // a 'both' provider with no usable weight cannot be kg-priced; it falls through to the
  // piece price (Decision 7). Only a per_kg provider stops dead on a missing weight.
  let weightMissing = false
  if (triedKg) {
    const weight = Number(profile.linear_weight_kg_per_m)
    if (!(weight > 0)) {
      if (basis === 'per_kg') return { unresolved: true, reason: 'no_weight' }
      weightMissing = true
    } else {
      const kg = resolveKgPrice({ provider, finish, series, profile, asOf, kgPrices })
      if (kg) {
        return { basis: 'per_kg', price_per_kg: kg.price_per_kg, price_per_m: kg.price_per_kg * weight, source: kg.source }
      }
    }
  }

  if (triedPiece) {
    // if the piece attempt also fails and the weight was the blocker, report that instead
    const fail = reason => ({ unresolved: true, reason: weightMissing ? 'no_weight' : reason })
    const variant = findVariant(variants, profile.id, finish.id, profile.default_length_m)
    if (!variant) return fail(basis === 'both' ? 'no_price' : 'no_variant')
    const row = pickLatest(piecePrices, asOf, r => r.variant_id === variant.id)
    if (!row) return fail(basis === 'both' ? 'no_price' : 'no_piece_price')
    const perPiece = Number(row.price_per_piece)
    return { basis: 'per_piece', price_per_piece: perPiece, price_per_m: perPiece / Number(variant.length_m), source: 'piece', variant_id: variant.id }
  }

  return { unresolved: true, reason: 'no_kg_price' }
}

export function netPrice(listPrice, discountPct = 0) {
  return Number(listPrice) * (1 - Number(discountPct || 0) / 100)
}

export function resolvePartPrice({ partId, asOf, partPrices }) {
  const row = pickLatest(partPrices, asOf, r => r.part_id === partId)
  if (!row) return null
  return { list_price: Number(row.list_price), discount_pct: Number(row.discount_pct), net_price: netPrice(row.list_price, row.discount_pct), row }
}
