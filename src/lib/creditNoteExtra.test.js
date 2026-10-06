import { describe, it, expect } from 'vitest'
import { pickCreditNoteExtra } from './creditNoteExtra.js'

describe('pickCreditNoteExtra', () => {
  it('omits blank fields on a new note', () => {
    expect(pickCreditNoteExtra({ expense_date: '', original_invoice_no: ' ', original_invoice_date: '', original_expense_id: null }, null)).toEqual({})
  })
  it('includes non-blank values', () => {
    expect(pickCreditNoteExtra({ expense_date: '2026-08-31', original_invoice_no: 'PK 69 06 24 057', original_invoice_date: '2026-06-24', original_expense_id: 'e1' }, null))
      .toEqual({ expense_date: '2026-08-31', original_invoice_no: 'PK 69 06 24 057', original_invoice_date: '2026-06-24', original_expense_id: 'e1' })
  })
  it('clears only values that were previously set', () => {
    expect(pickCreditNoteExtra({ expense_date: '', original_invoice_no: '', original_invoice_date: '', original_expense_id: null },
      { expense_date: '2026-08-31', original_invoice_no: null })).toEqual({ expense_date: null })
  })
})
