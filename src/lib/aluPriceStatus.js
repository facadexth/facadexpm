// Status of each price-history row as of a date. Pure; dates are 'YYYY-MM-DD'
// strings compared as strings. Same rule as pickLatest in aluPrice.js: within
// one price group the newest row with effective_from <= asOf is in use.
import { pickLatest } from './aluPrice.js'

export const STATUS_CURRENT = 'current'  // ใช้อยู่
export const STATUS_OLD = 'old'          // เก่า
export const STATUS_PENDING = 'pending'  // รอมีผล

// Returns Map(row.id -> status). groupKey(row) names the price group.
export function priceStatuses(rows, groupKey, asOf) {
  const groups = new Map()
  for (const r of rows || []) {
    const k = groupKey(r)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const out = new Map()
  for (const list of groups.values()) {
    const current = pickLatest(list, asOf)
    for (const r of list) {
      out.set(r.id, r.effective_from > asOf ? STATUS_PENDING : r === current ? STATUS_CURRENT : STATUS_OLD)
    }
  }
  return out
}
