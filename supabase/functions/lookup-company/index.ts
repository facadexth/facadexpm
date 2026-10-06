// supabase/functions/lookup-company/index.ts
// ============================================================
// lookup-company -- AI-assisted company lookup (name -> up to 3 candidates with
// registered name, address and 13-digit juristic ID) using Anthropic's server-side
// web search restricted to ALLOWED_DOMAINS (_shared/company-lookup.ts).
//
// Auth: caller's own JWT (deployed WITH JWT verification), gated like
// extract-po-document via is_admin_or_owner() over RPC (a plain SELECT would be
// filtered silently by RLS), plus tenant_can_write(). The Suppliers/Clients
// forms are not behind a module key, so there is no has_module_access check.
//
// Cost control: every call spends real ANTHROPIC_API_KEY money. The budget is
// RESERVED before the model call (consume_company_lookup: per-tenant daily cap
// by plan + a global daily ceiling, atomic) and refunded only when the call
// failed before any successful API response.
// All trust decisions live in the pure, tested _shared/company-lookup.ts.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  budgetDay, budgetOutcome, buildLookupRequest, candidatesFromContent, cleanCompanyName,
  INCOMPLETE_MESSAGE, lookupOutcome, MAX_CONTINUATIONS, shouldRefund,
} from '../_shared/company-lookup.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// deno-lint-ignore no-explicit-any
type Block = any
type SearchResult =
  | { ok: true; content: Block[]; stopReason: string | null; continuations: number; inputTokens: number; outputTokens: number; searchRequests: number }
  | { ok: false; status: number; code: string; refundable: boolean }

// Runs the request, continuing a paused server-side loop (MAX_CONTINUATIONS times).
async function runSearch(name: string, deadline: number): Promise<SearchResult> {
  const base = buildLookupRequest(name)
  const messages: Array<{ role: string; content: unknown }> = [...base.messages]
  const content: Block[] = []
  let inputTokens = 0, outputTokens = 0, searchRequests = 0
  let gotResponse = false
  let stopReason: string | null = null
  let continuations = 0
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    let res: Response
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        body: JSON.stringify({ ...base, messages }),
      })
    } catch (e) {
      console.error('lookup-company fetch failed:', String(e).slice(0, 200))
      // a timeout/abort may still have been processed and billed: only other failures refund
      return { ok: false, status: 502, code: 'ai_unavailable', refundable: shouldRefund({ kind: 'fetch', errorName: (e as Error)?.name }, gotResponse) }
    }
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 400)
      console.error('lookup-company API error', res.status, t)
      const refundable = shouldRefund({ kind: 'http', status: res.status }, gotResponse)
      if (res.status === 400 && /web search/i.test(t) && /not enabled/i.test(t)) return { ok: false, status: 503, code: 'search_disabled', refundable }
      return { ok: false, status: 502, code: 'ai_unavailable', refundable }
    }
    // deno-lint-ignore no-explicit-any
    let j: any
    try { j = await res.json() } catch { return { ok: false, status: 502, code: 'ai_unavailable', refundable: shouldRefund({ kind: 'unparseable_200' }, gotResponse) } }
    gotResponse = true
    const blocks: Block[] = Array.isArray(j?.content) ? j.content : []
    content.push(...blocks)
    inputTokens += j?.usage?.input_tokens ?? 0
    outputTokens += j?.usage?.output_tokens ?? 0
    searchRequests += j?.usage?.server_tool_use?.web_search_requests ?? 0
    stopReason = j?.stop_reason ?? null
    if (stopReason !== 'pause_turn') break
    if (i < MAX_CONTINUATIONS) {
      continuations++
      messages.push({ role: 'assistant', content: blocks })
    }
  }
  return { ok: true, content, stopReason, continuations, inputTokens, outputTokens, searchRequests }
}

