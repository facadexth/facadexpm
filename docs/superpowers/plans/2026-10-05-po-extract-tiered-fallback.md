# PO Extract: Cheaper-First Reading, Manual Fallback, Supplier Examples — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PO document scan (and the swap-tax-invoice action that reuses it) cheaper to run, never a dead end when the AI or quota is unavailable, and better calibrated by the supplier's saved examples.

**Architecture:** The edge function `extract-po-document` becomes a thin adapter around a pure, dependency-injected orchestration module (`_shared/po-scan-flow.ts`) that runs: cache lookup → quota check → cheap model → (one) escalation to the strong model → usage + cache write. All decisions (JSON parsing, sanity checks, cache key, ordering, error codes) live in pure `_shared` modules that vitest imports directly. The web client passes the new error `code` through and renders a notice plus a document preview instead of a red dead end.

**Tech Stack:** Supabase Edge Functions (Deno, TypeScript), Postgres + RLS, React 18 + Vite, vitest, Anthropic Messages API (Gemini only in an offline evaluation script).

**Spec:** `docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md` (read it first; this plan implements it). Related: `docs/superpowers/specs/2026-09-10-scan-credit-purchase-design.md` (not built; the flow order below is compatible with it).

## Global Constraints

- **Counting rule:** one successful document = one scan, whichever model read it. Rejected reads, failed calls, cache hits and the second pass are NOT counted. The `document_scan_usage` row and any credit draw are written only after a successful result.
- **Order inside one request:** auth gates (`is_admin_or_owner`, `has_module_access('purchase_orders')`) → cache lookup → quota check → model pass(es) → usage insert → cache write. A cache hit skips quota, usage and credit.
- **Error response shape:** `{ error: string, code: string }`. Codes and HTTP status: `quota_exhausted` 429, `ai_unavailable` 502, `unreadable` 422, `too_long` 502, `quota_check_failed` 500. Success body is the extraction object; `error` stays a human string so an old client keeps working.
- **Sanity checks:** JSON parses; `status` is not `"error"`; at least one line item; every line has quantity > 0 and a finite unit_price >= 0; if `printed_subtotal` is a number > 0, the sum of `quantity * unit_price * (1 - discount_pct/100)` must be within `max(1% of printed_subtotal, 5 baht)`.
- **Models:** strong = `claude-sonnet-5` (current, proven live 2026-10-05); cheap = `claude-haiku-4-5-20251001`. Verify both IDs against the API before deploy (Task 12). Cheap-first is behind the edge-function secret `PO_SCAN_CHEAP_FIRST` (`"true"` enables it; default off). This is how the spec's evaluation gate is enforced without a redeploy.
- **Time:** total budget 100 000 ms per request; a second pass starts only if less than 40 000 ms has elapsed.
- **User-facing text is Thai.** Reminder text in the PO form: `ตรวจรายการทุกครั้งก่อนบันทึก`.
- **Calibration examples:** cap of 3 per supplier unchanged (`saveSupplierDocumentExample` already inserts first, then prunes oldest).
- **Safety:** no secret in the repo or chat; migration is additive and nullable; `REVOKE ALL ... FROM anon` on the new table; Supabase project ref `kntspldhvcjeaubtqtkn` (CHANG), never Tokyo `yyzbgdmgyvvypfcjuhtr`; deploy exactly as `.claude/skills/chang-ship/SKILL.md` says (`npm run deploy`, never bare `wrangler deploy`).
- **Conventions:** `src/lib/*.test.js` imports `_shared/*.ts` with `'../../supabase/functions/_shared/<name>.ts'`; run tests with `npx vitest run`; commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs and failure modes the spec implies but a happy-path test would miss. Each line is pinned by a test in the task named in brackets.

1. The model wraps JSON in ``` fences or adds a sentence before/after it: parsing must still succeed. [Task 2]
2. `printed_subtotal` that includes VAT or reflects a document-level discount makes the check fail: the strong pass runs, and if the strong result still mismatches it is returned for the user to review (counted, not cached), never blocked. [Tasks 2, 4]
3. A cache hit while the tenant's quota is exhausted must be served free, with no usage row. [Task 4]
4. A response cut off by `max_tokens` must return `too_long`, skip the second pass, and not be counted. [Task 4]
5. The "save as supplier example" action must run only after the PO saved successfully; a failed example save must not undo or hide the saved PO. [Task 9]

Also covered: a cheap-model network/HTTP failure falls through to the strong model (Task 4); zero-quantity and negative-price lines fail the check (Task 2); string numbers with thousands separators parse (Task 2); a discounted line is no longer dropped by `validateExtraction` (Task 1).

---

### Task 1: Stop `validateExtraction` from dropping per-line discounts

Live bug found while planning: the edge function returns `discount_pct` per line (commit `12d9b67`), but `validateExtraction` in `src/lib/poDocumentExtraction.js` rebuilds each line without it, so the PO form always shows 0% and the swap modal's computed total ignores discounts (a discounted tax invoice can never match its expense). This task is independent and can ship on its own first.

**Files:**
- Modify: `src/lib/poDocumentExtraction.js` (function `validateExtraction`, around lines 31-65)
- Test: `src/lib/poDocumentExtraction.test.js`

**Interfaces:**
- Produces: `validateExtraction(raw)` now returns `data.line_items[i].discount_pct` (number 0..100, default 0) and `data.printed_subtotal` (number or null). Later tasks (swap modal, PO form, example builder) rely on both.

- [ ] **Step 1: Write the failing tests**

In `src/lib/poDocumentExtraction.test.js`, inside `describe('validateExtraction', ...)`, change the expected object of the first test to include `discount_pct: 0`:

```js
    expect(result.data.line_items).toEqual([
      { description: 'กรอบมุ้งบานเลื่อน 1.2 พ่นดำ-SMS', quantity: 3, unit: 'เส้น', unit_price: 353, discount_pct: 0 },
    ])
```

and add these tests at the end of the same `describe`:

```js
  it('keeps a per-line discount_pct, coercing numeric strings', () => {
    const result = validateExtraction({
      line_items: [
        { description: 'a', quantity: 1, unit: 'ชิ้น', unit_price: 10, discount_pct: 5 },
        { description: 'b', quantity: 1, unit: 'ชิ้น', unit_price: 10, discount_pct: '12.5' },
      ],
    })
    expect(result.data.line_items.map(it => it.discount_pct)).toEqual([5, 12.5])
  })

  it('defaults a missing or invalid discount_pct to 0 and clamps to 0..100', () => {
    const result = validateExtraction({
      line_items: [
        { description: 'a', quantity: 1, unit: 'x', unit_price: 10 },
        { description: 'b', quantity: 1, unit: 'x', unit_price: 10, discount_pct: 'abc' },
        { description: 'c', quantity: 1, unit: 'x', unit_price: 10, discount_pct: -5 },
        { description: 'd', quantity: 1, unit: 'x', unit_price: 10, discount_pct: 250 },
      ],
    })
    expect(result.data.line_items.map(it => it.discount_pct)).toEqual([0, 0, 0, 100])
  })

  it('keeps printed_subtotal when numeric and null otherwise', () => {
    expect(validateExtraction({ line_items: [], printed_subtotal: 1234.5 }).data.printed_subtotal).toBe(1234.5)
    expect(validateExtraction({ line_items: [], printed_subtotal: '1,200' }).data.printed_subtotal).toBeNull()
    expect(validateExtraction({ line_items: [] }).data.printed_subtotal).toBeNull()
  })
```

(`'1,200'` is intentionally null here: the client validator only accepts values the server already normalised.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: the three new tests and the edited first test FAIL (`discount_pct` undefined / `printed_subtotal` undefined).

- [ ] **Step 3: Implement**

In `src/lib/poDocumentExtraction.js`, add below `toFiniteNumber`:

```js
function toDiscountPct(v) {
  const n = toFiniteNumber(v)
  return n == null ? 0 : Math.min(100, Math.max(0, n))
}
```

In `validateExtraction`, change the returned line item and the returned data:

```js
      return {
        description,
        quantity: quantity ?? 0,
        unit: typeof it.unit === 'string' ? it.unit : '',
        unit_price: unit_price ?? 0,
        discount_pct: toDiscountPct(it.discount_pct),
      }
```

```js
      reference_no_guess: typeof raw.reference_no_guess === 'string' ? raw.reference_no_guess : null,
      printed_subtotal: typeof raw.printed_subtotal === 'number' && Number.isFinite(raw.printed_subtotal) ? raw.printed_subtotal : null,
      line_items,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npx vitest run`
Expected: all PASS.

```bash
git add src/lib/poDocumentExtraction.js src/lib/poDocumentExtraction.test.js
git commit -m "fix: keep per-line discount_pct and printed_subtotal in validateExtraction

The edge function returned discount_pct but the client validator rebuilt
each line without it, so scanned discounts never reached the PO form and
the swap-tax-invoice total ignored them.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure scan logic (parse, sanity checks, cache key)

**Files:**
- Create: `supabase/functions/_shared/scan-logic.ts`
- Test: `src/lib/scanLogic.test.js`

**Interfaces:**
- Produces (all exported from `scan-logic.ts`):
  - `type LineItem = { description: string; quantity: number; unit: string; unit_price: number; discount_pct: number }`
  - `type Extraction = { supplier_name_guess: string | null; document_date_guess: string | null; reference_no_guess: string | null; printed_subtotal: number | null; line_items: LineItem[] }`
  - `type Classified = { kind: 'reject' } | { kind: 'malformed' } | { kind: 'ok'; result: Extraction } | { kind: 'check_failed'; result: Extraction; reason: string }` where `reason` is one of `'no_items' | 'bad_item' | 'bad_quantity' | 'bad_price' | 'subtotal_mismatch'`
  - `parseModelJson(text: string): Record<string, unknown> | null`
  - `sumLineItems(items: LineItem[]): number` (rounded to 2 decimals)
  - `subtotalMatches(computed: number, printed: number): boolean`
  - `classifyModelOutput(text: string): Classified`
  - `sha256Hex(text: string): Promise<string>`
  - `scanCacheKey(input: { version: string; mimeType: string; imageBase64: string; examples: Array<{ mime_type: string; image_base64: string; extracted: unknown }> }): Promise<string>`
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/scanLogic.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  parseModelJson, sumLineItems, subtotalMatches, classifyModelOutput, sha256Hex, scanCacheKey,
} from '../../supabase/functions/_shared/scan-logic.ts'

