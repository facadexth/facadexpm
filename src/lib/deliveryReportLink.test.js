import { describe, it, expect } from 'vitest'
import { linkState, canMarkSigned } from '../../supabase/functions/_shared/delivery-report-link.ts'

describe('delivery report sign-link state', () => {
  it('replaced or void report -> replaced', () => {
    expect(linkState({ status: 'replaced' })).toBe('replaced')
    expect(linkState({ status: 'void' })).toBe('replaced')
  })
  it('draft / issued / signed -> ok, missing row -> missing', () => {
    expect(linkState({ status: 'draft' })).toBe('ok')
    expect(linkState({ status: 'issued' })).toBe('ok')
    expect(linkState({ status: 'signed' })).toBe('ok')
    expect(linkState(null)).toBe('missing')
  })
  it('only draft/issued may become signed', () => {
    expect(canMarkSigned({ status: 'draft' })).toBe(true)
    expect(canMarkSigned({ status: 'issued' })).toBe(true)
    expect(canMarkSigned({ status: 'signed' })).toBe(false)
    expect(canMarkSigned({ status: 'replaced' })).toBe(false)
    expect(canMarkSigned(null)).toBe(false)
  })
})
