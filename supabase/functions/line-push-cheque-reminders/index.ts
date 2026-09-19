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
// verify_jwt is ON -- only this project's own pg_cron job calls this,
// using the service-role key as its bearer token.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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

// Ported line-for-line from formatChequeReminderMessage.
function formatChequeReminderMessage(cheque: Cheque): string {
  return `🏦 เช็ค ${cheque.cheque_no} (${cheque.bank}) ครบกำหนด ${cheque.check_date}`
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

  const today = bangkokTodayISO()

  const { data: settingsRows, error: settingsError } = await admin
    .from('line_settings')
    .select('tenant_id, channel_access_token')
  if (settingsError) return json({ error: settingsError.message }, 500)

  let tenantsEnabled = 0
  let chequesDue = 0
  let messagesPushed = 0
  let pushFailures = 0

  for (const settings of settingsRows ?? []) {
    const lineEnabled = await getAppSetting(settings.tenant_id as string, 'cheque_reminder_line_enabled')
    if (lineEnabled !== 'true') continue // not explicitly enabled -- skip tenant
    tenantsEnabled++

    const daysVal = await getAppSetting(settings.tenant_id as string, 'cheque_reminder_days')
    const thresholdDays = daysVal != null ? parseInt(daysVal, 10) : 3 // same fallback ('3') as useAppSetting('cheque_reminder_days', '3') in Dashboard.jsx/Settings.jsx
    const safeThresholdDays = Number.isFinite(thresholdDays) ? thresholdDays : 3

    const { data: cheques, error } = await admin
      .from('cheques')
      .select('id, cheque_no, bank, status, check_date, created_by')
      .eq('tenant_id', settings.tenant_id)
      .neq('status', 'cashed')
    if (error) {
      console.error('cheques query failed', settings.tenant_id, error)
      continue
    }
    const dueCheques = (cheques ?? []).filter((c) => isChequeReminderDue(c as Cheque, safeThresholdDays, today))
    if (dueCheques.length === 0) continue

    const { data: owners, error: ownersError } = await admin
      .from('user_roles')
      .select('line_user_id')
      .eq('tenant_id', settings.tenant_id)
      .eq('role', 'OWNER')
      .not('line_user_id', 'is', null)
    if (ownersError) console.error('user_roles owners query failed', settings.tenant_id, ownersError)
    const ownerLineIds = (owners ?? []).map((o) => o.line_user_id as string)

    for (const cheque of dueCheques as Cheque[]) {
      chequesDue++

      // Resolving cheques.created_by to an individual, same join pattern
      // as quotations (user_roles.user_email = created_by). Straightforward
      // in practice -- created_by is the same free TEXT email-string shape
      // Task 1 added to both tables, so the exact same lookup works
      // unchanged; the only difference from quotations is cheques don't
      // ever null this out or require it, so it's simply absent (no error)
      // on any cheque created before Task 1 shipped `created_by`.
      const recipients = new Set<string>(ownerLineIds)
      if (cheque.created_by) {
        const { data: creator, error: creatorError } = await admin
          .from('user_roles')
          .select('line_user_id')
          .eq('tenant_id', settings.tenant_id)
          .eq('user_email', cheque.created_by)
          .not('line_user_id', 'is', null)
          .maybeSingle()
        if (creatorError) console.error('user_roles creator lookup failed', settings.tenant_id, creatorError)
        if (creator?.line_user_id) recipients.add(creator.line_user_id as string)
      }

      const message = formatChequeReminderMessage(cheque)
      for (const lineUserId of recipients) {
        const result = await sendLinePush(settings.channel_access_token, lineUserId, message)
        if (result.ok) messagesPushed++
        else {
          pushFailures++
          console.error('sendLinePush failed', settings.tenant_id, result.status)
        }
      }
    }
  }

  return json({ ok: true, tenantsEnabled, chequesDue, messagesPushed, pushFailures })
})
