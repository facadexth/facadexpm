import { describe, it, expect } from 'vitest'
import { buildItemDescription, descriptionParts, DEFAULT_DESCRIPTION_FORMAT } from './descriptionFormat.js'

const ctx = { item_name: 'D-01', type_name: 'ประตูบานเลื่อน', width_m: 2.4, height_m: 2.1, finish_name: 'อบขาว', series_label: 'Demo 40 · โรงรีด A', thickness_mm: 1.5, infill_name: 'กระจกเทมเปอร์ 6 มม.', hardware_set_name: 'HW-A' }

describe('buildItemDescription', () => {
  it('joins the chosen tokens in the chosen order', () => {
    expect(buildItemDescription(ctx, ['item_name', 'type', 'size', 'alu_color'])).toBe('D-01 ประตูบานเลื่อน ขนาด 2400 × 2100 มม. สีอบขาว')
    expect(buildItemDescription(ctx, ['size', 'item_name'])).toBe('ขนาด 2400 × 2100 มม. D-01')
  })
  it('skips empty parts and unknown tokens; a missing list uses the default format', () => {
    expect(buildItemDescription({ item_name: 'D-01', width_m: 0, height_m: 0 }, ['item_name', 'size', 'alu_color', 'nonsense'])).toBe('D-01')
    expect(descriptionParts(ctx, undefined).length).toBe(DEFAULT_DESCRIPTION_FORMAT.length)
    expect(buildItemDescription(null, ['item_name'])).toBe('')
  })
  it('thickness, infill and hardware set render too, and a custom separator is honoured', () => {
    expect(buildItemDescription(ctx, ['thickness', 'infill', 'hardware_set'], ' / ')).toBe('หนา 1.5 มม. / กระจกเทมเปอร์ 6 มม. / HW-A')
  })
})
