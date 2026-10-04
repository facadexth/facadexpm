import { describe, it, expect } from 'vitest'
import { formatChequeDigest, groupChequesByRecipient, MAX_CHEQUES_LISTED } from '../../supabase/functions/_shared/cheque-digest.ts'

const c = (n, d = '2026-10-10', by = null) => ({ cheque_no: `C${n}`, bank: 'กสิกร', check_date: d, created_by: by })

describe('cheque digest', () => {
  it('puts every cheque in one message, earliest first, with a count', () => {
    const t = formatChequeDigest([c(2, '2026-10-12'), c(1, '2026-10-09')])
    expect(t.split('\n')[0]).toContain('2 ใบ')
    expect(t.indexOf('C1')).toBeLessThan(t.indexOf('C2'))
  })
  it('cuts a long list and says how many were left out', () => {
    const t = formatChequeDigest(Array.from({ length: 60 }, (_, i) => c(i)))
    expect(t).toContain(`…และอีก ${60 - MAX_CHEQUES_LISTED} ใบ`)
    expect(t.length).toBeLessThanOrEqual(5000)
  })
  it('owners get everything; a creator also gets their own cheques only', () => {
    const cheques = [c(1, '2026-10-10', 'a@x.com'), c(2, '2026-10-10', 'b@x.com')]
    const m = groupChequesByRecipient(cheques, ['OWNER'], (e) => ({ 'a@x.com': 'A', 'b@x.com': 'B' })[e])
    expect(m.get('OWNER')).toHaveLength(2)
    expect(m.get('A')).toHaveLength(1)
    expect(m.get('B')).toHaveLength(1)
  })
  it('does not message an owner twice when they created the cheque', () => {
    const m = groupChequesByRecipient([c(1, '2026-10-10', 'o@x.com')], ['OWNER'], () => 'OWNER')
    expect(m.get('OWNER')).toHaveLength(1)
  })
})