const item = (over = {}) => ({ description: 'อลูมิเนียม', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0, ...over })
const out = (obj) => JSON.stringify({ status: 'success', line_items: [item()], ...obj })

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips ```json fences', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('finds the object when the model adds a sentence before and after', () => {
    expect(parseModelJson('Here is the result:\n{"a":1}\nHope that helps')).toEqual({ a: 1 })
  })
  it('returns null for garbage and for arrays', () => {
    expect(parseModelJson('no json here')).toBeNull()
    expect(parseModelJson('[1,2]')).toBeNull()
  })
})

describe('sumLineItems / subtotalMatches', () => {
  it('applies each line discount', () => {
    expect(sumLineItems([item({ quantity: 2, unit_price: 100, discount_pct: 10 }), item({ quantity: 1, unit_price: 50 })])).toBe(230)
  })
  it('accepts 5 baht slack on small totals', () => {
    expect(subtotalMatches(104, 100)).toBe(true)
    expect(subtotalMatches(106, 100)).toBe(false)
  })
  it('accepts 1% slack on large totals', () => {
    expect(subtotalMatches(100900, 100000)).toBe(true)
    expect(subtotalMatches(101100, 100000)).toBe(false)
  })
})

describe('classifyModelOutput', () => {
  it('treats status error as a reject', () => {
    expect(classifyModelOutput('{"status":"error","message":"unreadable_document_or_missing_table"}')).toEqual({ kind: 'reject' })
  })
  it('treats non-JSON and a missing line_items array as malformed', () => {
    expect(classifyModelOutput('sorry I cannot')).toEqual({ kind: 'malformed' })
    expect(classifyModelOutput('{"status":"success"}')).toEqual({ kind: 'malformed' })
  })
  it('accepts a good result and normalises it (status optional)', () => {
    const c = classifyModelOutput(JSON.stringify({ line_items: [item()], supplier_name_guess: ' ACME ' }))
    expect(c.kind).toBe('ok')
    expect(c.result.supplier_name_guess).toBe('ACME')
    expect(c.result.line_items).toEqual([item()])
    expect(c.result.printed_subtotal).toBeNull()
  })
  it('parses string numbers with thousands separators', () => {
    const c = classifyModelOutput(out({ line_items: [{ description: 'a', quantity: '2', unit: 'x', unit_price: '1,250.50' }] }))
    expect(c.kind).toBe('ok')
    expect(c.result.line_items[0].unit_price).toBe(1250.5)
  })
  it('flags an empty item list', () => {
    expect(classifyModelOutput(out({ line_items: [] }))).toMatchObject({ kind: 'check_failed', reason: 'no_items' })
  })
  it('flags zero quantity, negative price and blank description', () => {
    expect(classifyModelOutput(out({ line_items: [item({ quantity: 0 })] }))).toMatchObject({ kind: 'check_failed', reason: 'bad_quantity' })
    expect(classifyModelOutput(out({ line_items: [item({ unit_price: -1 })] }))).toMatchObject({ kind: 'check_failed', reason: 'bad_price' })
    expect(classifyModelOutput(out({ line_items: [item({ description: '  ' })] }))).toMatchObject({ kind: 'check_failed', reason: 'bad_item' })
  })
  it('flags a null price instead of silently using 0', () => {
    expect(classifyModelOutput(out({ line_items: [{ description: 'a', quantity: 1, unit: 'x', unit_price: null }] }))).toMatchObject({ kind: 'check_failed', reason: 'bad_price' })
  })
  it('passes when the printed subtotal matches the discounted sum', () => {
    const c = classifyModelOutput(out({ line_items: [item({ quantity: 2, unit_price: 100, discount_pct: 10 })], printed_subtotal: 180 }))
    expect(c.kind).toBe('ok')
  })
  it('flags a printed subtotal that does not match (e.g. it includes VAT)', () => {
    const c = classifyModelOutput(out({ printed_subtotal: 214 }))
    expect(c).toMatchObject({ kind: 'check_failed', reason: 'subtotal_mismatch' })
    expect(c.result.line_items).toHaveLength(1)
  })
  it('skips the subtotal check when none is printed (null or 0)', () => {
    expect(classifyModelOutput(out({ printed_subtotal: null })).kind).toBe('ok')
    expect(classifyModelOutput(out({ printed_subtotal: 0 })).kind).toBe('ok')
  })
  it('clamps discount_pct to 0..100 and defaults it to 0', () => {
    const c = classifyModelOutput(out({ line_items: [item({ discount_pct: 400 }), { description: 'b', quantity: 1, unit: 'x', unit_price: 5 }] }))
    expect(c.result.line_items.map(i => i.discount_pct)).toEqual([100, 0])
  })
})

describe('scanCacheKey', () => {
  const base = { version: 'v1', mimeType: 'image/jpeg', imageBase64: 'AAAA', examples: [] }
  it('is a stable 64-char hex string', async () => {
    const a = await scanCacheKey(base)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await scanCacheKey({ ...base })).toBe(a)
  })
  it('changes with the image, the mime type, the prompt version and the examples', async () => {
    const a = await scanCacheKey(base)
    expect(await scanCacheKey({ ...base, imageBase64: 'AAAB' })).not.toBe(a)
    expect(await scanCacheKey({ ...base, mimeType: 'application/pdf' })).not.toBe(a)
    expect(await scanCacheKey({ ...base, version: 'v2' })).not.toBe(a)
    const ex = { mime_type: 'image/jpeg', image_base64: 'BBBB', extracted: { line_items: [] } }
    expect(await scanCacheKey({ ...base, examples: [ex] })).not.toBe(a)
    expect(await scanCacheKey({ ...base, examples: [{ ...ex, extracted: { line_items: [1] } }] })).not.toBe(await scanCacheKey({ ...base, examples: [ex] }))
  })
  it('sha256Hex matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/scanLogic.test.js`
Expected: FAIL (cannot find module `scan-logic.ts`).

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/scan-logic.ts`:

```ts
// ============================================================
// Pure logic for the PO document scan (see
// docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md):
// parsing the model's JSON, the sanity checks that decide whether an
// answer is good enough, and the cache key. No I/O, so vitest imports
// it directly and the edge function reuses it unchanged.
// ============================================================

export type LineItem = { description: string; quantity: number; unit: string; unit_price: number; discount_pct: number }
export type Extraction = {
  supplier_name_guess: string | null
  document_date_guess: string | null
  reference_no_guess: string | null
  printed_subtotal: number | null
  line_items: LineItem[]
}
export type Classified =
  | { kind: 'reject' }
  | { kind: 'malformed' }
  | { kind: 'ok'; result: Extraction }
  | { kind: 'check_failed'; result: Extraction; reason: string }

export const SUBTOTAL_TOLERANCE_PCT = 0.01
export const SUBTOTAL_TOLERANCE_MIN_BAHT = 5

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Models sometimes wrap JSON in ``` fences or add a sentence around it --
 *  strip fences, and if the text still is not JSON, try the outermost {...}. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  try {
    return asObject(JSON.parse(cleaned))
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return asObject(JSON.parse(cleaned.slice(start, end + 1)))
    } catch {
      return null
    }
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function sumLineItems(items: LineItem[]): number {
  const total = items.reduce((s, it) => s + it.quantity * it.unit_price * (1 - it.discount_pct / 100), 0)
  return Math.round(total * 100) / 100
}

export function subtotalMatches(computed: number, printed: number): boolean {
  return Math.abs(computed - printed) <= Math.max(printed * SUBTOTAL_TOLERANCE_PCT, SUBTOTAL_TOLERANCE_MIN_BAHT)
}

export function classifyModelOutput(text: string): Classified {
  const obj = parseModelJson(text)
  if (!obj) return { kind: 'malformed' }
  if (obj.status === 'error') return { kind: 'reject' }
  if (!Array.isArray(obj.line_items)) return { kind: 'malformed' }

  const problems: string[] = []
  const line_items: LineItem[] = []
  for (const raw of obj.line_items) {
    const r = asObject(raw) ?? {}
    const description = str(r.description) ?? ''
    const quantity = num(r.quantity)
    const unit_price = num(r.unit_price)
    const discount = num(r.discount_pct)
    if (!description) problems.push('bad_item')
    if (quantity == null || quantity <= 0) problems.push('bad_quantity')
    if (unit_price == null || unit_price < 0) problems.push('bad_price')
    line_items.push({
      description,
      quantity: quantity ?? 0,
      unit: typeof r.unit === 'string' ? r.unit : '',
      unit_price: unit_price ?? 0,
      discount_pct: discount == null ? 0 : Math.min(100, Math.max(0, discount)),
    })
  }

  const result: Extraction = {
    supplier_name_guess: str(obj.supplier_name_guess),
    document_date_guess: str(obj.document_date_guess),
    reference_no_guess: str(obj.reference_no_guess),
    printed_subtotal: num(obj.printed_subtotal),
    line_items,
  }

  if (line_items.length === 0) return { kind: 'check_failed', result, reason: 'no_items' }
  if (problems.length) return { kind: 'check_failed', result, reason: problems[0] }
  if (result.printed_subtotal != null && result.printed_subtotal > 0 && !subtotalMatches(sumLineItems(line_items), result.printed_subtotal)) {
    return { kind: 'check_failed', result, reason: 'subtotal_mismatch' }
  }
  return { kind: 'ok', result }
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Cache key for one scan request. Hashes the document, the mime type, the
 *  prompt version and every calibration example (image + saved result), so
 *  changing the prompt or a supplier's examples never serves a stale answer. */
export async function scanCacheKey(input: {
  version: string
  mimeType: string
  imageBase64: string
  examples: Array<{ mime_type: string; image_base64: string; extracted: unknown }>
}): Promise<string> {
  const parts = [input.version, await sha256Hex(`${input.mimeType}\n${input.imageBase64}`)]
  for (const ex of input.examples) {
    parts.push(await sha256Hex(`${ex.mime_type}\n${ex.image_base64}\n${JSON.stringify(ex.extracted)}`))
  }
  return sha256Hex(parts.join('|'))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/scanLogic.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/scan-logic.ts src/lib/scanLogic.test.js
git commit -m "feat: pure scan logic (JSON parsing, sanity checks, cache key)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Merged system prompt

**Files:**
- Create: `supabase/functions/_shared/po-extract-prompt.ts`
- Test: `src/lib/poExtractPrompt.test.js`

**Interfaces:**
- Produces: `PROMPT_VERSION: string` (bump it whenever the prompt text changes; it is part of the cache key) and `SYSTEM_PROMPT: string`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/poExtractPrompt.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../../supabase/functions/_shared/po-extract-prompt.ts'

describe('SYSTEM_PROMPT', () => {
  it('names every field the app and the sanity checks depend on', () => {
    for (const key of ['"status"', 'supplier_name_guess', 'document_date_guess', 'reference_no_guess', 'printed_subtotal', 'line_items', 'description', 'quantity', 'unit', 'unit_price', 'discount_pct']) {
      expect(SYSTEM_PROMPT).toContain(key)
    }
  })
  it('defines the reject shape exactly as the code expects it', () => {
    expect(SYSTEM_PROMPT).toContain('"status": "error"')
    expect(SYSTEM_PROMPT).toContain('unreadable_document_or_missing_table')
  })
  it('forbids the model from calculating totals and from using markdown fences', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never calculate totals/)
    expect(SYSTEM_PROMPT).toMatch(/No markdown fences/)
  })
  it('has a non-empty prompt version', () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/poExtractPrompt.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/po-extract-prompt.ts`:

