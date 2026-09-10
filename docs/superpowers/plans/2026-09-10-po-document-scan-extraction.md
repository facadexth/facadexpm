# PO Document Scan Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user photograph a supplier's delivery-note/quotation document and have an AI vision call pre-fill a new Purchase Order's line items, with per-supplier calibration examples managed from the Suppliers page.

**Architecture:** One stateless Supabase Edge Function (`extract-po-document`) calls Claude's vision API with the uploaded image (+ optional per-supplier calibration examples) and returns structured JSON. All other logic — storage, DB rows, capping examples at 3, wiring the result into the existing PO form — lives in the frontend, calling that function like any other Supabase RPC.

**Tech Stack:** React (existing pages), Supabase (Postgres + Storage + Edge Functions/Deno), Claude Messages API (vision), Vitest for the pure-logic unit tests.

**Spec:** `docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md`

## Global Constraints

- Cap: 3 calibration examples per supplier — oldest deleted when a 4th is saved (spec, Data model section).
- Images downscaled to max ~1600px on the longest side before sending to the API or storing as a calibration example (spec, Architecture section).
- Extraction never auto-saves a PO or a calibration example — every result is reviewed/edited by the user first (spec, Goal section).
- API key `ANTHROPIC_API_KEY` is a single platform-wide Edge Function secret, not per-tenant (spec, API key section).
- Model: `claude-sonnet-5` (current latest Sonnet at time of writing — confirm this is still the correct public API model identifier in Anthropic's docs before deploying Task 3; update the constant if the platform default has moved on).
- Edge function must reject unauthorized callers (not ADMIN/OWNER, or tenant lacks `purchase_orders` module access) before making the paid API call.

---

### Task 1: Database schema — `supplier_document_examples` table + storage bucket

**Files:**
- Create: `supabase/migrations/2026-09-10-04-supplier-document-examples.sql`

**Interfaces:**
- Produces: table `supplier_document_examples(id, tenant_id, supplier_id, file_path, extracted, created_at)`; storage bucket `supplier-doc-examples`. Both used by Task 5's hooks.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-10-04-supplier-document-examples.sql
--
-- Calibration examples for the PO document-scan extraction feature (see
-- docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md).
-- A "few-shot calibration" example: a verified-correct (document image,
-- extracted line items) pair for one supplier, used to prime future
-- extraction calls for that same supplier. Capped at 3 per supplier by
-- the application layer (saveSupplierDocumentExample in useSupabase.js),
-- not by a DB constraint.
CREATE TABLE supplier_document_examples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  extracted     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_document_examples_supplier_id ON supplier_document_examples(supplier_id);
CREATE INDEX idx_supplier_document_examples_tenant_id ON supplier_document_examples(tenant_id);

ALTER TABLE supplier_document_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON supplier_document_examples FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

INSERT INTO storage.buckets (id, name, public) VALUES ('supplier-doc-examples', 'supplier-doc-examples', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY supplier_doc_examples_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  )
  WITH CHECK (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  );
```

- [ ] **Step 2: Apply the migration to the production project**

Use the `mcp__plugin_supabase_supabase__apply_migration` tool (name: `supplier_document_examples`, query: the SQL above), or run it directly via the Supabase SQL execution tool. This project applies migrations straight to production (see other files in `supabase/migrations/` — there is no separate local/staging Supabase instance in this workflow).

- [ ] **Step 3: Verify the table and bucket exist**

Run via the SQL execution tool:
```sql
select count(*) from supplier_document_examples;
select id, public from storage.buckets where id = 'supplier-doc-examples';
```
Expected: first query returns `0` (empty table, no error — confirms the table exists and RLS doesn't block a service-role/admin read); second query returns one row with `public = false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-10-04-supplier-document-examples.sql
git commit -m "Add supplier_document_examples table + storage bucket for PO scan calibration"
```

---

### Task 2: Extraction validation and image-sizing logic (pure, unit-tested)

**Files:**
- Create: `src/lib/poDocumentExtraction.js`
- Test: `src/lib/poDocumentExtraction.test.js`

**Interfaces:**
- Produces:
  - `computeDownscaledSize(width, height, maxDim = 1600) -> { width, height }`
  - `validateExtraction(raw) -> { ok: true, data: { supplier_name_guess, document_date_guess, reference_no_guess, line_items } } | { ok: false, error: string }`
  - `fileToDownscaledBase64(file, maxDim = 1600) -> Promise<{ base64, mimeType }>` (browser-only, uses `Image`/`canvas` — not unit tested, covered by Task 8's manual test)
  - `blobToBase64(blob) -> Promise<string>` (browser-only, uses `FileReader` — not unit tested, covered by Task 8's manual test)
- Consumes: nothing (this is the lowest-level file in the feature).

- [ ] **Step 1: Write the failing tests**

```javascript
// src/lib/poDocumentExtraction.test.js
import { describe, it, expect } from 'vitest'
import { computeDownscaledSize, validateExtraction } from './poDocumentExtraction.js'

describe('computeDownscaledSize', () => {
  it('leaves an image already under maxDim unchanged', () => {
    expect(computeDownscaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
  it('scales down a landscape image so the longest side hits maxDim', () => {
    expect(computeDownscaledSize(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 })
  })
  it('scales down a portrait image so the longest side hits maxDim', () => {
    expect(computeDownscaledSize(1200, 4000, 1600)).toEqual({ width: 480, height: 1600 })
  })
  it('never upscales a small image', () => {
    expect(computeDownscaledSize(400, 300, 1600)).toEqual({ width: 400, height: 300 })
  })
})

describe('validateExtraction', () => {
  it('accepts a well-formed response, coercing numeric strings', () => {
    const raw = {
      supplier_name_guess: 'YONG CHANG (THAILAND) CO., LTD.',
      document_date_guess: '2026-09-08',
      reference_no_guess: 'IV6909/08046',
      line_items: [
        { description: 'กรอบมุ้งบานเลื่อน 1.2 พ่นดำ-SMS', quantity: '3', unit: 'เส้น', unit_price: '353' },
      ],
    }
    const result = validateExtraction(raw)
    expect(result.ok).toBe(true)
    expect(result.data.line_items).toEqual([
      { description: 'กรอบมุ้งบานเลื่อน 1.2 พ่นดำ-SMS', quantity: 3, unit: 'เส้น', unit_price: 353 },
    ])
    expect(result.data.supplier_name_guess).toBe('YONG CHANG (THAILAND) CO., LTD.')
  })

  it('rejects a non-object response', () => {
    expect(validateExtraction(null).ok).toBe(false)
    expect(validateExtraction('not json').ok).toBe(false)
  })

  it('rejects a response missing line_items', () => {
    const result = validateExtraction({ supplier_name_guess: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/line_items/)
  })

  it('rejects a response where line_items is not an array', () => {
    const result = validateExtraction({ line_items: 'oops' })
    expect(result.ok).toBe(false)
  })

  it('drops a line item missing a description rather than crashing', () => {
    const result = validateExtraction({
      line_items: [
        { description: 'ok', quantity: 1, unit: 'ชิ้น', unit_price: 10 },
        { quantity: 1, unit: 'ชิ้น', unit_price: 10 },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.data.line_items).toHaveLength(1)
    expect(result.data.line_items[0].description).toBe('ok')
  })

  it('defaults missing supplier/date/reference guesses to null', () => {
    const result = validateExtraction({ line_items: [] })
    expect(result.ok).toBe(true)
    expect(result.data.supplier_name_guess).toBeNull()
    expect(result.data.document_date_guess).toBeNull()
    expect(result.data.reference_no_guess).toBeNull()
    expect(result.data.line_items).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: FAIL — `poDocumentExtraction.js` does not exist yet ("Failed to resolve import").

- [ ] **Step 3: Write the implementation**

```javascript
// src/lib/poDocumentExtraction.js
// ============================================================
// PO document-scan extraction -- pure validation/sizing logic used by
// both the Suppliers-page calibration flow and the PO create form's
// "upload from photo" control (see
// docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md).
// The actual AI call lives server-side (supabase/functions/extract-po-
// document) -- this file only shapes what goes in (image sizing) and
// validates what comes back, so a malformed AI response can never crash
// the form it's about to pre-fill.
// ============================================================

/** Target size for an image before it's sent to the extraction API or
 *  stored as a calibration example -- never upscales, only shrinks the
 *  longest side down to maxDim. */
export function computeDownscaledSize(width, height, maxDim = 1600) {
  if (width <= maxDim && height <= maxDim) return { width, height }
  const scale = width >= height ? maxDim / width : maxDim / height
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function toFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Normalizes and defensively validates the extraction edge function's
 *  JSON response. Never throws -- returns { ok:false, error } for
 *  anything unusable instead, so a bad AI response degrades to "nothing
 *  pre-filled" rather than a crash or garbage data in the form. */
export function validateExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'ผลลัพธ์จาก AI ไม่ใช่ข้อมูลที่ถูกต้อง' }
  }
  if (!Array.isArray(raw.line_items)) {
    return { ok: false, error: 'ผลลัพธ์จาก AI ไม่มี line_items' }
  }

  const line_items = raw.line_items
    .map(it => {
      if (!it || typeof it !== 'object') return null
      const description = typeof it.description === 'string' ? it.description.trim() : ''
      if (!description) return null
      const quantity = toFiniteNumber(it.quantity)
      const unit_price = toFiniteNumber(it.unit_price)
      return {
        description,
        quantity: quantity ?? 0,
        unit: typeof it.unit === 'string' ? it.unit : '',
        unit_price: unit_price ?? 0,
      }
    })
    .filter(Boolean)

  return {
    ok: true,
    data: {
      supplier_name_guess: typeof raw.supplier_name_guess === 'string' ? raw.supplier_name_guess : null,
      document_date_guess: typeof raw.document_date_guess === 'string' ? raw.document_date_guess : null,
      reference_no_guess: typeof raw.reference_no_guess === 'string' ? raw.reference_no_guess : null,
      line_items,
    },
  }
}

/** Reads a browser File, downscales it via canvas, and returns a JPEG
 *  base64 payload (no data: URL prefix) ready to send to the edge
 *  function or store as a calibration example. Browser-only (Image +
 *  canvas) -- not unit tested, verified manually per Task 8. */
export async function fileToDownscaledBase64(file, maxDim = 1600) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const img = await new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'))
    image.src = dataUrl
  })
  const { width, height } = computeDownscaledSize(img.naturalWidth, img.naturalHeight, maxDim)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(img, 0, 0, width, height)
  const outUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: outUrl.split(',')[1], mimeType: 'image/jpeg' }
}

/** Converts a Blob (e.g. downloaded from Supabase Storage) to a bare
 *  base64 string, no data: URL prefix. Used to re-encode an already-
 *  downscaled saved calibration example for a future extraction call. */
export async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return dataUrl.split(',')[1]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/poDocumentExtraction.js src/lib/poDocumentExtraction.test.js
git commit -m "Add PO document extraction validation/sizing helpers"
```

---

### Task 3: Edge Function `extract-po-document`

**Files:**
- Create: `supabase/functions/extract-po-document/index.ts`

**Interfaces:**
- Consumes: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` env vars (secrets set in Step 3 below).
- Produces: `POST /functions/v1/extract-po-document` accepting
  `{ image_base64: string, mime_type: string, examples?: [{ image_base64: string, mime_type: string, extracted: object }] }`,
  returning `{ supplier_name_guess, document_date_guess, reference_no_guess, line_items }` (200) or `{ error: string }` (4xx/5xx).
  Consumed by Task 5's `extractPoDocument()`.

- [ ] **Step 1: Write the function**

```typescript
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
```

- [ ] **Step 2: Set the required secret**

Ask the user to run this themselves (so the raw key never appears in this session's chat log):
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <project-ref>
```
`SUPABASE_URL` and `SUPABASE_ANON_KEY` are already available to every Edge Function in this project automatically (see `omise-create-charge` using the same two env vars with no separate secrets-set step for them).

- [ ] **Step 3: Deploy the function**

```bash
supabase functions deploy extract-po-document --project-ref <project-ref>
```

- [ ] **Step 4: Manually verify it rejects an unauthenticated call**

```bash
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/extract-po-document \
  -H "Content-Type: application/json" \
  -d '{"image_base64":"x","mime_type":"image/jpeg"}'
```
Expected: `401` with `{"error":"Missing Authorization"}` — confirms the auth gate is live before wiring up any frontend caller. A full authenticated round-trip is verified in Task 8 once the frontend caller (Task 5) exists.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/extract-po-document/index.ts
git commit -m "Add extract-po-document Edge Function (Claude vision extraction)"
```

---

### Task 4: `useSupabase.js` — calibration examples + extraction call

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: `validateExtraction`, `blobToBase64` from Task 2's `src/lib/poDocumentExtraction.js`; `supplier_document_examples` table + `supplier-doc-examples` bucket from Task 1; `extract-po-document` function from Task 3.
- Produces:
  - `useSupplierDocumentExamples(supplierId) -> { data, loading, error, refetch }` (rows ordered oldest-first)
  - `saveSupplierDocumentExample(supplierId, base64, mimeType, extracted) -> Promise<void>`
  - `deleteSupplierDocumentExample(example) -> Promise<void>` (`example` = a row from the hook above)
  - `extractPoDocument(base64, mimeType, examples) -> Promise<{ ok: true, data } | { ok: false, error }>` where `examples` is the array of rows from `useSupplierDocumentExamples`
  Consumed by Task 6 (Suppliers.jsx) and Task 7 (PurchaseOrders.jsx).

- [ ] **Step 1: Add the import**

At the top of `src/hooks/useSupabase.js`, add:
```javascript
import { validateExtraction, blobToBase64 } from '../lib/poDocumentExtraction.js'
```

- [ ] **Step 2: Add the hook and mutations**

Append to `src/hooks/useSupabase.js`:
```javascript
// ── PO Document Scan Extraction ─────────────────────────────

/** Calibration examples for one supplier's document layout, oldest
 *  first (so saveSupplierDocumentExample's prune-the-oldest logic and
 *  the training modal's display order agree). */
export function useSupplierDocumentExamples(supplierId) {
  return useQuery(async () => {
    if (!supplierId) return []
    const { data, error } = await supabase
      .from('supplier_document_examples')
      .select('*')
      .eq('supplier_id', supplierId)
      .order('created_at')
    if (error) throw error
    return data
  }, [supplierId])
}

const MAX_SUPPLIER_DOCUMENT_EXAMPLES = 3

/** Saves a newly-verified (image, corrected extraction) pair as a
 *  calibration example for a supplier. `base64`/`mimeType` are the same
 *  already-downscaled image the extraction call itself used. Prunes the
 *  oldest example first if this would exceed the cap. */
export async function saveSupplierDocumentExample(supplierId, base64, mimeType, extracted) {
  const { data: existing, error: listError } = await supabase
    .from('supplier_document_examples')
    .select('id, file_path, created_at')
    .eq('supplier_id', supplierId)
    .order('created_at')
  if (listError) throw listError

  if ((existing || []).length >= MAX_SUPPLIER_DOCUMENT_EXAMPLES) {
    const oldest = existing[0]
    await supabase.storage.from('supplier-doc-examples').remove([oldest.file_path])
    const { error: delError } = await supabase.from('supplier_document_examples').delete().eq('id', oldest.id)
    if (delError) throw delError
  }

  const { data: { user } } = await supabase.auth.getUser()
  const { data: roleRow } = await supabase.from('user_roles').select('tenant_id').eq('user_email', user.email).single()
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const filePath = `${roleRow.tenant_id}/${supplierId}/${Date.now()}.${ext}`

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const { error: upErr } = await supabase.storage.from('supplier-doc-examples').upload(filePath, bytes, { contentType: mimeType })
  if (upErr) throw upErr

  const { error: insErr } = await supabase
    .from('supplier_document_examples')
    .insert({ supplier_id: supplierId, file_path: filePath, extracted })
  if (insErr) {
    await supabase.storage.from('supplier-doc-examples').remove([filePath])
    throw insErr
  }
}

export async function deleteSupplierDocumentExample(example) {
  const { error: rmErr } = await supabase.storage.from('supplier-doc-examples').remove([example.file_path])
  if (rmErr) throw rmErr
  const { error: delErr } = await supabase.from('supplier_document_examples').delete().eq('id', example.id)
  if (delErr) throw delErr
}

/** Re-downloads a saved calibration example's (already-downscaled) image
 *  and re-encodes it to base64 for inclusion in an extraction call --
 *  examples are stored in Storage, not as base64, so this is the one
 *  place that bridges the two. */
async function loadExampleForPrompt(example) {
  const { data: blob, error } = await supabase.storage.from('supplier-doc-examples').download(example.file_path)
  if (error) throw error
  const base64 = await blobToBase64(blob)
  return { image_base64: base64, mime_type: blob.type || 'image/jpeg', extracted: example.extracted }
}

/** Calls the extract-po-document Edge Function with one document image
 *  and (optionally) a supplier's saved calibration examples. Never
 *  throws -- returns the same { ok, data|error } shape as
 *  validateExtraction so callers have one place to handle failure. */
export async function extractPoDocument(base64, mimeType, examples = []) {
  try {
    const examplesForPrompt = await Promise.all((examples || []).map(loadExampleForPrompt))
    const { data, error } = await supabase.functions.invoke('extract-po-document', {
      body: { image_base64: base64, mime_type: mimeType, examples: examplesForPrompt },
    })
    if (error) return { ok: false, error: error.message }
    return validateExtraction(data)
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
```

- [ ] **Step 3: Verify the file still builds**

Run: `npx vite build`
Expected: builds cleanly, no import errors.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add supplier document example hooks and extractPoDocument call"
```

---

### Task 5: Suppliers page — "🎓 ฝึกอ่านเอกสาร" calibration modal

**Files:**
- Modify: `src/pages/Suppliers.jsx`

**Interfaces:**
- Consumes: `useSupplierDocumentExamples`, `saveSupplierDocumentExample`, `deleteSupplierDocumentExample`, `extractPoDocument` (Task 4); `fileToDownscaledBase64` (Task 2); `Modal` from `../components/Modal.jsx`.
- Produces: nothing consumed by later tasks — this is a leaf UI task.

- [ ] **Step 1: Add the new imports**

In `src/pages/Suppliers.jsx`, extend the existing imports:
```javascript
import { useSuppliers, useSupplierDocumentExamples, saveSupplierDocumentExample, deleteSupplierDocumentExample, extractPoDocument } from '../hooks/useSupabase.js'
import { fileToDownscaledBase64 } from '../lib/poDocumentExtraction.js'
```
(`useSuppliers` already exists in the current import line — extend it rather than duplicating the import.)

- [ ] **Step 2: Add the training modal component**

Add this new component to `src/pages/Suppliers.jsx`, above the default-exported `Suppliers` function:
```javascript
function SupplierDocumentTrainingModal({ supplier, onClose }) {
  const { data: examples, refetch } = useSupplierDocumentExamples(supplier.id)
  const [extracting, setExtracting] = useState(false)
  const [pending, setPending] = useState(null) // { base64, mimeType, lineItems }
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setError(null)
    setExtracting(true)
    try {
      const { base64, mimeType } = await fileToDownscaledBase64(file)
      const result = await extractPoDocument(base64, mimeType, examples || [])
      if (!result.ok) { setError(result.error); return }
      setPending({ base64, mimeType, lineItems: result.data.line_items })
    } catch (err) {
      setError(err.message)
    } finally {
      setExtracting(false)
    }
  }

  const setLineItem = (i, key, value) => {
    setPending(p => ({ ...p, lineItems: p.lineItems.map((it, idx) => idx === i ? { ...it, [key]: value } : it) }))
  }

  const handleSaveExample = async () => {
    if (!pending) return
    setSaving(true)
    try {
      await saveSupplierDocumentExample(supplier.id, pending.base64, pending.mimeType, { line_items: pending.lineItems })
      setPending(null)
      await refetch()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteExample = async (ex) => {
    try {
      await deleteSupplierDocumentExample(ex)
      await refetch()
    } catch (err) {
      alert('ลบไม่สำเร็จ: ' + err.message)
    }
  }

  return (
    <Modal title={`ฝึกอ่านเอกสาร — ${supplier.name}`} onClose={onClose} maxWidth={700}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          อัพโหลดตัวอย่างเอกสารของซัพพลายเออร์รายนี้ ตรวจ/แก้ผลลัพธ์ให้ถูกต้อง แล้วบันทึกเป็นตัวอย่าง
          — ระบบจะใช้ตัวอย่างที่บันทึกไว้ช่วยอ่านเอกสารเดิมของซัพพลายเออร์รายนี้ได้แม่นขึ้นในครั้งถัดไป
          (เก็บได้สูงสุด 3 ตัวอย่างต่อราย ตัวอย่างเก่าสุดจะถูกลบเมื่อบันทึกตัวที่ 4)
        </p>

        <div>
          <label className="label">อัพโหลดตัวอย่างเอกสาร</label>
          <input type="file" accept="image/*" onChange={handleUpload} disabled={extracting} />
          {extracting && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text3)' }}>⏳ กำลังอ่านเอกสาร...</span>}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {pending && (
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>ผลลัพธ์ที่อ่านได้ — ตรวจ/แก้ก่อนบันทึก</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {pending.lineItems.map((it, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 100px', gap: 6 }}>
                  <input className="input input-sm" value={it.description} onChange={e => setLineItem(i, 'description', e.target.value)} />
                  <input className="input input-sm" type="number" value={it.quantity} onChange={e => setLineItem(i, 'quantity', parseFloat(e.target.value) || 0)} />
                  <input className="input input-sm" value={it.unit} onChange={e => setLineItem(i, 'unit', e.target.value)} />
                  <input className="input input-sm" type="number" value={it.unit_price} onChange={e => setLineItem(i, 'unit_price', parseFloat(e.target.value) || 0)} />
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={saving} onClick={handleSaveExample}>
              {saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกเป็นตัวอย่าง'}
            </button>
          </div>
        )}

        <div>
          <label className="label">ตัวอย่างที่บันทึกไว้ ({(examples || []).length}/3)</label>
          {(examples || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีตัวอย่าง</div>}
          {(examples || []).map(ex => (
            <div key={ex.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 0' }}>
              <span>{new Date(ex.created_at).toLocaleDateString('th-TH')} — {(ex.extracted?.line_items || []).length} รายการ</span>
              <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => handleDeleteExample(ex)}>ลบ</button>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 3: Add the per-row button and modal wiring**

In the `export default function Suppliers()` component, add state:
```javascript
const [trainingSupplier, setTrainingSupplier] = useState(null)
```
In the table's actions cell (the `<td>` containing the existing แก้ไข/ลบ buttons, inside `{canEdit && (...)}`), add a third button:
```javascript
<button className="btn btn-sm btn-ghost" onClick={() => setTrainingSupplier(s)}>🎓 ฝึกอ่านเอกสาร</button>
```
placed alongside the existing แก้ไข/ลบ buttons for that row.

At the bottom of the component's returned JSX (alongside the existing `{showForm && ...}` / `{deleteId && ...}` blocks), add:
```javascript
{trainingSupplier && (
  <SupplierDocumentTrainingModal supplier={trainingSupplier} onClose={() => setTrainingSupplier(null)} />
)}
```

- [ ] **Step 4: Build check**

Run: `npx vite build`
Expected: builds cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Suppliers.jsx
git commit -m "Add per-supplier document-reading calibration modal to Suppliers page"
```

---

### Task 6: PurchaseOrders page — "📷 อัพโหลดจากใบส่งของ/ใบเสนอราคา" on the create form

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Consumes: `useSupplierDocumentExamples`, `extractPoDocument` (Task 4); `fileToDownscaledBase64` (Task 2).
- Produces: nothing consumed by later tasks — leaf UI task.

- [ ] **Step 1: Add the new imports**

Replace the existing `useSupabase.js` import line (currently line 9) in `src/pages/PurchaseOrders.jsx` with:
```javascript
import { usePurchaseOrders, useSites, useSuppliers, useCategories, useUnits, useInventoryItems, useAllInventoryItems, useInventoryItemUnitFactors, useStockBalances, useAluminumProfiles, useAllAluminumProfiles, useMySignatureUrl, useMyWorkerName, useSupplierDocumentExamples, extractPoDocument } from '../hooks/useSupabase.js'
```
and add, right after it:
```javascript
import { fileToDownscaledBase64 } from '../lib/poDocumentExtraction.js'
```

- [ ] **Step 2: Add the upload control inside `PurchaseOrderForm`**

Inside `function PurchaseOrderForm(...)` (defined at line 159), after the `const [form, setForm, clearFormDraft] = useDraftForm(...)` line, add:
```javascript
const { data: supplierExamples } = useSupplierDocumentExamples(form.supplier_id || null)
const [scanning, setScanning] = useState(false)
const [scanError, setScanError] = useState(null)

const handleScanUpload = async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  e.target.value = ''
  setScanError(null)
  setScanning(true)
  try {
    const { base64, mimeType } = await fileToDownscaledBase64(file)
    const result = await extractPoDocument(base64, mimeType, supplierExamples || [])
    if (!result.ok) { setScanError(result.error); return }
    const { document_date_guess, reference_no_guess, line_items } = result.data
    setForm(f => ({
      ...f,
      date: document_date_guess || f.date,
      notes: reference_no_guess ? [f.notes, `อ้างอิง: ${reference_no_guess}`].filter(Boolean).join(' ') : f.notes,
      items: line_items.length
        ? line_items.map(it => ({ ...EMPTY_ITEM, description: it.description, quantity: String(it.quantity), unit: it.unit, unit_price: String(it.unit_price) }))
        : f.items,
    }))
  } catch (err) {
    setScanError(err.message)
  } finally {
    setScanning(false)
  }
}
```
(`useState` is already imported in this file at the top per line 7.)

- [ ] **Step 3: Render the control in the form**

In the JSX returned by `PurchaseOrderForm`, immediately after the Supplier `<QuickAddSelect>` block (the one ending `table="suppliers" ... onCreated={onSupplierCreated} />`) and before the `<ItemsEditor .../>` line, add:
```javascript
<div>
  <label className="label">📷 อัพโหลดจากใบส่งของ/ใบเสนอราคา (ไม่บังคับ)</label>
  <input type="file" accept="image/*" onChange={handleScanUpload} disabled={!form.supplier_id || scanning} />
  {!form.supplier_id && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>เลือก Supplier ก่อนถึงจะอัพโหลดได้</div>}
  {scanning && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>⏳ กำลังอ่านเอกสาร...</div>}
  {scanError && <div className="alert alert-error" style={{ marginTop: 6 }}>{scanError}</div>}
</div>
```

- [ ] **Step 4: Build check**

Run: `npx vite build`
Expected: builds cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "Add upload-from-photo control to the create-PO form"
```

---

### Task 7: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the Edge Function secret and deploy are live**

Confirm Task 3 Steps 2-3 were actually completed (secret set, function deployed) before testing — this task assumes that's done.

- [ ] **Step 2: Run the full automated test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `src/lib/poDocumentExtraction.test.js` cases.

- [ ] **Step 3: Start the dev server and test the Suppliers calibration flow**

Run: `npm run dev`, open the app, go to ⚙️ ตั้งค่า → (suppliers/ผู้จำหน่าย) page. Pick a real supplier (e.g. one matching the sample document already on hand — create a "YONG CHANG (THAILAND)" supplier first if none exists). Click "🎓 ฝึกอ่านเอกสาร", upload the sample document photo. Verify: extraction returns line items resembling the real document (6 rows: กรอบมุ้งบานเลื่อน..., B10008 กล่องเรียบ..., etc.), correct any misreads in the editable table, click "💾 บันทึกเป็นตัวอย่าง", confirm it appears in the "ตัวอย่างที่บันทึกไว้" list.

- [ ] **Step 4: Test the PO creation flow using that calibration**

Go to ใบสั่งซื้อ → "+ เพิ่มใบสั่งซื้อ". Select the same supplier used in Step 3. Confirm the upload control is now enabled. Upload the same (or a second, similar) document from that supplier. Verify the form's line items get replaced with the extracted rows, review them, fill in the remaining required fields (site, category, date if not guessed), and save the PO successfully.

- [ ] **Step 5: Test the failure path**

Upload a non-document image (e.g. an unrelated photo) or, if easiest, temporarily use an invalid API key to force a failure. Confirm: an error message appears, the form is left exactly as it was (no partial/garbage pre-fill), and manual entry still works normally afterward.

- [ ] **Step 6: Fix any real extraction inaccuracies found in Steps 3-4**

If line items are frequently misread in a specific, fixable way (e.g. consistently swapping quantity and unit columns), adjust the `SYSTEM_PROMPT` in `supabase/functions/extract-po-document/index.ts` accordingly, redeploy (`supabase functions deploy extract-po-document`), and re-test. This is expected tuning, not a sign the design is wrong — leave the prompt wording to what actually works against the real document.
