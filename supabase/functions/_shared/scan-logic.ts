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
  /** Grand total INCLUDING VAT as printed (null if not printed / unclear). */
  printed_total: number | null
  /** Decided from the numbers by detectPriceBasis, never by the model:
   *  true = printed unit prices already include VAT, false = they exclude it,
   *  null = could not tell (nothing printed to check against, or a mismatch). */
  prices_include_vat: boolean | null
  line_items: LineItem[]
  deposit_deductions: Array<{ ref: string; amount: number }>
}
export type PriceBasis = 'exclusive' | 'inclusive' | 'unchecked' | 'mismatch'
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

export const VAT_RATE = 0.07

/** Decides whether the printed unit prices include VAT, from numbers only
 *  (sum = sumLineItems of the read lines). Some suppliers print VAT-inclusive
 *  unit prices and others VAT-exclusive ones -- even the same company on
 *  different documents -- so both bases are a correct read. Rules, in order,
 *  each with the subtotalMatches tolerance:
 *   1. sum ~ printed_subtotal            -> exclusive (also VAT-exempt docs, subtotal == total)
 *   2. sum ~ printed_total               -> inclusive
 *   3. sum ~ printed_subtotal x 1.07     -> inclusive (only the pre-VAT subtotal printed)
 *   4. subtotal null, sum ~ total / 1.07 -> exclusive (only the grand total printed)
 *  Neither figure printed -> 'unchecked'; nothing fits -> 'mismatch'.
 *  A non-positive figure counts as not printed. When only the total is
 *  printed and it is so small that the sum fits BOTH rule 2 and rule 4
 *  (the 5 baht minimum slack covers 7% below ~71 baht) the basis is
 *  ambiguous: 'unchecked', so the PO is never flipped to inclusive on a guess. */
export function detectPriceBasis(sum: number, printedSubtotal: number | null, printedTotal: number | null): PriceBasis {
  const sub = printedSubtotal != null && printedSubtotal > 0 ? printedSubtotal : null
  const tot = printedTotal != null && printedTotal > 0 ? printedTotal : null
  if (sub == null && tot == null) return 'unchecked'
  if (sub != null && subtotalMatches(sum, sub)) return 'exclusive'
  const matchesTotal = tot != null && subtotalMatches(sum, tot)
  const matchesTotalExVat = sub == null && tot != null && subtotalMatches(sum, tot / (1 + VAT_RATE))
  if (matchesTotal && matchesTotalExVat) return 'unchecked'
  if (matchesTotal) return 'inclusive'
  if (sub != null && subtotalMatches(sum, sub * (1 + VAT_RATE))) return 'inclusive'
  if (matchesTotalExVat) return 'exclusive'
  return 'mismatch'
}

/** Fills fields added after a result was cached (printed_total,
 *  prices_include_vat, deposit_deductions) so an older scan_result_cache
 *  entry is served in the current shape instead of with missing keys. */
export function withExtractionDefaults(cached: Partial<Extraction> & Record<string, unknown>): Extraction {
  return {
    ...cached,
    supplier_name_guess: cached.supplier_name_guess ?? null,
    document_date_guess: cached.document_date_guess ?? null,
    reference_no_guess: cached.reference_no_guess ?? null,
    printed_subtotal: typeof cached.printed_subtotal === 'number' ? cached.printed_subtotal : null,
    printed_total: typeof cached.printed_total === 'number' ? cached.printed_total : null,
    prices_include_vat: typeof cached.prices_include_vat === 'boolean' ? cached.prices_include_vat : null,
    line_items: Array.isArray(cached.line_items) ? cached.line_items : [],
    deposit_deductions: Array.isArray(cached.deposit_deductions) ? cached.deposit_deductions : [],
  }
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

  const deposit_deductions: Array<{ ref: string; amount: number }> = []
  for (const raw of Array.isArray(obj.deposit_deductions) ? obj.deposit_deductions : []) {
    const r = asObject(raw)
    const ref = r ? str(r.ref) : null
    const amount = r ? num(r.amount) : null
    if (ref && amount != null && amount > 0) deposit_deductions.push({ ref, amount })
  }

  const result: Extraction = {
    supplier_name_guess: str(obj.supplier_name_guess),
    document_date_guess: str(obj.document_date_guess),
    reference_no_guess: str(obj.reference_no_guess),
    printed_subtotal: num(obj.printed_subtotal),
    printed_total: num(obj.printed_total),
    prices_include_vat: null,
    line_items,
    deposit_deductions,
  }

  if (line_items.length === 0) return { kind: 'check_failed', result, reason: 'no_items' }
  if (problems.length) return { kind: 'check_failed', result, reason: problems[0] }
  const basis = detectPriceBasis(sumLineItems(line_items), result.printed_subtotal, result.printed_total)
  if (basis === 'mismatch') return { kind: 'check_failed', result, reason: 'subtotal_mismatch' }
  if (basis !== 'unchecked') result.prices_include_vat = basis === 'inclusive'
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