```ts
// ============================================================
// System prompt for extract-po-document. Merges the owner's reference
// prompt (strict JSON, explicit reject path; kept in the user-level skill
// document-extraction-prompt) with the fields the app already depends on
// (supplier/date/reference guesses, per-line discount_pct) and the new
// printed_subtotal used by the sanity check. Input is the document image
// or PDF itself (no OCR step), so the examples are described in words.
// Bump PROMPT_VERSION whenever the text below changes: it is part of the
// cache key, so a stale cached answer is never served for a new prompt.
// ============================================================

export const PROMPT_VERSION = '2026-10-05-v1'

export const SYSTEM_PROMPT = `You are a highly accurate data extraction agent. You read Thai and English supplier documents (delivery notes, provisional invoices, tax invoices, quotations, purchase requests; often dot-matrix printed or photographed) and extract the header information and the line-item table.

# Rules
1. For each item extract: description, quantity, unit, unit_price, and that row's own discount_pct.
2. Never calculate totals yourself. printed_subtotal is only a value you READ from the document.
3. If the document is unreadable (blurry, garbage) or has no clear table of items with quantities and prices, reject it.
4. Respond with ONLY a JSON object. No markdown fences, no greetings, no commentary.

# Success shape
{
  "status": "success",
  "supplier_name_guess": string or null,
  "document_date_guess": string or null (ISO YYYY-MM-DD, best effort from any date printed on the document),
  "reference_no_guess": string or null (document/invoice number as printed, e.g. "IV6909/08046"),
  "printed_subtotal": number or null (the goods total BEFORE VAT exactly as printed; null if no such line is printed or it is unclear),
  "line_items": [
    { "description": string, "quantity": number, "unit": string, "unit_price": number, "discount_pct": number }
  ]
}

# Reject shape
{ "status": "error", "message": "unreadable_document_or_missing_table" }

# Field rules
- unit_price is the price per single unit AS PRINTED, before applying that row's own discount_pct and before VAT. It is not the line total and not a value you already discounted in your head.
- discount_pct is that row's own discount percentage, read from a discount column or notation next to THAT row only (e.g. "5%", "ลด 5%"). Many documents discount only some rows; a discount printed next to one item is never evidence that other items are discounted. A row with no discount printed has discount_pct 0, never null.
- Numbers are plain numbers: no thousands separators, no currency words.
- Keep Thai text as printed in "unit" (e.g. เส้น, ชิ้น, ชุด, แผ่น, ตร.ม.).
- Use null (not a guess) for header fields you cannot determine.
- Include every goods/materials line. Skip signature lines, totals, VAT rows and boilerplate footer text.

# Examples (described in words; the real input is an image)
- A quotation listing "อลูมิเนียมกล่อง 1x1 นิ้ว สีดำ 50 เส้น 250.00" and "กระจกใส 6 มม. 15 ตร.ม. 450" gives two line_items: (อลูมิเนียมกล่อง 1x1 นิ้ว สีดำ, 50, เส้น, 250, 0) and (กระจกใส 6 มม., 15, ตร.ม., 450, 0).
- A photo too blurry to read, or one that shows no item table, gives the reject shape.`
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/poExtractPrompt.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/po-extract-prompt.ts src/lib/poExtractPrompt.test.js
git commit -m "feat: merged PO extraction system prompt with reject path and printed_subtotal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Scan orchestration (`runScan`)

**Files:**
- Create: `supabase/functions/_shared/po-scan-flow.ts`
- Test: `src/lib/poScanFlow.test.js`

**Interfaces:**
- Consumes (Task 2): `classifyModelOutput`, `type Extraction` from `./scan-logic.ts`.
- Produces:
  - `TIME_BUDGET_MS = 100_000`, `ESCALATE_ONLY_BEFORE_MS = 40_000`
  - `type ModelCall = { ok: true; text: string; stopReason: string | null; inputTokens: number | null; outputTokens: number | null } | { ok: false; detail: string }`
  - `type ScanDeps = { cheapFirst: boolean; cheapModel: string; strongModel: string; now(): number; lookupCache(key: string): Promise<Extraction | null>; storeCache(key: string, result: Extraction): Promise<void>; checkQuota(): Promise<{ ok: true; allowed: boolean } | { ok: false }>; callModel(model: string, deadlineMs: number): Promise<ModelCall>; recordUsage(info: { model: string; inputTokens: number | null; outputTokens: number | null }): Promise<void> }`
  - `type ScanOutcome = { status: number; body: Record<string, unknown> }`
  - `runScan(deps: ScanDeps, cacheKey: string): Promise<ScanOutcome>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/poScanFlow.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { runScan, ESCALATE_ONLY_BEFORE_MS } from '../../supabase/functions/_shared/po-scan-flow.ts'

const GOOD = JSON.stringify({ status: 'success', supplier_name_guess: 'ACME', line_items: [{ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0 }], printed_subtotal: 200 })
const MISMATCH = JSON.stringify({ status: 'success', line_items: [{ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0 }], printed_subtotal: 999 })
const REJECT = JSON.stringify({ status: 'error', message: 'unreadable_document_or_missing_table' })
const EMPTY = JSON.stringify({ status: 'success', line_items: [] })
const ok = (text, extra = {}) => ({ ok: true, text, stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, ...extra })

function makeDeps(over = {}) {
  const log = { models: [], usage: [], cacheStored: [], quotaCalls: 0 }
  const clock = { t: 0 }
  const queues = { cheap: [], strong: [], ...(over.queues || {}) }
  const deps = {
    cheapFirst: false, cheapModel: 'cheap', strongModel: 'strong',
    now: () => clock.t,
    lookupCache: async () => { if (over.cacheThrows) throw new Error('db down'); return over.cached ?? null },
    storeCache: async (k, r) => { if (over.storeThrows) throw new Error('db down'); log.cacheStored.push([k, r]) },
    checkQuota: async () => { log.quotaCalls++; return over.quota ?? { ok: true, allowed: true } },
    callModel: async (model) => { log.models.push(model); clock.t += over.callMs ?? 0; return queues[model].shift() },
    recordUsage: async (u) => { if (over.usageThrows) throw new Error('db down'); log.usage.push(u) },
    ...(over.deps || {}),
  }
  return { deps, log, clock }
}

