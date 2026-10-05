// supabase/functions/extract-po-document/index.ts
// ============================================================
// extract-po-document -- stateless AI vision extraction for the PO
// document-scan feature (see
// docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md
// and docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md).
// Takes one document image/PDF (+ optional per-supplier calibration
// examples, as prior verified image+JSON pairs) and returns a best-effort
// structured guess at supplier/date/reference/line items.
//
// This file is only the adapter: auth gates, building the Anthropic request,
// and wiring the Supabase calls into runScan (_shared/po-scan-flow.ts), which
// owns the order of steps (cache -> quota -> cheap/strong model -> usage).
//
// Auth: bound to the caller's own JWT (same pattern as
// omise-create-charge), gated via the existing is_admin_or_owner() and
// has_module_access('purchase_orders') RLS helper functions -- called
// directly over RPC rather than reimplemented here. A plain SELECT
// against purchase_orders is NOT sufficient: RLS USING clauses filter
// rows silently rather than erroring, so a non-admin or a
// module-less tenant would get `{ data: [], error: null }`, not an
// error, and slip straight through. This gate exists because every
// call spends real ANTHROPIC_API_KEY money.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../_shared/po-extract-prompt.ts'
import { scanCacheKey, type Extraction } from '../_shared/scan-logic.ts'
import { runScan, type ModelCall, type ScanDeps } from '../_shared/po-scan-flow.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const STRONG_MODEL = 'claude-sonnet-5'
const CHEAP_MODEL = 'claude-haiku-4-5-20251001'
// Cheap-first stays off until the owner sets this secret to "true" after the
// offline evaluation (plan Task 11) shows it is accurate enough.
const CHEAP_FIRST = Deno.env.get('PO_SCAN_CHEAP_FIRST') === 'true'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

type ExampleInput = { image_base64: string; mime_type: string; extracted: Record<string, unknown> }

// Claude reads PDFs natively as a "document" content block, distinct from
// the "image" block used for photos -- same base64 source shape either
// way, just a different `type` and field name for the data.
function documentContentBlock(base64: string, mimeType: string) {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }
  }
  return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
}

function buildMessages(imageBase64: string, mimeType: string, examples: ExampleInput[]) {
  const messages: Array<{ role: string; content: unknown }> = []
  for (const ex of examples) {
    messages.push({
      role: 'user',
      content: [
        documentContentBlock(ex.image_base64, ex.mime_type),
        { type: 'text', text: 'Extract this document.' },
      ],
    })
    messages.push({ role: 'assistant', content: JSON.stringify(ex.extracted) })
  }
  messages.push({
    role: 'user',
    content: [
      documentContentBlock(imageBase64, mimeType),
      { type: 'text', text: 'Extract this document.' },
    ],
  })
  return messages
}

// One JSON line per model call so spend and upstream errors are visible in the
// function logs. Never log the request body, document, examples, headers or keys.
function logCall(
  model: string,
  ok: boolean,
  httpStatus: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
  stopReason: string | null,
  detail?: string,
) {
  console.log(JSON.stringify({
    evt: 'po_scan_model_call',
    model,
    ok,
    httpStatus,
    inputTokens,
    outputTokens,
    stopReason,
    ...(ok ? {} : { detail: (detail ?? '').slice(0, 300) }),
  }))
}

