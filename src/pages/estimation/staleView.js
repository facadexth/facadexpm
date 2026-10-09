// src/pages/estimation/staleView.js
// View-model of the "new prices" banner and its refresh dialog: the listPriceChanges output as plain rows.
// Pure. No React, no Supabase.
import { priceRowLabel } from './projectDefaults.js'
import { localDateString } from '../../lib/localDate.js'

export const itemLabel = (item, fallbackId) => (item ? `${item.opening_no}${item.item_name ? ` · ${item.item_name}` : ''}` : String(fallbackId))

// rows: one per changed part (item name, part, old price, new price); itemCount: distinct items with a change.
export function changesView(changes, itemsById, index) {
  const list = changes || []
  return {
    itemCount: new Set(list.map(c => c.opening_id)).size,
    rows: list.map(c => ({
      item: itemLabel((itemsById || {})[c.opening_id], c.opening_id), part: c.name,
      before: priceRowLabel(index, c.before), after: priceRowLabel(index, c.after),
    })),
  }
}

// The dialog must say ALL items are re-priced, not only the listed ones.
export const refreshWarning = (priceAsOf, today) =>
  `ทุกรายการของโปรเจกต์นี้จะถูกคิดราคาใหม่ตามราคาวันนี้ (${today}) แทนราคา ณ ${priceAsOf} ไม่ใช่เฉพาะรายการที่แสดงด้านล่าง`

// The only write: the project's price date.
export const refreshPatch = (now = new Date()) => ({ price_as_of: localDateString(now) })
