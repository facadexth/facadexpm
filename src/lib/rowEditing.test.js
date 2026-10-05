import { describe, it, expect } from 'vitest'
import { removeBlockOrClear } from './rowEditing.js'

const BLANK = { description: '', quantity: '1' }
const make = () => ({ ...BLANK })

describe('removeBlockOrClear', () => {
  it('removes a middle row', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
    expect(removeBlockOrClear(rows, 1, 1, make)).toEqual([{ a: 1 }, { a: 3 }])
    expect(rows).toHaveLength(3)
  })
  it('removes a 2-row block from a longer list', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 'd' }, { a: 4 }]
    expect(removeBlockOrClear(rows, 1, 2, make)).toEqual([{ a: 1 }, { a: 4 }])
    expect(rows).toHaveLength(4)
  })
  it('a single-row list returns a fresh blank row and leaves the original untouched', () => {
    const rows = [{ description: 'x' }]
    const out = removeBlockOrClear(rows, 0, 1, make)
    expect(out).toEqual([BLANK])
    expect(out).not.toBe(rows)
    expect(rows).toEqual([{ description: 'x' }])
  })
  it('a block equal to the whole list returns the blank row', () => {
    const rows = [{ a: 1 }, { a: 'd' }]
    expect(removeBlockOrClear(rows, 0, 2, make)).toEqual([BLANK])
    expect(rows).toHaveLength(2)
  })
  it('makeEmpty returns a new object each time', () => {
    const a = removeBlockOrClear([{ a: 1 }], 0, 1, make)[0]
    const b = removeBlockOrClear([{ a: 1 }], 0, 1, make)[0]
    expect(a).not.toBe(b)
    expect(a).not.toBe(BLANK)
  })
})
