// customer-line-webhook: one endpoint for every tenant's own customer-facing LINE OA.
// Each tenant points its OA at ...?t=<webhook_key>. The crew bot lives in line-webhook.
// Logic is in _shared/customer-line-handler.ts (unit tested); this file is the HTTP shell.
// Never log tokens, secrets, request bodies or LINE user ids.
// Deploys with --no-verify-jwt: LINE calls it without a Supabase JWT; auth is the webhook_key plus the LINE signature.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { timingSafeEqual } from '../_shared/timing-safe.ts'
import { sendLineReplyMessages } from '../_shared/line-reply.ts'
import { replyWithFallback } from '../_shared/reply-fallback.ts'
import { handleCustomerEvent, type CustomerDeps } from '../_shared/customer-line-handler.ts'
import type { SiteStatus, SitePhase } from '../_shared/customer-line-replies.ts'
import {
  contentRetryDelay, mediaTooBig, repairMediaExt, repairMediaPath, repairUploadMime, OPEN_REPAIR_STATUSES, MAX_CHOOSER_TICKETS,
  type RepairTicket, type MediaCounts,
} from '../_shared/repair.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// Local HMAC check (not _shared/line.ts, which reads the crew bot's env vars at import).
async function verifySignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return timingSafeEqual(btoa(String.fromCharCode(...new Uint8Array(sig))), header)
}

// Supabase edge runtime global: lets work continue after the response is sent.
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined

const SIGNED_URL_SECONDS = 604800
const DONE_WINDOW_MS = 30 * 24 * 3600 * 1000
const REPAIR_SESSION_MS = 30 * 60 * 1000
const REPAIR_BUCKET = 'repair-media'
const MEDIA_FETCH_TIMEOUT_MS = 60000

// Reads a body up to the 50 MB cap; null when it goes over (the rest is cancelled, never buffered).
async function readCapped(res: Response): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (mediaTooBig(total)) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}
const text = (body: string, status: number) => new Response(body, { status })

// 42P01 = undefined_table: the repair tables are not there yet (webhook deployed before migration -11).
// Logged once per instance so existing commands keep working without flooding the logs.
let missingTableLogged = false
function missingTable(error: { code?: string } | null): boolean {
  if (error?.code !== '42P01') return false
  if (!missingTableLogged) { console.error('customer-line repair tables missing (42P01): apply migration -11'); missingTableLogged = true }
  return true
}

// 42703 = undefined_column: the session columns of migration -13 are not there yet (webhook deployed first).
let missingColumnLogged = false
function missingColumn(error: { code?: string } | null): boolean {
  if (error?.code !== '42703') return false
  if (!missingColumnLogged) { console.error('customer-line repair session columns missing (42703): apply migration -13'); missingColumnLogged = true }
  return true
}

