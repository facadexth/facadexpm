// customer-form -- public, unauthenticated endpoint behind /r/<token> in the frontend (the LINE
// repair form, CRM phase 1). Same pattern as field-form: the public page never touches the database
// with the anon key; every read/write goes through here with the service role, so
// customer_link_tokens and submit_repair_form() keep no anon/authenticated grants.
//
// All rules live in _shared/customer-form-logic.ts (unit-tested by vitest). This file only wires
// the real Supabase/LINE calls into its CustomerFormDeps.
//
// Files go to the private repair-media bucket under <tenant_id>/form-<token_id>/ -- the first
// segment must be the tenant id for the staff storage policy, and submit_repair_form() refuses any
// path outside that folder.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { pushToCustomer, customerPushDeps } from '../_shared/customer-push.ts'
import { repairFormDoneText } from '../_shared/repair.ts'
import { handleCustomerForm, type CustomerFormDeps, type SubmitRpcResult } from '../_shared/customer-form-logic.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const BUCKET = 'repair-media'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const deps: CustomerFormDeps = {
  async loadToken(token) {
    const { data: tok, error } = await admin.from('customer_link_tokens')
      .select('id, tenant_id, client_id, line_user_id, purpose, expires_at, used_at, ref_id')
      .eq('token', token).maybeSingle()
    if (error) throw error
    if (!tok) return null
    let refTicketNumber: string | null = null
    if (tok.used_at && tok.ref_id) {
      const { data: t } = await admin.from('repair_tickets').select('ticket_number')
        .eq('tenant_id', tok.tenant_id).eq('id', tok.ref_id).maybeSingle()
      refTicketNumber = (t?.ticket_number as string | undefined) ?? null
    }
    return {
      id: tok.id as string,
      tenantId: tok.tenant_id as string,
      clientId: tok.client_id as string,
      lineUserId: tok.line_user_id as string,
      purpose: tok.purpose as string,
      expiresAt: tok.expires_at as string,
      usedAt: (tok.used_at as string | null) ?? null,
      refTicketNumber,
    }
  },

  hasModule: (tenantId) => tenantHasModuleAccess(admin, tenantId, 'line_bot'),

  // Same query as customer-line-webhook's listClientSites.
  async listSites(tenantId, clientId) {
    const { data, error } = await admin.from('sites').select('id, name')
      .eq('tenant_id', tenantId).eq('client_id', clientId).neq('status', 'Cancelled')
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map((s) => ({ id: s.id as string, name: (s.name as string) ?? '' }))
  },

  // brandName: same lookup as customer-line-webhook's getContact. Cosmetic, so errors fall back to ''.
  async brand(tenantId, clientId) {
    const [{ data: ch }, { data: t }, { data: c }] = await Promise.all([
      admin.from('customer_line_channels').select('display_name').eq('tenant_id', tenantId).maybeSingle(),
      admin.from('tenants').select('company_name').eq('id', tenantId).maybeSingle(),
      admin.from('clients').select('name').eq('tenant_id', tenantId).eq('id', clientId).maybeSingle(),
    ])
    return {
      clientName: (c?.name as string | undefined) ?? '',
      brandName: (ch?.display_name as string | null) || (t?.company_name as string | undefined) || '',
    }
  },

  // Objects already stored in this token's folder. limit well above MAX_UPLOADS_PER_TOKEN
  // (storage.list defaults to 100).
  async countUploads(tenantId, tokenId) {
    const { data, error } = await admin.storage.from(BUCKET).list(`${tenantId}/form-${tokenId}`, { limit: 1000 })
    if (error) throw error
    return (data ?? []).filter((o) => o.id !== null).length
  },

  async signUpload(path) {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw error ?? new Error('sign failed')
    return { signedUrl: data.signedUrl, token: data.token }
  },

  async objectSize(path) {
    const cut = path.lastIndexOf('/')
    const dir = path.slice(0, cut)
    const file = path.slice(cut + 1)
    const { data, error } = await admin.storage.from(BUCKET).list(dir, { search: file, limit: 100 })
    if (error) throw error
    const obj = (data ?? []).find((o) => o.name === file)
    const size = (obj?.metadata as { size?: unknown } | null | undefined)?.size
    return typeof size === 'number' ? size : null
  },

  async submitRpc(token, payload) {
    const { data, error } = await admin.rpc('submit_repair_form', { p_token: token, p_payload: payload })
    if (error) throw error
    return (data ?? null) as SubmitRpcResult | null
  },

  pushReceived: (tenantId, lineUserId, ticketNumber) =>
    pushToCustomer(customerPushDeps(admin), tenantId, lineUserId, [{ type: 'text', text: repairFormDoneText(ticketNumber) }]),
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: 'bad_request' }, 400)
    }
    const res = await handleCustomerForm(body, deps, Date.now())
    return json(res.body, res.status)
  } catch (e) {
    console.error('customer-form failed', (e as Error)?.name ?? 'Error')
    return json({ errors: ['ส่งไม่สำเร็จ กรุณาลองใหม่'] }, 500)
  }
})
