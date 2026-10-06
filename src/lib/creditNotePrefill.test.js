import { describe, it, expect } from 'vitest'
import { setCreditNotePrefill, takeCreditNotePrefill } from './creditNotePrefill.js'
describe('creditNotePrefill', () => {
  it('hands the value over exactly once', () => {
    setCreditNotePrefill({ po_id: 'p1' })
    expect(takeCreditNotePrefill()).toEqual({ po_id: 'p1' })
    expect(takeCreditNotePrefill()).toBeNull()
  })
})
