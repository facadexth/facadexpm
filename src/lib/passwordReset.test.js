import { describe, it, expect } from 'vitest'
import { validateNewPassword, isRecoveryUrl, isExpiredLinkUrl, classifyResetRequest, MIN_PASSWORD_LENGTH, RESET_COOLDOWN_SECONDS } from './passwordReset.js'

describe('validateNewPassword', () => {
  it('rejects short passwords', () => {
    expect(validateNewPassword('12345', '12345')).toMatch(/อย่างน้อย 6/)
    expect(validateNewPassword('', '')).toMatch(/อย่างน้อย 6/)
    expect(validateNewPassword(undefined, undefined)).toMatch(/อย่างน้อย 6/)
  })
  it('rejects a mismatch', () => {
    expect(validateNewPassword('abcdef1', 'abcdef2')).toMatch(/ไม่ตรงกัน/)
  })
  it('accepts a matching password of 6+ characters', () => {
    expect(validateNewPassword('abcdef', 'abcdef')).toBeNull()
    expect(MIN_PASSWORD_LENGTH).toBe(6)
  })
})

describe('isRecoveryUrl', () => {
  it('detects the recovery hash Supabase appends to the email link', () => {
    expect(isRecoveryUrl('#access_token=abc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery')).toBe(true)
    expect(isRecoveryUrl('#type=recovery&access_token=abc')).toBe(true)
  })
  it('ignores other hashes', () => {
    expect(isRecoveryUrl('')).toBe(false)
    expect(isRecoveryUrl(undefined)).toBe(false)
    expect(isRecoveryUrl('#type=signup&access_token=abc')).toBe(false)
    expect(isRecoveryUrl('#type=recovery_foo')).toBe(false)
  })
})

describe('isExpiredLinkUrl', () => {
  it('detects an expired or used link', () => {
    expect(isExpiredLinkUrl('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '')).toBe(true)
    expect(isExpiredLinkUrl('', '?error=access_denied')).toBe(true)
  })
  it('is false for a normal page load', () => {
    expect(isExpiredLinkUrl('', '')).toBe(false)
    expect(isExpiredLinkUrl('#type=recovery&access_token=x', '')).toBe(false)
  })
})

describe('classifyResetRequest', () => {
  it('success looks the same as an unknown address (no account probing)', () => {
    expect(classifyResetRequest(null)).toEqual({ ok: true, message: null })
    expect(classifyResetRequest({ code: 'user_not_found', message: 'User not found', status: 400 })).toEqual({ ok: true, message: null })
  })
  it('reports a rate limit', () => {
    expect(classifyResetRequest({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 }).ok).toBe(false)
    expect(classifyResetRequest({ status: 429, message: 'x' }).message).toMatch(/บ่อยเกินไป/)
  })
  it('reports a network failure', () => {
    expect(classifyResetRequest({ message: 'Failed to fetch' }).ok).toBe(false)
  })
  it('cooldown is 60 seconds', () => {
    expect(RESET_COOLDOWN_SECONDS).toBe(60)
  })
})
