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
