import { describe, it, expect } from 'vitest'
import { checkBundle, REQUIRED_REF, FORBIDDEN_REFS } from './verify-bundle.mjs'

describe('checkBundle', () => {
  it('passes a bundle that points only at CHANG', () => {
    expect(checkBundle([`x="https://${REQUIRED_REF}.supabase.co"`])).toEqual([])
  })
  it('fails when the CHANG project is missing', () => {
    expect(checkBundle(['nothing here'])).toHaveLength(1)
  })
  it('fails when the retired Tokyo project is present, even beside CHANG', () => {
    const text = `a="${REQUIRED_REF}" b="${FORBIDDEN_REFS[0]}"`
    const problems = checkBundle([text])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(FORBIDDEN_REFS[0])
  })
  it('reports both problems when CHANG is missing and Tokyo is present', () => {
    expect(checkBundle([`b="${FORBIDDEN_REFS[0]}"`])).toHaveLength(2)
  })
  it('looks across every file', () => {
    expect(checkBundle(['a', `https://${REQUIRED_REF}`])).toEqual([])
  })
})
