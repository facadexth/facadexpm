// Turns the raw supabase.auth.signUp() result into what the signup screen
// should show. One email = one company (user_roles.user_email is unique), so
// an email that already has an account must never look like a success.
//
// With "Confirm email" OFF Supabase returns an "already registered" error.
// With it ON, to stop people probing which emails exist, it returns success
// with no error and a user whose `identities` list is empty -- and sends
// nothing. Without this check the screen would say "account created" and the
// person would wait for an email that never comes.

export const DUPLICATE_EMAIL_MESSAGE =
  'อีเมลนี้ถูกใช้งานแล้ว กรุณาเข้าสู่ระบบด้วยอีเมลนี้ หากจำรหัสผ่านไม่ได้ให้ติดต่อผู้ดูแลระบบ หรือใช้อีเมลอื่นสมัคร'

const GENERIC_SIGNUP_ERROR = 'สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง ถ้ายังไม่ได้ให้ติดต่อ support@changpm.app หรือ LINE @changpm'

// Supabase's own wording is English, and on a gateway failure it can be an
// empty object ("{}"). Show Thai text for the cases people actually hit.
export function signupErrorMessage(error) {
  const raw = String(error?.message ?? '').trim()
  const status = error?.status
  if (status === 429 || /rate limit/i.test(raw)) return 'ส่งอีเมลบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'
  if (/error sending confirmation email/i.test(raw)) {
    return 'ระบบส่งอีเมลยืนยันไม่สำเร็จ กรุณาลองใหม่ภายหลัง หรือติดต่อ support@changpm.app / LINE @changpm'
  }
  if (/password should be at least/i.test(raw)) return 'รหัสผ่านสั้นเกินไป กรุณาตั้งอย่างน้อย 6 ตัวอักษร'
  if (/invalid format|valid email|unable to validate email/i.test(raw)) return 'รูปแบบอีเมลไม่ถูกต้อง'
  if (!raw || /^[{[]/.test(raw) || (typeof status === 'number' && status >= 500)) return GENERIC_SIGNUP_ERROR
  return raw
}

export function classifySignup({ data, error }) {
  if (error) {
    if (/already\s+(been\s+)?registered/i.test(error.message || '')) {
      return { kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE }
    }
    return { kind: 'error', message: signupErrorMessage(error) }
  }
  const user = data?.user
  if (user && Array.isArray(user.identities) && user.identities.length === 0) {
    return { kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE }
  }
  // No session after a successful signUp means the email must be confirmed first.
  if (!data?.session) return { kind: 'confirm' }
  return { kind: 'ok' }
}
