// supabase/functions/_shared/line-admin-chat-logic.ts
// Pure decision logic for LINE "hybrid privacy mode" (see
// docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
// No Deno or DB imports on purpose: vitest imports this file directly
// (src/lib/lineAdminChatLogic.test.js), so the logic is written once and
// tested, instead of ported line-for-line like the older LINE modules.

export type ChatMode = 'secure_bot' | 'chat_with_admin'
export type DmRoute = 'start_chat' | 'chat_not_allowed' | 'end_chat' | 'record_text' | 'record_image' | 'normal_flow'

// The Rich Menu button / typed text is exactly this. Exact-match only,
// never substring: an ordinary sentence must never be able to opt a user
// into being recorded.
export const ADMIN_CHAT_START_PHRASE = 'คุยกับแอดมิน'
export const ADMIN_CHAT_END_PHRASE = 'จบการสนทนา'

// How long a chat may sit quiet before it is closed, and how long before
// that the user gets a heads-up. 30 minutes: the mode records messages, so
// a forgotten session must not stay open for hours.
export const DEFAULT_IDLE_MINUTES = 30
export const WARN_LEAD_MINUTES = 10

// First sentence is the owner-approved wording; the second line tells the
// user how to leave (a one-tap chip is attached when it is sent).
export const ADMIN_CHAT_START_NOTICE =
  'กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน\nพิมพ์ "จบการสนทนา" เมื่อเสร็จ หรือกดปุ่มด้านล่าง'
// Deliberately NOT "เข้ารหัส": the system does not encrypt, and telling
// users it does would itself be a PDPA problem.
export const ADMIN_CHAT_END_NOTICE = 'จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น'
export const ADMIN_CHAT_ACK_NOTICE = 'ส่งถึงแอดมินแล้ว แอดมินจะตอบเมื่อพร้อม'
export const ADMIN_CHAT_NOT_ALLOWED_NOTICE =
  'ช่องทางนี้สำหรับเจ้าของ/แอดมินของบริษัท หากเป็นเรื่องงาน กดปุ่ม "แจ้งปัญหา" หรือแจ้งหัวหน้า/แอดมินของบริษัทของคุณ'
export const ADMIN_CHAT_WARN_NOTICE = 'บทสนทนากับแอดมินจะสิ้นสุดใน 10 นาที หากยังต้องการคุย พิมพ์ข้อความต่อได้เลย'

// One-tap "end" chip shown under bot messages in this mode.
export const ADMIN_CHAT_END_QUICK_REPLY = [{ label: 'จบการสนทนา', text: ADMIN_CHAT_END_PHRASE }]

export function formatAdminReply(text: string): string {
  return `💬 แอดมิน: ${text}`
}

export function isStartPhrase(text: string | undefined): boolean {
  return (text ?? '').trim() === ADMIN_CHAT_START_PHRASE
}

export function routeDmEvent(input: {
  mode: ChatMode
  msgType: 'text' | 'image'
  text?: string
  // Only OWNER/ADMIN accounts may open a chat with the platform admin;
  // a worker's questions belong with their own company's admin.
  canStartChat?: boolean
}): DmRoute {
  const trimmed = input.msgType === 'text' ? (input.text ?? '').trim() : ''
  if (input.mode === 'chat_with_admin') {
    if (input.msgType === 'image') return 'record_image'
    return trimmed === ADMIN_CHAT_END_PHRASE ? 'end_chat' : 'record_text'
  }
  if (input.msgType === 'text' && trimmed === ADMIN_CHAT_START_PHRASE) {
    return input.canStartChat === true ? 'start_chat' : 'chat_not_allowed'
  }
  return 'normal_flow'
}

export function isSessionExpired(lastActivityMs: number, idleMinutes: number, nowMs: number): boolean {
  return nowMs - lastActivityMs > idleMinutes * 60 * 1000
}

// True once, in the last WARN_LEAD_MINUTES before the session would expire.
// Not when the limit is too short to leave room for a warning, and not once
// the session is past the limit (the expiry job closes it instead).
export function shouldWarnBeforeExpiry(input: {
  lastActivityMs: number
  idleMinutes: number
  nowMs: number
  alreadyWarned: boolean
}): boolean {
  if (input.alreadyWarned) return false
  if (input.idleMinutes <= WARN_LEAD_MINUTES) return false
  const elapsed = input.nowMs - input.lastActivityMs
  const limit = input.idleMinutes * 60 * 1000
  return elapsed >= limit - WARN_LEAD_MINUTES * 60 * 1000 && elapsed <= limit
}

// PostgREST errors carry `details`/`hint`, which can echo row values
// (e.g. a duplicate-key message includes the offending value). Log only
// the code and message so message content can never reach function logs.
export function safeErrorSummary(err: unknown): { code: string | null; message: string } {
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  return {
    code: typeof e.code === 'string' ? e.code : null,
    message: typeof e.message === 'string' ? e.message : 'unknown error',
  }
}

export function logSafeError(label: string, err: unknown): void {
  console.error(label, safeErrorSummary(err))
}
