// supabase/functions/line-push-cheque-reminders/index.ts
// Scheduled (Supabase Cron -- see
// supabase/migrations/2026-09-19-02-line-push-cron.sql) daily cheque
// reminder push. Reuses the SAME `cheque_reminder_days` app_setting the
// existing in-app Dashboard alert already reads (src/pages/Dashboard.jsx:209,
// src/pages/Settings.jsx:122) -- no second threshold setting -- gated by
// a second, LINE-specific app_setting `cheque_reminder_line_enabled`
// (Task 7) that tenants must explicitly turn on; a tenant with neither
// setting is skipped entirely, not defaulted to "on".
//
// No "already sent" guard: the existing in-app alert re-shows every day
// a cheque is within the threshold (not a one-time dismissal), so this
// push behaves the same way -- a daily nudge until the cheque clears
// (status changes away from anything but 'cashed'), not a one-time send.
//
// verify_jwt is ON, but that ALONE is not real access control -- it
// only checks that the Authorization bearer is a validly-signed JWT
// for this project, not its role. This project's anon key is such a
// JWT and is intentionally public (ships in the client bundle), so
// verify_jwt alone would let anyone holding it call this function
// directly, on demand, bypassing the cron schedule. Today this
// function is only *accidentally* safe from that (its enabling toggle,
// `cheque_reminder_line_enabled`, doesn't exist for any tenant yet --
// Task 7 hasn't shipped it), which is not a real guarantee once it
// does. The real access control is the `x-cron-secret` header check
// immediately below, verified via public.verify_cron_secret() (see
// supabase/migrations/2026-09-19-04-line-push-cron-secret-verify-fn.sql)
// BEFORE any other query or LINE push.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { formatChequeDigest, groupChequesByRecipient } from '../_shared/cheque-digest.ts'
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

function bangkokTodayISO(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const DAY_MS = 86400000
function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor((new Date(toISO).getTime() - new Date(fromISO).getTime()) / DAY_MS)
}

// Ported line-for-line from src/lib/lineNotifications.js's
// isChequeReminderDue -- keep in sync with that file.
type Cheque = { id: string; cheque_no: string; bank: string; status: string; check_date: string; created_by: string | null }
function isChequeReminderDue(cheque: Cheque, thresholdDays: number, todayISO: string): boolean {
  if (cheque.status === 'cashed') return false
  return daysBetween(todayISO, cheque.check_date) <= thresholdDays
}

async function getAppSetting(tenantId: string, key: string): Promise<string | null> {
  const { data, error } = await admin.from('app_settings').select('value').eq('tenant_id', tenantId).eq('key', key).maybeSingle()
  if (error) {
    console.error('app_settings lookup failed', tenantId, key, error)
    return null
  }
  return data?.value ?? null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)

  const today = bangkokTodayISO()

  // Companies with an uncashed cheque; each is then checked for its own switches and window.
  const { data: tenantRows, error: tenantError } = await admin.from('cheques').select('tenant_id').neq('status', 'cashed')
  if (tenantError) return json({ error: tenantError.message }, 500)
  const tenantIds = [...new Set((tenantRows ?? []).map((r) => r.tenant_id as string))]

  let tenantsEnabled = 0
  let chequesDue = 0
  let messagesPushed = 0
  let pushFailures = 0

  for (const tenantId of tenantIds) {
    // LINE: opt-in (cheque_reminder_line_enabled) + the LINE bot module. Device push: its own switch.
    const lineOn = (await tenantHasModuleAccess(admin, tenantId, 'line_bot')) && (await getAppSetting(tenantId, 'cheque_reminder_line_enabled')) === 'true'
    const webOn = (await tenantHasModuleAccess(admin, tenantId, 'cheque_tracking')) && (await isPushEnabled(admin, tenantId, 'web_push_cheque_due'))
    if (!lineOn && !webOn) continue
    tenantsEnabled++

    const daysVal = await getAppSetting(tenantId, 'cheque_reminder_days')
    const thresholdDays = daysVal != null ? parseInt(daysVal, 10) : 3 // same fallback ('3') as useAppSetting('cheque_reminder_days', '3') in Dashboard.jsx/Settings.jsx
    const safeThresholdDays = Number.isFinite(thresholdDays) ? thresholdDays : 3

    const { data: cheques, error } = await admin
      .from('cheques')
      .select('id, cheque_no, bank, status, check_date, created_by')
      .eq('tenant_id', tenantId)
      .neq('status', 'cashed')
    if (error) {
      console.error('cheques query failed', tenantId, error)
      continue
    }
    const dueCheques = ((cheques ?? []) as Cheque[]).filter((c) => isChequeReminderDue(c, safeThresholdDays, today))
    if (dueCheques.length === 0) continue
    chequesDue += dueCheques.length

    if (lineOn) {
      const { data: owners, error: ownersError } = await admin
        .from('user_roles').select('line_user_id').eq('tenant_id', tenantId).eq('role', 'OWNER').not('line_user_id', 'is', null)
      if (ownersError) console.error('user_roles owners query failed', tenantId, ownersError)
      const ownerLineIds = (owners ?? []).map((o) => o.line_user_id as string)

      // Creators' LINE ids, looked up once per company (not once per cheque).
      const creatorEmails = [...new Set(dueCheques.map((c) => c.created_by).filter((e): e is string => !!e))]
      const creatorLine = new Map<string, string>()
      if (creatorEmails.length) {
        const { data: creators, error: creatorError } = await admin
          .from('user_roles').select('user_email, line_user_id').eq('tenant_id', tenantId).in('user_email', creatorEmails).not('line_user_id', 'is', null)
        if (creatorError) console.error('user_roles creators lookup failed', tenantId, creatorError)
        for (const c of creators ?? []) creatorLine.set(c.user_email as string, c.line_user_id as string)
      }

      // One message per person with all their cheques in it.
      const byRecipient = groupChequesByRecipient(dueCheques, ownerLineIds, (email) => creatorLine.get(email))
      for (const [lineUserId, list] of byRecipient) {
        const message = formatChequeDigest(list)
        const result = await withPushBudget(admin, tenantId, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, message))
        if (result.ok) messagesPushed++
        else {
          pushFailures++
          console.error('sendLinePush failed', tenantId, result.status)
        }
      }
    }

    if (webOn) {
      await sendWebPushToTenantAdmins(admin, tenantId, {
        title: '🏦 เช็คใกล้ครบกำหนด',
        body: `${dueCheques.length} ใบ ครบกำหนดภายใน ${safeThresholdDays} วัน`,
        tab: 'cheques',
      })
    }
  }

  return json({ ok: true, tenantsEnabled, chequesDue, messagesPushed, pushFailures })
})
