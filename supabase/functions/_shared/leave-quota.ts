// _shared/leave-quota.ts -- remaining ลากิจ/ลาป่วย for the current (Bangkok)
// calendar year. Moved here from field-form/index.ts (2026-10-18) so the LINE
// "สถานะคำขอ" reply (line-webhook) shows exactly the numbers the leave form shows.
//
// Mirrors useLeaveQuotaUsage/useSickLeaveQuotaUsage in src/hooks/useSupabase.js
// EXACTLY (same worker_assignments row-count * 0.5 convention, same legacy
// 'leave' => leave_personal rule) so the LINE-side numbers never drift from
// what HR.jsx/MySchedule.jsx show in the app itself.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
export function bangkokYear(now = Date.now()): number {
  return Number(new Date(now + 7 * 60 * 60 * 1000).toISOString().slice(0, 4))
}

// Pure half, for tests: each worker_assignments leave row is half a day.
export function leaveRemainingFromCounts(personalRows: number, sickRows: number, annualLeaveDays: number, annualSickDays: number) {
  return { remainingPersonal: annualLeaveDays - personalRows * 0.5, remainingSick: annualSickDays - sickRows * 0.5 }
}

// tenantId (optional) adds an explicit tenant filter on top of the worker id.
export async function leaveQuotaRemaining(admin: SupabaseClient, workerId: string, annualLeaveDays: number, annualSickDays: number, tenantId?: string) {
  const year = bangkokYear()
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const scoped = (q: any) => (tenantId ? q.eq('tenant_id', tenantId) : q)
  const [personalRes, sickRes] = await Promise.all([
    scoped(admin.from('worker_assignments').select('id').eq('worker_id', workerId).in('type', ['leave_personal', 'leave']).gte('date', from).lte('date', to)),
    scoped(admin.from('worker_assignments').select('id').eq('worker_id', workerId).eq('type', 'leave_sick').gte('date', from).lte('date', to)),
  ])
  return leaveRemainingFromCounts(personalRes.data?.length ?? 0, sickRes.data?.length ?? 0, annualLeaveDays, annualSickDays)
}
