// supabase/functions/line-push-quotation-followups/index.ts
// Scheduled (Supabase Cron -- see
// supabase/migrations/2026-09-19-02-line-push-cron.sql) daily scan for
// sent quotations whose price validity (valid_until) ends within 7 days
// (_shared/quotation-expiry.ts). Also sends a free Web Push to the admins' devices
// (own on/off switch, independent of the LINE one). Pushes to the
// tenant's OWNER(s) AND to the specific quotation's creator (if that
// person has linked their own LINE account) -- a user who hasn't linked
// yet simply doesn't get pushed to (Task 6's linking is opt-in), same
// as any other not-yet-configured integration, never an error.
//
// verify_jwt is ON, but that ALONE is not real access control -- it
// only checks that the Authorization bearer is a validly-signed JWT
// for this project, not its role. This project's anon key is such a
// JWT and is intentionally public (ships in the client bundle), so
// verify_jwt alone would let anyone holding it call this function
// directly, on demand, bypassing the cron schedule -- against the real,
// currently-linked OWNER. The real access control is the
// `x-cron-secret` header check immediately below, verified via
// public.verify_cron_secret() (see
// supabase/migrations/2026-09-19-04-line-push-cron-secret-verify-fn.sql)
// BEFORE any other query or LINE push.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { isExpiryNoticeDue, formatExpiryMessage, daysUntil, type ExpiringQuotation } from '../_shared/quotation-expiry.ts'
import { quotationExpiryPush } from '../_shared/web-push-messages.ts'
import { sendWebPushToTenantAdmins } from '../_shared/web-push.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function isAuthorizedCronCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-cron-secret')
  if (!provided) return false
  const { data, error } = await admin.rpc('verify_cron_secret', { provided })
  if (error) {
    console.error('verify_cron_secret RPC failed', error)
    return false
  }
  return data === true
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Bangkok has no DST -- a fixed +7h offset is always correct.
function bangkokTodayISO(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)

  const today = bangkokTodayISO()

  let quotationsDue = 0
  let messagesPushed = 0
  let pushFailures = 0

  // Every company with a quotation to notice, not only those with LINE set up: Web Push works without it.
  const { data: tenantRows, error: tenantError } = await admin.from('quotations').select('tenant_id')
    .eq('status', 'sent').eq('on_hold', false).not('valid_until', 'is', null)
  if (tenantError) return json({ error: tenantError.message }, 500)
  const tenantIds = [...new Set((tenantRows ?? []).map((r) => r.tenant_id as string))]

  for (const tenantId of tenantIds) {
    const { data: quotations, error } = await admin
      .from('quotations')
      .select('id, quotation_number, status, on_hold, valid_until, expiry_notified_for, created_by')
      .eq('tenant_id', tenantId)
      .eq('status', 'sent').eq('on_hold', false)
      .not('valid_until', 'is', null)
    if (error) {
      console.error('quotations query failed', tenantId, error)
      continue
    }
    const dueQuotations = ((quotations ?? []) as ExpiringQuotation[]).filter((q) => isExpiryNoticeDue(q, today))
    if (dueQuotations.length === 0) continue

    const lineOn = (await tenantHasModuleAccess(admin, tenantId, 'line_bot')) && (await isPushEnabled(admin, tenantId, 'line_push_quotation_followup'))
    const webOn = await isPushEnabled(admin, tenantId, 'web_push_quotation_expiry')

    let ownerLineIds: string[] = []
    if (lineOn) {
      const { data: owners, error: ownersError } = await admin
        .from('user_roles').select('line_user_id').eq('tenant_id', tenantId).eq('role', 'OWNER').not('line_user_id', 'is', null)
      if (ownersError) console.error('user_roles owners query failed', tenantId, ownersError)
      ownerLineIds = (owners ?? []).map((o) => o.line_user_id as string)
    }

    for (const quotation of dueQuotations) {
      quotationsDue++

      if (lineOn) {
        const recipients = new Set<string>(ownerLineIds)
        if (quotation.created_by) {
          const { data: creator, error: creatorError } = await admin
            .from('user_roles').select('line_user_id').eq('tenant_id', tenantId).eq('user_email', quotation.created_by)
            .not('line_user_id', 'is', null).maybeSingle()
          if (creatorError) console.error('user_roles creator lookup failed', tenantId, creatorError)
          if (creator?.line_user_id) recipients.add(creator.line_user_id as string)
        }
        const message = formatExpiryMessage(quotation, today)
        for (const lineUserId of recipients) {
          const result = await withPushBudget(admin, tenantId, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, message))
          if (result.ok) messagesPushed++
          else {
            pushFailures++
            console.error('sendLinePush failed', tenantId, result.status)
          }
        }
      }
      if (webOn) {
        await sendWebPushToTenantAdmins(admin, tenantId, quotationExpiryPush(quotation.quotation_number, quotation.valid_until as string, daysUntil(today, quotation.valid_until as string)))
      }

      // Mark as noticed for THIS valid_until (even with no recipients) so it is not repeated
      // tomorrow; a snooze changes valid_until and so earns a fresh notice later.
      const { error: updateError } = await admin.from('quotations').update({ expiry_notified_for: quotation.valid_until }).eq('id', quotation.id)
      if (updateError) console.error('expiry_notified_for update failed', quotation.id, updateError)
    }
  }

  return json({ ok: true, quotationsDue, messagesPushed, pushFailures })
})
