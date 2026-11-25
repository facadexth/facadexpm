import { describe, it, expect } from 'vitest'
import { repairItemLine, repairSignItems } from '../../supabase/functions/_shared/repair-sign-doc.ts'

describe('repairItemLine', () => {
  it('formats location (room) — symptom: note', () => {
    expect(repairItemLine({ location: 'ห้องนอน', room: 'ชั้น 2', symptom: 'รั่วซึม', note: 'มุมหน้าต่าง' }))
      .toBe('ห้องนอน (ชั้น 2) — รั่วซึม: มุมหน้าต่าง')
  })
  it('omits empty room and note', () => {
    expect(repairItemLine({ location: 'ห้องครัว', room: '  ', symptom: 'กระจกแตก', note: null })).toBe('ห้องครัว — กระจกแตก')
    expect(repairItemLine({ location: 'ห้องครัว', room: null, symptom: 'กระจกแตก', note: 'ด่วน' })).toBe('ห้องครัว — กระจกแตก: ด่วน')
  })
})

describe('repairSignItems', () => {
  it('orders items by seq', () => {
    const out = repairSignItems('ignored', [
      { seq: 2, location: 'B', symptom: 'y' },
      { seq: 1, location: 'A', symptom: 'x' },
    ])
    expect(out).toEqual([{ description: 'A — x' }, { description: 'B — y' }])
  })
  it('falls back to the trimmed ticket description when there are no items', () => {
    expect(repairSignItems('  หน้าต่างรั่ว  ', [])).toEqual([{ description: 'หน้าต่างรั่ว' }])
    expect(repairSignItems('หน้าต่างรั่ว', null)).toEqual([{ description: 'หน้าต่างรั่ว' }])
  })
  it('returns no items when there is no description either', () => {
    expect(repairSignItems('   ', [])).toEqual([])
  })
})
