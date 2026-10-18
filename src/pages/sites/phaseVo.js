// ============================================================
// VO phase fields, shared by GanttView's inline phase form and
// PhaseManageModal. site_phases gets is_vo + vo_ref (PM may set them) and a
// VO phase always saves billing_weight_pct = 0 (it is outside the contract
// weights). The VO baht value is money: only roles that canSeeMoney see it,
// and it lives in phase_vo_values (OWNER/ADMIN RLS), never in site_phases.
// ============================================================
import { supabase } from '../../lib/supabase.js'

/** The site_phases payload with the VO columns applied. schemaReady false
 *  (migration not applied) -> the payload is returned unchanged. */
export function withVoColumns(payload, row, schemaReady) {
  if (!schemaReady) return payload
  return {
    ...payload,
    billing_weight_pct: row.is_vo ? 0 : payload.billing_weight_pct,
    is_vo: !!row.is_vo,
    vo_ref: String(row.vo_ref ?? '').trim() || null,
  }
}

/** phase id -> VO value as a string, for the form. {} on any error. */
export async function loadPhaseVoValues(phaseIds) {
  if (!phaseIds.length) return {}
  const { data, error } = await supabase.from('phase_vo_values').select('phase_id, vo_value').in('phase_id', phaseIds)
  if (error) return {}
  return Object.fromEntries((data || []).map((r) => [r.phase_id, String(r.vo_value)]))
}

/** Writes phase_vo_values for saved phases: a VO phase with a value is
 *  upserted (on its primary key phase_id); any other phase loses its row.
 *  rows: [{ phaseId, isVo, value }]. Call only for roles that canSeeMoney. */
export async function savePhaseVoValues(rows) {
  const hasValue = (r) => r.isVo && String(r.value ?? '').trim() !== ''
  const upserts = rows.filter(hasValue).map((r) => ({ phase_id: r.phaseId, vo_value: Number(r.value) || 0 }))
  const removes = rows.filter((r) => !hasValue(r)).map((r) => r.phaseId)
  if (upserts.length) {
    const { error } = await supabase.from('phase_vo_values').upsert(upserts, { onConflict: 'phase_id' })
    if (error) throw error
  }
  if (removes.length) {
    const { error } = await supabase.from('phase_vo_values').delete().in('phase_id', removes)
    if (error) throw error
  }
}
