// supabase/functions/_shared/line-admin-chat-logic.ts
// Pure decision logic for LINE "hybrid privacy mode" (see
// docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
// No Deno or DB imports on purpose: vitest imports this file directly
// (src/lib/lineAdminChatLogic.test.js), so the logic is written once and
// tested, instead of ported line-for-line like the older LINE modules.

export type ChatMode = 'secure_bot' | 'chat_with_admin'
export type DmRoute = 'start_chat' | 'end_chat' | 'record_text' | 'record_image' | 'normal_flow'

// The Rich Menu button sends this exact text (all existing buttons work
// that way). Exact-match only, never substring: an ordinary sentence
// must never be able to opt a user into being recorded.
export const ADMIN_CHAT_START_PHRASE = 'คุยกับแอดมิน'
export const ADMIN_CHAT_END_PHRASE = 'จบการสนทนา'

export const ADMIN_CHAT_START_NOTICE = 'กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน'
// Deliberately NOT "เข้ารหัส": the system does not encrypt, and telling
// users it does would itself be a PDPA problem.
export const ADMIN_CHAT_END_NOTICE = 'จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น'

export function routeDmEvent(input: { mode: ChatMode; msgType: 'text' | 'image'; text?: string }): DmRoute {
  const trimmed = input.msgType === 'text' ? (input.text ?? '').trim() : ''
  if (input.mode === 'chat_with_admin') {
    if (input.msgType === 'image') return 'record_image'
    return trimmed === ADMIN_CHAT_END_PHRASE ? 'end_chat' : 'record_text'
  }
  return input.msgType === 'text' && trimmed === ADMIN_CHAT_START_PHRASE ? 'start_chat' : 'normal_flow'
}

export function isSessionExpired(lastActivityMs: number, idleHours: number, nowMs: number): boolean {
  return nowMs - lastActivityMs > idleHours * 3600 * 1000
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
