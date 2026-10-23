import { describe, it, expect, vi, afterEach } from 'vitest'
import { newId } from './uuid.js'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  afterEach(() => vi.restoreAllMocks())
  it('uses crypto.randomUUID when present', () => {
    expect(newId()).toMatch(V4)
  })
  it('falls back to getRandomValues when randomUUID is missing', () => {
    const orig = globalThis.crypto.randomUUID
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true })
    try {
      const a = newId(), b = newId()
      expect(a).toMatch(V4)
      expect(b).toMatch(V4)
      expect(a).not.toBe(b)
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: orig, configurable: true, writable: true })
    }
  })
})
