// "เปลี่ยน LINE" for a worker who moved to a new LINE account (2026-11-04).
// Owner decision: the old LINE is cut IMMEDIATELY (a lost/handed-on phone must
// not keep checking in or requesting advances), and a fresh link code is issued
// in the same update. The existing line-webhook code path then links whichever
// LINE sends that code -- no bot change needed.
//
// .select() is required: an update blocked by RLS (or a worker id that no
// longer exists) returns zero rows with no error, which would otherwise show
// the owner a success while nothing changed.
export async function changeWorkerLine(client, workerId, code) {
  if (!workerId) throw new Error('ไม่พบทีมงาน')
  if (!code) throw new Error('ไม่มีรหัสเชื่อมต่อ')
  const { data, error } = await client
    .from('workers')
    .update({ line_user_id: null, line_link_code: code })
    .eq('id', workerId)
    .select('id, name, nickname, position, status, line_user_id, line_link_code')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) throw new Error('เปลี่ยน LINE ไม่สำเร็จ — ไม่มีสิทธิ์แก้ไข หรือไม่พบทีมงานคนนี้')
  return data[0]
}
