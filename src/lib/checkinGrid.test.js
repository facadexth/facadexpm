import { describe, it, expect } from 'vitest'
import { deriveCellStates } from './checkinGrid.js'

describe('deriveCellStates', () => {
  it('returns "done" when both checkin_at and checkout_at are set', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: '2026-09-29T17:00:00Z' }]
    const cellState = deriveCellStates(checkins, [])
    expect(cellState('w1', '2026-09-29')).toBe('done')
  })

  it('returns "open" when checkin_at is set but checkout_at is not', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: null }]
    const cellState = deriveCellStates(checkins, [])
    expect(cellState('w1', '2026-09-29')).toBe('open')
  })

  it('returns "missed" when there is a site assignment but no check-in row', () => {
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'site' }]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBe('missed')
  })

  it('treats factory and subcontract assignment types as scheduled too', () => {
    const assignments = [
      { worker_id: 'w1', date: '2026-09-29', type: 'factory' },
      { worker_id: 'w2', date: '2026-09-29', type: 'subcontract' },
    ]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBe('missed')
    expect(cellState('w2', '2026-09-29')).toBe('missed')
  })

  it('returns null when there is no assignment and no check-in', () => {
    const cellState = deriveCellStates([], [])
    expect(cellState('w1', '2026-09-29')).toBeNull()
  })

  it('does not treat leave/office/holiday assignment types as scheduled', () => {
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'leave_personal' }]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBeNull()
  })

  it('a completed check-in takes priority over a matching assignment (done, not missed)', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: '2026-09-29T17:00:00Z' }]
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'site' }]
    const cellState = deriveCellStates(checkins, assignments)
    expect(cellState('w1', '2026-09-29')).toBe('done')
  })
})
