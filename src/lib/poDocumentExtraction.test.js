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
