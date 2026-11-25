// repair-workorder -- public, unauthenticated endpoint behind /w/<token> in the frontend (the crew's
// repair work order page, CRM phase 2a). Deploy with --no-verify-jwt. Same pattern as customer-form:
// the page never touches the database with the anon key; every read/write goes through here with the
// service role, and the token (line_deep_link_tokens, action_type 'repair_workorder', issued by LINE
// "งานวันนี้") is validated by _shared/repair-workorder-logic.ts.
//
// All rules live in _shared/repair-workorder-logic.ts (unit-tested by vitest). This file only wires
// the real Supabase/LINE calls into its RepairWorkorderDeps. Every query is filtered by the token's
// tenant_id (the service role has no current_tenant_id(), so tenant_id is also set on every insert).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { pushToCustomer, customerPushDeps } from '../_shared/customer-push.ts'
import { APP_URL } from '../_shared/app-url.ts'
import { loadWorkOrderInput, RECEIPT_BUCKET, RECEIPT_DOCUMENT_TYPE } from '../_shared/repair-workorder-load.ts'
import { buildWorkOrder } from '../_shared/repair-workorder.ts'
import { handleRepairWorkorder, SIGNED_URL_SECONDS, type RepairWorkorderDeps, type CrewReceipt } from '../_shared/repair-workorder-logic.ts'

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

// signUrls for loadWorkOrderInput: one createSignedUrls call per bucket, aligned with `paths`.
// A storage failure leaves photos as placeholders instead of failing the whole page.
async function signUrls(bucket: string, paths: string[]): Promise<(string | null)[]> {
  const { data, error } = await admin.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_SECONDS)
  if (error) {
    console.error('repair-workorder: signing failed', bucket)
    return paths.map(() => null)
  }
  const byPath = new Map<string, string>()
  for (const s of data ?? []) if (s?.path && s.signedUrl) byPath.set(s.path, s.signedUrl)
  return paths.map((p) => byPath.get(p) ?? null)
}

const deps: RepairWorkorderDeps = {
  async loadToken(token) {
    const { data: tok, error } = await admin.from('line_deep_link_tokens')
      .select('id, tenant_id, worker_id, action_type, expires_at, repair_ticket_id')
      .eq('token', token).maybeSingle()
    if (error) throw error
    if (!tok) return null
    return {
      id: tok.id as string,
      tenantId: tok.tenant_id as string,
      workerId: tok.worker_id as string,
      actionType: tok.action_type as string,
      repairTicketId: (tok.repair_ticket_id as string | null) ?? null,
      expiresAt: tok.expires_at as string,
    }
  },

  async loadWorker(workerId) {
    const { data: w, error } = await admin.from('workers').select('id, tenant_id, name, nickname, status')
      .eq('id', workerId).maybeSingle()
    if (error) throw error
    if (!w) return null
    return {
      id: w.id as string,
      tenantId: w.tenant_id as string,
      name: (w.name as string | null) ?? '',
      nickname: (w.nickname as string | null) ?? null,
      status: (w.status as string | null) ?? '',
    }
  },

  hasModule: (tenantId) => tenantHasModuleAccess(admin, tenantId, 'line_bot'),

  async isAssigned(tenantId, workerId, ticketId, date) {
    const { data, error } = await admin.from('worker_assignments').select('id')
      .eq('tenant_id', tenantId).eq('worker_id', workerId).eq('repair_ticket_id', ticketId).eq('date', date).limit(1)
    if (error) throw error
    return (data ?? []).length > 0
  },

  async loadTicket(tenantId, ticketId) {
    const { data: t, error } = await admin.from('repair_tickets').select('id, tenant_id, ticket_number, status, line_user_id, scheduled_date')
      .eq('tenant_id', tenantId).eq('id', ticketId).maybeSingle()
    if (error) throw error
    if (!t) return null
    return {
      id: t.id as string,
      tenantId: t.tenant_id as string,
      ticketNumber: (t.ticket_number as string | null) ?? '',
      status: t.status as string,
      lineUserId: (t.line_user_id as string | null) ?? null,
      scheduledDate: (t.scheduled_date as string | null) ?? null,
    }
  },

  async loadWorkOrder(ticketId, tenantId, today) {
    const { data: tn, error } = await admin.from('tenants').select('company_name, address, phone, logo_url')
      .eq('id', tenantId).maybeSingle()
    if (error) throw error
    const tenant = {
      company_name: (tn?.company_name as string | undefined) ?? undefined,
      address: (tn?.address as string | undefined) ?? undefined,
      phone: (tn?.phone as string | undefined) ?? undefined,
      logo_url: (tn?.logo_url as string | null | undefined) ?? null,
    }
    const input = await loadWorkOrderInput(admin, ticketId, { today, signUrls, tenant })
    return buildWorkOrder(input)
  },

  async latestReceipt(tenantId, ticketId) {
    const { data, error } = await admin.from('document_receipts').select('id, signer_name, signed_at')
      .eq('tenant_id', tenantId).eq('document_type', RECEIPT_DOCUMENT_TYPE).eq('document_id', ticketId)
      .order('signed_at', { ascending: false }).limit(1)
    if (error) throw error
    return ((data ?? [])[0] as CrewReceipt | undefined) ?? null
  },

  async uploadSignature(path, bytes) {
    const { error } = await admin.storage.from(RECEIPT_BUCKET).upload(path, bytes, { contentType: 'image/png' })
    if (error) throw error
  },

  async removeSignature(path) {
    const { error } = await admin.storage.from(RECEIPT_BUCKET).remove([path])
    if (error) throw error
  },

  async insertReceipt(row) {
    const { data, error } = await admin.from('document_receipts').insert(row)
      .select('id, signer_name, signed_at').single()
    if (error) throw error
    return data as CrewReceipt
  },

  async createSignLink(row) {
    const { data, error } = await admin.from('document_receipt_links').insert(row).select('id').single()
    if (error) throw error
    return { id: data.id as string }
  },

  async recentSignLink(tenantId, ticketId, sinceIso, nowIso) {
    const { data, error } = await admin.from('document_receipt_links').select('id')
      .eq('tenant_id', tenantId).eq('document_type', RECEIPT_DOCUMENT_TYPE).eq('document_id', ticketId)
      .is('signed_at', null).gte('created_at', sinceIso).gt('expires_at', nowIso)
      .order('created_at', { ascending: false }).limit(1)
    if (error) throw error
    const row = (data ?? [])[0] as { id: string } | undefined
    return row ? { id: row.id } : null
  },

  pushCustomer: (tenantId, lineUserId, text) =>
    pushToCustomer(customerPushDeps(admin), tenantId, lineUserId, [{ type: 'text', text }]),

  appUrl: APP_URL,
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
    const res = await handleRepairWorkorder(body, deps, Date.now())
    return json(res.body, res.status)
  } catch (e) {
    console.error('repair-workorder failed', (e as Error)?.name ?? 'Error')
    return json({ error: 'failed' }, 500)
  }
})