describe('runScan', () => {
  it('serves a cache hit with no quota check, no model call and no usage', async () => {
    const cached = { line_items: [], supplier_name_guess: 'X', document_date_guess: null, reference_no_guess: null, printed_subtotal: null }
    const { deps, log } = makeDeps({ cached, quota: { ok: true, allowed: false } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.cache_hit).toBe(true)
    expect(log.quotaCalls).toBe(0)
    expect(log.models).toEqual([])
    expect(log.usage).toEqual([])
  })

  it('falls through to a normal scan when the cache lookup throws', async () => {
    const { deps, log } = makeDeps({ cacheThrows: true, queues: { strong: [ok(GOOD)] } })
    expect((await runScan(deps, 'k')).status).toBe(200)
    expect(log.models).toEqual(['strong'])
  })

  it('returns 500 quota_check_failed when the quota RPC fails, without calling a model', async () => {
    const { deps, log } = makeDeps({ quota: { ok: false } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 500, body: { code: 'quota_check_failed' } })
    expect(log.models).toEqual([])
  })

  it('returns 429 quota_exhausted when the tenant is over quota', async () => {
    const { deps, log } = makeDeps({ quota: { ok: true, allowed: false } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 429, body: { code: 'quota_exhausted' } })
    expect(log.models).toEqual([])
  })

  it('with cheap-first off, uses only the strong model, records usage once and caches the result', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'key1')
    expect(r.status).toBe(200)
    expect(r.body.model_used).toBe('strong')
    expect(r.body.line_items).toHaveLength(1)
    expect(log.models).toEqual(['strong'])
    expect(log.usage).toEqual([{ model: 'strong', inputTokens: 100, outputTokens: 50 }])
    expect(log.cacheStored).toHaveLength(1)
    expect(log.cacheStored[0][0]).toBe('key1')
  })

  it('with cheap-first on, a good cheap answer never reaches the strong model', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r.body.model_used).toBe('cheap')
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([{ model: 'cheap', inputTokens: 100, outputTokens: 50 }])
  })

  it('escalates once when the cheap answer fails a check, and sums tokens across both calls', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(MISMATCH)], strong: [ok(GOOD, { inputTokens: 300, outputTokens: 80 })] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.model_used).toBe('strong')
    expect(log.models).toEqual(['cheap', 'strong'])
    expect(log.usage).toEqual([{ model: 'strong', inputTokens: 400, outputTokens: 130 }])
  })

  it('escalates when the cheap model call itself fails (network or HTTP error)', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [{ ok: false, detail: 'boom' }], strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(log.models).toEqual(['cheap', 'strong'])
  })

  it('escalates when the cheap model rejects, and returns unreadable only if the strong model also rejects', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(REJECT)], strong: [ok(REJECT)] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 422, body: { code: 'unreadable' } })
    expect(log.models).toEqual(['cheap', 'strong'])
    expect(log.usage).toEqual([])
    expect(log.cacheStored).toEqual([])
  })

  it('returns the strong result for review (counted, not cached) when it still fails the subtotal check', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(MISMATCH)] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.line_items).toHaveLength(1)
    expect(log.usage).toHaveLength(1)
    expect(log.cacheStored).toEqual([])
  })

  it('returns unreadable when the final answer has no line items', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(EMPTY)] } })
    expect(await runScan(deps, 'k')).toMatchObject({ status: 422, body: { code: 'unreadable' } })
    expect(log.usage).toEqual([])
  })

  it('returns too_long and skips the second pass when the answer was cut off by max_tokens', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok('{"line_items":[', { stopReason: 'max_tokens' })] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'too_long' } })
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([])
  })

  it('does not start a second pass once too much time has passed, and answers ai_unavailable', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, callMs: ESCALATE_ONLY_BEFORE_MS + 1, queues: { cheap: [ok(MISMATCH)], strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([])
  })

  it('returns ai_unavailable (with the API detail) when the strong call fails', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [{ ok: false, detail: 'AI API error: authentication_error' }] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
    expect(String(r.body.error)).toContain('authentication_error')
    expect(log.usage).toEqual([])
  })

  it('returns ai_unavailable when the strong answer is not JSON', async () => {
    const { deps } = makeDeps({ queues: { strong: [ok('sorry, no')] } })
    expect(await runScan(deps, 'k')).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
  })

  it('still succeeds when writing usage or the cache fails', async () => {
    const { deps } = makeDeps({ usageThrows: true, storeThrows: true, queues: { strong: [ok(GOOD)] } })
    expect((await runScan(deps, 'k')).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/poScanFlow.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/po-scan-flow.ts`:

```ts
// ============================================================
// Orchestration for one PO document scan, with every side effect
// injected so the ORDER of steps is unit-testable (see
// docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md,
// "Relationship to the scan-credit purchase design"):
//   cache -> quota -> model pass(es) -> usage + cache write.
// A cache hit skips quota/usage entirely; usage is written only for a
// result that is returned to the user.
// ============================================================
import { classifyModelOutput, type Extraction } from './scan-logic.ts'

export const TIME_BUDGET_MS = 100_000
export const ESCALATE_ONLY_BEFORE_MS = 40_000

export type ModelCall =
  | { ok: true; text: string; stopReason: string | null; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; detail: string }

export type ScanDeps = {
  cheapFirst: boolean
  cheapModel: string
  strongModel: string
  now(): number
  lookupCache(key: string): Promise<Extraction | null>
  storeCache(key: string, result: Extraction): Promise<void>
  checkQuota(): Promise<{ ok: true; allowed: boolean } | { ok: false }>
  callModel(model: string, deadlineMs: number): Promise<ModelCall>
  recordUsage(info: { model: string; inputTokens: number | null; outputTokens: number | null }): Promise<void>
}

export type ScanOutcome = { status: number; body: Record<string, unknown> }

const QUOTA_MSG = 'ใช้โควต้าการสแกนเอกสารในเดือนนี้ครบแล้ว กรุณาอัพเกรดแพ็กเกจหรือรอรอบเดือนถัดไป'
const TOO_LONG_MSG = 'เอกสารนี้มีรายการเยอะเกินไป AI ตอบไม่ทันจบภายในขีดจำกัด กรุณาสแกนทีละหน้า/ทีละส่วนที่มีตารางรายการ หรือกรอกใบสั่งซื้อด้วยตนเอง'
const UNREADABLE_MSG = 'อ่านเอกสารนี้ไม่ออก (ภาพไม่ชัดหรือไม่พบตารางรายการ) กรุณาถ่ายใหม่ให้ชัดขึ้น หรือกรอกใบสั่งซื้อด้วยตนเอง'
const MALFORMED_MSG = 'อ่านผลลัพธ์จาก AI ไม่สำเร็จ (ไม่ใช่ JSON ที่ถูกต้อง)'
const CHECK_FAILED_MSG = 'ผลลัพธ์จาก AI ไม่ผ่านการตรวจความถูกต้อง'

const fail = (status: number, code: string, error: string): ScanOutcome => ({ status, body: { error, code } })

export async function runScan(deps: ScanDeps, cacheKey: string): Promise<ScanOutcome> {
  const cached = await deps.lookupCache(cacheKey).catch(() => null)
  if (cached) return { status: 200, body: { ...cached, cache_hit: true } }

  const quota = await deps.checkQuota()
  if (!quota.ok) return fail(500, 'quota_check_failed', 'ตรวจสอบโควต้าไม่สำเร็จ')
  if (!quota.allowed) return fail(429, 'quota_exhausted', QUOTA_MSG)

  const start = deps.now()
  const deadline = start + TIME_BUDGET_MS
  const models = deps.cheapFirst ? [deps.cheapModel, deps.strongModel] : [deps.strongModel]
  let inputTokens = 0
  let outputTokens = 0
  let sawTokens = false
  let lastFailure: ScanOutcome = fail(502, 'ai_unavailable', 'เรียก AI ไม่สำเร็จ')

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const isLast = i === models.length - 1
    if (i > 0 && deps.now() - start > ESCALATE_ONLY_BEFORE_MS) break

    const call = await deps.callModel(model, deadline)
    if (!call.ok) {
      lastFailure = fail(502, 'ai_unavailable', `เรียก AI ไม่สำเร็จ: ${call.detail}`)
      continue
    }
    if (call.inputTokens != null || call.outputTokens != null) {
      sawTokens = true
      inputTokens += call.inputTokens ?? 0
      outputTokens += call.outputTokens ?? 0
    }
    if (call.stopReason === 'max_tokens') return fail(502, 'too_long', TOO_LONG_MSG)

    const c = classifyModelOutput(call.text)
    // Accept a clean answer from any pass; accept a check-failed answer only
    // from the LAST pass (the user reviews it), and never an empty one.
    if (c.kind === 'ok' || (isLast && c.kind === 'check_failed' && c.reason !== 'no_items')) {
      await deps.recordUsage({
        model,
        inputTokens: sawTokens ? inputTokens : null,
        outputTokens: sawTokens ? outputTokens : null,
      }).catch(() => {})
      if (c.kind === 'ok') await deps.storeCache(cacheKey, c.result).catch(() => {})
      return { status: 200, body: { ...c.result, model_used: model } }
    }

    if (c.kind === 'reject') lastFailure = fail(422, 'unreadable', UNREADABLE_MSG)
    else if (c.kind === 'check_failed') {
      lastFailure = c.reason === 'no_items' ? fail(422, 'unreadable', UNREADABLE_MSG) : fail(502, 'ai_unavailable', CHECK_FAILED_MSG)
    } else lastFailure = fail(502, 'ai_unavailable', MALFORMED_MSG)
  }
  return lastFailure
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/poScanFlow.test.js`
Expected: all PASS. If a test fails, fix `po-scan-flow.ts` (the tests encode the spec), not the test.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/po-scan-flow.ts src/lib/poScanFlow.test.js
git commit -m "feat: runScan orchestration (cache, quota, cheap-then-strong, usage after success)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Migration (`model_used` column and result cache table)

**Files:**
- Create: `supabase/migrations/2026-10-05-01-po-scan-cache-and-model-used.sql`

**Interfaces:**
- Produces: column `document_scan_usage.model_used TEXT NULL`; table `scan_result_cache(id, tenant_id, cache_key, result, created_at)` with `UNIQUE (tenant_id, cache_key)` (constraint columns are exactly `tenant_id, cache_key`; Task 6 upserts with `onConflict: 'tenant_id,cache_key'`).
- Findings from the live DB (2026-10-05): no view references `document_scan_usage`; two functions do (`tenant_under_document_scan_limit`, `tenant_document_scan_usage_this_month`) and only count rows, so a new nullable column is safe. The existing `admin_full_access` policy on `document_scan_usage` is `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')`; the new table mirrors it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-10-05-01-po-scan-cache-and-model-used.sql`:

```sql
-- PO document scan: record which model read a document, and cache successful
-- reads per tenant so a re-upload of the same file is free.
-- Spec: docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md
-- Additive and nullable only. No view references document_scan_usage (checked
-- 2026-10-05), so the new column cannot hit the view column-freeze trap.

ALTER TABLE document_scan_usage ADD COLUMN IF NOT EXISTS model_used TEXT;

CREATE TABLE IF NOT EXISTS scan_result_cache (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key  TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cache_key)
);

ALTER TABLE scan_result_cache ENABLE ROW LEVEL SECURITY;

-- Same gate as document_scan_usage: only the tenant's own admins/owners on a
-- package that includes purchase orders can read or write it.
DROP POLICY IF EXISTS admin_full_access ON scan_result_cache;
CREATE POLICY admin_full_access ON scan_result_cache FOR ALL
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- Hygiene: Supabase's default grants give anon full table privileges; RLS
-- already blocks it, but this table has no reason to be reachable by anon.
REVOKE ALL ON scan_result_cache FROM anon;
```

- [ ] **Step 2: Dry-run the migration in a transaction that cannot persist**

Run this one statement with the Supabase MCP `execute_sql` on project `kntspldhvcjeaubtqtkn` (paste the migration body between `BEGIN;` and the `DO` block). It always raises, so nothing persists:

```sql
BEGIN;
-- <paste the full migration file body here>
DO $$
DECLARE r text;
BEGIN
  SELECT string_agg(x, ', ' ORDER BY x) INTO r FROM (
    SELECT 'col:' || column_name x FROM information_schema.columns WHERE table_name = 'document_scan_usage' AND column_name = 'model_used'
    UNION ALL SELECT 'table:' || table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scan_result_cache'
    UNION ALL SELECT 'policy:' || policyname FROM pg_policies WHERE tablename = 'scan_result_cache'
    UNION ALL SELECT 'uniq:' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.scan_result_cache'::regclass AND contype = 'u'
    UNION ALL SELECT 'anon_priv:' || privilege_type FROM information_schema.role_table_grants WHERE table_name = 'scan_result_cache' AND grantee = 'anon'
  ) s;
  RAISE EXCEPTION 'RESULT %', r;
END $$;
```

Expected error text: `RESULT col:model_used, policy:admin_full_access, table:scan_result_cache, uniq:UNIQUE (tenant_id, cache_key)` and **no** `anon_priv:` entries. If `anon_priv:` appears, the REVOKE did not take effect: fix the migration.

- [ ] **Step 3: Commit (do NOT apply yet)**

The migration is applied in Task 12, before the function deploy. Applying it later keeps the plan's order safe: migration, then function, then web.

```bash
git add supabase/migrations/2026-10-05-01-po-scan-cache-and-model-used.sql
git commit -m "feat: migration for scan_result_cache and document_scan_usage.model_used

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Edge function adapter

**Files:**
- Modify (rewrite): `supabase/functions/extract-po-document/index.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROMPT`, `PROMPT_VERSION` (Task 3); `scanCacheKey`, `type Extraction` (Task 2); `runScan`, `type ModelCall`, `type ScanDeps` (Task 4); table `scan_result_cache` and column `document_scan_usage.model_used` (Task 5).
- Produces: HTTP contract: request body unchanged (`{ image_base64, mime_type, examples? }`); success body is the Extraction plus `model_used` and optionally `cache_hit`; errors are `{ error, code }` as listed in Global Constraints.

There is no unit test for this file (it is I/O glue; all decisions are tested in Tasks 2-4). Verification is Task 12's live check.

- [ ] **Step 1: Replace the file with the adapter**

Overwrite `supabase/functions/extract-po-document/index.ts` with:

```ts
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
    return { ok: false, detail: String(e) }
  }
  if (!res.ok) {
    const errText = await res.text()
    return { ok: false, detail: `AI API error: ${errText.slice(0, 500)}` }
  }
  const j = await res.json()
  // The model can return a leading `thinking` content block before its
  // actual text response -- find the first text block by type.
  const block = Array.isArray(j?.content) ? j.content.find((b: { type?: string }) => b?.type === 'text') : null
  if (typeof block?.text !== 'string') return { ok: false, detail: 'AI ไม่ได้ตอบกลับเป็นข้อความ' }
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

  const outcome = await runScan(deps, cacheKey)
  return json(outcome.body, outcome.status)
})
```

- [ ] **Step 2: Type-check what can be checked offline**

Run: `npx vitest run`
Expected: all tests PASS (the shared modules are imported by tests; the adapter is not).
Then, if Deno is installed (`which deno`), run `deno check supabase/functions/extract-po-document/index.ts` and expect no errors. If Deno is not installed, skip this: the first real type check is the deploy in Task 12.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/extract-po-document/index.ts
git commit -m "feat: extract-po-document adapter around runScan (cache, cheap-first switch, error codes)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Client error codes and notice text

**Files:**
- Modify: `src/hooks/useSupabase.js` (function `extractPoDocument`, around lines 1649-1672)
- Create: `src/lib/scanNotice.js`
- Test: `src/lib/scanNotice.test.js`

**Interfaces:**
- Produces:
  - `extractPoDocument(base64, mimeType, examples)` now resolves `{ ok: false, error: string, code: string | null }` on failure (success shape unchanged).
  - `scanErrorNotice(code: string | null | undefined, message?: string): { text: string }`
  - `SCAN_REMINDER: string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/scanNotice.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { scanErrorNotice, SCAN_REMINDER } from './scanNotice.js'

