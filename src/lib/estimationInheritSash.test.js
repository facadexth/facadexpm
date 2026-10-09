// src/lib/estimationInheritSash.test.js -- the sash thickness inherits like every other default (item -> project -> none).
import { describe, it, expect } from 'vitest'
import { resolveItemInputs } from './estimationInherit.js'

describe('resolveItemInputs sash thickness', () => {
  it('item value wins, then the project default, else null (null = same as the frame)', () => {
    expect(resolveItemInputs({ sash_thickness_mm: 1.5 }, { default_sash_thickness_mm: 2 }, null, {}).sash_thickness_mm).toBe(1.5)
    expect(resolveItemInputs({}, { default_sash_thickness_mm: '2' }, null, {}).sash_thickness_mm).toBe(2)
    expect(resolveItemInputs({}, {}, null, {}).sash_thickness_mm).toBeNull()
  })
  it('the frame thickness is unaffected', () => {
    expect(resolveItemInputs({ thickness_mm: 2 }, { default_sash_thickness_mm: 1.5 }, null, {}).thickness_mm).toBe(2)
  })
})