async function callAnthropic(model: string, messages: unknown, deadlineMs: number): Promise<ModelCall> {
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(Math.max(1000, deadlineMs - Date.now())),
      // 4096 was too low for a real document with a long item list (the
      // answer got cut off mid-line-item). 8192 is the highest safe ceiling
      // without an extended-output beta header; if even this is not enough
      // runScan answers `too_long` from stop_reason === 'max_tokens'.
      body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM_PROMPT, messages }),
    })
  } catch (e) {
    logCall(model, false, null, null, null, null, String(e))
    return { ok: false, detail: String(e) }
  }
  if (!res.ok) {
    let errText = ''
    try {
      errText = await res.text()
    } catch (e) {
      errText = String(e)
    }
    logCall(model, false, res.status, null, null, null, errText)
    return { ok: false, detail: `AI API error: ${errText.slice(0, 500)}` }
  }
  // deno-lint-ignore no-explicit-any
  let j: any
  try {
    j = await res.json()
  } catch (e) {
    logCall(model, false, res.status, null, null, null, String(e))
    return { ok: false, detail: `AI response unreadable: ${String(e)}` }
  }
  // The model can return a leading `thinking` content block before its
  // actual text response -- find the first text block by type.
  const block = Array.isArray(j?.content) ? j.content.find((b: { type?: string }) => b?.type === 'text') : null
  if (typeof block?.text !== 'string') {
    logCall(model, false, res.status, j?.usage?.input_tokens ?? null, j?.usage?.output_tokens ?? null, j?.stop_reason ?? null, 'no text block')
    return { ok: false, detail: 'AI ไม่ได้ตอบกลับเป็นข้อความ' }
  }
  logCall(model, true, res.status, j?.usage?.input_tokens ?? null, j?.usage?.output_tokens ?? null, j?.stop_reason ?? null)
  return {
    ok: true,
    text: block.text,
    stopReason: j?.stop_reason ?? null,
    inputTokens: j?.usage?.input_tokens ?? null,
    outputTokens: j?.usage?.output_tokens ?? null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

  let body: { image_base64?: string; mime_type?: string; examples?: ExampleInput[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const { image_base64, mime_type, examples } = body
  if (!image_base64 || typeof image_base64 !== 'string') return json({ error: 'image_base64 required' }, 400)
  if (!mime_type || typeof mime_type !== 'string') return json({ error: 'mime_type required' }, 400)

  // Bound to the caller's own JWT (see the header comment for why the RLS
  // helper functions are called directly instead of a plain SELECT).
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isAdminOrOwner, error: adminCheckError } = await userClient.rpc('is_admin_or_owner')
  if (adminCheckError || !isAdminOrOwner) return json({ error: 'Unauthorized' }, 403)

  const { data: hasAccess, error: moduleCheckError } = await userClient.rpc('has_module_access', { p_module_key: 'purchase_orders' })
  if (moduleCheckError || !hasAccess) return json({ error: 'Unauthorized' }, 403)

  const exampleList = Array.isArray(examples) ? examples : []
  const messages = buildMessages(image_base64, mime_type, exampleList)
  const cacheKey = await scanCacheKey({ version: PROMPT_VERSION, mimeType: mime_type, imageBase64: image_base64, examples: exampleList })

  const deps: ScanDeps = {
    cheapFirst: CHEAP_FIRST,
    cheapModel: CHEAP_MODEL,
    strongModel: STRONG_MODEL,
    now: () => Date.now(),
    lookupCache: async (key) => {
      const { data, error } = await userClient.from('scan_result_cache').select('result').eq('cache_key', key).maybeSingle()
      if (error) throw error
      return (data?.result as Extraction | undefined) ?? null
    },
    storeCache: async (key, result) => {
      // onConflict names the table's real unique constraint columns.
      const { error } = await userClient.from('scan_result_cache').upsert({ cache_key: key, result }, { onConflict: 'tenant_id,cache_key', ignoreDuplicates: true })
      if (error) console.error('scan_result_cache upsert failed:', error.message)
    },
    // Monthly quota, tier-configurable (packages.max_document_scans_per_month,
    // NULL = unlimited). Checked BEFORE any model call: that is the step that
    // costs money, and a tenant over quota never reaches it.
    checkQuota: async () => {
      const { data, error } = await userClient.rpc('tenant_under_document_scan_limit')
      if (error) return { ok: false }
      return { ok: true, allowed: !!data }
    },
    callModel: (model, deadlineMs) => callAnthropic(model, messages, deadlineMs),
    // Counts against the monthly quota only for a result that is returned to
    // the user; real token counts come straight from Anthropic's `usage`.
    recordUsage: async ({ model, inputTokens, outputTokens }) => {
      const { error } = await userClient.from('document_scan_usage').insert({
        mime_type, input_tokens: inputTokens, output_tokens: outputTokens, model_used: model,
      })
      if (error) console.error('document_scan_usage insert failed:', error.message)
    },
  }

  let outcome: Awaited<ReturnType<typeof runScan>>
  try {
    outcome = await runScan(deps, cacheKey)
  } catch (e) {
    console.error('extract-po-document runScan threw:', String(e))
    console.log(JSON.stringify({ evt: 'po_scan_outcome', status: 502, code: 'ai_unavailable', model_used: null, cache_hit: false, threw: true }))
    return json({ error: 'ระบบอ่านเอกสารขัดข้อง ลองใหม่ภายหลัง หรือกรอกรายการเองจากเอกสาร', code: 'ai_unavailable' }, 502)
  }
  const ob = outcome.body as Record<string, unknown>
  console.log(JSON.stringify({
    evt: 'po_scan_outcome',
    status: outcome.status,
    code: ob.code ?? null,
    model_used: ob.model_used ?? null,
    cache_hit: ob.cache_hit === true,
  }))
  return json(outcome.body, outcome.status)
})
