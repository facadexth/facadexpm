// src/pages/estimation/itemSave.js
// Saves one estimation item: the estimation_openings row first (insert for a new item, update by rowId), then, when
// saveAddons, its inline add-ons (estimation_item_addons, addonSave.saveItemAddons: delete-then-insert under the
// row's id, so an empty list clears them). A failed row save throws; a failed add-on save does NOT undo the row:
// it comes back as addonError so the form can say "saved, but the add-ons were not" and stay open.
import { saveItemAddons } from '../../lib/addonSave.js'

export async function saveItemWithAddons({ supabase, rowId, payload, addons, main, saveAddons }) {
  const { data, error } = rowId
    ? await supabase.from('estimation_openings').update(payload).eq('id', rowId).select('id').single()
    : await supabase.from('estimation_openings').insert(payload).select('id').single()
  if (error) throw error
  let addonError = null
  if (saveAddons) {
    try { await saveItemAddons({ supabase, openingId: data.id, addons: addons || [], main }) } catch (e) { addonError = e }
  }
  return { id: data.id, addonError }
}

// When the item form may seed / save its inline add-ons. map = ctx.itemAddonsByOpening (undefined while loading),
// error = ctx.itemAddonsError, itemId = the edited row (null for a new item), seeded = the form already holds the
// saved list, hadAddons = the item had saved add-ons (or the form saved some). Ready only when the map is loaded AND
// there is no load error (useItemAddons keeps `{}` on error, which must never read as "no add-ons").
// Returns { ready, seed, save }: seed = the saved list to put into the form (once, when ready and not yet seeded),
// save = rewrite the add-on table on save (form has add-ons, or the item had some so an empty list clears them).
export function addonSavePlan({ map, error = null, loading = false, itemId = null, formAddons = [], seeded = false, hadAddons = false }) {
  if (!itemId) return { ready: true, seed: null, save: (formAddons || []).length > 0 || hadAddons }
  const ready = !!map && !error && !loading
  if (!ready) return { ready: false, seed: null, save: false }
  if (!seeded) {
    const saved = map[itemId] || []
    return { ready: true, seed: saved, save: false }
  }
  return { ready: true, seed: null, save: (formAddons || []).length > 0 || hadAddons }
}
