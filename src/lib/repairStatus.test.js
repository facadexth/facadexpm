import { describe, it, expect } from 'vitest'
import { REPAIR_STATUS, REPAIR_STEPS, canMove } from './repairStatus.js'
import * as shared from '../../supabase/functions/_shared/repair.ts'

const ALL = ['pending_review', 'received', 'scheduled', 'in_progress', 'done', 'declined']

describe('repairStatus (browser copy of the shared status rules)', () => {
  it('has the same labels and steps as _shared/repair.ts', () => {
    expect(REPAIR_STATUS).toEqual(shared.REPAIR_STATUS)
    expect([...REPAIR_STEPS]).toEqual([...shared.REPAIR_STEPS])
  })
  it('allows exactly the same moves as _shared/repair.ts', () => {
    for (const from of ALL) for (const to of ALL) {
      expect(canMove(from, to), `${from} -> ${to}`).toBe(shared.canMove(from, to))
    }
  })
  it('uses the Thai labels from the spec', () => {
    expect(ALL.map((s) => REPAIR_STATUS[s])).toEqual(['รอพิจารณา', 'รับเรื่อง', 'นัดเข้า', 'กำลังซ่อม', 'เสร็จ', 'ไม่รับ'])
  })
})
