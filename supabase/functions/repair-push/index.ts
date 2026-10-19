// repair-push: LINE messages to customers about repair tickets, sent through the tenant's OWN customer OA.
//
// Two callers:
//   1. Staff (JWT, OWNER or ADMIN): POST {action:'schedule'|'report', ticket_id, force?}
//      - schedule: the appointment text; sets notified_schedule_at (re-sending allowed).
//      - report:   the "ซ่อมเสร็จ" Flex with before/after photos; sets reported_at; refused once sent unless force.
//   2. pg_cron (x-cron-secret, checked with verify_cron_secret): POST {action:'reminders'}
//      at 06:00 UTC = 13:00 Bangkok, reminds about tickets scheduled for Bangkok tomorrow.
//
// Deploys WITH JWT verification on (the default), like the other cron functions.
// The caller's tenant always comes from their user_roles row, never from the body.
// Every push goes through _shared/customer-push.ts (setting -> budget -> push). Never logs or returns the token
// or a LINE user id.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { pushToCustomer, customerPushDeps } from '../_shared/customer-push.ts'
import type { CustomerPushDeps, CustomerPushResult } from '../_shared/customer-push.ts'
import { scheduleText, reminderText, repairReportFlex } from '../_shared/repair.ts'
import type { RepairTicket } from '../_shared/repair.ts'
import { warrantyStatus } from '../_shared/warranty.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNED_URL_SECONDS = 31536000 // 365 days (R14)
// repairReportFlex shows only the first before and the first after photo, so only those are signed.
const PHOTOS_PER_SIDE = 1

const TICKET_COLS =
  'id, tenant_id, ticket_number, site_id, client_id, line_user_id, status, description, fix_note, ' +
  'scheduled_date, scheduled_start, duration_hours, done_at, reported_at, notified_schedule_at, reminded_at'

type TicketRow = {
  id: string
  tenant_id: string
  ticket_number: string
  site_id: string
  client_id: string | null
  line_user_id: string | null
  status: string
  description: string | null
  fix_note: string | null
  scheduled_date: string | null
  scheduled_start: string | null
  duration_hours: number | null
  done_at: string | null
  reported_at: string | null
  notified_schedule_at: string | null
  reminded_at: string | null
}
type SiteRow = { id: string; name: string | null; handover_date: string | null; warranty_months: number | null }

const errCode = (e: unknown) => (e as { code?: string } | null)?.code ?? 'unknown'

function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function toRepairTicket(t: TicketRow, site: SiteRow | null): RepairTicket {
  return {
    ticket_number: t.ticket_number,
    site_name: site?.name ?? '',
    status: t.status,
    description: t.description,
    fix_note: t.fix_note,
    scheduled_date: t.scheduled_date,
    scheduled_start: t.scheduled_start,
    duration_hours: t.duration_hours,
    done_at: t.done_at,
    handover_date: site?.handover_date ?? null,
    warranty_months: site?.warranty_months ?? null,
  }
}

// The ticket's own LINE user, else the client's linked account in this tenant.
async function recipientFor(tenantId: string, t: TicketRow): Promise<string | null> {
  if (t.line_user_id) return t.line_user_id
  if (!t.client_id) return null
  const { data, error } = await admin.from('customer_line_accounts').select('line_user_id')
    .eq('tenant_id', tenantId).eq('client_id', t.client_id).maybeSingle()
  if (error) {
    console.error('repair-push account lookup failed', errCode(error))
    return null
  }
  return (data?.line_user_id as string | undefined) ?? null
}

// Per-tenant deps: the setting and token are read once per tenant per request.
function cachedDeps(base: CustomerPushDeps): CustomerPushDeps {
  const enabled = new Map<string, Promise<boolean>>()
  const tokens = new Map<string, Promise<string | null>>()
  return {
    ...base,
    pushEnabled: (id) => {
      if (!enabled.has(id)) enabled.set(id, base.pushEnabled(id))
      return enabled.get(id)!
    },
    accessToken: (id) => {
      if (!tokens.has(id)) tokens.set(id, base.accessToken(id))
      return tokens.get(id)!
    },
  }
}

async function isAuthorizedCronCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-cron-secret')
  if (!provided) return false
  const { data, error } = await admin.rpc('verify_cron_secret', { provided })
  if (error) {
    console.error('repair-push verify_cron_secret failed', errCode(error))
    return false
  }
  return data === true
}

// ---------------- staff actions ----------------

async function loadTicket(tenantId: string, ticketId: string) {
  const { data, error } = await admin.from('repair_tickets').select(TICKET_COLS)
    .eq('tenant_id', tenantId).eq('id', ticketId).maybeSingle()
  if (error) throw error
  return (data as TicketRow | null) ?? null
}

