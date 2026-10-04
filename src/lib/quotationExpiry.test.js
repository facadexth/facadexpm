import { describe, it, expect } from 'vitest'
import { isExpiryNoticeDue, formatExpiryMessage, daysUntil } from '../../supabase/functions/_shared/quotation-expiry.ts'

const q = (o = {}) => ({ id: '1', quotation_number: 'QT-1', status: 'sent', on_hold: false, valid_until: '2026-10-11', expiry_notified_for: null, created_by: null, ...o })

describe('quotation expiry notice', () => {
  it('is due from 7 days before valid_until', () => {
    expect(isExpiryNoticeDue(q(), '2026-10-04')).toBe(true)
    expect(isExpiryNoticeDue(q(), '2026-10-03')).toBe(false)
  })
  it('is sent once per valid_until, and again after a snooze moves the date', () => {
    expect(isExpiryNoticeDue(q({ expiry_notified_for: '2026-10-11' }), '2026-10-08')).toBe(false)
    expect(isExpiryNoticeDue(q({ expiry_notified_for: '2026-10-11', valid_until: '2026-10-18' }), '2026-10-12')).toBe(true)
  })
  it('skips held, undated and non-sent quotations', () => {
    expect(isExpiryNoticeDue(q({ on_hold: true }), '2026-10-08')).toBe(false)
    expect(isExpiryNoticeDue(q({ valid_until: null }), '2026-10-08')).toBe(false)
    expect(isExpiryNoticeDue(q({ status: 'accepted' }), '2026-10-08')).toBe(false)
  })
  it('counts days and words the message', () => {
    expect(daysUntil('2026-10-04', '2026-10-11')).toBe(7)
    expect(formatExpiryMessage(q(), '2026-10-04')).toContain('อีก 7 วัน')
    expect(formatExpiryMessage(q(), '2026-10-11')).toContain('วันนี้')
    expect(formatExpiryMessage(q(), '2026-10-12')).toContain('เลยกำหนดแล้ว')
  })
})
