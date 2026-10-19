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

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// Local HMAC check (not _shared/line.ts, which reads the crew bot's env vars at import).
async function verifySignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return timingSafeEqual(btoa(String.fromCharCode(...new Uint8Array(sig))), header)
}

const SIGNED_URL_SECONDS = 604800
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
  return text('OK', 200)
})