async function loadSite(tenantId: string, siteId: string): Promise<SiteRow | null> {
  const { data, error } = await admin.from('sites').select('id, name, handover_date, warranty_months')
    .eq('tenant_id', tenantId).eq('id', siteId).maybeSingle()
  if (error) throw error
  return (data as SiteRow | null) ?? null
}

async function actionSchedule(tenantId: string, t: TicketRow): Promise<Response> {
  if (t.status !== 'scheduled' || !t.scheduled_date) {
    return json({ error: 'not_scheduled', message: 'ต้องเป็นสถานะ "นัดเข้า" และมีวันนัดก่อนส่ง' }, 409)
  }
  const site = await loadSite(tenantId, t.site_id)
  const to = await recipientFor(tenantId, t)
  const result = await pushToCustomer(customerPushDeps(admin), tenantId, to,
    [{ type: 'text', text: scheduleText(toRepairTicket(t, site)) }])
  const patch: Record<string, unknown> = {}
  if (result.sent) patch.notified_schedule_at = new Date().toISOString()
  // A moved appointment that is still ahead gets reminded again, whether or not this push went out.
  if (t.scheduled_date > bangkokToday()) patch.reminded_at = null
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from('repair_tickets').update(patch).eq('tenant_id', tenantId).eq('id', t.id)
    if (error) console.error('repair-push schedule mark failed', errCode(error))
  }
  return json(result)
}

async function signedPhotoUrls(tenantId: string, ticketId: string): Promise<{ before: string[]; after: string[] }> {
  const { data, error } = await admin.from('repair_ticket_media').select('role, storage_path, created_at')
    .eq('tenant_id', tenantId).eq('ticket_id', ticketId).eq('media_type', 'image')
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = (data ?? []) as { role: string; storage_path: string }[]
  // Staff "before" photos first, then what the customer sent.
  const beforePaths = [
    ...rows.filter((r) => r.role === 'before'),
    ...rows.filter((r) => r.role === 'customer'),
  ].map((r) => r.storage_path)
  const afterPaths = rows.filter((r) => r.role === 'after').map((r) => r.storage_path)

  const sign = async (paths: string[]) => {
    const out: string[] = []
    for (const p of paths) {
      if (out.length >= PHOTOS_PER_SIDE) break
      if (!p || !p.startsWith(`${tenantId}/`)) continue // never sign another tenant's object
      const { data: s, error: sErr } = await admin.storage.from('repair-media').createSignedUrl(p, SIGNED_URL_SECONDS)
      if (sErr || !s?.signedUrl) {
        console.error('repair-push sign failed', sErr?.name ?? 'no_url')
        continue
      }
      out.push(s.signedUrl)
    }
    return out
  }
  return { before: await sign(beforePaths), after: await sign(afterPaths) }
}

async function actionReport(tenantId: string, t: TicketRow, force: boolean): Promise<Response> {
  if (t.status !== 'done') {
    return json({ error: 'not_done', message: 'ต้องเป็นสถานะ "เสร็จ" ก่อนส่งรายงาน' }, 409)
  }
  if (t.reported_at && !force) return json({ error: 'already_reported', reported_at: t.reported_at }, 409)

  // Claim reported_at before sending so a double click cannot send the card twice.
  const claimedAt = new Date().toISOString()
  let claim = admin.from('repair_tickets').update({ reported_at: claimedAt })
    .eq('tenant_id', tenantId).eq('id', t.id)
  claim = t.reported_at ? claim.eq('reported_at', t.reported_at) : claim.is('reported_at', null)
  const { data: claimed, error: claimErr } = await claim.select('id')
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) return json({ error: 'already_reported' }, 409)

  let result: CustomerPushResult
  try {
    const site = await loadSite(tenantId, t.site_id)
    const today = bangkokToday()
    const w = warrantyStatus(site?.handover_date, Number(site?.warranty_months) || 0, today)
    const warrantyEndDate = w.kind === 'active' ? w.end : null
    const photos = await signedPhotoUrls(tenantId, t.id)
    const to = await recipientFor(tenantId, t)
    result = await pushToCustomer(customerPushDeps(admin), tenantId, to,
      [repairReportFlex(toRepairTicket(t, site), photos.before, photos.after, warrantyEndDate)])
  } catch (e) {
    result = { sent: false, skipped: 'error' }
    console.error('repair-push report failed', errCode(e))
  }

  if (!result.sent) {
    // Not sent: put reported_at back to what it was.
    const { error } = await admin.from('repair_tickets').update({ reported_at: t.reported_at })
      .eq('tenant_id', tenantId).eq('id', t.id).eq('reported_at', claimedAt)
    if (error) console.error('repair-push report unclaim failed', errCode(error))
  }
  return json(result)
}

// ---------------- cron: reminders ----------------

