import { describe, it, expect } from 'vitest'
import { contentRetryDelay, CONTENT_RETRY_MAX, CONTENT_RETRY_DELAY_MS } from '../../supabase/functions/_shared/repair.ts'

describe('contentRetryDelay (LINE 202 = video still preparing)', () => {
  it('waits 5 s after a 202, for up to 6 retries', () => {
    expect(CONTENT_RETRY_MAX).toBe(6)
    expect(CONTENT_RETRY_DELAY_MS).toBe(5000)
    for (let attempt = 1; attempt <= 6; attempt++) expect(contentRetryDelay(attempt, 202)).toBe(5000)
  })
  it('gives up after the 6th retry', () => {
    expect(contentRetryDelay(7, 202)).toBeNull()
    expect(contentRetryDelay(100, 202)).toBeNull()
  })
  it('never retries a 200 or a real error', () => {
    expect(contentRetryDelay(1, 200)).toBeNull()
    expect(contentRetryDelay(1, 404)).toBeNull()
    expect(contentRetryDelay(1, 500)).toBeNull()
  })
})
