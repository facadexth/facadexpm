import { describe, it, expect } from 'vitest'
import { priceStatuses, STATUS_CURRENT, STATUS_OLD, STATUS_PENDING } from './aluPriceStatus.js'

const key = r => r.g
const row = (id, g, effective_from) => ({ id, g, effective_from })

describe('priceStatuses', () => {
  it('latest row not in the future is current, older rows are old', () => {
    const s = priceStatuses([row(1, 'a', '2026-01-01'), row(2, 'a', '2026-06-01')], key, '2026-10-08')
    expect(s.get(2)).toBe(STATUS_CURRENT)
    expect(s.get(1)).toBe(STATUS_OLD)
  })
  it('a future-dated row is pending and does not displace the current one', () => {
    const s = priceStatuses([row(1, 'a', '2026-01-01'), row(2, 'a', '2027-01-01')], key, '2026-10-08')
    expect(s.get(1)).toBe(STATUS_CURRENT)
    expect(s.get(2)).toBe(STATUS_PENDING)
  })
  it('a row effective exactly on the date is current', () => {
    const s = priceStatuses([row(1, 'a', '2026-01-01'), row(2, 'a', '2026-10-08')], key, '2026-10-08')
    expect(s.get(2)).toBe(STATUS_CURRENT)
    expect(s.get(1)).toBe(STATUS_OLD)
  })
  it('a group with only future rows has no current row', () => {
    const s = priceStatuses([row(1, 'a', '2027-01-01'), row(2, 'a', '2027-06-01')], key, '2026-10-08')
    expect([...s.values()]).toEqual([STATUS_PENDING, STATUS_PENDING])
  })
  it('groups are independent', () => {
    const s = priceStatuses([row(1, 'a', '2026-01-01'), row(2, 'b', '2025-01-01'), row(3, 'b', '2027-01-01')], key, '2026-10-08')
    expect(s.get(1)).toBe(STATUS_CURRENT)
    expect(s.get(2)).toBe(STATUS_CURRENT)
    expect(s.get(3)).toBe(STATUS_PENDING)
  })
})