async function refund(admin: ReturnType<typeof createClient>, r: { tenant: string; day: string | null }) {
  try {
    const { error } = await admin.rpc('refund_company_lookup', { p_tenant: r.tenant, p_day: r.day ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10) })
    console.log(JSON.stringify({ evt: 'company_lookup_refund', ok: !error, code: error ? ((error as { code?: string }).code ?? 'unknown') : null }))
  } catch (e) {
    console.error('company_lookup_refund threw', String(e).slice(0, 200))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let reservedFor: { tenant: string; day: string | null } | null = null
  let callStarted = false
  let admin: ReturnType<typeof createClient> | null = null
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'ไม่ได้เข้าสู่ระบบ', code: 'unauthorized' }, 401)

    let body: { name?: unknown }
    try { body = await req.json() } catch { return json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง', code: 'bad_request' }, 400) }
    const name = cleanCompanyName(body?.name)
    if (!name) return json({ error: 'ใส่ชื่อบริษัท 2-120 ตัวอักษร', code: 'bad_name' }, 400)

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const FORBIDDEN = { error: 'เฉพาะผู้ดูแลระบบหรือเจ้าของเท่านั้นที่ใช้ค้นหาอัตโนมัติได้', code: 'forbidden' }
    const { data: isAdminOrOwner, error: adminErr } = await userClient.rpc('is_admin_or_owner')
    if (adminErr || !isAdminOrOwner) return json(FORBIDDEN, 403)
    const { data: canWrite, error: writeErr } = await userClient.rpc('tenant_can_write')
    if (writeErr || !canWrite) return json(FORBIDDEN, 403)
    const { data: tenantId, error: tenantErr } = await userClient.rpc('current_tenant_id')
    if (tenantErr || !tenantId) return json(FORBIDDEN, 403)

    // Reserve BEFORE spending anything: every attempt counts.
    admin = createClient(SUPABASE_URL, SERVICE_KEY)
    const { data: reserved, error: reserveErr } = await admin.rpc('consume_company_lookup', { p_tenant: tenantId })
    if (reserveErr) console.error('lookup-company reserve failed', (reserveErr as { code?: string }).code ?? 'unknown')
    const budget = budgetOutcome(reserveErr ? 'error' : reserved)
    const reservedDay = budgetDay(reserved)
    if (!budget.ok) {
      console.log(JSON.stringify({ evt: 'company_lookup_budget', code: budget.code }))
      return json({ error: budget.message, code: budget.code }, budget.code === 'error' ? 502 : 429)
    }
    reservedFor = { tenant: tenantId, day: reservedDay }
    callStarted = true

    const r = await runSearch(name, Date.now() + 50_000)
    if (!r.ok) {
      if (r.refundable) {
        // Anthropic certainly did not bill (non-2xx / non-timeout fetch failure): give it back
        await refund(admin, reservedFor)
      }
      reservedFor = null
      const msg = r.code === 'search_disabled' ? 'บริการค้นหายังไม่เปิดใช้' : 'ระบบค้นหาขัดข้อง ลองใหม่ภายหลัง หรือใช้ปุ่ม "ค้นหาใน DBD" แทน'
      return json({ error: msg, code: r.code }, r.status)
    }
    reservedFor = null // a response arrived: the attempt stays counted

    const { candidates, evidence, drops, rawCount } = candidatesFromContent(r.content)
    const dropCounts: Record<string, number> = {}
    for (const d of drops) dropCounts[d] = (dropCounts[d] ?? 0) + 1
    console.log(JSON.stringify({
      evt: 'company_lookup',
      rawCandidates: rawCount, drops: dropCounts, kept: candidates.length,
      stopReason: r.stopReason, continuations: r.continuations,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, webSearchRequests: r.searchRequests,
      citations: evidence.citations.length, searchErrors: evidence.searchErrors,
    }))

    const outcome = lookupOutcome(r.stopReason, candidates.length)
    if (outcome === 'incomplete') return json({ error: INCOMPLETE_MESSAGE, code: 'incomplete' }, 200)
    return json({ candidates })
  } catch (e) {
    console.error('lookup-company threw:', String(e).slice(0, 300))
    // only refund when the failure happened before the Anthropic call began
    if (reservedFor && admin && !callStarted) await refund(admin, reservedFor)
    return json({ error: 'ระบบค้นหาขัดข้อง ลองใหม่ภายหลัง หรือใช้ปุ่ม "ค้นหาใน DBD" แทน', code: 'ai_unavailable' }, 502)
  }
})
