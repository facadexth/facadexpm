// supabase/functions/extract-po-document/index.ts
// ============================================================
// extract-po-document -- stateless AI vision extraction for the PO
// document-scan feature (see
// docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md).
// Takes one document image (+ optional per-supplier calibration
// examples, as prior verified image+JSON pairs) and returns a
// best-effort structured guess at supplier/date/reference/line items.
// Has no knowledge of suppliers, POs, or tenants -- callers own all of
// that; this function only talks to Claude's API.
//
// Auth: bound to the caller's own JWT (same pattern as
// omise-create-charge) so a plain SELECT against a purchase_orders-
// module-gated table is enough to confirm the caller is an admin/owner
// of a tenant with the purchase_orders module -- reusing existing RLS
// instead of re-implementing role checks here. This gate exists because
// every call spends real ANTHROPIC_API_KEY money.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const MODEL = 'claude-sonnet-5'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const SYSTEM_PROMPT = `You read Thai supplier delivery notes, provisional invoices, and quotations (often dot-matrix printed) and extract their line-item table plus header info.

Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape:
{
  "supplier_name_guess": string or null,
  "document_date_guess": string or null (ISO YYYY-MM-DD, best effort from any date printed on the document),
  "reference_no_guess": string or null (invoice/document number printed on it, e.g. "IV6909/08046"),
  "line_items": [
    { "description": string, "quantity": number, "unit": string, "unit_price": number }
  ]
}

Rules:
- unit_price is the price per single unit as printed (before any discount/VAT columns), not the line's total amount.
- Keep Thai text as printed in "unit" (e.g. "เส้น", "ชิ้น", "ชุด", "แผ่น").
- If a field cannot be determined, use null (for header fields) rather than guessing.
- Include every goods/materials line; skip signature lines, totals, VAT rows, and boilerplate footer text.`

type ExampleInput = { image_base64: string; mime_type: string; extracted: Record<string, unknown> }

function buildMessages(imageBase64: string, mimeType: string, examples: ExampleInput[]) {
  const messages: Array<{ role: string; content: unknown }> = []
  for (const ex of examples) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: ex.mime_type, data: ex.image_base64 } },
        { type: 'text', text: 'Extract this document.' },
      ],
    })
    messages.push({ role: 'assistant', content: JSON.stringify(ex.extracted) })
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
      { type: 'text', text: 'Extract this document.' },
    ],
  })
  return messages
}

function parseModelJson(text: string): Record<string, unknown> | null {
  // Models sometimes wrap JSON in ```json fences despite instructions --
  // strip those before parsing rather than failing on well-formed output.
  const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
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

  // Bound to the caller's own JWT -- respects RLS, so this SELECT only
  // succeeds for an admin/owner whose tenant has the purchase_orders
  // module, matching every other PO-module action in the app.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { error: authCheckError } = await userClient.from('purchase_orders').select('id').limit(1)
  if (authCheckError) return json({ error: 'Unauthorized' }, 403)

  const messages = buildMessages(image_base64, mime_type, Array.isArray(examples) ? examples : [])

  let anthropicRes: Response
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      }),
    })
  } catch (e) {
    return json({ error: `เรียก AI ไม่สำเร็จ: ${String(e)}` }, 502)
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text()
    return json({ error: `AI API error: ${errText.slice(0, 500)}` }, 502)
  }

  const anthropicJson = await anthropicRes.json()
  const text = anthropicJson?.content?.[0]?.text
  if (typeof text !== 'string') return json({ error: 'AI ไม่ได้ตอบกลับเป็นข้อความ' }, 502)

  const parsed = parseModelJson(text)
  if (!parsed) return json({ error: 'อ่านผลลัพธ์จาก AI ไม่สำเร็จ (ไม่ใช่ JSON ที่ถูกต้อง)' }, 502)

  return json(parsed)
})
