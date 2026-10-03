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

export function classifySignup({ data, error }) {
  if (error) {
    if (/already\s+(been\s+)?registered/i.test(error.message || '')) {
      return { kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE }
    }
    return { kind: 'error', message: error.message }
  }
  const user = data?.user
  if (user && Array.isArray(user.identities) && user.identities.length === 0) {
    return { kind: 'duplicate', message: DUPLICATE_EMAIL_MESSAGE }
  }
  // No session after a successful signUp means the email must be confirmed first.
  if (!data?.session) return { kind: 'confirm' }
  return { kind: 'ok' }
}
