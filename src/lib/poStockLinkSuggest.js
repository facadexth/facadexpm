// Suggests a stock item for each scanned PO line.
// (i) the supplier's own past PO lines with the same description (most recent first),
// (ii) else exactly one active stock item with the same name. Units are ignored.

export const normName = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * @param lines          scanned lines ({description, ...})
 * @param inventoryItems stock items ({id, name, active?}); active !== false counts as active
 * @param pastPoItems    [{description, inventory_item_id}] of this supplier, most recent first
 * @returns array parallel to lines: item id or null
 */
export function suggestStockLinks(lines, inventoryItems, pastPoItems) {
  const active = (inventoryItems || []).filter(it => it && it.active !== false)
  const activeIds = new Set(active.map(it => it.id))
  const byName = new Map()
  for (const it of active) {
    const k = normName(it.name)
    byName.set(k, [...(byName.get(k) || []), it.id])
  }
  const pastByDesc = new Map()
  for (const p of pastPoItems || []) {
    if (!p || !p.inventory_item_id || !activeIds.has(p.inventory_item_id)) continue
    const k = normName(p.description)
    if (k && !pastByDesc.has(k)) pastByDesc.set(k, p.inventory_item_id) // first = most recent
  }
  return (lines || []).map(line => {
    const k = normName(line?.description)
    if (!k) return null
    if (pastByDesc.has(k)) return pastByDesc.get(k)
    const ids = byName.get(k)
    return ids && ids.length === 1 ? ids[0] : null
  })
}
