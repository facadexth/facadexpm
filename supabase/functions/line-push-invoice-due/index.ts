// supabase/functions/line-push-invoice-due/index.ts
// Scheduled MONTHLY (Supabase Cron -- see
// supabase/migrations/2026-09-19-02-line-push-cron.sql, 1st of each
// month) push for Ongoing sites due their next progress invoice.
//
// billing_pct: reuses site_financial_summary.billing_pct exactly as
// src/pages/Sites.jsx does (useSites() in src/hooks/useSupabase.js:57-66
// selects `*` from that view; Sites.jsx:585 reads `s.billing_pct`
// straight off it) -- not re-derived here. That view has NO tenant_id
// column (confirmed live via information_schema.columns) and is
// security_invoker, so under this function's service-role client it
// would return every tenant's sites with no way to filter by tenant
// directly on the view. Worked around by first fetching this tenant's
// Ongoing site ids from `sites` (which DOES have tenant_id), then
// filtering site_financial_summary by `id IN (...)`.
//
// last_invoice_date: site_financial_summary also has no such column
// (confirmed live) -- computed here the same way this codebase treats
// invoices elsewhere: MAX(invoices.date) per site, EXCLUDING status =
// 'void' rows, matching src/pages/Invoices.jsx's treatment of a void
// invoice as not real (e.g. `invoice.status === 'void' -> { amount: 0,
// pct: 0 }` at Invoices.jsx:1024/1047, and the `hideVoid` list filter at
// Invoices.jsx:1647).
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
import { formatInvoiceDueDigest } from '../_shared/invoice-due-message.ts'
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

function bangkokTodayISO(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Ported line-for-line from src/lib/lineNotifications.js's
// isSiteInvoiceDueThisMonth -- keep in sync with that file.
type Site = { id: string; name: string; site_number: string; status: string; billing_pct: number | null; last_invoice_date: string | null }
function isSiteInvoiceDueThisMonth(site: Site, todayISO: string): boolean {
  if (site.status !== 'Ongoing') return false
  if ((site.billing_pct ?? 0) >= 100) return false
  if (!site.last_invoice_date) return true
  const today = new Date(todayISO)
  const last = new Date(site.last_invoice_date)
  return !(last.getFullYear() === today.getFullYear() && last.getMonth() === today.getMonth())
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)

  const today = bangkokTodayISO()

  const { data: settingsRows, error: settingsError } = await admin
    .from('line_settings')
    .select('tenant_id')
  if (settingsError) return json({ error: settingsError.message }, 500)

  let sitesDue = 0
  let messagesPushed = 0
  let pushFailures = 0

  for (const settings of settingsRows ?? []) {
    // Real gap closed 2026-10-01 -- see tenant-access.ts's header.
    if (!(await tenantHasModuleAccess(admin, settings.tenant_id as string, 'line_bot'))) continue
    if (!(await isPushEnabled(admin, settings.tenant_id as string, 'line_push_invoice_due'))) continue

    const { data: ongoingSites, error: sitesError } = await admin
      .from('sites')
      .select('id')
      .eq('tenant_id', settings.tenant_id)
      .eq('status', 'Ongoing')
    if (sitesError) {
      console.error('sites query failed', settings.tenant_id, sitesError)
      continue
    }
    const siteIds = (ongoingSites ?? []).map((s) => s.id as string)
    if (siteIds.length === 0) continue

    const { data: financials, error: financialsError } = await admin
      .from('site_financial_summary')
      .select('id, name, site_number, status, billing_pct')
      .in('id', siteIds)
    if (financialsError) {
      console.error('site_financial_summary query failed', settings.tenant_id, financialsError)
      continue
    }

    const { data: invoiceRows, error: invoicesError } = await admin
      .from('invoices')
      .select('site_id, date')
      .in('site_id', siteIds)
      .neq('status', 'void')
    if (invoicesError) console.error('invoices query failed', settings.tenant_id, invoicesError)
    const lastInvoiceDateBySite = new Map<string, string>()
    for (const inv of invoiceRows ?? []) {
      const siteId = inv.site_id as string
      const date = inv.date as string
      const current = lastInvoiceDateBySite.get(siteId)
      if (!current || date > current) lastInvoiceDateBySite.set(siteId, date)
    }

    const dueSites = (financials ?? [])
      .map((f) => ({ ...f, last_invoice_date: lastInvoiceDateBySite.get(f.id as string) ?? null }) as Site)
      .filter((site) => isSiteInvoiceDueThisMonth(site, today))
    if (dueSites.length === 0) continue

    const { data: owners, error: ownersError } = await admin
      .from('user_roles')
      .select('line_user_id')
      .eq('tenant_id', settings.tenant_id)
      .eq('role', 'OWNER')
      .not('line_user_id', 'is', null)
    if (ownersError) console.error('user_roles owners query failed', settings.tenant_id, ownersError)
    const ownerLineIds = (owners ?? []).map((o) => o.line_user_id as string)

    // One message listing every due site (was one message per site per owner).
    sitesDue += dueSites.length
    const message = formatInvoiceDueDigest(dueSites)
    for (const lineUserId of ownerLineIds) {
      const result = await withPushBudget(admin, settings.tenant_id as string, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, message))
      if (result.ok) messagesPushed++
      else {
        pushFailures++
        console.error('sendLinePush failed', settings.tenant_id, result.status)
      }
    }
  }

  return json({ ok: true, sitesDue, messagesPushed, pushFailures })
})
