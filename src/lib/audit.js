import { supabase } from './supabase.js'

/**
 * เขียน audit log ทุกครั้งที่มีการแก้ไขข้อมูล
 * เรียกหลัง supabase mutation สำเร็จ
 */
export async function auditLog(tableName, recordId, action, oldValues, newValues) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    await supabase.from('audit_logs').insert({
      table_name: tableName,
      record_id:  recordId || null,
      action,
      user_email: session?.user?.email || 'system',
      old_values: oldValues || null,
      new_values: newValues || null,
    })
  } catch (e) {
    // audit log failure ไม่ควร block main operation
    console.warn('audit log failed:', e.message)
  }
}
