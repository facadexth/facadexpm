// site-jobsheet -- public, unauthenticated endpoint behind /j/<token> in the frontend (the crew's
// daily job sheet page, ใบงานประจำวัน, CRM G). Deploy with --no-verify-jwt. Same pattern as
// repair-workorder: the page never touches the database with the anon key; every read/write goes
// through here with the service role, and the token (line_deep_link_tokens, action_type
// 'site_jobsheet', issued by LINE "งานวันนี้") is validated by _shared/site-jobsheet-logic.ts.
//
// All rules live in _shared/site-jobsheet-logic.ts (unit-tested by vitest). This file only wires the
// real Supabase calls into its SiteJobsheetDeps. Every query is filtered by the token's tenant_id (the
// service role has no current_tenant_id(), so tenant_id is also set on every insert).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { loadJobSheetInput } from '../_shared/site-jobsheet-load.ts'
import { buildJobSheet } from '../_shared/site-jobsheet.ts'
import {
  handleSiteJobsheet, SIGNED_URL_SECONDS, PHOTO_BUCKET, type SiteJobsheetDeps, type SheetCard,
} from '../_shared/site-jobsheet-logic.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// signUrls for loadJobSheetInput: one createSignedUrls call per bucket, aligned with `paths`.
// A storage failure leaves drawings without a link instead of failing the whole page.
async function signUrls(bucket: string, paths: string[]): Promise<(string | null)[]> {
  const { data, error } = await admin.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_SECONDS)
  if (error) {
    console.error('site-jobsheet: signing failed', bucket)
    return paths.map(() => null)
  }
  const byPath = new Map<string, string>()
  for (const s of data ?? []) if (s?.path && s.signedUrl) byPath.set(s.path, s.signedUrl)
  return paths.map((p) => byPath.get(p) ?? null)
}

// Lists one folder of the photo bucket, files whose name starts with `search` (storage search is a
// prefix match on the name). Folder placeholders (id null) are skipped.
async function listNames(dir: string, search: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(PHOTO_BUCKET).list(dir, { search, limit: 1000 })
  if (error) throw error
  return (data ?? []).filter((o) => o.id !== null).map((o) => o.name)
}

const deps: SiteJobsheetDeps = {
  async loadToken(token) {
    const { data: tok, error } = await admin.from('line_deep_link_tokens')
      .select('id, tenant_id, worker_id, action_type, expires_at, site_id')
      .eq('token', token).maybeSingle()
    if (error) throw error
    if (!tok) return null
    return {
      id: tok.id as string,
      tenantId: tok.tenant_id as string,
      workerId: tok.worker_id as string,
      actionType: tok.action_type as string,
      siteId: (tok.site_id as string | null) ?? null,
      expiresAt: tok.expires_at as string,
    }
  },

  async loadWorker(workerId) {
    const { data: w, error } = await admin.from('workers').select('id, tenant_id, status')
      .eq('id', workerId).maybeSingle()
    if (error) throw error
    if (!w) return null
    return { id: w.id as string, tenantId: w.tenant_id as string, status: (w.status as string | null) ?? '' }
  },

  hasModule: (tenantId) => tenantHasModuleAccess(admin, tenantId, 'line_bot'),

  async loadAssignments(tenantId, workerId, date) {
    const { data, error } = await admin.from('worker_assignments')
      .select('site_id, type, repair_ticket_id, is_team_leader')
      .eq('tenant_id', tenantId).eq('worker_id', workerId).eq('date', date)
    if (error) throw error
    return (data ?? []).map((r) => ({
      siteId: (r.site_id as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      repairTicketId: (r.repair_ticket_id as string | null) ?? null,
      isTeamLeader: r.is_team_leader === true,
    }))
  },

  async loadSheet(tenantId, siteId, date, viewerWorkerId) {
    // The loader reads the site by id; make sure it is the token's tenant before showing anything.
    const { data: st, error: se } = await admin.from('sites').select('id')
      .eq('tenant_id', tenantId).eq('id', siteId).maybeSingle()
    if (se) throw se
    if (!st) throw new Error('site not in tenant')
    const { data: tn, error } = await admin.from('tenants').select('company_name, address, phone, logo_url')
      .eq('id', tenantId).maybeSingle()
    if (error) throw error
    const tenant = {
      company_name: (tn?.company_name as string | undefined) ?? undefined,
      address: (tn?.address as string | undefined) ?? undefined,
      phone: (tn?.phone as string | undefined) ?? undefined,
      logo_url: (tn?.logo_url as string | null | undefined) ?? null,
    }
    const input = await loadJobSheetInput(admin, siteId, { date, tenant, viewerWorkerId, signUrls })
    return buildJobSheet(input)
  },

  async countUploads(dir, filePrefix) {
    return (await listNames(dir, filePrefix)).filter((n) => n.startsWith(filePrefix)).length
  },

  async signUpload(path) {
    const { data, error } = await admin.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw error ?? new Error('sign failed')
    return { signedUrl: data.signedUrl, token: data.token }
  },

  async photoExists(path) {
    const cut = path.lastIndexOf('/')
    const file = path.slice(cut + 1)
    return (await listNames(path.slice(0, cut), file)).includes(file)
  },

  async loadCard(tenantId, siteId, taskId) {
    const { data: t, error } = await admin.from('phase_tasks')
      .select('id, tenant_id, site_id, status, progress_mode, parent_task_id')
      .eq('tenant_id', tenantId).eq('site_id', siteId).eq('id', taskId).maybeSingle()
    if (error) throw error
    if (!t) return null
    const { data: kids, error: ke } = await admin.from('phase_tasks').select('id')
      .eq('tenant_id', tenantId).eq('parent_task_id', taskId).limit(1)
    if (ke) throw ke
    return {
      id: t.id as string,
      tenantId: t.tenant_id as string,
      siteId: t.site_id as string,
      status: t.status as SheetCard['status'],
      progressMode: (t.progress_mode as string | null) ?? null,
      parentTaskId: (t.parent_task_id as string | null) ?? null,
      hasChildren: (kids ?? []).length > 0,
    }
  },

  async updateCardStatus(tenantId, siteId, taskId, status, fromStatus) {
    let q = admin.from('phase_tasks').update({ status })
      .eq('tenant_id', tenantId).eq('site_id', siteId).eq('id', taskId)
    if (fromStatus) q = q.eq('status', fromStatus)
    const { data, error } = await q.select('id')
    if (error) return { errorMessage: error.message ?? '' }
    return { updated: (data ?? []).length }
  },

  async insertPhotos(rows) {
    const { error } = await admin.from('line_site_photos').insert(rows)
    if (error) throw error
  },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'bad_request' }, 405)

  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad_request' }, 400)
    }
    const res = await handleSiteJobsheet(body, deps, Date.now())
    return json(res.body, res.status)
  } catch (e) {
    console.error('site-jobsheet failed', (e as Error)?.name ?? 'Error')
    return json({ error: 'failed' }, 500)
  }
})
