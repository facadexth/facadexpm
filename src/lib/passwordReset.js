// ============================================================
// Forgot-password flow helpers (pure, no React / Supabase).
// Flow: Login "ลืมรหัสผ่าน?" -> supabase.auth.resetPasswordForEmail -> user clicks the emailed link ->
// the app opens with a recovery session -> ResetPassword screen -> supabase.auth.updateUser({ password }).
// ============================================================

export const MIN_PASSWORD_LENGTH = 6
/** The "send again" button stays disabled this long after a request (stops rapid re-sends). */
export const RESET_COOLDOWN_SECONDS = 60

/** Thai error for the new-password form, or null when valid. */
export function validateNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `รหัสผ่านต้องอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`
  }
  if (password !== confirm) return 'รหัสผ่านสองช่องไม่ตรงกัน'
  return null
}

/** True when the page was opened from a password-recovery email link (implicit flow puts type=recovery in the hash). */
export function isRecoveryUrl(hash) {
  return /[#&]type=recovery(&|$)/.test(String(hash || ''))
}

/** True when Supabase bounced the user back with an expired / already-used link. */
export function isExpiredLinkUrl(hash, search) {
  const s = `${hash || ''}&${search || ''}`
  return /(^|[#&?])error_code=otp_expired(&|$)/.test(s) || /(^|[#&?])error=access_denied(&|$)/.test(s)
}

/**
 * What the "send link" form shows after resetPasswordForEmail answered.
 * The same success message is used whether or not the address has an account (nobody can probe which emails are
 * users); only a rate limit or a network problem is reported, because the user can act on those.
 * @returns {{ ok: boolean, message: string|null }}
 */
export function classifyResetRequest(error) {
  if (!error) return { ok: true, message: null }
  const code = String(error.code || '')
  const msg = String(error.message || '')
  if (code === 'over_email_send_rate_limit' || error.status === 429 || /rate limit/i.test(msg)) {
    return { ok: false, message: 'ขอลิงก์บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }
  }
  if (/failed to fetch|network|load failed/i.test(msg)) {
    return { ok: false, message: 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ กรุณาลองใหม่' }
  }
  // unknown email, disabled user, etc. -> look identical to success
  return { ok: true, message: null }
}
