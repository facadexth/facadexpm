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