async function runReminders(): Promise<Response> {
  const tomorrow = addDays(bangkokToday(), 1)
  // The one cross-tenant read: each group below is handled with its own tenant's token, setting and budget.
  const { data, error } = await admin.from('repair_tickets').select(TICKET_COLS)
    .eq('status', 'scheduled').eq('scheduled_date', tomorrow).is('reminded_at', null)
  if (error) {
    console.error('repair-push reminders select failed', errCode(error))
    return json({ ok: false, error: 'select_failed' }, 500)
  }
  const byTenant = new Map<string, TicketRow[]>()
  for (const t of (data ?? []) as TicketRow[]) {
    const list = byTenant.get(t.tenant_id) ?? []
    list.push(t)
    byTenant.set(t.tenant_id, list)
  }

  const summary = { date: tomorrow, tenants: byTenant.size, tickets: 0, skipped_module_tenants: 0, sent: 0, off: 0, no_recipient: 0, budget: 0, error: 0 }
  const deps = cachedDeps(customerPushDeps(admin))

  for (const [tenantId, tickets] of byTenant) {
    let handled = 0
    let counted = false
    try {
      // No line_bot module: skip the tenant entirely, no markers set.
      if (!(await tenantHasModuleAccess(admin, tenantId, 'line_bot'))) {
        summary.skipped_module_tenants++
        continue
      }
      summary.tickets += tickets.length
      counted = true
      const siteIds = [...new Set(tickets.map((t) => t.site_id))]
      const { data: s, error: sErr } = await admin.from('sites').select('id, name, handover_date, warranty_months')
        .eq('tenant_id', tenantId).in('id', siteIds)
      if (sErr) throw sErr
      const sites = new Map(((s ?? []) as SiteRow[]).map((x) => [x.id, x]))

      const clientIds = [...new Set(tickets.filter((t) => !t.line_user_id && t.client_id).map((t) => t.client_id as string))]
      const accounts = new Map<string, string>()
      if (clientIds.length > 0) {
        const { data: a, error: aErr } = await admin.from('customer_line_accounts').select('client_id, line_user_id')
          .eq('tenant_id', tenantId).in('client_id', clientIds)
        if (aErr) throw aErr
        for (const x of a ?? []) accounts.set(x.client_id as string, x.line_user_id as string)
      }

      for (const t of tickets) {
        const to = t.line_user_id || (t.client_id ? accounts.get(t.client_id) : null) || null
        const r = await pushToCustomer(deps, tenantId, to,
          [{ type: 'text', text: reminderText(toRepairTicket(t, sites.get(t.site_id) ?? null)) }])
        const kind = r.sent ? 'sent' : (r.skipped ?? 'error')
        summary[kind]++
        handled++
        // Sent, or skipped for a reason that will not change by retrying: mark it done.
        if (kind === 'sent' || kind === 'off' || kind === 'no_recipient') {
          const { error: uErr } = await admin.from('repair_tickets').update({ reminded_at: new Date().toISOString() })
            .eq('tenant_id', tenantId).eq('id', t.id).is('reminded_at', null)
          if (uErr) console.error('repair-push reminder mark failed', errCode(uErr))
        }
      }
    } catch (e) {
      console.error('repair-push reminders tenant failed', tenantId, errCode(e))
      if (!counted) summary.tickets += tickets.length
      summary.error += Math.max(0, tickets.length - handled)
    }
  }
  return json({ ok: true, ...summary })
}

// ---------------- entry ----------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
    if (!body || typeof body !== 'object') throw new Error('bad body')
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  try {
    // Cron mode.
    if (req.headers.get('x-cron-secret') !== null) {
      if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)
      if (body.action !== 'reminders') return json({ error: 'bad_action' }, 400)
      return await runReminders()
    }

    // Staff mode.
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'unauthorized' }, 401)
    const { data: { user }, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !user?.email) return json({ error: 'unauthorized' }, 401)
    const { data: role } = await admin.from('user_roles').select('tenant_id, role').eq('user_email', user.email).maybeSingle()
    if (!role || !['OWNER', 'ADMIN'].includes(role.role as string) || !role.tenant_id) return json({ error: 'forbidden' }, 403)
    const tenantId = role.tenant_id as string

    const action = body.action
    if (action !== 'schedule' && action !== 'report') return json({ error: 'bad_action' }, 400)
    const ticketId = typeof body.ticket_id === 'string' ? body.ticket_id : ''
    if (!UUID_RE.test(ticketId)) return json({ error: 'bad_ticket_id' }, 400)
    if (!(await tenantHasModuleAccess(admin, tenantId, 'line_bot'))) return json({ sent: false, skipped: 'off' })

    const ticket = await loadTicket(tenantId, ticketId)
    if (!ticket) return json({ error: 'not_found' }, 404)

    if (action === 'schedule') return await actionSchedule(tenantId, ticket)
    return await actionReport(tenantId, ticket, body.force === true)
  } catch (e) {
    console.error('repair-push failed', errCode(e))
    return json({ error: 'internal' }, 500)
  }
})