describe('scanErrorNotice', () => {
  it('tells the user to type the lines themselves for every known code', () => {
    for (const code of ['quota_exhausted', 'ai_unavailable', 'unreadable', 'too_long']) {
      expect(scanErrorNotice(code).text).toMatch(/กรอก/)
    }
  })
  it('points a quota-exhausted tenant at the package settings', () => {
    expect(scanErrorNotice('quota_exhausted').text).toMatch(/ตั้งค่า/)
  })
  it('suggests retaking the photo when the document is unreadable', () => {
    expect(scanErrorNotice('unreadable').text).toMatch(/ถ่ายใหม่/)
  })
  it('falls back to the server message for an unknown or missing code', () => {
    expect(scanErrorNotice(null, 'Error: boom').text).toBe('Error: boom')
    expect(scanErrorNotice('something_new', 'custom').text).toBe('custom')
  })
  it('has a generic fallback when there is no message either', () => {
    expect(scanErrorNotice(undefined).text).toMatch(/กรอก/)
  })
  it('exposes the reminder shown after a scan', () => {
    expect(SCAN_REMINDER).toBe('ตรวจรายการทุกครั้งก่อนบันทึก')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/scanNotice.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/lib/scanNotice.js`:

```js
// ============================================================
// User-facing text for a PO document scan that could not be read
// automatically. Codes come from the extract-po-document edge function
// (see docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md).
// Every message ends the same way: the user can still type the lines in,
// using the document preview shown above the item list.
// ============================================================

export const SCAN_REMINDER = 'ตรวจรายการทุกครั้งก่อนบันทึก'

const NOTICES = {
  quota_exhausted: 'โควต้าสแกนเอกสารเดือนนี้ครบแล้ว กรอกรายการเองจากเอกสารด้านบนได้เลย หรืออัปเกรดแพ็กเกจที่เมนูตั้งค่า',
  ai_unavailable: 'ระบบอ่านเอกสารอัตโนมัติใช้ไม่ได้ในตอนนี้ ลองใหม่ภายหลัง หรือกรอกรายการเองจากเอกสารด้านบน',
  unreadable: 'อ่านเอกสารไม่ออก ลองถ่ายใหม่ให้ชัดขึ้น หรือกรอกรายการเองจากเอกสารด้านบน',
  too_long: 'เอกสารนี้มีรายการเยอะเกินไป ลองสแกนทีละหน้า หรือกรอกรายการเองจากเอกสารด้านบน',
}

export function scanErrorNotice(code, message) {
  if (code && NOTICES[code]) return { text: NOTICES[code] }
  return { text: message || 'อ่านเอกสารไม่สำเร็จ กรอกรายการเองได้' }
}
```

In `src/hooks/useSupabase.js`, replace the body of the `if (error) { ... }` block inside `extractPoDocument` with:

```js
    if (error) {
      let message = error.message
      let code = null
      try {
        const body = await error.context?.json()
        if (body?.error) message = body.error
        if (body?.code) code = body.code
      } catch {
        // context unreadable/not JSON -- fall back to the generic message above
      }
      return { ok: false, error: message, code }
    }
```

and change the final catch to `return { ok: false, error: e.message, code: null }`. Update the doc comment above the function so its "returns" line says `{ ok, data | error, code }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanNotice.js src/lib/scanNotice.test.js src/hooks/useSupabase.js
git commit -m "feat: pass scan error codes to the client and add notice text

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Document preview and notice in the PO form

**Files:**
- Create: `src/components/ScanDocPreview.jsx`, `src/components/ScanNotice.jsx`
- Modify: `src/pages/PurchaseOrders.jsx` (imports at the top; `PurchaseOrderForm` state and `handleScanUpload` around lines 177-241; the upload block around lines 273-279)

**Interfaces:**
- Consumes (Task 7): `scanErrorNotice`, `SCAN_REMINDER`; `extractPoDocument` returning `code`.
- Produces: `<ScanDocPreview file={File | null} />` and `<ScanNotice code message />`, both reused by Task 9. In `PurchaseOrderForm`, new state `scanFile`, `scanCode`, `scanPayload` (`{ base64, mimeType, reference_no_guess } | null`), reused by Task 10.

These are browser-only UI; no unit test (the repo has no component test setup). Verification is the live check in Task 12.

- [ ] **Step 1: Create the components**

Create `src/components/ScanDocPreview.jsx`:

```jsx
import { useEffect, useState } from 'react'

/** Collapsible preview of the document the user just uploaded, so a scan
 *  that could not be read automatically never leaves them without the
 *  source to type the lines from. Folded by default on narrow screens. */
export default function ScanDocPreview({ file }) {
  const [url, setUrl] = useState(null)
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768)

  useEffect(() => {
    if (!file) { setUrl(null); return undefined }
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  if (!file || !url) return null
  const isPdf = file.type === 'application/pdf'
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginTop: 8 }}>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(o => !o)}>
        {open ? '🙈 ซ่อนเอกสาร' : '📄 ดูเอกสาร'}
      </button>
      {open && (isPdf ? (
        <object data={url} type="application/pdf" style={{ width: '100%', height: 420, marginTop: 8 }}>
          เปิดไฟล์ PDF ในหน้านี้ไม่ได้ <a href={url} target="_blank" rel="noreferrer">เปิดในแท็บใหม่</a>
        </object>
      ) : (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="เอกสารที่อัปโหลด" style={{ width: '100%', maxHeight: 420, objectFit: 'contain', marginTop: 8 }} />
        </a>
      ))}
    </div>
  )
}
```

Create `src/components/ScanNotice.jsx`:

```jsx
import { scanErrorNotice } from '../lib/scanNotice.js'

/** Yellow notice for a scan that could not be read automatically. Replaces
 *  the old red error box: the user can still enter the lines by hand. */
export default function ScanNotice({ code, message }) {
  const { text } = scanErrorNotice(code, message)
  return (
    <div role="status" style={{ marginTop: 6, padding: 10, borderRadius: 8, fontSize: 13, background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.5)' }}>
      {text}
    </div>
  )
}
```

- [ ] **Step 2: Wire them into `PurchaseOrderForm`**

In `src/pages/PurchaseOrders.jsx`:

1. Add imports next to the existing `poDocumentExtraction.js` import:

```jsx
import ScanDocPreview from '../components/ScanDocPreview.jsx'
import ScanNotice from '../components/ScanNotice.jsx'
import { SCAN_REMINDER } from '../lib/scanNotice.js'
```

2. In `PurchaseOrderForm`, next to `const [scanError, setScanError] = useState(null)` add:

```jsx
  const [scanCode, setScanCode] = useState(null)
  const [scanFile, setScanFile] = useState(null)
  const [scanPayload, setScanPayload] = useState(null) // { base64, mimeType, reference_no_guess } after a successful scan
```

3. In `handleScanUpload`, replace the lines from `e.target.value = ''` through `setScanning(true)` with:

```jsx
    e.target.value = ''
    setScanError(null)
    setScanCode(null)
    setScanPayload(null)
    setScanFile(file)
    setScanning(true)
```

and replace `if (!result.ok) { setScanError(result.error); return }` with:

```jsx
      if (!result.ok) { setScanError(result.error); setScanCode(result.code || null); return }
      setScanPayload({ base64, mimeType, reference_no_guess: result.data.reference_no_guess })
```

4. In the render, replace `{scanError && <div className="alert alert-error" style={{ marginTop: 6 }}>{scanError}</div>}` with:

```jsx
          {scanError && <ScanNotice code={scanCode} message={scanError} />}
          {scanFile && <ScanDocPreview file={scanFile} />}
          {scanFile && !scanning && <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{SCAN_REMINDER}</div>}
```

- [ ] **Step 3: Build and run the tests**

Run: `npx vitest run && npm run build`
Expected: tests PASS; build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ScanDocPreview.jsx src/components/ScanNotice.jsx src/pages/PurchaseOrders.jsx
git commit -m "feat: show the uploaded document and a notice when a PO scan cannot be read

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Swap-tax-invoice modal (examples, preview, manual entry)

**Files:**
- Modify: `src/pages/PurchaseOrders.jsx` (`SwapTaxInvoiceModal`, around lines 519-625)

**Interfaces:**
- Consumes: `useSupplierDocumentExamples(supplierId)` (already imported in this file), `ScanDocPreview`, `ScanNotice` (Task 8), `extractPoDocument` returning `code` (Task 7).
- Produces: nothing new for later tasks.

Behaviour: the modal passes the PO supplier's saved examples to the scan; shows the document preview; on any scan failure shows the notice plus two manual fields (invoice number and amount before VAT). The manual path sets `extracted` so the **existing amount-match safeguard** (±1% / 5 baht against the expense's `amount_no_vat`) still gates the save.

- [ ] **Step 1: Edit the modal**

In `SwapTaxInvoiceModal`:

1. Next to the existing `useState` lines add:

```jsx
  const { data: supplierExamples } = useSupplierDocumentExamples(po.supplier_id || null)
  const [scanCode, setScanCode] = useState(null)
  const [scanFile, setScanFile] = useState(null)
  const [manualRef, setManualRef] = useState('')
  const [manualAmount, setManualAmount] = useState('')
```

2. In `handleUpload`, replace `setExtracted(null)\n    setScanning(true)` with:

```jsx
    setExtracted(null)
    setScanCode(null)
    setScanFile(file)
    setScanning(true)
```

and replace the extraction call and failure line:

```jsx
      const result = await extractPoDocument(base64, mimeType, supplierExamples || [])
      if (!result.ok) { setScanError(result.error); setScanCode(result.code || null); return }
```

3. Add a handler below `handleUpload`:

```jsx
  // Manual path when the automatic read failed: the user types the real tax
  // invoice's number and its amount before VAT. It feeds the SAME `extracted`
  // state, so the amount-match check below still gates the swap.
  const applyManual = () => {
    const amount = parseFloat(manualAmount)
    if (!manualRef.trim() || !Number.isFinite(amount) || amount <= 0) return
    setExtracted({ reference_no_guess: manualRef.trim(), line_items: [], computedTotal: amount, manual: true })
  }
```

4. In `handleSave`, change `const itemsSummary = ...join('; ')` so a manual entry has a readable note: after it, add

```jsx
      const noteDetail = extracted.manual ? `กรอกเอง ยอดก่อน VAT ${fmt(extracted.computedTotal)}` : itemsSummary
```

and use `noteDetail` instead of `itemsSummary` in the `newNotes` template string.

5. In the render, replace `{scanError && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{scanError}</div>}` with:

```jsx
              {scanError && <ScanNotice code={scanCode} message={scanError} />}
              {scanFile && <ScanDocPreview file={scanFile} />}
```

and, directly after that `<div>` (the one holding the file input), add the manual block:

```jsx
            {scanError && !extracted && (
              <div style={{ display: 'grid', gap: 8, border: '1px dashed var(--border)', borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>กรอกเองจากใบกำกับภาษี</div>
                <input className="input" placeholder="เลขที่ใบกำกับภาษี" value={manualRef} onChange={e => setManualRef(e.target.value)} />
                <input className="input" type="number" min="0" step="0.01" placeholder="ยอดรวมก่อน VAT (บาท)" value={manualAmount} onChange={e => setManualAmount(e.target.value)} />
                <button type="button" className="btn btn-ghost" onClick={applyManual}>ใช้ค่าที่กรอก</button>
              </div>
            )}
```

The existing result box already shows `ยอดรวมที่อ่านได้` and the ✅/⚠️ match line from `extracted.computedTotal`; for a manual entry `line_items` is empty, so it will also print "ไม่พบรายการสินค้าในเอกสาร": change that fallback line to render only when `!extracted.manual`.

- [ ] **Step 2: Build and test**

Run: `npx vitest run && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 3: Commit**

```bash
git add src/pages/PurchaseOrders.jsx
git commit -m "feat: swap-tax-invoice uses supplier examples, shows the document and allows manual entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: "Save this document as a supplier example"

**Files:**
- Modify: `src/lib/poDocumentExtraction.js` (add `buildExampleExtracted`)
- Test: `src/lib/poDocumentExtraction.test.js`
- Modify: `src/pages/PurchaseOrders.jsx` (imports; `PurchaseOrderForm` submit and checkbox; parent `handleSave` around lines 729-780)
- Modify: `src/hooks/useSupabase.js` is NOT changed (`saveSupplierDocumentExample` already exists, 3-example cap and insert-then-prune included)

**Interfaces:**
- Consumes (Task 8): `scanPayload`, `scanFile` state in `PurchaseOrderForm`; (existing) `saveSupplierDocumentExample(supplierId, base64, mimeType, extracted)` from `src/hooks/useSupabase.js`.
- Produces: `buildExampleExtracted({ supplierName, date, referenceNo, items }): { supplier_name_guess, document_date_guess, reference_no_guess, line_items }` in `poDocumentExtraction.js`. `PurchaseOrderForm` calls `onSave(form, { afterSave })`; the parent `handleSave(form, opts)` awaits `opts.afterSave()` only after the PO and its items saved.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/poDocumentExtraction.test.js` (and add `buildExampleExtracted` to the import at the top):

```js
describe('buildExampleExtracted', () => {
  it('turns the corrected form lines into the extraction shape saved as an example', () => {
    const out = buildExampleExtracted({
      supplierName: 'YONG CHANG', date: '2026-09-08', referenceNo: 'IV6909/08046',
      items: [
        { description: ' กรอบมุ้ง ', quantity: '3', unit: 'เส้น', unit_price: '353', discount_pct: '5' },
        { description: '', quantity: '1', unit: 'ชิ้น', unit_price: '10', discount_pct: '0' },
        { description: 'ขอบยาง', quantity: '', unit: '', unit_price: 'abc', discount_pct: '' },
      ],
    })
    expect(out).toEqual({
      supplier_name_guess: 'YONG CHANG',
      document_date_guess: '2026-09-08',
      reference_no_guess: 'IV6909/08046',
      line_items: [
        { description: 'กรอบมุ้ง', quantity: 3, unit: 'เส้น', unit_price: 353, discount_pct: 5 },
        { description: 'ขอบยาง', quantity: 0, unit: '', unit_price: 0, discount_pct: 0 },
      ],
    })
  })
  it('uses null for missing header values and an empty list for no items', () => {
    expect(buildExampleExtracted({ items: [] })).toEqual({ supplier_name_guess: null, document_date_guess: null, reference_no_guess: null, line_items: [] })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: FAIL (`buildExampleExtracted` is not a function).

- [ ] **Step 3: Implement the builder**

Add to `src/lib/poDocumentExtraction.js` after `validateExtraction`:

```js
/** Builds the `extracted` JSON saved with a supplier calibration example from
 *  the lines the user corrected in the PO form (so the example is a verified
 *  answer, not the raw AI output). Same shape the edge function returns. */
export function buildExampleExtracted({ supplierName, date, referenceNo, items }) {
  return {
    supplier_name_guess: supplierName || null,
    document_date_guess: date || null,
    reference_no_guess: referenceNo || null,
    line_items: (items || [])
      .filter(it => (it.description || '').trim())
      .map(it => ({
        description: it.description.trim(),
        quantity: parseFloat(it.quantity) || 0,
        unit: it.unit || '',
        unit_price: parseFloat(it.unit_price) || 0,
        discount_pct: parseFloat(it.discount_pct) || 0,
      })),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/poDocumentExtraction.test.js`
Expected: all PASS.

- [ ] **Step 5: Wire the checkbox and the after-save hook**

In `src/pages/PurchaseOrders.jsx`:

1. Add `saveSupplierDocumentExample` to the long `from '../hooks/useSupabase.js'` import on line 9, and change the extraction import to `import { fileToExtractionPayload, buildExampleExtracted } from '../lib/poDocumentExtraction.js'`.

2. In `PurchaseOrderForm`, next to `scanPayload` add `const [saveAsExample, setSaveAsExample] = useState(false)`, and in `handleScanUpload` where state is reset (Task 8, step 2.3) add `setSaveAsExample(false)`.

3. Replace the form's submit handler `onSubmit={e => { e.preventDefault(); clearFormDraft(); onSave(form) }}` with:

```jsx
    <form onSubmit={e => {
      e.preventDefault()
      clearFormDraft()
      const supplierName = (suppliers || []).find(s => s.id === form.supplier_id)?.name
      const extra = saveAsExample && scanPayload
        ? { afterSave: () => saveSupplierDocumentExample(
            form.supplier_id, scanPayload.base64, scanPayload.mimeType,
            buildExampleExtracted({ supplierName, date: form.date, referenceNo: scanPayload.reference_no_guess, items: form.items }),
          ) }
        : undefined
      onSave(form, extra)
    }}>
```

4. Under the preview/reminder lines added in Task 8, add the checkbox (only after a successful scan with a supplier chosen):

```jsx
          {scanPayload && form.supplier_id && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={saveAsExample} onChange={e => setSaveAsExample(e.target.checked)} />
              <span>เก็บใบนี้เป็นตัวอย่างของซัพพลายเออร์ (ช่วยให้ AI อ่านเอกสารเจ้านี้แม่นขึ้น เก็บได้สูงสุด 3 ใบ ใบเก่าสุดจะถูกแทนที่)</span>
            </label>
          )}
```

5. In the parent `handleSave` change the signature to `async (form, opts)` and replace the three lines after the items insert:

```js
      clearDraft(ADD_FORM_OPEN_KEY)
      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
```

with:

```js
      // The example is saved only after the PO and its items are safely
      // stored, and a failure here must never undo or hide the saved PO.
      let exampleError = null
      if (opts?.afterSave) {
        try { await opts.afterSave() } catch (e) { exampleError = e.message }
      }
      clearDraft(ADD_FORM_OPEN_KEY)
      setShowAdd(false); setEditRow(null); refetch()
      showToast(exampleError ? `บันทึกสำเร็จ แต่เก็บตัวอย่างไม่สำเร็จ: ${exampleError}` : 'บันทึกสำเร็จ')
```

- [ ] **Step 6: Build, test, commit**

Run: `npx vitest run && npm run build`
Expected: PASS and a clean build.

```bash
git add src/lib/poDocumentExtraction.js src/lib/poDocumentExtraction.test.js src/pages/PurchaseOrders.jsx
git commit -m "feat: offer to save a corrected scan as a supplier example after the PO is saved

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Offline evaluation script (Anthropic models and Gemini Pro)

Produces the evidence for the spec's gate: ship cheap-first only if the cheap model matches the strong one and escalates on well under half the documents. Runs on the owner's machine with the owner's keys; nothing here touches production, and no key is ever written to the repo or pasted in chat.

**Files:**
- Create: `src/lib/scanEvalCompare.js`
- Test: `src/lib/scanEvalCompare.test.js`
- Create: `scripts/eval-po-extract.mjs`
- Modify: `.gitignore` (add `eval-docs/` and `eval-report*.csv`)

**Interfaces:**
- Consumes: `SYSTEM_PROMPT` (Task 3), `classifyModelOutput`, `sumLineItems` (Task 2).
- Produces: `compareExtraction(expected, actual): { lineCountMatches: boolean, quantityAcc: number, unitPriceAcc: number, unitAcc: number, accuracy: number }` (all 0..1; fields compared over the expected lines, aligned by position) and `summarise(rows)` helpers used by the script.

- [ ] **Step 1: Write the failing test**

Create `src/lib/scanEvalCompare.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { compareExtraction, summariseProvider } from './scanEvalCompare.js'

const L = (over = {}) => ({ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0, ...over })

describe('compareExtraction', () => {
  it('scores a perfect read as 1', () => {
    const r = compareExtraction({ line_items: [L(), L({ description: 'b' })] }, { line_items: [L(), L({ description: 'b' })] })
    expect(r).toMatchObject({ lineCountMatches: true, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, accuracy: 1 })
  })
  it('counts a wrong price and a wrong unit separately', () => {
    const r = compareExtraction({ line_items: [L(), L()] }, { line_items: [L({ unit_price: 90 }), L({ unit: 'ชิ้น' })] })
    expect(r.unitPriceAcc).toBe(0.5)
    expect(r.unitAcc).toBe(0.5)
    expect(r.quantityAcc).toBe(1)
  })
  it('penalises missing lines (compared over the expected lines)', () => {
    const r = compareExtraction({ line_items: [L(), L()] }, { line_items: [L()] })
    expect(r.lineCountMatches).toBe(false)
    expect(r.accuracy).toBe(0.5)
  })
  it('treats prices within half a satang as equal and handles an empty actual', () => {
    expect(compareExtraction({ line_items: [L({ unit_price: 100.004 })] }, { line_items: [L()] }).unitPriceAcc).toBe(1)
    expect(compareExtraction({ line_items: [L()] }, { line_items: [] }).accuracy).toBe(0)
  })
})

describe('summariseProvider', () => {
  it('averages accuracy, check pass rate and tokens', () => {
    const s = summariseProvider([
      { accuracy: 1, kind: 'ok', inputTokens: 100, outputTokens: 10 },
      { accuracy: 0.5, kind: 'check_failed', inputTokens: 300, outputTokens: 30 },
    ])
    expect(s).toEqual({ docs: 2, meanAccuracy: 0.75, checkPassRate: 0.5, inputTokens: 400, outputTokens: 40 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/scanEvalCompare.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the compare helpers**

Create `src/lib/scanEvalCompare.js`:

```js
// Comparison helpers for the offline PO-scan evaluation
// (scripts/eval-po-extract.mjs). Lines are aligned by position and scored
// over the EXPECTED lines, so a missing line costs accuracy.

const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005

export function compareExtraction(expected, actual) {
  const exp = expected?.line_items || []
  const act = actual?.line_items || []
  if (exp.length === 0) return { lineCountMatches: act.length === 0, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, accuracy: 1 }
  let q = 0, p = 0, u = 0
  exp.forEach((e, i) => {
    const a = act[i]
    if (!a) return
    if (near(e.quantity, a.quantity)) q++
    if (near(e.unit_price, a.unit_price)) p++
    if ((e.unit || '').trim() === (a.unit || '').trim()) u++
  })
  const n = exp.length
  return {
    lineCountMatches: act.length === exp.length,
    quantityAcc: q / n, unitPriceAcc: p / n, unitAcc: u / n,
    accuracy: (q + p + u) / (3 * n),
  }
}

export function summariseProvider(rows) {
  const n = rows.length || 1
  return {
    docs: rows.length,
    meanAccuracy: rows.reduce((s, r) => s + r.accuracy, 0) / n,
    checkPassRate: rows.filter(r => r.kind === 'ok').length / n,
    inputTokens: rows.reduce((s, r) => s + (r.inputTokens || 0), 0),
    outputTokens: rows.reduce((s, r) => s + (r.outputTokens || 0), 0),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/scanEvalCompare.test.js`
Expected: all PASS.

- [ ] **Step 5: Write the script**

Create `scripts/eval-po-extract.mjs`. It is run with `npx --yes tsx` because it imports TypeScript from `_shared`:

```js
// Offline evaluation of PO document extraction across providers/models.
// Usage (keys come from the environment, never from the repo):
//   ANTHROPIC_API_KEY=... GEMINI_API_KEY=... \
//   npx --yes tsx scripts/eval-po-extract.mjs --dir ./eval-docs \
//     --providers anthropic:claude-haiku-4-5-20251001,anthropic:claude-sonnet-5,gemini:<model-id> \
//     [--dry-run] [--out eval-report.csv]
// <dir> holds documents (.pdf/.jpg/.jpeg/.png) each with a sibling
// <name>.expected.json in the extraction shape (the corrected answer).
// Use only documents the owner supplies or FacadeX's own tenant -- never
// another tenant's saved supplier examples.
// --dry-run skips every network call and answers with the expected JSON,
// to prove the pipeline end to end (expect accuracy 1.0 everywhere).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { SYSTEM_PROMPT } from '../supabase/functions/_shared/po-extract-prompt.ts'
import { classifyModelOutput } from '../supabase/functions/_shared/scan-logic.ts'
import { compareExtraction, summariseProvider } from '../src/lib/scanEvalCompare.js'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(e => e.length))
const dir = args.dir
const providers = String(args.providers || '').split(',').filter(Boolean)
const dryRun = args['dry-run'] === true
if (!dir || providers.length === 0) { console.error('need --dir and --providers'); process.exit(1) }

const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }

async function callAnthropic(model, mimeType, b64) {
  const block = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract this document.' }] }] }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const t = (j.content || []).find(b => b.type === 'text')
  return { text: t?.text ?? '', inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 }
}

// Gemini REST shape as of writing; verify against Google's current API
// reference before the first run. If a request is rejected, fix the script
// from the docs -- do not guess.
async function callGemini(model, mimeType, b64) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: b64 } }, { text: 'Extract this document.' }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  })
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  return {
    text: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '',
    inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

const files = readdirSync(dir).filter(f => MIME[extname(f).toLowerCase()])
const rows = []
for (const spec of providers) {
  const [kind, ...rest] = spec.split(':')
  const model = rest.join(':')
  for (const f of files) {
    const base = basename(f, extname(f))
    const expected = JSON.parse(readFileSync(join(dir, `${base}.expected.json`), 'utf8'))
    const mimeType = MIME[extname(f).toLowerCase()]
    const b64 = readFileSync(join(dir, f)).toString('base64')
    const t0 = Date.now()
    let out
    try {
      out = dryRun ? { text: JSON.stringify({ status: 'success', ...expected }), inputTokens: 0, outputTokens: 0 }
        : kind === 'gemini' ? await callGemini(model, mimeType, b64) : await callAnthropic(model, mimeType, b64)
    } catch (e) {
      rows.push({ provider: spec, doc: f, kind: 'call_failed', accuracy: 0, inputTokens: 0, outputTokens: 0, ms: Date.now() - t0, note: String(e).slice(0, 120) })
      continue
    }
    const c = classifyModelOutput(out.text)
    const actual = c.kind === 'ok' || c.kind === 'check_failed' ? c.result : { line_items: [] }
    rows.push({ provider: spec, doc: f, kind: c.kind, accuracy: compareExtraction(expected, actual).accuracy, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ms: Date.now() - t0, note: c.reason || '' })
  }
}

const csv = ['provider,doc,kind,accuracy,input_tokens,output_tokens,ms,note',
  ...rows.map(r => [r.provider, r.doc, r.kind, r.accuracy.toFixed(3), r.inputTokens, r.outputTokens, r.ms, r.note].join(','))].join('\n')
writeFileSync(args.out && args.out !== true ? args.out : 'eval-report.csv', csv)

console.log('\nprovider'.padEnd(46), 'docs  meanAcc  checkPass  inTok   outTok')
for (const spec of providers) {
  const s = summariseProvider(rows.filter(r => r.provider === spec))
  console.log(spec.padEnd(45), String(s.docs).padEnd(5), s.meanAccuracy.toFixed(3).padEnd(8), s.checkPassRate.toFixed(2).padEnd(10), String(s.inputTokens).padEnd(7), s.outputTokens)
}
console.log('\nGate (spec): enable PO_SCAN_CHEAP_FIRST only if the cheap model checkPass is high enough that');
console.log('escalation (1 - checkPass) is well under 0.5 AND its meanAcc is within ~0.02 of the strong model.')
```

Add to `.gitignore`:

```
eval-docs/
eval-report*.csv
```

- [ ] **Step 6: Prove the pipeline with a dry run**

Create a scratch folder outside the repo with one tiny document and its expected JSON, then run (no network, no keys):

```bash
mkdir -p /tmp/po-eval-dry && printf 'x' > /tmp/po-eval-dry/doc1.jpg && printf '%s' '{"line_items":[{"description":"a","quantity":2,"unit":"เส้น","unit_price":100,"discount_pct":0}]}' > /tmp/po-eval-dry/doc1.expected.json
npx --yes tsx scripts/eval-po-extract.mjs --dir /tmp/po-eval-dry --providers anthropic:dry,gemini:dry --dry-run --out /tmp/po-eval-dry/report.csv
```

Expected: a table with `docs 1`, `meanAcc 1.000`, `checkPass 1.00` for both providers, and `/tmp/po-eval-dry/report.csv` written. (The dry run makes no network call, so the model names are irrelevant.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/scanEvalCompare.js src/lib/scanEvalCompare.test.js scripts/eval-po-extract.mjs .gitignore
git commit -m "feat: offline evaluation script for PO extraction (Anthropic models and Gemini Pro)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deploy in order and verify live

Follow `.claude/skills/chang-ship/SKILL.md` for every command and guard. Order is fixed: migration, function, web, then (only if the evaluation passes) switch cheap-first on. State plainly at the end what was verified live and what was only unit-tested.

**Files:**
- Modify: `src/changelog.json`, `package.json` (version)

- [ ] **Step 1: Changelog and version**

Open `src/changelog.json` and `package.json`. Read the top changelog `version` and the `package.json` `version` (they match; at planning time both were `1.20.38`, re-read in case another change landed). Bump both to the next patch and add a new first entry with today's date and these notes (Thai, user-facing, no jargon):

```json
  {
    "version": "<next patch>",
    "date": "<today YYYY-MM-DD>",
    "notes": [
      "สแกนเอกสารใบสั่งซื้อ: แก้ให้ส่วนลดต่อรายการที่อ่านได้ถูกใส่ลงในฟอร์มและคำนวณยอดตรงกัน (เดิมส่วนลดหาย)",
      "ถ้าอ่านเอกสารอัตโนมัติไม่ได้หรือโควต้าหมด จะแสดงเอกสารให้ดูและกรอกรายการเองได้ ไม่ขึ้นข้อความแดงตัน",
      "สแกนไฟล์เดิมซ้ำได้ผลทันทีและไม่นับโควต้า เอกสารที่อ่านไม่ออกก็ไม่นับโควต้า",
      "ใบสั่งซื้อ: เก็บใบที่แก้ไขแล้วเป็นตัวอย่างของซัพพลายเออร์ได้หลังบันทึก และหน้าสลับใบกำกับภาษีใช้ตัวอย่างของซัพพลายเออร์ด้วย",
      "หน้าสลับใบกำกับภาษี: กรอกเลขที่และยอดเองได้เมื่ออ่านอัตโนมัติไม่ได้ (ยังต้องยอดตรงกับรายจ่ายเดิม)"
    ]
  },
```

Run: `npx vitest run` (the repo may test the changelog shape). Expected: PASS.

- [ ] **Step 2: Verify the model IDs against the API (owner runs this locally)**

The owner runs, with their own key in the shell (never printed or pasted into chat):

```bash
curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | grep -o '"id":"[^"]*"'
```

Expected: the list contains both `claude-sonnet-5` and `claude-haiku-4-5-20251001`. If either is missing, fix `STRONG_MODEL` / `CHEAP_MODEL` in `supabase/functions/extract-po-document/index.ts` and the Global Constraints line before deploying.

- [ ] **Step 3: Apply the migration**

Apply `supabase/migrations/2026-10-05-01-po-scan-cache-and-model-used.sql` per chang-ship section 3 (`npx supabase db query --linked -f <file>`; if the CLI is not logged in, run the identical file content with the Supabase MCP `execute_sql`). Then verify with a separate, single query:

```sql
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'document_scan_usage' AND column_name = 'model_used') AS has_col,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scan_result_cache') AS has_table,
       (SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'scan_result_cache' AND grantee = 'anon') AS anon_grants;
```

Expected: `has_col 1, has_table 1, anon_grants 0`.

- [ ] **Step 4: Deploy the edge function (cheap-first still off)**

Run: `npx supabase functions deploy extract-po-document --project-ref kntspldhvcjeaubtqtkn --use-api` (JWT verification stays on; no `--no-verify-jwt`).
Expected: deploy succeeds. A TypeScript error here is the first real type check of the adapter: fix it, redeploy.

- [ ] **Step 5: Live-check the function with the owner's session (Chrome tool, chang-ship section 4)**

On changpm.app logged in as the owner, call the function from the page with the user's own token (do not print the token): one small PDF and one JPEG photo. Then run these queries, one at a time:

```sql
SELECT created_at, mime_type, model_used, input_tokens, output_tokens FROM document_scan_usage ORDER BY created_at DESC LIMIT 3;
```
Expected: one new row per successful scan with `model_used = 'claude-sonnet-5'`.

```sql
SELECT count(*) FROM scan_result_cache;
```
Expected: one row per successful, check-passing scan.

Re-upload the same PDF. Expected: the response contains `cache_hit: true`, `document_scan_usage` gets **no** new row. Then upload a deliberately blurry photo. Expected: HTTP 422 with `code: "unreadable"`, no new `document_scan_usage` row, no cache row.

- [ ] **Step 6: Deploy the web app**

Run: `npm run deploy` (chang-ship section 1: build, `verify-bundle`, `smoke-boot`, `wrangler deploy`).
Expected: the bundle check confirms the CHANG ref and no Tokyo ref.

- [ ] **Step 7: Live-check the screens (Chrome tool, chang-ship section 4)**

After the PWA update banner is accepted, on the PO form: upload a PDF with a discounted line and confirm the discount column is filled and the total matches the document; upload the blurry photo and confirm the yellow notice, the document preview and the reminder line appear and the item list is still editable by hand; tick "เก็บใบนี้เป็นตัวอย่างของซัพพลายเออร์" on a good scan, save the PO, and confirm a new example appears on the supplier page (and that the PO itself saved). On a received PO's swap modal: confirm the supplier examples are used, the preview shows, and the manual fields accept an invoice number and amount that must still match the expense's amount. Read-only clicking only; do not save changes to real data that the owner did not ask for.

- [ ] **Step 8: Evaluate, then decide cheap-first (owner)**

The owner puts 20-30 real documents (their own or FacadeX's own tenant) and matching `*.expected.json` files in `eval-docs/` and runs Task 11's script with `anthropic:claude-haiku-4-5-20251001,anthropic:claude-sonnet-5,gemini:<current Gemini Pro model id from Google's docs>`. If the gate in the spec passes (cheap meanAcc within ~0.02 of strong, escalation well under half), the owner sets the Supabase secret `PO_SCAN_CHEAP_FIRST` to `true` in the dashboard for project CHANG. Verify with a new scan: `document_scan_usage.model_used` shows `claude-haiku-4-5-20251001` for a clean document and `claude-sonnet-5` after an escalation. If the gate fails, leave the secret unset: everything else in this plan still ships and works.

- [ ] **Step 9: Commit**

```bash
git add src/changelog.json package.json
git commit -m "chore: changelog and version for the PO scan upgrade

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Do not push or merge until the owner confirms the live checks.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Blocking prerequisite (502, key) | Resolved 2026-10-05 (secret reset); Task 12 step 2 re-verifies model IDs |
| 1. Cheaper model first (prompt, checks, escalation, time rule, cache, quota rule, `model_used`, error codes) | Tasks 2, 3, 4, 5, 6 |
| 2. Manual-entry fallback (codes, preview, notice, swap modal, reminder) | Tasks 7, 8, 9 |
| 3. Supplier examples (both passes, swap modal, save-as-example) | Tasks 6 (examples sent in both passes), 9, 10 |
| Relationship to scan-credit purchase (order of steps) | Tasks 4, 6 |
| Rollout order, testing, evaluation incl. Gemini Pro | Tasks 5, 11, 12 |
| Live bug found while planning (`discount_pct` dropped) | Task 1 |
