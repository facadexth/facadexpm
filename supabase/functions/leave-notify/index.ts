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
import { sendLinePush } from '../_shared/line.ts'

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
    .select('tenant_id, leave_type, date_from, date_to, shift, workers(line_user_id)')
    .eq('id', leaveRequestId).maybeSingle()
  if (reqError || !req_) return json({ error: reqError?.message ?? 'not_found' }, 404)

  const lineUserId = (req_.workers as unknown as { line_user_id: string | null } | null)?.line_user_id
  if (!lineUserId) return json({ ok: true, skipped: 'no_line_user_id' })

  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', req_.tenant_id).maybeSingle()
  if (!settings?.channel_access_token) return json({ ok: true, skipped: 'no_line_settings' })

  const leaveLabel = req_.leave_type === 'leave_sick' ? 'ลาป่วย' : 'ลากิจ'
  const shiftLabel = SHIFT_LABEL[req_.shift as string] ?? ''
  const dateLabel = req_.date_from === req_.date_to ? req_.date_from : `${req_.date_from} — ${req_.date_to}`
  const text = decision === 'approved'
    ? `✅ คำขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel} ของคุณได้รับการอนุมัติแล้ว`
    : `❌ คำขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel} ของคุณถูกปฏิเสธ`

  const result = await sendLinePush(settings.channel_access_token, lineUserId, text)
  return json({ ok: result.ok })
})
