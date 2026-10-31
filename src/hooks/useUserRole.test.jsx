// @vitest-environment jsdom
// A useUserRole instance mounted after App resolved the role starts with it (no null/loading first render).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { setCurrentRole } from '../lib/roles.js'

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    auth: { getSession: () => new Promise(() => {}), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  },
}))

import { useUserRole } from './useUserRole.js'

afterEach(() => setCurrentRole(null))

describe('useUserRole seeding', () => {
  it('starts with the global role and loading false when the role is already known', () => {
    setCurrentRole('PM')
    const { result } = renderHook(() => useUserRole())
    expect(result.current.role).toBe('PM')
    expect(result.current.loading).toBe(false)
    expect(result.current.isAtLeast('ADMIN')).toBe(false)
  })

  it('starts with null and loading true before any role is known', () => {
    const { result } = renderHook(() => useUserRole())
    expect(result.current.role).toBe(null)
    expect(result.current.loading).toBe(true)
  })
})
