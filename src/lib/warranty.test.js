import { describe, it, expect } from 'vitest'
import { warrantyEnd, warrantyStatus, followupDue } from '../../supabase/functions/_shared/warranty.ts'

describe('warrantyEnd', () => {
  it('clamps like Postgres', () => {
    expect(warrantyEnd('2026-01-31', 1)).toBe('2026-02-28')
    expect(warrantyEnd('2024-01-31', 1)).toBe('2024-02-29')
    expect(warrantyEnd('2025-10-14', 12)).toBe('2026-10-14')
  })
  it('null when no handover or months <= 0', () => {
    expect(warrantyEnd(null, 12)).toBeNull()
    expect(warrantyEnd('2025-10-14', 0)).toBeNull()
  })
})

describe('warrantyStatus', () => {
  it('active on end day with daysLeft 0', () => {
    const s = warrantyStatus('2025-10-14', 12, '2026-10-14')
    expect(s.kind).toBe('active')
    expect(s.daysLeft).toBe(0)
    expect(s.end).toBe('2026-10-14')
  })
  it('expired the day after', () => {
    expect(warrantyStatus('2025-10-14', 12, '2026-10-15').kind).toBe('expired')
  })
  it('not handed over / none', () => {
    expect(warrantyStatus(null, 12, '2026-10-19').kind).toBe('not_handed_over')
    expect(warrantyStatus('2025-10-14', 0, '2026-10-19').kind).toBe('none')
  })
})

describe('followupDue', () => {
  const site = { status: 'Completed', handover_date: '2025-10-14', warranty_months: 12, warranty_followup_at: null }
  it('true at 30 days left, false at 31', () => {
    expect(followupDue(site, '2026-09-14')).toBe(true)
    expect(followupDue(site, '2026-09-13')).toBe(false)
  })
  it('false when followed up, not completed, or expired', () => {
    expect(followupDue({ ...site, warranty_followup_at: '2026-09-20' }, '2026-09-14')).toBe(false)
    expect(followupDue({ ...site, status: 'Active' }, '2026-09-14')).toBe(false)
    expect(followupDue(site, '2026-10-15')).toBe(false)
  })
})
