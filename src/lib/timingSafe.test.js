import { describe, it, expect } from 'vitest'
import { timingSafeEqual } from '../../supabase/functions/_shared/timing-safe.ts'

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('abc123==', 'abc123==')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
  })
  it('rejects a different last character', () => {
    expect(timingSafeEqual('abc123==', 'abc123=x')).toBe(false)
  })
  it('rejects different lengths, including a prefix', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
  })
  it('handles non-ASCII input', () => {
    expect(timingSafeEqual('ก', 'ก')).toBe(true)
    expect(timingSafeEqual('ก', 'ข')).toBe(false)
  })
})
