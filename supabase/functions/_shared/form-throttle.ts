// _shared/form-throttle.ts -- limits on the เบิกของ / ขอลา forms so one crew account cannot
// flood a company with requests (each creates a purchase order / leave request and notifies admins).
//   links:   at most LINKS_PER_HOUR links requested per worker and action per hour
//   submits: at most SUBMITS_PER_DAY submitted forms per worker and action per Bangkok day
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const LINKS_PER_HOUR = 6
export const SUBMITS_PER_DAY = 10

export const THROTTLED_LINK_MESSAGE = '⏳ ขอลิงก์บ่อยเกินไป รอสักครู่แล้วลองใหม่ หรือใช้ลิงก์ล่าสุดที่ส่งให้ไปแล้ว (ใช้ได้ 30 นาที)'
export const DAILY_LIMIT_MESSAGE = `วันนี้ส่งคำขอครบ ${SUBMITS_PER_DAY} ครั้งแล้ว หากต้องการเพิ่มกรุณาแจ้งแอดมินโดยตรง`

// Pure so it can be unit-tested: is `count` already at the limit?
export const atLimit = (count: number, limit: number) => count >= limit

// Start of the current Bangkok calendar day, as a UTC ISO timestamp.
export function bangkokDayStartISO(now = Date.now()): string {
  const bkk = new Date(now + 7 * 3600 * 1000)
  return new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()) - 7 * 3600 * 1000).toISOString()
}

export async function linkRequestsThrottled(admin: SupabaseClient, workerId: string, actionType: string): Promise<boolean> {
  const since = new Date(Date.now() - 3600 * 1000).toISOString()
  const { count, error } = await admin.from('line_deep_link_tokens').select('id', { count: 'exact', head: true })
    .eq('worker_id', workerId).eq('action_type', actionType).gte('created_at', since)
  if (error) { console.error('link throttle lookup failed', error.message); return true } // fail closed
  return atLimit(count ?? 0, LINKS_PER_HOUR)
}

export async function dailySubmitLimitReached(admin: SupabaseClient, workerId: string, actionType: string): Promise<boolean> {
  const { count, error } = await admin.from('line_deep_link_tokens').select('id', { count: 'exact', head: true })
    .eq('worker_id', workerId).eq('action_type', actionType).gte('used_at', bangkokDayStartISO())
  if (error) { console.error('daily limit lookup failed', error.message); return true } // fail closed
  return atLimit(count ?? 0, SUBMITS_PER_DAY)
}
