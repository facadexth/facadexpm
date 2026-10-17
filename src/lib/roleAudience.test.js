import { describe, it, expect } from 'vitest'
import { rolesFor } from '../../supabase/functions/_shared/roleAudience.ts'
describe('rolesFor', () => {
  it('ops includes PM, money does not', () => {
    expect(rolesFor('ops')).toEqual(['OWNER', 'ADMIN', 'PM'])
    expect(rolesFor('money')).toEqual(['OWNER', 'ADMIN'])
  })
  it('throws on a missing or unknown audience', () => {
    expect(() => rolesFor(undefined)).toThrow()
    expect(() => rolesFor('x')).toThrow()
  })
})
