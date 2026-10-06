import { pickPeakFields } from './peakFields.js'

// Columns added by migration 2026-10-06-03 (+ the older original_expense_id).
// Sent only when non-blank, or when clearing a previously-set value, so saves
// keep working before the migration is applied.
export const CN_EXTRA_KEYS = ['expense_date', 'original_invoice_no', 'original_invoice_date', 'original_expense_id']

export const pickCreditNoteExtra = (form, original) => pickPeakFields(form, original, CN_EXTRA_KEYS)
