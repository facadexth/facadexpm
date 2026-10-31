// src/lib/hardwareSetRemove.js
// Removing a hardware set (owner 2026-11-01): allowed only when nothing uses it. Every column that stores a set id is
// checked first (SET_USAGE, from the foreign keys on alu_parts in supabase/migrations); only when all are clear are the
// set's contents (alu_part_set_items), its series links (alu_series_parts) and then the set row (alu_parts) removed.
// A database refusal (23503) still says "in use". db = the supabase client (PostgREST), passed in for tests.
export const SET_IN_USE_TEXT = 'ชุดนี้มีรายการใช้อยู่ — ปิดใช้งานแทน'

export const SET_USAGE = [
  { table: 'estimation_openings', column: 'hardware_set_id' },          // items (ON DELETE RESTRICT)
  { table: 'estimation_projects', column: 'default_hardware_set_id' },  // project default (would be cleared silently)
  { table: 'alu_hardware_package_items', column: 'hardware_set_id' },   // hardware packages (would be removed silently)
  { table: 'bom_template_hardware', column: 'part_id' },                // template hardware rows
  { table: 'alu_part_set_items', column: 'part_id' },                   // a set inside another set
  { table: 'estimation_settings', column: 'sealant_part_id' },
  { table: 'estimation_settings', column: 'shim_part_id' },
  { table: 'estimation_settings', column: 'screw_part_id' },
  { table: 'estimation_settings', column: 'plug_part_id' },
]

// -> { removed: true } | { removed: false, message }; other errors are thrown (shown through rpcErrorText).
export async function removeHardwareSet(db, setId) {
  for (const u of SET_USAGE) {
    const { count, error } = await db.from(u.table).select('id', { count: 'exact', head: true }).eq(u.column, setId)
    if (error) throw error
    if (count) return { removed: false, message: SET_IN_USE_TEXT }
  }
  try {
    for (const [table, column] of [['alu_part_set_items', 'set_id'], ['alu_series_parts', 'part_id']]) {
      const { error } = await db.from(table).delete().eq(column, setId)
      if (error) throw error
    }
    const { data, error } = await db.from('alu_parts').delete().eq('id', setId).select('id')
    if (error) throw error
    if (!data || !data.length) throw { code: '42501', message: 'set row not removed' }
  } catch (e) {
    if (e && e.code === '23503') return { removed: false, message: SET_IN_USE_TEXT }
    throw e
  }
  return { removed: true }
}
