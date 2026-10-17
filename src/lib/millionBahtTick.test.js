import { describe, it, expect } from 'vitest'
import { millionBahtTick } from './millionBahtTick.js'

describe('millionBahtTick', () => {
  it('formats in ล้านบาท', () => {
    expect(millionBahtTick(0)).toBe('0')
    expect(millionBahtTick(250000)).toBe('0.25 ลบ.')
    expect(millionBahtTick(2500000)).toBe('2.5 ลบ.')
    expect(millionBahtTick(3000000)).toBe('3 ลบ.')
    expect(millionBahtTick(12480000)).toBe('12 ลบ.')
    expect(millionBahtTick(125000000)).toBe('125 ลบ.')
    expect(millionBahtTick(-1500000)).toBe('-1.5 ลบ.')
  })
})