function buildDeps(tenantId: string, accessToken: string): CustomerDeps {
  // Plain INSERT of a session row (PK tenant_id + line_user_id) after clearing only an EXPIRED one. On 23505
  // (an active session already exists: double tap / concurrent start) returns that session's ticket id
  // instead; null = inserted. Caller undoes its own side effects when a different ticket comes back.
  async function claimSession(lineUserId: string, row: Record<string, unknown>): Promise<{ ticketId: string } | null> {
    const { error: oldErr } = await admin.from('customer_line_repair_sessions').delete()
      .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).lte('expires_at', new Date().toISOString())
    if (oldErr) throw oldErr
    const { error: sessErr } = await admin.from('customer_line_repair_sessions').insert(
      { tenant_id: tenantId, line_user_id: lineUserId, expires_at: new Date(Date.now() + REPAIR_SESSION_MS).toISOString(), ...row },
    )
    if (!sessErr) return null
    if (sessErr.code !== '23505') throw sessErr
    const { data: cur, error: curErr } = await admin.from('customer_line_repair_sessions').select('ticket_id')
      .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
    if (curErr) throw curErr
    if (!cur) throw sessErr
    return { ticketId: cur.ticket_id as string }
  }
  async function siteNameOf(siteId: string | null | undefined): Promise<string> {
    if (!siteId) return ''
    const { data } = await admin.from('sites').select('name').eq('tenant_id', tenantId).eq('id', siteId).maybeSingle()
    return (data?.name as string) ?? ''
  }

  const deps: CustomerDeps = {
    // A DB error must throw (the per-event catch logs it, no reply), never look like "not linked".
    async getAccount(lineUserId) {
      const { data, error } = await admin.from('customer_line_accounts').select('client_id')
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      if (error) throw error
      if (!data) return null
      const { data: client, error: clientError } = await admin.from('clients').select('name')
        .eq('tenant_id', tenantId).eq('id', data.client_id).maybeSingle()
      if (clientError) throw clientError
      return { clientId: data.client_id as string, clientName: (client?.name as string) ?? '' }
    },
    async claimInvite(code, lineUserId, displayName) {
      const { data, error } = await admin.rpc('claim_customer_invite', {
        p_tenant: tenantId, p_code: code, p_line_user_id: lineUserId, p_display_name: displayName,
      })
      if (error) throw error
      const row = Array.isArray(data) ? data[0] : data
      return row?.status === 'ok'
        ? { status: 'ok', clientName: (row.client_name as string) ?? null }
        : { status: 'invalid', clientName: null }
    },
    async getDisplayName(lineUserId) {
      try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return null
        const j = await res.json()
        return typeof j?.displayName === 'string' ? j.displayName : null
      } catch { return null }
    },
    async loadSites(clientId) {
      const { data: sites, error } = await admin.from('sites').select('id, name, status, end_date, handover_date, warranty_months')
        .eq('tenant_id', tenantId).eq('client_id', clientId).neq('status', 'Cancelled')
      if (error) throw error
      // Phases for the status card (and its กำลังทำ text): ONE query for every ongoing / paused site.
      // Issue phases are internal; VO phases are real work and stay.
      const activeIds = (sites ?? []).filter((s) => s.status === 'Ongoing' || s.status === 'On Hold').map((s) => s.id as string)
      const phasesBySite = new Map<string, SitePhase[]>()
      if (activeIds.length > 0) {
        const { data: phases, error: pErr } = await admin.from('site_phases').select('site_id, name, start_date, end_date, status, sort_order')
          .eq('tenant_id', tenantId).in('site_id', activeIds).eq('is_issue_phase', false)
          .order('site_id').order('sort_order')
        if (pErr) throw pErr
        for (const p of phases ?? []) {
          const list = phasesBySite.get(p.site_id as string) ?? []
          list.push({
            name: (p.name as string) ?? '',
            start_date: (p.start_date as string | null) ?? null,
            end_date: (p.end_date as string | null) ?? null,
            status: (p.status as string) ?? 'not_started',
          })
          phasesBySite.set(p.site_id as string, list)
        }
      }
      const out: SiteStatus[] = []
      for (const s of sites ?? []) {
        const { data: pct } = await admin.rpc('site_progress_pct', { p_site_id: s.id })
        const prow = Array.isArray(pct) ? pct[0] : pct
        const cp = prow?.contract_pct
        out.push({
          name: s.name as string,
          status: s.status as SiteStatus['status'],
          pct: cp === null || cp === undefined ? null : Number(cp),
          phases: phasesBySite.get(s.id as string) ?? [],
          endDate: (s.end_date as string | null) ?? null,
          handoverDate: (s.handover_date as string | null) ?? null,
          warrantyMonths: Number(s.warranty_months ?? 0),
        })
      }
      return out
    },
    async loadPhotos(clientId, limit) {
      const { data: active } = await admin.from('sites').select('id')
        .eq('tenant_id', tenantId).eq('client_id', clientId).in('status', ['Ongoing', 'On Hold'])
      if (!active || active.length !== 1) return []
      const siteId = active[0].id as string
      const { data: a } = await admin.from('line_site_photos').select('photo_path, created_at')
        .eq('tenant_id', tenantId).eq('site_id', siteId).eq('customer_visible', true)
        .order('created_at', { ascending: false }).limit(limit)
      const { data: b } = await admin.from('site_attachments').select('file_path, file_name, uploaded_at')
        .eq('tenant_id', tenantId).eq('site_id', siteId).eq('customer_visible', true)
        .order('uploaded_at', { ascending: false }).limit(10)
      const cands = [
        ...(a ?? []).map((r) => ({ bucket: 'line-site-photos', path: r.photo_path as string, at: r.created_at as string })),
        ...(b ?? []).filter((r) => /\.(jpe?g|png)$/i.test(r.file_name as string))
          .map((r) => ({ bucket: 'site-attachments', path: r.file_path as string, at: r.uploaded_at as string })),
      ].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, limit)
      const urls: { url: string }[] = []
      for (const c of cands) {
        const { data } = await admin.storage.from(c.bucket).createSignedUrl(c.path, SIGNED_URL_SECONDS)
        if (data?.signedUrl) urls.push({ url: data.signedUrl })
      }
      return urls
    },
    async getContact() {
      const { data: ch } = await admin.from('customer_line_channels').select('contact_phone, contact_hours, display_name')
        .eq('tenant_id', tenantId).maybeSingle()
      // Soft: the brand name is cosmetic, so a tenants error falls back to '' instead of failing the reply.
      const { data: t } = await admin.from('tenants').select('company_name, phone').eq('id', tenantId).maybeSingle()
      return {
        companyName: (t?.company_name as string) ?? '',
        phone: (ch?.contact_phone as string | null) || (t?.phone as string | null) || null,
        hours: (ch?.contact_hours as string | null) || null,
        brandName: (ch?.display_name as string | null) || (t?.company_name as string) || '',
      }
    },
    async openRequest(kind, lineUserId, clientId, displayName) {
      const { error } = await admin.from('customer_line_requests').insert({
        tenant_id: tenantId, line_user_id: lineUserId, client_id: clientId, kind, display_name: displayName,
      })
      // 23505 = an open request of this kind already exists (partial unique index): success.
      if (error && error.code !== '23505') throw error
    },
    async claimWelcome(lineUserId) {
      const { data, error } = await admin.rpc('claim_customer_welcome', { p_tenant: tenantId, p_line_user_id: lineUserId })
      if (error) { console.error('customer-line welcome claim failed', error.code); return false }
      return data === true
    },
    async getRepairSession(lineUserId) {
      const sel = (cols: string) => admin.from('customer_line_repair_sessions').select(cols)
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      const first = await sel('ticket_id, expires_at, mode, started_at')
      // 42703 = -13 not applied yet: read the old columns; every session is then a new report.
      const { data, error } = first.error && missingColumn(first.error) ? await sel('ticket_id, expires_at') : first
      if (error) {
        // 42P01 = table missing (webhook deployed before -11): behave as "no repair session".
        if (missingTable(error)) return null
        throw error
      }
      if (!data) return null
      // deno-lint-ignore no-explicit-any
      const row = data as any
      const { data: t, error: tErr } = await admin.from('repair_tickets').select('site_id, ticket_number')
        .eq('tenant_id', tenantId).eq('id', row.ticket_id).maybeSingle()
      if (tErr) throw tErr
      if (!t) return null
      return {
        ticketId: row.ticket_id as string,
        siteName: await siteNameOf(t.site_id as string),
        expiresAt: row.expires_at as string,
        mode: row.mode === 'add' ? 'add' : 'new',
        startedAt: (row.started_at as string | undefined) ?? undefined,
        ticketNumber: (t.ticket_number as string) ?? '',
      }
    },
    async listClientSites(clientId) {
      const { data, error } = await admin.from('sites').select('id, name')
        .eq('tenant_id', tenantId).eq('client_id', clientId).neq('status', 'Cancelled')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map((s) => ({ id: s.id as string, name: (s.name as string) ?? '' }))
    },
    async startRepair(clientId, siteId, lineUserId, displayName) {
      // The site must belong to this client in this tenant.
      const { data: site, error: sErr } = await admin.from('sites').select('id, name')
        .eq('tenant_id', tenantId).eq('id', siteId).eq('client_id', clientId).maybeSingle()
      if (sErr) throw sErr
      if (!site) throw new Error('repair site not found')
      // ticket_number is set by the BEFORE INSERT trigger.
      const { data: ticket, error: tErr } = await admin.from('repair_tickets').insert({
        tenant_id: tenantId, site_id: siteId, client_id: clientId, source: 'line', line_user_id: lineUserId,
        status: 'pending_review', created_by: displayName ? `LINE: ${displayName}` : 'LINE',
      }).select('id').single()
      if (tErr) throw tErr
      // Session mode defaults to 'new'. A concurrent start loses with 23505: drop our ticket, use theirs.
      let cur: { ticketId: string } | null
      try {
        cur = await claimSession(lineUserId, { ticket_id: ticket.id })
      } catch (e) {
        await admin.from('repair_tickets').delete().eq('tenant_id', tenantId).eq('id', ticket.id)
        throw e
      }
      if (!cur) return { ticketId: ticket.id as string, siteName: (site.name as string) ?? '', mode: 'new' }
      await admin.from('repair_tickets').delete().eq('tenant_id', tenantId).eq('id', ticket.id)
      // The winning session may be an add session: hand back its mode so the reply matches it.
      const won = await deps.getRepairSession(lineUserId)
      if (won) return { ticketId: won.ticketId, siteName: won.siteName, mode: won.mode ?? 'new', ticketNumber: won.ticketNumber }
      const { data: curT } = await admin.from('repair_tickets').select('site_id')
        .eq('tenant_id', tenantId).eq('id', cur.ticketId).maybeSingle()
      return { ticketId: cur.ticketId, siteName: await siteNameOf(curT?.site_id as string | undefined), mode: 'new' }
    },
    async listOpenTickets(clientId, siteId) {
      const { data, error } = await admin.from('repair_tickets').select('ticket_number, status, scheduled_date, scheduled_start')
        .eq('tenant_id', tenantId).eq('client_id', clientId).eq('site_id', siteId).in('status', OPEN_REPAIR_STATUSES)
        .order('created_at', { ascending: false }).limit(MAX_CHOOSER_TICKETS)
      if (error) {
        if (missingTable(error)) return []
        throw error
      }
      const siteName = await siteNameOf(siteId)
      return (data ?? []).map((r): RepairTicket => ({
        ticket_number: r.ticket_number as string,
        site_name: siteName,
        status: r.status as string,
        scheduled_date: (r.scheduled_date as string | null) ?? null,
        scheduled_start: (r.scheduled_start as string | null) ?? null,
      }))
    },
    async startAddSession(clientId, ticketNumber, lineUserId) {
      // Only this client's own OPEN ticket in this tenant.
      const { data: t, error } = await admin.from('repair_tickets').select('id, ticket_number, site_id, description, customer_update_at')
        .eq('tenant_id', tenantId).eq('client_id', clientId).eq('ticket_number', ticketNumber)
        .in('status', OPEN_REPAIR_STATUSES).maybeSingle()
      if (error) {
        if (missingTable(error)) return null
        throw error
      }
      if (!t) return null
      // started_at keeps its DB default now(); media rows carry the customer's send time (storeRepairMedia),
      // which the finish counts and the cancel compare against it. description_before / update_before are what
      // ยกเลิก puts back.
      const cur = await claimSession(lineUserId, {
        ticket_id: t.id, mode: 'add',
        description_before: (t.description as string | null) ?? null,
        update_before: (t.customer_update_at as string | null) ?? null,
      })
      if (!cur) return { mode: 'add', ticketNumber: t.ticket_number as string, siteName: await siteNameOf(t.site_id as string) }
      // An active session won the race: answer with that one.
      const s = await deps.getRepairSession(lineUserId)
      if (!s) return null
      return { mode: s.mode ?? 'new', ticketNumber: s.ticketNumber ?? '', siteName: s.siteName }
    },
    async markCustomerUpdate(ticketId) {
      const { error } = await admin.from('repair_tickets').update({ customer_update_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('id', ticketId)
      if (error) throw error
    },
    async appendRepairText(ticketId, newText) {
      // Compare-and-set on updated_at (bumped by trigger on every UPDATE) so two webhook calls cannot drop a line.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error } = await admin.from('repair_tickets').select('description, updated_at')
          .eq('tenant_id', tenantId).eq('id', ticketId).maybeSingle()
        if (error) throw error
        if (!data) return
        const old = (data.description as string | null) ?? ''
        const next = old ? `${old}\n${newText}` : newText
        const { data: upd, error: uErr } = await admin.from('repair_tickets').update({ description: next })
          .eq('tenant_id', tenantId).eq('id', ticketId).eq('updated_at', data.updated_at).select('id')
        if (uErr) throw uErr
        if ((upd ?? []).length > 0) return
      }
      throw new Error('repair description busy')
    },
    async storeRepairMedia(ticketId, messageId, mediaType, fileName, sentAt) {
      // Redelivery: the path is {tenant}/{ticket}/{messageId}.{ext}; a row already there means done.
      const safeId = String(messageId).replace(/[^A-Za-z0-9]/g, '')
      if (!safeId) return 'error'
      const prefix = `${tenantId}/${ticketId}/${safeId}.`
      const hasRow = async (path?: string) => {
        let q = admin.from('repair_ticket_media').select('id').eq('tenant_id', tenantId).eq('ticket_id', ticketId)
        q = path ? q.eq('storage_path', path) : q.like('storage_path', `${prefix}%`)
        const { data, error } = await q.limit(1)
        if (error) throw error
        return (data ?? []).length > 0
      }
      if (await hasRow()) return 'ok'
      let res: Response
      // 202 = video still being prepared: wait and retry (contentRetryDelay); anything else but 200 fails.
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
            headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
          })
        } catch { return 'error' }
        if (res.status === 200) break
        await res.body?.cancel().catch(() => {})
        const wait = contentRetryDelay(attempt, res.status)
        if (wait === null) {
          if (res.status === 202) console.error('customer-line repair video still preparing, gave up', safeId)
          return 'error'
        }
        await new Promise((r) => setTimeout(r, wait))
      }
      const len = Number(res.headers.get('content-length'))
      if (Number.isFinite(len) && len > 0 && mediaTooBig(len)) { await res.body?.cancel().catch(() => {}); return 'too_big' }
      let bytes: Uint8Array | null
      try { bytes = await readCapped(res) } catch { return 'error' }
      if (bytes === null) return 'too_big'
      const rawMime = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream'
      const mime = repairUploadMime(rawMime)
      const ext = repairMediaExt(rawMime, mediaType === 'file' ? fileName : null)
      const path = repairMediaPath(tenantId, ticketId, messageId, ext)
      const { error: upErr } = await admin.storage.from(REPAIR_BUCKET).upload(path, bytes, { contentType: mime, upsert: false })
      let uploadedNow = true
      if (upErr) {
        // deno-lint-ignore no-explicit-any
        const e = upErr as any
        const exists = String(e.statusCode ?? e.status ?? '') === '409' || /exist|duplicate/i.test(String(e.message ?? ''))
        if (!exists) { console.error('customer-line repair upload failed', upErr.message); return 'error' }
        // Object from an earlier attempt: only add the row if that attempt never did.
        if (await hasRow(path)) return 'ok'
        uploadedNow = false
      }
      // created_at = when the customer sent it (LINE event.timestamp, never in the future), so a slow
      // download cannot drift into a later add session's window; unknown -> the DB default now().
      const sent = sentAt !== undefined && Number.isFinite(sentAt) && sentAt > 0 ? new Date(Math.min(sentAt, Date.now())).toISOString() : null
      const { error: insErr } = await admin.from('repair_ticket_media').insert({
        tenant_id: tenantId, ticket_id: ticketId, role: 'customer', media_type: mediaType, storage_path: path,
        file_name: fileName ?? null, mime, size_bytes: bytes.byteLength, ...(sent ? { created_at: sent } : {}),
      })
      // 23505 = a concurrent delivery of the same message already recorded this path: its row owns the file.
      if (insErr?.code === '23505') return 'ok'
      if (insErr) {
        if (uploadedNow) await admin.storage.from(REPAIR_BUCKET).remove([path])
        console.error('customer-line repair media row failed', insErr.code)
        return 'error'
      }
      return 'ok'
    },
    async finishRepair(lineUserId) {
      const sel = (cols: string) => admin.from('customer_line_repair_sessions').select(cols)
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      const first = await sel('ticket_id, mode, started_at, description_before')
      const { data: sessRow, error } = first.error && missingColumn(first.error) ? await sel('ticket_id') : first
      if (error) throw error
      if (!sessRow) return null
      // deno-lint-ignore no-explicit-any
      const sess = sessRow as any
      const add = sess.mode === 'add'
      const { error: dErr } = await admin.from('customer_line_repair_sessions').delete()
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId)
      if (dErr) throw dErr
      const { data: t, error: tErr } = await admin.from('repair_tickets').select('ticket_number, description, site_id')
        .eq('tenant_id', tenantId).eq('id', sess.ticket_id).maybeSingle()
      if (tErr) throw tErr
      if (!t) return null
      const { data: site } = await admin.from('sites').select('name').eq('tenant_id', tenantId).eq('id', t.site_id).maybeSingle()
      // Add session: only this session's customer media, and text only if the description changed.
      let mq = admin.from('repair_ticket_media').select('media_type').eq('tenant_id', tenantId).eq('ticket_id', sess.ticket_id)
      if (add) mq = mq.eq('role', 'customer').gte('created_at', sess.started_at)
      const { data: media, error: mErr } = await mq
      if (mErr) throw mErr
      const hasText = add
        ? String(t.description ?? '') !== String(sess.description_before ?? '')
        : String(t.description ?? '').trim() !== ''
      const counts: MediaCounts = { text: hasText ? 1 : 0, image: 0, video: 0, file: 0 }
      for (const m of media ?? []) {
        const k = m.media_type as 'image' | 'video' | 'file'
        if (k in counts) counts[k] = (counts[k] ?? 0) + 1
      }
      return { ticketNumber: t.ticket_number as string, siteName: (site?.name as string) ?? '', counts, mode: add ? 'add' : 'new' }
    },
    async cancelRepair(lineUserId) {
      const sel = (cols: string) => admin.from('customer_line_repair_sessions').select(cols)
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      const first = await sel('ticket_id, mode, started_at, description_before, update_before')
      const { data: sessRow, error } = first.error && missingColumn(first.error) ? await sel('ticket_id') : first
      if (error) throw error
      if (!sessRow) return 'cancelled'
      // deno-lint-ignore no-explicit-any
      const sess = sessRow as any
      const ticketId = sess.ticket_id as string
      if (sess.mode === 'add') {
        // Undo only this session: its customer media (sent at/after started_at; rows, then objects, best effort),
        // customer_update_at and the description.
        // The ticket itself is never deleted.
        const { data: gone, error: dmErr } = await admin.from('repair_ticket_media').delete()
          .eq('tenant_id', tenantId).eq('ticket_id', ticketId).eq('role', 'customer').gte('created_at', sess.started_at)
          .select('storage_path')
        if (dmErr) throw dmErr
        const paths = (gone ?? []).map((m) => m.storage_path as string).filter((p) => p.startsWith(`${tenantId}/${ticketId}/`))
        if (paths.length > 0) {
          const { error: rmErr } = await admin.storage.from(REPAIR_BUCKET).remove(paths)
          if (rmErr) console.error('customer-line repair media remove failed', rmErr.message)
        }
        // The badge goes back to where it was before this session.
        const { error: cuErr } = await admin.from('repair_tickets').update({ customer_update_at: (sess.update_before as string | null) ?? null })
          .eq('tenant_id', tenantId).eq('id', ticketId)
        if (cuErr) throw cuErr
        // Description: put back the text from before this session, but only while the current text still starts
        // with it (otherwise staff changed it: leave it alone). Compare-and-set on updated_at, one retry.
        const before = (sess.description_before as string | null) ?? ''
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data: cur, error: rErr } = await admin.from('repair_tickets').select('description, updated_at')
            .eq('tenant_id', tenantId).eq('id', ticketId).maybeSingle()
          if (rErr) throw rErr
          const now = (cur?.description as string | null) ?? ''
          if (!cur || now === before || !now.startsWith(before)) break
          const { data: upd, error: uErr } = await admin.from('repair_tickets').update({ description: before || null })
            .eq('tenant_id', tenantId).eq('id', ticketId).eq('updated_at', cur.updated_at).select('id')
          if (uErr) throw uErr
          if ((upd ?? []).length > 0) break
          if (attempt === 1) console.error('customer-line repair add cancel: description busy, left as is')
        }
        const { error: sErr } = await admin.from('customer_line_repair_sessions').delete()
          .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).eq('ticket_id', ticketId)
        if (sErr) throw sErr
        return 'reverted'
      }
      // Media rows cascade with the ticket, so read their paths first.
      const { data: media, error: mErr } = await admin.from('repair_ticket_media').select('storage_path')
        .eq('tenant_id', tenantId).eq('ticket_id', ticketId)
      if (mErr) throw mErr
      // Guarded delete first: only the customer's own LINE report that staff have not picked up yet.
      const { data: deleted, error: delErr } = await admin.from('repair_tickets').delete()
        .eq('tenant_id', tenantId).eq('id', ticketId).eq('source', 'line').eq('line_user_id', lineUserId)
        .eq('status', 'pending_review').select('id')
      if (delErr) throw delErr
      if ((deleted ?? []).length === 0) return 'kept'
      // Storage after the rows; best effort. Row paths plus anything else in the ticket folder.
      const folder = `${tenantId}/${ticketId}`
      const paths = new Set((media ?? []).map((m) => m.storage_path as string).filter((p) => p.startsWith(`${folder}/`)))
      const { data: listed } = await admin.storage.from(REPAIR_BUCKET).list(folder, { limit: 1000 })
      for (const o of listed ?? []) if (o.name) paths.add(`${folder}/${o.name}`)
      if (paths.size > 0) {
        const { error: rmErr } = await admin.storage.from(REPAIR_BUCKET).remove([...paths])
        if (rmErr) console.error('customer-line repair media remove failed', rmErr.message)
      }
      // The session cascaded with the ticket; delete explicitly in case it pointed elsewhere.
      const { error: sErr } = await admin.from('customer_line_repair_sessions').delete()
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).eq('ticket_id', ticketId)
      if (sErr) throw sErr
      return 'cancelled'
    },
    async listRepairTickets(clientId) {
      const cols = 'ticket_number, site_id, status, description, fix_note, scheduled_date, scheduled_start, duration_hours, created_at, done_at'
      // All open tickets (no limit) + done tickets of the last 30 days; the Flex caps at 10.
      const { data: open, error } = await admin.from('repair_tickets').select(cols)
        .eq('tenant_id', tenantId).eq('client_id', clientId).not('status', 'in', '(declined,done)')
        .order('created_at', { ascending: false })
      if (error) {
        if (missingTable(error)) return []
        throw error
      }
      const { data: done, error: dErr } = await admin.from('repair_tickets').select(cols)
        .eq('tenant_id', tenantId).eq('client_id', clientId).eq('status', 'done')
        .gte('done_at', new Date(Date.now() - DONE_WINDOW_MS).toISOString())
        .order('done_at', { ascending: false })
      if (dErr) throw dErr
      const data = [...(open ?? []), ...(done ?? [])]
      const rows = data ?? []
      const siteIds = [...new Set(rows.map((r) => r.site_id as string))]
      const sites = new Map<string, { name: string; handover_date: string | null; warranty_months: number | null }>()
      if (siteIds.length > 0) {
        const { data: s, error: sErr } = await admin.from('sites').select('id, name, handover_date, warranty_months')
          .eq('tenant_id', tenantId).in('id', siteIds)
        if (sErr) throw sErr
        for (const x of s ?? []) {
          sites.set(x.id as string, {
            name: (x.name as string) ?? '',
            handover_date: (x.handover_date as string | null) ?? null,
            warranty_months: (x.warranty_months as number | null) ?? null,
          })
        }
      }
      return rows.map((r): RepairTicket => {
        const site = sites.get(r.site_id as string)
        return {
          ticket_number: r.ticket_number as string,
          site_name: site?.name ?? '',
          status: r.status as string,
          description: r.description as string | null,
          fix_note: r.fix_note as string | null,
          scheduled_date: r.scheduled_date as string | null,
          scheduled_start: r.scheduled_start as string | null,
          duration_hours: r.duration_hours == null ? null : Number(r.duration_hours),
          created_at: r.created_at as string | null,
          done_at: r.done_at as string | null,
          handover_date: site?.handover_date ?? null,
          warranty_months: site?.warranty_months ?? null,
        }
      })
    },
    async touchAccount(lineUserId) {
      await admin.from('customer_line_accounts').update({ last_seen_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId)
    },
  }
  return deps
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return text('Method not allowed', 405)
  const key = new URL(req.url).searchParams.get('t')
  if (!key) return text('Not found', 404)

  const { data: credsData, error: credsError } = await admin.rpc('customer_line_creds_by_key', { p_key: key })
  const creds = Array.isArray(credsData) ? credsData[0] : credsData
  if (credsError || !creds) return text('Not found', 404)
  const tenantId = creds.tenant_id as string
  const secret = (creds.channel_secret as string).replace(/\s+/g, '')
  const accessToken = (creds.access_token as string).replace(/\s+/g, '')

  const rawBody = await req.text()
  if (!(await verifySignature(secret, rawBody, req.headers.get('x-line-signature')))) return text('Unauthorized', 401)

  if (!(await tenantHasModuleAccess(admin, tenantId, 'line_bot'))) return text('OK', 200)

  let events: unknown[] = []
  try { events = JSON.parse(rawBody)?.events ?? [] } catch { return text('OK', 200) }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  const deps = buildDeps(tenantId, accessToken)
  // Events in order, one at a time; each is caught on its own.
  const work = async () => {
    for (const event of events as { replyToken?: string }[]) {
      try {
        const msgs = await handleCustomerEvent(event, { tenantId, today }, deps)
        if (msgs.length > 0 && event.replyToken) {
          await replyWithFallback((rt, m) => sendLineReplyMessages(accessToken, rt, m), event.replyToken, msgs)
        }
      } catch (e) {
        console.error('customer-line event failed', (e as Error).message)
      }
    }
  }
  // Ack LINE at once (slow media downloads must not trigger redelivery); the work keeps running.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime) EdgeRuntime.waitUntil(work())
  else await work()
  return text('OK', 200)
})
