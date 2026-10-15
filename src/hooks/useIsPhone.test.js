// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useIsPhone, PHONE_QUERY, isPhoneNow } from './useIsPhone.js'

afterEach(cleanup)

function mockMatchMedia(matches) {
  const listeners = new Set()
  const mql = {
    matches, media: PHONE_QUERY,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    fire(next) { mql.matches = next; listeners.forEach(fn => fn({ matches: next })) },
  }
  window.matchMedia = q => { if (q !== PHONE_QUERY) throw new Error('unexpected query ' + q); return mql }
  return mql
}

describe('useIsPhone', () => {
  let saved
  beforeEach(() => { saved = window.matchMedia })
  afterEach(() => { window.matchMedia = saved })

  it('reads the media query and follows changes', () => {
    const mql = mockMatchMedia(false)
    const { result } = renderHook(() => useIsPhone())
    expect(result.current).toBe(false)
    act(() => mql.fire(true))
    expect(result.current).toBe(true)
    expect(isPhoneNow()).toBe(true)
  })

  it('stops listening on unmount', () => {
    const mql = mockMatchMedia(true)
    const { result, unmount } = renderHook(() => useIsPhone())
    expect(result.current).toBe(true)
    unmount()
    act(() => mql.fire(false))
    expect(result.current).toBe(true)
  })

  it('is false when matchMedia is missing (SSR / old browsers)', () => {
    window.matchMedia = undefined
    const { result } = renderHook(() => useIsPhone())
    expect(result.current).toBe(false)
    expect(isPhoneNow()).toBe(false)
  })
})
