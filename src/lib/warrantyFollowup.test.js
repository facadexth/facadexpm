import { describe, it, expect } from 'vitest'
import { buildFollowupRows, followupMessage, ddmmyyyy } from './warrantyFollowup.js'

const today = '2026-10-19'
const site = (o) => ({ id: 's', name: 'บ้านA', status: 'Completed', handover_date: '2025-11-10', warranty_months: '12', warranty_followup_at: null, client_id: 'c1', ...o })

describe('warrantyFollowup', () => {
  it('formats dates and message', () => {
    expect(ddmmyyyy('2026-11-10')).toBe('10/11/2026')
    expect(followupMessage('บ้านA', '2026-11-10')).toBe('สวัสดีครับ ประกันงานของ บ้านA จะหมดวันที่ 10/11/2026 มีจุดไหนต้องการให้เข้าไปตรวจหรือแก้ไขไหมครับ')
  })
  it('keeps only due sites, with days left, retention and LINE flag', () => {
    const rows = buildFollowupRows(
      [site({ id: 'a' }), site({ id: 'b', warranty_followup_at: '2026-10-01T00:00:00Z' }), site({ id: 'c', handover_date: '2026-06-01' })],
      today,
      { clientsById: { c1: { name: 'ลูกค้า', phone: '081' } }, linkedClientIds: new Set(['c1']), retentionBySite: { a: { total_retention: 5000, retention_released: false } } },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'a', end: '2026-11-10', daysLeft: 22, lineLinked: true, retentionDue: 5000, clientName: 'ลูกค้า' })
  })
  it('hides released or zero retention', () => {
    const r = (ret) => buildFollowupRows([site({ id: 'a' })], today, { retentionBySite: { a: ret } })[0].retentionDue
    expect(r({ total_retention: 5000, retention_released: true })).toBe(0)
    expect(r({ total_retention: 0, retention_released: false })).toBe(0)
  })
})
