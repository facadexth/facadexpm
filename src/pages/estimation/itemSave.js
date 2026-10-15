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
