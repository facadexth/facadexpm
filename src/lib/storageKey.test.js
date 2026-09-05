import { describe, it, expect } from 'vitest'
import { sanitizeStorageFileName } from './storageKey.js'

describe('sanitizeStorageFileName', () => {
  it('replaces Thai characters that Supabase Storage rejects as InvalidKey', () => {
    expect(sanitizeStorageFileName('QT26-58077_ชั้น2.pdf')).toBe('QT26-58077_____2.pdf')
  })

  it('leaves an already-safe ASCII filename untouched', () => {
    expect(sanitizeStorageFileName('invoice-2026-018.pdf')).toBe('invoice-2026-018.pdf')
  })

  it('replaces spaces and other punctuation', () => {
    expect(sanitizeStorageFileName('my file (1).pdf')).toBe('my_file__1_.pdf')
  })

  it('handles an empty or missing name without throwing', () => {
    expect(sanitizeStorageFileName('')).toBe('')
    expect(sanitizeStorageFileName(undefined)).toBe('')
  })
})
