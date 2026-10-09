// src/lib/openingExtras.js
// Accessories the template does not list but the owner's rules imply: plastic shim + screw + plastic
// plug at every fixing point (one of each per point), and the sealant length around the opening.
// Pure. Off until the tenant links the parts in estimation_settings (a null part id = no line).

// Points along one side: one every `pitchM`, at least `minPerSide` (owner: every 60 cm, min 2 per side).
export function fixingPointsForSide(lengthM, pitchM, minPerSide) {
  const len = Number(lengthM)
  if (!(len > 0)) return 0
  return Math.max(minPerSide, Math.ceil(len / pitchM - 1e-9) + 1)
}

// Four sides of a rectangular frame: top/bottom run `width`, left/right run `height`.
export function frameFixingPoints(widthM, heightM, settings) {
  return 2 * fixingPointsForSide(widthM, settings.fixing_pitch_m, settings.fixing_min_per_side)
    + 2 * fixingPointsForSide(heightM, settings.fixing_pitch_m, settings.fixing_min_per_side)
}

export const sealantTubes = (totalLengthM, mPerTube) => (totalLengthM > 0 ? Math.ceil(totalLengthM / mPerTube - 1e-9) : 0)

// units: [{ width_m, height_m }] -- the main opening and, when present, the add-on (its own frame).
// Returns the fixing-point count, the sealant length (opening perimeters) and a priced line per linked part.
export function openingExtras({ units, settings, partsById, pricing }) {
  const valid = (units || []).filter(u => u && u.width_m > 0 && u.height_m > 0)
  const points = valid.reduce((s, u) => s + frameFixingPoints(u.width_m, u.height_m, settings), 0)
  const sealant_m = valid.reduce((s, u) => s + 2 * (u.width_m + u.height_m), 0)
  const spec = [
    ['shim', settings.shim_part_id, points], ['screw', settings.screw_part_id, points], ['plug', settings.plug_part_id, points],
  ]
  const lines = spec.filter(([, partId, qty]) => partId && qty > 0).map(([key, partId, quantity]) => {
    const part = (partsById || {})[partId]
    const hp = pricing.hardwarePrice({ part_id: partId, reference_unit_price: 0 })
    const resolved = hp.source === 'part'
    return {
      key, part_id: partId, name: part ? part.name : '?', unit: part ? part.unit : null, quantity,
      unit_price: resolved ? hp.unit_price : 0, cost: resolved ? quantity * hp.unit_price : 0,
      resolved, reason: resolved ? null : 'no_part_price',
    }
  })
  return { points, sealant_m, lines, cost: lines.reduce((s, l) => s + l.cost, 0), unresolved: lines.filter(l => !l.resolved).map(l => ({ name: l.name, reason: l.reason })) }
}
