// supabase/functions/line-push-quotation-followups/index.ts
// Scheduled (Supabase Cron -- see
// supabase/migrations/2026-09-19-02-line-push-cron.sql) daily scan for
// sent quotations whose follow-up window has elapsed. Pushes to the
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

const DAY_MS = 86400000
function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor((new Date(toISO).getTime() - new Date(fromISO).getTime()) / DAY_MS)
}

// Ported line-for-line from src/lib/lineNotifications.js's
// isQuotationFollowupDue -- keep in sync with that file.
type Quotation = {
  id: string
  quotation_number: string
  status: string
  sent_at: string | null
  follow_up_after_days: number | null
  follow_up_sent_at: string | null
  created_by: string | null
}
function isQuotationFollowupDue(quotation: Quotation, todayISO: string): boolean {
  if (quotation.status !== 'sent') return false
  if (quotation.follow_up_after_days == null) return false
  if (quotation.follow_up_sent_at) return false
  if (!quotation.sent_at) return false
  return daysBetween(quotation.sent_at, todayISO) >= (quotation.follow_up_after_days as number)
}

// Ported line-for-line from formatQuotationFollowupMessage.
function formatQuotationFollowupMessage(quotation: Quotation): string {
  return `📤 ติดตามใบเสนอราคา ${quotation.quotation_number} — ส่งไปแล้ว ${quotation.follow_up_after_days} วัน ยังไม่มีการตอบรับ`
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)

  const today = bangkokTodayISO()

  const { data: settingsRows, error: settingsError } = await admin
    .from('line_settings')
    .select('tenant_id')
  if (settingsError) return json({ error: settingsError.message }, 500)

  let quotationsDue = 0
  let messagesPushed = 0
  let pushFailures = 0

  for (const settings of settingsRows ?? []) {
    // Real gap closed 2026-10-01 -- see tenant-access.ts's header.
    if (!(await tenantHasModuleAccess(admin, settings.tenant_id as string, 'line_bot'))) continue
    if (!(await isPushEnabled(admin, settings.tenant_id as string, 'line_push_quotation_followup'))) continue

    const { data: quotations, error } = await admin
      .from('quotations')
      .select('id, quotation_number, status, sent_at, follow_up_after_days, follow_up_sent_at, created_by')
      .eq('tenant_id', settings.tenant_id)
      .eq('status', 'sent')
      .not('follow_up_after_days', 'is', null)
      .is('follow_up_sent_at', null)
    if (error) {
      console.error('quotations query failed', settings.tenant_id, error)
      continue
    }
    const dueQuotations = (quotations ?? []).filter((q) => isQuotationFollowupDue(q as Quotation, today))
    if (dueQuotations.length === 0) continue

    const { data: owners, error: ownersError } = await admin
      .from('user_roles')
      .select('line_user_id')
      .eq('tenant_id', settings.tenant_id)
      .eq('role', 'OWNER')
      .not('line_user_id', 'is', null)
    if (ownersError) console.error('user_roles owners query failed', settings.tenant_id, ownersError)
    const ownerLineIds = (owners ?? []).map((o) => o.line_user_id as string)

    for (const quotation of dueQuotations as Quotation[]) {
      quotationsDue++

      const recipients = new Set<string>(ownerLineIds)
      if (quotation.created_by) {
        const { data: creator, error: creatorError } = await admin
          .from('user_roles')
          .select('line_user_id')
          .eq('tenant_id', settings.tenant_id)
          .eq('user_email', quotation.created_by)
          .not('line_user_id', 'is', null)
          .maybeSingle()
        if (creatorError) console.error('user_roles creator lookup failed', settings.tenant_id, creatorError)
        if (creator?.line_user_id) recipients.add(creator.line_user_id as string)
      }

      const message = formatQuotationFollowupMessage(quotation)
      for (const lineUserId of recipients) {
        const result = await withPushBudget(admin, settings.tenant_id as string, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, message))
        if (result.ok) messagesPushed++
        else {
          pushFailures++
          console.error('sendLinePush failed', settings.tenant_id, result.status)
        }
      }

      // Mark sent regardless of recipient count (even zero -- e.g. no
      // OWNER/creator has linked LINE yet) so this quotation is never
      // re-evaluated as due again tomorrow.
      const { error: updateError } = await admin
        .from('quotations')
        .update({ follow_up_sent_at: new Date().toISOString() })
        .eq('id', quotation.id)
      if (updateError) console.error('follow_up_sent_at update failed', quotation.id, updateError)
    }
  }

  return json({ ok: true, quotationsDue, messagesPushed, pushFailures })
})
