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
import type { SiteStatus } from '../_shared/customer-line-replies.ts'
import { mediaTooBig, repairMediaExt, repairMediaPath, repairUploadMime, type RepairTicket, type MediaCounts } from '../_shared/repair.ts'

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

function buildDeps(tenantId: string, accessToken: string): CustomerDeps {
  return {
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
      const out: SiteStatus[] = []
      for (const s of sites ?? []) {
        const { data: pct } = await admin.rpc('site_progress_pct', { p_site_id: s.id })
        const prow = Array.isArray(pct) ? pct[0] : pct
        const { data: phases } = await admin.from('site_phases').select('name')
          .eq('tenant_id', tenantId).eq('site_id', s.id).eq('status', 'in_progress').eq('is_issue_phase', false).order('sort_order')
        const cp = prow?.contract_pct
        out.push({
          name: s.name as string,
          status: s.status as SiteStatus['status'],
          pct: cp === null || cp === undefined ? null : Number(cp),
          phases: (phases ?? []).map((p) => p.name as string),
          endDate: (s.end_date as string | null) ?? null,
          handoverDate: (s.handover_date as string | null) ?? null,
          warrantyMonths: Number(s.warranty_months ?? 0),
        })
      }
      return out
    },
    async loadPhotos(clientId) {
      const { data: active } = await admin.from('sites').select('id')
        .eq('tenant_id', tenantId).eq('client_id', clientId).in('status', ['Ongoing', 'On Hold'])
      if (!active || active.length !== 1) return []
      const siteId = active[0].id as string
      const { data: a } = await admin.from('line_site_photos').select('photo_path, created_at')
        .eq('tenant_id', tenantId).eq('site_id', siteId).eq('customer_visible', true)
        .order('created_at', { ascending: false }).limit(3)
      const { data: b } = await admin.from('site_attachments').select('file_path, file_name, uploaded_at')
        .eq('tenant_id', tenantId).eq('site_id', siteId).eq('customer_visible', true)
        .order('uploaded_at', { ascending: false }).limit(10)
      const cands = [
        ...(a ?? []).map((r) => ({ bucket: 'line-site-photos', path: r.photo_path as string, at: r.created_at as string })),
        ...(b ?? []).filter((r) => /\.(jpe?g|png)$/i.test(r.file_name as string))
          .map((r) => ({ bucket: 'site-attachments', path: r.file_path as string, at: r.uploaded_at as string })),
      ].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 3)
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
      const { data, error } = await admin.from('customer_line_repair_sessions').select('ticket_id, expires_at')
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      if (error) throw error
      if (!data) return null
      const { data: t, error: tErr } = await admin.from('repair_tickets').select('site_id')
        .eq('tenant_id', tenantId).eq('id', data.ticket_id).maybeSingle()
      if (tErr) throw tErr
      if (!t) return null
      const { data: site } = await admin.from('sites').select('name')
        .eq('tenant_id', tenantId).eq('id', t.site_id).maybeSingle()
      return { ticketId: data.ticket_id as string, siteName: (site?.name as string) ?? '', expiresAt: data.expires_at as string }
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
      const nowIso = new Date().toISOString()
      // Only an EXPIRED session is cleared; an active one (double tap) wins below.
      const { error: oldErr } = await admin.from('customer_line_repair_sessions').delete()
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).lte('expires_at', nowIso)
      if (oldErr) throw oldErr
      // ticket_number is set by the BEFORE INSERT trigger.
      const { data: ticket, error: tErr } = await admin.from('repair_tickets').insert({
        tenant_id: tenantId, site_id: siteId, client_id: clientId, source: 'line', line_user_id: lineUserId,
        status: 'pending_review', created_by: displayName ? `LINE: ${displayName}` : 'LINE',
      }).select('id').single()
      if (tErr) throw tErr
      const expiresAt = new Date(Date.now() + REPAIR_SESSION_MS).toISOString()
      // Plain INSERT (PK tenant_id + line_user_id): a concurrent start loses with 23505.
      const { error: sessErr } = await admin.from('customer_line_repair_sessions').insert(
        { tenant_id: tenantId, line_user_id: lineUserId, ticket_id: ticket.id, expires_at: expiresAt },
      )
      if (!sessErr) return { ticketId: ticket.id as string, siteName: (site.name as string) ?? '' }
      await admin.from('repair_tickets').delete().eq('tenant_id', tenantId).eq('id', ticket.id)
      if (sessErr.code !== '23505') throw sessErr
      const { data: cur, error: curErr } = await admin.from('customer_line_repair_sessions').select('ticket_id')
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      if (curErr) throw curErr
      if (!cur) throw sessErr
      const { data: curT } = await admin.from('repair_tickets').select('site_id')
        .eq('tenant_id', tenantId).eq('id', cur.ticket_id).maybeSingle()
      const { data: curSite } = curT
        ? await admin.from('sites').select('name').eq('tenant_id', tenantId).eq('id', curT.site_id).maybeSingle()
        : { data: null }
      return { ticketId: cur.ticket_id as string, siteName: (curSite?.name as string) ?? '' }
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
    async storeRepairMedia(ticketId, messageId, mediaType, fileName) {
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
      try {
        res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
          headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
        })
      } catch { return 'error' }
      // 202 = video still being prepared; anything but 200 is a failure.
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return 'error' }
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
      const { error: insErr } = await admin.from('repair_ticket_media').insert({
        tenant_id: tenantId, ticket_id: ticketId, role: 'customer', media_type: mediaType, storage_path: path,
        file_name: fileName ?? null, mime, size_bytes: bytes.byteLength,
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
      const { data: sess, error } = await admin.from('customer_line_repair_sessions').select('ticket_id')
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      if (error) throw error
      if (!sess) return null
      const { error: dErr } = await admin.from('customer_line_repair_sessions').delete()
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId)
      if (dErr) throw dErr
      const { data: t, error: tErr } = await admin.from('repair_tickets').select('ticket_number, description, site_id')
        .eq('tenant_id', tenantId).eq('id', sess.ticket_id).maybeSingle()
      if (tErr) throw tErr
      if (!t) return null
      const { data: site } = await admin.from('sites').select('name').eq('tenant_id', tenantId).eq('id', t.site_id).maybeSingle()
      const { data: media, error: mErr } = await admin.from('repair_ticket_media').select('media_type')
        .eq('tenant_id', tenantId).eq('ticket_id', sess.ticket_id)
      if (mErr) throw mErr
      const counts: MediaCounts = { text: String(t.description ?? '').trim() ? 1 : 0, image: 0, video: 0, file: 0 }
      for (const m of media ?? []) {
        const k = m.media_type as 'image' | 'video' | 'file'
        if (k in counts) counts[k] = (counts[k] ?? 0) + 1
      }
      return { ticketNumber: t.ticket_number as string, siteName: (site?.name as string) ?? '', counts }
    },
    async cancelRepair(lineUserId) {
      const { data: sess, error } = await admin.from('customer_line_repair_sessions').select('ticket_id')
        .eq('tenant_id', tenantId).eq('line_user_id', lineUserId).maybeSingle()
      if (error) throw error
      if (!sess) return 'cancelled'
      const ticketId = sess.ticket_id as string
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
      if (error) throw error
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
