// supabase/functions/line-worker-offboarded/index.ts
// Called by a Postgres trigger (see migration 2026-09-20-03) the
// moment a worker's status flips 'active' -> 'inactive' -- proactive,
// not dependent on the offboarded worker ever messaging the bot again
// (line-webhook's own reactive alert, kept as a fallback for the case
// this trigger somehow doesn't fire, e.g. a status change made via a
// path other than a normal UPDATE). Same "tell an OWNER, since LINE
// bots can't remove someone from a group chat themselves" logic.
//
// Auth: the same shared-secret pattern Task 4's cron jobs use
// (verify_cron_secret() against the line_push_cron_shared_secret Vault
// entry) -- this function is called by trusted internal Postgres, not
// LINE itself, so verify_jwt: true + this header check is the right
// shape (unlike line-webhook, which is called BY LINE and uses HMAC
// signature verification instead).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const providedSecret = req.headers.get('x-cron-secret')
  const { data: secretOk } = await admin.rpc('verify_cron_secret', { provided: providedSecret })
  if (!secretOk) return json({ error: 'unauthorized' }, 401)

  const { worker_id } = await req.json().catch(() => ({}))
  if (!worker_id) return json({ error: 'worker_id required' }, 400)

  const { data: worker } = await admin.from('workers').select('id, name, tenant_id, status').eq('id', worker_id).maybeSingle()
  if (!worker || worker.status !== 'inactive') return json({ ok: true, skipped: 'not inactive or not found' })

  // Real gap closed 2026-10-01 (final-review finding #3c): deleting the
  // old per-tenant line_settings existence check during the shared-bot
  // migration removed this function's only line_bot gate -- it never
  // imported tenantHasModuleAccess at all. See tenant-access.ts's header.
  if (!(await tenantHasModuleAccess(admin, worker.tenant_id as string, 'line_bot'))) return json({ ok: true, skipped: 'line_bot module not enabled for this tenant' })

  if (!(await isPushEnabled(admin, worker.tenant_id as string, 'line_push_offboarding'))) return json({ ok: true, skipped: 'push_disabled' })

  // Alert at most once per 24h per worker. Claim the window with one atomic
  // UPDATE BEFORE sending: previously the timestamp was only written after
  // the pushes, so flipping a worker active -> inactive -> active -> inactive
  // re-sent every owner a message each time.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: claimed } = await admin.from('workers')
    .update({ line_offboarding_alerted_at: new Date().toISOString() })
    .eq('id', worker.id)
    .or(`line_offboarding_alerted_at.is.null,line_offboarding_alerted_at.lt.${cutoff}`)
    .select('id')
  if (!claimed?.length) return json({ ok: true, skipped: 'alerted_recently' })

  const { data: owners } = await admin
    .from('user_roles')
    .select('line_user_id')
    .eq('tenant_id', worker.tenant_id)
    .eq('role', 'OWNER')
    .not('line_user_id', 'is', null)

  for (const owner of owners ?? []) {
    await withPushBudget(admin, worker.tenant_id as string, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, owner.line_user_id as string, `⚠️ ${worker.name} ถูกเปลี่ยนสถานะเป็นพ้นสภาพพนักงาน กรุณาลบออกจากกลุ่มทีมงานใน LINE ด้วยครับ`))
  }

  return json({ ok: true, notified: (owners ?? []).length })
})
