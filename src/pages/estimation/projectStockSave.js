// src/pages/estimation/projectStockSave.js
// Writes of the stock-length settings. No upsert (house rule): look the row up, then insert / update / delete,
// always filtered by THIS project. A blank value removes the per-profile override.
import { supabase } from '../../lib/supabase.js'
import { stockWriteAction } from './projectBomHelpers.js'

// value: a positive number, or null to remove the override.
export async function saveProfileStock(projectId, profileId, value) {
  const { data: existing, error: le } = await supabase.from('estimation_project_stock')
    .select('id, length_m').eq('project_id', projectId).eq('profile_id', profileId).maybeSingle()
  if (le) throw le
  const act = stockWriteAction(existing || null, value)
  let error = null
  if (act.op === 'insert') ({ error } = await supabase.from('estimation_project_stock').insert({ project_id: projectId, profile_id: profileId, length_m: act.value }))
  else if (act.op === 'update') ({ error } = await supabase.from('estimation_project_stock').update({ length_m: act.value }).eq('id', act.id).eq('project_id', projectId))
  else if (act.op === 'delete') ({ error } = await supabase.from('estimation_project_stock').delete().eq('id', act.id).eq('project_id', projectId))
  else if (act.op === 'invalid') throw new Error('ความยาวเส้นไม่ถูกต้อง')
  if (error) throw error
}

export async function saveProjectStockLength(projectId, value) {
  const { error } = await supabase.from('estimation_projects').update({ stock_length_m: value }).eq('id', projectId)
  if (error) throw error
}
