// supabase/functions/leave-notify/index.ts
// ============================================================
// leave-notify -- sends a LINE push confirming an approve/reject decision
// back to the worker who submitted the leave request. Called from
// HR.jsx's reviewLeaveRequest right after the leave_requests status update
// succeeds. Previously a worker got NO feedback at all when their leave
// was approved or rejected -- the only signal was the HR tab's own badge,
// which the worker (not an app user) never sees.
//
// Auth: bound to the caller's own JWT (same pattern as
// extract-po-document), gated via the existing is_admin_or_owner() RLS
// helper function called directly over RPC -- a plain SELECT against
// leave_requests is NOT a valid gate on its own since RLS USING clauses
// filter rows silently rather than erroring, but calling the admin check
// explicitly makes "not authorized" unambiguous regardless.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const SHIFT_LABEL: Record<string, string> = { morning: ' (ช่วงเช้า)', evening: ' (ช่วงบ่าย)', full_day: '' }

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Duplicated from field-form/index.ts rather than shared -- Deno Edge
// Functions can't share code across function directories except via
// ../_shared/, same reasoning field-form's own resolveTodaysSite comment
// gives for its duplication. Mirrors useLeaveQuotaUsage/
// useSickLeaveQuotaUsage in src/hooks/useSupabase.js EXACTLY (same
// worker_assignments row-count * 0.5 convention, same legacy
// 'leave' => leave_personal rule) so these numbers never drift from what
// HR.jsx/MySchedule.jsx show in the app itself.
async function leaveQuotaRemaining(workerId: string, annualLeaveDays: number, annualSickDays: number) {
  const year = Number(bangkokToday().slice(0, 4))
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const [personalRes, sickRes] = await Promise.all([
    admin.from('worker_assignments').select('id').eq('worker_id', workerId).in('type', ['leave_personal', 'leave']).gte('date', from).lte('date', to),
    admin.from('worker_assignments').select('id').eq('worker_id', workerId).eq('type', 'leave_sick').gte('date', from).lte('date', to),
  ])
  const personalUsed = (personalRes.data?.length ?? 0) * 0.5
  const sickUsed = (sickRes.data?.length ?? 0) * 0.5
  return { remainingPersonal: annualLeaveDays - personalUsed, remainingSick: annualSickDays - sickUsed }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

  let body: { leaveRequestId?: string; decision?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const { leaveRequestId, decision } = body
  if (!leaveRequestId) return json({ error: 'leaveRequestId required' }, 400)
  if (decision !== 'approved' && decision !== 'rejected') return json({ error: 'invalid_decision' }, 400)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isAdminOrOwner, error: adminCheckError } = await userClient.rpc('is_admin_or_owner')
  if (adminCheckError || !isAdminOrOwner) return json({ error: 'Unauthorized' }, 403)

  // RLS-scoped read via the caller's own JWT -- admin_full_access already
  // restricts this to the caller's own tenant, same guarantee the is_admin_or_owner
  // check above gives for the write path.
  const { data: req_, error: reqError } = await userClient.from('leave_requests')
    .select('tenant_id, worker_id, leave_type, date_from, date_to, shift, workers(line_user_id, annual_leave_days, annual_sick_leave_days)')
    .eq('id', leaveRequestId).maybeSingle()
  if (reqError || !req_) return json({ error: reqError?.message ?? 'not_found' }, 404)

  // Real gap closed 2026-10-01 (final-review finding #3b): deleting the
  // old per-tenant line_settings existence check during the shared-bot
  // migration removed this function's only line_bot gate -- it never
  // imported tenantHasModuleAccess at all. See tenant-access.ts's header.
  if (!(await tenantHasModuleAccess(admin, req_.tenant_id as string, 'line_bot'))) return json({ ok: true, skipped: 'line_bot module not enabled for this tenant' })

  if (!(await isPushEnabled(admin, req_.tenant_id as string, 'line_push_leave_result'))) return json({ ok: true, skipped: 'push_disabled' })

  const workerRow = req_.workers as unknown as { line_user_id: string | null; annual_leave_days: number | null; annual_sick_leave_days: number | null } | null
  const lineUserId = workerRow?.line_user_id
  if (!lineUserId) return json({ ok: true, skipped: 'no_line_user_id' })

  const leaveLabel = req_.leave_type === 'leave_sick' ? 'ลาป่วย' : 'ลากิจ'
  const shiftLabel = SHIFT_LABEL[req_.shift as string] ?? ''
  const dateLabel = req_.date_from === req_.date_to ? req_.date_from : `${req_.date_from} — ${req_.date_to}`

  let text: string
  if (decision === 'approved') {
    // worker_assignments rows for this request were already written by
    // HR.jsx's reviewLeaveRequest BEFORE it calls this function, so the
    // quota query below reflects this request's own usage already.
    const { remainingPersonal, remainingSick } = await leaveQuotaRemaining(
      req_.worker_id as string, workerRow?.annual_leave_days ?? 0, workerRow?.annual_sick_leave_days ?? 0,
    )
    text = `✅ คำขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel} ของคุณได้รับการอนุมัติแล้ว\nคงเหลือ: ลากิจ ${remainingPersonal} วัน / ลาป่วย ${remainingSick} วัน`
  } else {
    text = `❌ คำขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel} ของคุณถูกปฏิเสธ`
  }

  // Announce each decision once. The claim is a single atomic UPDATE, so a
  // repeated or parallel call for the same decision matches no row and sends
  // nothing -- this endpoint used to push on every call, which let any
  // admin (including a free trial) use it to burn the shared LINE quota.
  const { data: claimed } = await admin.from('leave_requests')
    .update({ decision_notified: decision })
    .eq('id', leaveRequestId)
    .or(`decision_notified.is.null,decision_notified.neq.${decision}`)
    .select('id')
  if (!claimed?.length) return json({ ok: true, skipped: 'already_notified' })

  const result = await withPushBudget(admin, req_.tenant_id as string, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, text))
  if (!result.ok) {
    // Nothing reached the worker: release the claim so a later call can retry.
    await admin.from('leave_requests').update({ decision_notified: null }).eq('id', leaveRequestId).eq('decision_notified', decision)
  }
  return json({ ok: result.ok, ...(result.skipped ? { skipped: result.skipped } : {}) })
})
