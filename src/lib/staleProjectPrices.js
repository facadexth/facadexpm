// src/lib/staleProjectPrices.js
// Which priced lines would come out differently if the project's locked price date were today?
// Callers compute each opening's BOM twice (asOf = project.price_as_of, asOf = today) and pass both
// maps here. A line is "changed" when it used a different price row, or gained / lost a price.
// Spec Decision 3 ("มีราคาใหม่ N รายการ").

function priceLines(bom) {
  return [
    ...((bom && bom.profileLines) || []),
    ...((bom && bom.gridLines) || []),
    ...((bom && bom.hardwareLines) || []),
    ...((bom && bom.hardwareSetLines) || []),
  ]
}

export function listPriceChanges(lockedByOpening, currentByOpening) {
  const changes = []
  for (const [openingId, locked] of Object.entries(lockedByOpening || {})) {
    const current = (currentByOpening || {})[openingId]
    if (!current) continue
    const before = priceLines(locked)
    const after = priceLines(current)
    before.forEach((line, i) => {
      const next = after[i]
      if (!next) return
      const a = line.price_row_id ?? null
      const b = next.price_row_id ?? null
      if (a !== b) changes.push({ opening_id: openingId, name: line.role_name || line.name, before: a, after: b })
    })
  }
  return changes
}
