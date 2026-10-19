import { describe, it, expect } from 'vitest'
import { isCustomerImage } from './customerVisible.js'

describe('isCustomerImage', () => {
  it('accepts jpg/jpeg/png in any case', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'x.y.Png']) expect(isCustomerImage(n)).toBe(true)
  })
  it('rejects other files and empty input', () => {
    for (const n of ['a.pdf', 'a.xlsx', 'jpg', 'a.jpg.pdf', '', null, undefined]) expect(isCustomerImage(n)).toBe(false)
  })
})
