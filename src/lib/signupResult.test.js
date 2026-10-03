import { describe, it, expect } from 'vitest'
import { classifySignup, signupErrorMessage, DUPLICATE_EMAIL_MESSAGE } from './signupResult.js'

describe('classifySignup', () => {
  it('treats the "already registered" error as a duplicate', () => {
    expect(classifySignup({ data: null, error: { message: 'User already registered' } }))
      .toEqual({ kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE })
  })
  it('treats a fake success (empty identities) as a duplicate', () => {
    const data = { user: { identities: [] }, session: null }
    expect(classifySignup({ data, error: null }).kind).toBe('duplicate')
  })
  it('translates the common errors to Thai', () => {
    expect(classifySignup({ data: null, error: { message: 'Password should be at least 6 characters' } }))
      .toEqual({ kind: 'error', message: 'รหัสผ่านสั้นเกินไป กรุณาตั้งอย่างน้อย 6 ตัวอักษร' })
  })
  it('passes an unknown but readable error through', () => {
    expect(classifySignup({ data: null, error: { message: 'Something specific', status: 400 } }))
      .toEqual({ kind: 'error', message: 'Something specific' })
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

describe('signupErrorMessage', () => {
  it('never shows an empty object', () => {
    for (const message of ['{}', '', '[object Object]'.slice(0, 0), '{"a":1}']) {
      const m = signupErrorMessage({ message })
      expect(m).toContain('support@changpm.app')
      expect(m).not.toMatch(/^[{[]/)
    }
    expect(signupErrorMessage(undefined)).toContain('support@changpm.app')
  })
  it('explains a confirmation-email failure', () => {
    expect(signupErrorMessage({ message: 'Error sending confirmation email', status: 500 })).toContain('อีเมลยืนยัน')
  })
  it('explains rate limiting', () => {
    expect(signupErrorMessage({ message: 'email rate limit exceeded', status: 429 })).toContain('บ่อยเกินไป')
  })
  it('falls back to a generic message for server errors with odd text', () => {
    expect(signupErrorMessage({ message: 'upstream connect error', status: 503 })).toContain('สมัครไม่สำเร็จ')
  })
})
