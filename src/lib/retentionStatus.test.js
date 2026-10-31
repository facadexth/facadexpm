import { describe, it, expect } from 'vitest'
import { retentionStatusFor, retentionDueText, retentionHandedOver } from './retentionStatus.js'

const TODAY = '2026-10-20'
const fmt = d => `F(${d})`

describe('retentionStatusFor', () => {
  it('released wins over everything', () => {
    expect(retentionStatusFor({ retention_released: true }, TODAY).label).toBe('คืนแล้ว')
  })

  it('Ongoing site with a planned end_date and no due date is รอจบงาน', () => {
    const row = { status: 'Ongoing', end_date: '2026-12-01', due_date: null }
    expect(retentionStatusFor(row, TODAY).label).toBe('รอจบงาน')
    expect(retentionDueText(row, fmt)).toBe('รอจบงาน')
  })

  it('row without status/handover (not merged) is รอจบงาน', () => {
    expect(retentionStatusFor({ due_date: null }, TODAY).label).toBe('รอจบงาน')
  })

  it('handed over with warranty 0 (no due date) is ไม่มีระยะประกัน', () => {
    const row = { status: 'Completed', handover_date: '2026-05-01', end_date: '2026-05-01', due_date: null }
    expect(retentionHandedOver(row)).toBe(true)
    expect(retentionStatusFor(row, TODAY).label).toBe('ไม่มีระยะประกัน')
    expect(retentionDueText(row, fmt)).toBe('ไม่มีระยะประกัน')
  })

  it('reopened site (handover kept, not Completed) without due date is รอจบงาน', () => {
    const row = { status: 'Ongoing', handover_date: '2026-05-01', due_date: null }
    expect(retentionStatusFor(row, TODAY).label).toBe('รอจบงาน')
  })

  it('due date states', () => {
    const base = { status: 'Completed', handover_date: '2025-10-01' }
    expect(retentionStatusFor({ ...base, due_date: '2026-10-19' }, TODAY).label).toBe('เกินกำหนด')
    expect(retentionStatusFor({ ...base, due_date: '2026-10-20' }, TODAY).label).toBe('ใกล้ครบกำหนด')
    expect(retentionStatusFor({ ...base, due_date: '2026-11-19' }, TODAY).label).toBe('ใกล้ครบกำหนด')
    expect(retentionStatusFor({ ...base, due_date: '2026-11-20' }, TODAY).label).toBe('รอครบกำหนด')
    expect(retentionDueText({ ...base, due_date: '2026-11-20' }, fmt)).toBe('F(2026-11-20)')
  })
})
