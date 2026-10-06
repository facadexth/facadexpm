// supabase/functions/lookup-company/index.ts
// ============================================================
// lookup-company -- AI-assisted company lookup (name -> up to 3 candidates with
// registered name, address and 13-digit juristic ID) using Anthropic's server-side
// web search restricted to ALLOWED_DOMAINS (_shared/company-lookup.ts).
//
// Auth: caller's own JWT (deployed WITH JWT verification), then tenant_can_write()
// over RPC (a plain SELECT would be filtered silently by RLS). Every call spends
// real ANTHROPIC_API_KEY money, so a per-tenant daily cap (service role, table
// company_lookup_usage) is checked before the model call and incremented only
// after a lookup that returned at least one validated candidate.
// All trust decisions live in the pure, tested _shared/company-lookup.ts.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  buildLookupRequest, candidatesFromContent, capDecision, cleanCompanyName,
  DAILY_LOOKUP_CAP, MAX_CONTINUATIONS,
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

// Runs the request, continuing a paused server-side loop a few times.
async function runSearch(name: string, deadline: number): Promise<{ ok: true; content: Block[]; searches: number } | { ok: false; status: number; code: string }> {
  const base = buildLookupRequest(name)
  const messages: Array<{ role: string; content: unknown }> = [...base.messages]
  const content: Block[] = []
  let searches = 0
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
      return { ok: false, status: 502, code: 'ai_unavailable' }
    }
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 400)
      console.error('lookup-company API error', res.status, t)
      if (res.status === 400 && /web search/i.test(t) && /not enabled/i.test(t)) return { ok: false, status: 503, code: 'search_disabled' }
      return { ok: false, status: 502, code: 'ai_unavailable' }
    }
    // deno-lint-ignore no-explicit-any
    let j: any
    try { j = await res.json() } catch { return { ok: false, status: 502, code: 'ai_unavailable' } }
    const blocks: Block[] = Array.isArray(j?.content) ? j.content : []
    content.push(...blocks)
    searches += j?.usage?.server_tool_use?.web_search_requests ?? 0
    if (j?.stop_reason !== 'pause_turn') return { ok: true, content, searches }
    messages.push({ role: 'assistant', content: blocks })
  }
  return { ok: true, content, searches }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

  let body: { name?: unknown }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const name = cleanCompanyName(body?.name)
  if (!name) return json({ error: 'ใส่ชื่อบริษัท 2-120 ตัวอักษร', code: 'bad_name' }, 400)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: canWrite, error: writeErr } = await userClient.rpc('tenant_can_write')
  if (writeErr || !canWrite) return json({ error: 'Unauthorized' }, 403)
  const { data: tenantId, error: tenantErr } = await userClient.rpc('current_tenant_id')
  if (tenantErr || !tenantId) return json({ error: 'Unauthorized' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data: used, error: usedErr } = await admin.rpc('company_lookup_count_today', { p_tenant: tenantId })
  if (usedErr) {
    console.error('lookup-company cap check failed', (usedErr as { code?: string }).code ?? 'unknown')
    return json({ error: 'ระบบขัดข้อง ลองใหม่ภายหลัง', code: 'ai_unavailable' }, 502)
  }
  if (!capDecision(Number(used) || 0).allowed) {
    return json({ error: `ใช้ค้นหาอัตโนมัติครบ ${DAILY_LOOKUP_CAP} ครั้งต่อวันแล้ว ลองใหม่พรุ่งนี้ หรือใช้ปุ่ม "ค้นหาใน DBD" แทน`, code: 'daily_cap' }, 429)
  }

  const r = await runSearch(name, Date.now() + 50_000)
  if (!r.ok) {
    const msg = r.code === 'search_disabled' ? 'บริการค้นหายังไม่เปิดใช้' : 'ระบบค้นหาขัดข้อง ลองใหม่ภายหลัง หรือใช้ปุ่ม "ค้นหาใน DBD" แทน'
    return json({ error: msg, code: r.code }, r.status)
  }

  const { candidates, evidence } = candidatesFromContent(r.content)
  console.log(JSON.stringify({ evt: 'company_lookup', searches: r.searches || evidence.searches, citations: evidence.citations.length, errors: evidence.searchErrors, candidates: candidates.length }))

  if (candidates.length > 0) {
    const { error } = await admin.rpc('company_lookup_record', { p_tenant: tenantId })
    if (error) console.error('company_lookup_record failed', (error as { code?: string }).code ?? 'unknown')
  }
  return json({ candidates })
})
