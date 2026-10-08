import { describe, it, expect } from 'vitest'
import {
  parseModelJson, sumLineItems, subtotalMatches, classifyModelOutput, sha256Hex, scanCacheKey,
  detectPriceBasis, withExtractionDefaults,
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

describe('classifyModelOutput deposit_deductions', () => {
  it('passes valid deductions through and drops invalid ones', () => {
    const c = classifyModelOutput(out({ deposit_deductions: [{ ref: ' AI1 ', amount: '41,004.00' }, { ref: '', amount: 5 }, { ref: 'B', amount: 0 }] }))
    expect(c.kind).toBe('ok')
    expect(c.result.deposit_deductions).toEqual([{ ref: 'AI1', amount: 41004 }])
  })
  it('defaults to []', () => {
    expect(classifyModelOutput(out({})).result.deposit_deductions).toEqual([])
  })
})

describe('detectPriceBasis', () => {
  // S = 200 in most cases; tolerance on a ~200 baht figure is the 5 baht minimum.
  it('prices exclude VAT when the sum matches printed_subtotal (first rule)', () => {
    expect(detectPriceBasis(200, 200, 214)).toBe('exclusive')
    expect(detectPriceBasis(200, 200, null)).toBe('exclusive')
  })
  it('a VAT-exempt document (subtotal == total == sum) stays exclusive', () => {
    expect(detectPriceBasis(200, 200, 200)).toBe('exclusive')
  })
  it('prices include VAT when the sum matches printed_total instead', () => {
    expect(detectPriceBasis(214, 200, 214)).toBe('inclusive')
    expect(detectPriceBasis(214, null, 214)).toBe('inclusive')
  })
  it('prices include VAT when only the pre-VAT subtotal is printed and sum == subtotal x 1.07', () => {
    expect(detectPriceBasis(1070, 1000, null)).toBe('inclusive')
  })
  it('prices exclude VAT when only the total is printed and sum == total / 1.07', () => {
    expect(detectPriceBasis(1000, null, 1070)).toBe('exclusive')
  })
  it('the total / 1.07 rule only applies when printed_subtotal is null', () => {
    expect(detectPriceBasis(1000, 1200, 1070)).toBe('mismatch')
  })
  it('no check when neither figure is printed (null or 0)', () => {
    expect(detectPriceBasis(200, null, null)).toBe('unchecked')
    expect(detectPriceBasis(200, 0, 0)).toBe('unchecked')
  })
  it('a sum matching neither basis is a mismatch', () => {
    expect(detectPriceBasis(200, 300, 321)).toBe('mismatch')
    expect(detectPriceBasis(200, null, 321)).toBe('mismatch')
  })
  it('uses the same tolerance as subtotalMatches at the boundary', () => {
    // 5 baht minimum slack on small figures
    expect(detectPriceBasis(205, 200, null)).toBe('exclusive')
    expect(detectPriceBasis(205.01, 200, null)).toBe('mismatch')
    expect(detectPriceBasis(219, null, 214)).toBe('inclusive')
    expect(detectPriceBasis(219.01, null, 214)).toBe('mismatch')
    // 1% slack on large figures: total 107,000, sum 108,070 is exactly 1% off
    expect(detectPriceBasis(108070, null, 107000)).toBe('inclusive')
    expect(detectPriceBasis(108071, 99000, 107000)).toBe('mismatch')
  })
  it('a tiny total where the sum fits both total and total/1.07 is left unchecked, never flipped to inclusive', () => {
    // 50 vs 53.5: both within the 5 baht minimum slack
    expect(detectPriceBasis(50, null, 53.5)).toBe('unchecked')
  })
})

describe('classifyModelOutput VAT basis', () => {
  const two = (price) => ({ line_items: [item({ quantity: 2, unit_price: price })] })
  it('exclusive document: ok, prices_include_vat false, printed_total kept', () => {
    const c = classifyModelOutput(out({ ...two(100), printed_subtotal: 200, printed_total: 214 }))
    expect(c.kind).toBe('ok')
    expect(c.result.prices_include_vat).toBe(false)
    expect(c.result.printed_total).toBe(214)
  })
  it('VAT-exempt document (subtotal == total) is exclusive', () => {
    const c = classifyModelOutput(out({ ...two(100), printed_subtotal: 200, printed_total: 200 }))
    expect(c).toMatchObject({ kind: 'ok', result: { prices_include_vat: false } })
  })
  it('inclusive document whose lines add up to printed_total passes the check', () => {
    const c = classifyModelOutput(out({ ...two(107), printed_subtotal: 200, printed_total: 214 }))
    expect(c).toMatchObject({ kind: 'ok', result: { prices_include_vat: true } })
    expect(c.result.line_items[0].unit_price).toBe(107)
  })
  it('inclusive document that prints only the pre-VAT subtotal passes via x1.07', () => {
    const c = classifyModelOutput(out({ line_items: [item({ quantity: 10, unit_price: 107 })], printed_subtotal: 1000 }))
    expect(c).toMatchObject({ kind: 'ok', result: { prices_include_vat: true } })
  })
  it('exclusive document that prints only the grand total passes via /1.07', () => {
    const c = classifyModelOutput(out({ line_items: [item({ quantity: 10, unit_price: 100 })], printed_total: 1070 }))
    expect(c).toMatchObject({ kind: 'ok', result: { prices_include_vat: false } })
  })
  it('a sum matching neither basis still fails the check with subtotal_mismatch', () => {
    const c = classifyModelOutput(out({ ...two(100), printed_subtotal: 300, printed_total: 321 }))
    expect(c).toMatchObject({ kind: 'check_failed', reason: 'subtotal_mismatch' })
    expect(c.result.prices_include_vat).toBeNull()
  })
  it('both printed figures null: ok, no basis decided', () => {
    const c = classifyModelOutput(out({ printed_subtotal: null, printed_total: null }))
    expect(c.kind).toBe('ok')
    expect(c.result.printed_total).toBeNull()
    expect(c.result.prices_include_vat).toBeNull()
  })
  it('parses printed_total given as a string with separators', () => {
    const c = classifyModelOutput(out({ line_items: [item({ quantity: 1, unit_price: 1070 })], printed_total: '1,070.00' }))
    expect(c).toMatchObject({ kind: 'ok', result: { printed_total: 1070, prices_include_vat: true } })
  })
})

describe('withExtractionDefaults (older cached entries)', () => {
  it('fills printed_total and prices_include_vat with null on an old cached shape', () => {
    const old = { supplier_name_guess: 'X', document_date_guess: null, reference_no_guess: null, printed_subtotal: 200, line_items: [item()] }
    const r = withExtractionDefaults(old)
    expect(r.printed_total).toBeNull()
    expect(r.prices_include_vat).toBeNull()
    expect(r.deposit_deductions).toEqual([])
    expect(r.line_items).toEqual([item()])
    expect(r.supplier_name_guess).toBe('X')
    expect(r.printed_subtotal).toBe(200)
  })
  it('keeps the new fields when present', () => {
    const r = withExtractionDefaults({ line_items: [], printed_total: 214, prices_include_vat: true, deposit_deductions: [{ ref: 'A', amount: 1 }] })
    expect(r).toMatchObject({ printed_total: 214, prices_include_vat: true, deposit_deductions: [{ ref: 'A', amount: 1 }] })
  })
  it('treats a non-boolean prices_include_vat as null', () => {
    expect(withExtractionDefaults({ line_items: [], prices_include_vat: 'yes' }).prices_include_vat).toBeNull()
  })
})
