// Staff-side call to the repair-push edge function (schedule / report) and its Thai result text.
// A push never undoes a saved schedule or close: callers save first, then show this notice.
import { supabase } from './supabase.js'

const SKIPPED = {
  off: { kind: 'warning', text: 'ไม่ได้ส่ง: ปิดการแจ้งลูกค้าอยู่' },
  budget: { kind: 'warning', text: 'ไม่ได้ส่ง: เกินโควต้าวันนี้' },
  no_recipient: { kind: 'warning', text: 'ไม่ได้ส่ง: ลูกค้ายังไม่ได้เชื่อม LINE' },
}
const REFUSED = {
  not_scheduled: 'ไม่ได้ส่ง: งานยังไม่อยู่สถานะนัดเข้า',
  not_done: 'ไม่ได้ส่ง: งานยังไม่เสร็จ',
  already_reported: 'ไม่ได้ส่ง: ส่งรายงานไปแล้ว',
}
const FAILED = { kind: 'error', text: 'ส่งไลน์ไม่สำเร็จ' }

// { data } = a 200 body; { errorBody } = the JSON body of a non-2xx answer (or null).
export function pushResultNotice({ data, errorBody } = {}) {
  if (data && data.sent === true) return { kind: 'success', text: 'ส่งไลน์ให้ลูกค้าแล้ว' }
  if (data && data.sent === false) return SKIPPED[data.skipped] || FAILED
  const code = errorBody?.error
  if (code && REFUSED[code]) return { kind: 'warning', text: REFUSED[code] }
  return FAILED
}

export async function invokeRepairPush(action, ticketId, force = false) {
  try {
    const body = { action, ticket_id: ticketId }
    if (force) body.force = true
    const { data, error } = await supabase.functions.invoke('repair-push', { body })
    if (!error) return pushResultNotice({ data })
    let errorBody = null
    try { errorBody = await error.context?.json?.() } catch { /* not JSON */ }
    return pushResultNotice({ errorBody })
  } catch {
    return FAILED
  }
}
