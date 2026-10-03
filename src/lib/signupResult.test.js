import { describe, it, expect } from 'vitest'
import { classifySignup, DUPLICATE_EMAIL_MESSAGE } from './signupResult.js'

describe('classifySignup', () => {
  it('treats the "already registered" error as a duplicate', () => {
    expect(classifySignup({ data: null, error: { message: 'User already registered' } }))
      .toEqual({ kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE })
  })
  it('treats a fake success (empty identities) as a duplicate', () => {
    const data = { user: { identities: [] }, session: null }
    expect(classifySignup({ data, error: null }).kind).toBe('duplicate')
  })
  it('passes other errors through unchanged', () => {
    expect(classifySignup({ data: null, error: { message: 'Password should be at least 6 characters' } }))
      .toEqual({ kind: 'error', message: 'Password should be at least 6 characters' })
  })
  it('asks the person to confirm their email when no session came back', () => {
    const data = { user: { identities: [{ id: 'x' }] }, session: null }
    expect(classifySignup({ data, error: null }).kind).toBe('confirm')
  })
  it('is a plain success when a session came back (confirm off)', () => {
    const data = { user: { identities: [{ id: 'x' }] }, session: { access_token: 't' } }
    expect(classifySignup({ data, error: null }).kind).toBe('ok')
  })
})
