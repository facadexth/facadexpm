import { describe, it, expect } from 'vitest'
import {
  routeDmEvent, isStartPhrase, isSessionExpired, shouldWarnBeforeExpiry, safeErrorSummary,
  formatAdminReply, DEFAULT_IDLE_MINUTES, WARN_LEAD_MINUTES,
  ADMIN_CHAT_START_PHRASE, ADMIN_CHAT_END_PHRASE,
  ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE, ADMIN_CHAT_ACK_NOTICE,
  ADMIN_CHAT_NOT_ALLOWED_NOTICE, ADMIN_CHAT_WARN_NOTICE, ADMIN_CHAT_END_QUICK_REPLY,
} from '../../supabase/functions/_shared/line-admin-chat-logic.ts'
import { RESERVED_PHRASES } from './lineCommandSettings.js'

describe('isStartPhrase', () => {
  it('matches only the exact phrase (trim allowed)', () => {
    expect(isStartPhrase('คุยกับแอดมิน')).toBe(true)
    expect(isStartPhrase('  คุยกับแอดมิน \n')).toBe(true)
    expect(isStartPhrase('ผมอยากคุยกับแอดมินหน่อย')).toBe(false)
    expect(isStartPhrase(undefined)).toBe(false)
  })
})

describe('routeDmEvent in secure_bot mode', () => {
  it('opens a chat on the exact start phrase when the sender may start one', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'คุยกับแอดมิน', canStartChat: true })).toBe('start_chat')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: '  คุยกับแอดมิน \n', canStartChat: true })).toBe('start_chat')
  })
  it('refuses to open a chat for a sender who may not (a worker), and records nothing', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'คุยกับแอดมิน', canStartChat: false })).toBe('chat_not_allowed')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'คุยกับแอดมิน' })).toBe('chat_not_allowed')
  })
  it('does NOT open a chat when the phrase is merely inside a longer sentence', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'ผมอยากคุยกับแอดมินหน่อย', canStartChat: true })).toBe('normal_flow')
  })
  it('sends everything else down the normal flow', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'งานวันนี้', canStartChat: true })).toBe('normal_flow')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'image', canStartChat: true })).toBe('normal_flow')
  })
  it('never routes to a record_* action (nothing is stored in secure_bot)', () => {
    const inputs = [
      { msgType: 'text', text: 'hello' }, { msgType: 'text', text: '' },
      { msgType: 'text', text: 'จบการสนทนา' }, { msgType: 'text', text: 'คุยกับแอดมิน' }, { msgType: 'image' },
    ]
    for (const i of inputs) for (const canStartChat of [true, false]) {
      expect(['record_text', 'record_image']).not.toContain(routeDmEvent({ mode: 'secure_bot', canStartChat, ...i }))
    }
  })
})

describe('routeDmEvent in chat_with_admin mode', () => {
  it('records text and images', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'สวัสดี' })).toBe('record_text')
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'image' })).toBe('record_image')
  })
  it('ends only on the exact end phrase', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'จบการสนทนา' })).toBe('end_chat')
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'ขอจบการสนทนาครับ' })).toBe('record_text')
  })
  it('records the start phrase if sent again while already chatting', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'คุยกับแอดมิน' })).toBe('record_text')
  })
})

describe('idle expiry (minutes)', () => {
  const MIN = 60 * 1000
  it('defaults to 30 minutes', () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30)
  })
  it('is false at exactly the limit and true just past it', () => {
    expect(isSessionExpired(0, 30, 30 * MIN)).toBe(false)
    expect(isSessionExpired(0, 30, 30 * MIN + 1)).toBe(true)
  })
})

describe('shouldWarnBeforeExpiry', () => {
  const MIN = 60 * 1000
  const base = { lastActivityMs: 0, idleMinutes: 30, alreadyWarned: false }
  it('warns 10 minutes before the limit', () => {
    expect(WARN_LEAD_MINUTES).toBe(10)
    expect(shouldWarnBeforeExpiry({ ...base, nowMs: 19 * MIN })).toBe(false)
    expect(shouldWarnBeforeExpiry({ ...base, nowMs: 20 * MIN })).toBe(true)
    expect(shouldWarnBeforeExpiry({ ...base, nowMs: 29 * MIN })).toBe(true)
  })
  it('does not warn once the session is already expired (it is closed instead)', () => {
    expect(shouldWarnBeforeExpiry({ ...base, nowMs: 31 * MIN })).toBe(false)
  })
  it('warns only once per quiet period', () => {
    expect(shouldWarnBeforeExpiry({ ...base, nowMs: 25 * MIN, alreadyWarned: true })).toBe(false)
  })
  it('never warns when the limit is not longer than the warning lead', () => {
    expect(shouldWarnBeforeExpiry({ lastActivityMs: 0, idleMinutes: 10, nowMs: 9 * MIN, alreadyWarned: false })).toBe(false)
  })
})

describe('safeErrorSummary', () => {
  it('keeps code and message but drops details/hint (which can echo row values)', () => {
    const err = { code: '23505', message: 'duplicate key value violates unique constraint "x"', details: 'Key (body)=(secret text) already exists.', hint: 'secret' }
    const out = safeErrorSummary(err)
    expect(out).toEqual({ code: '23505', message: 'duplicate key value violates unique constraint "x"' })
    expect(JSON.stringify(out)).not.toContain('secret')
  })
  it('tolerates non-error input', () => {
    expect(safeErrorSummary(null)).toEqual({ code: null, message: 'unknown error' })
  })
})

describe('copy', () => {
  it('start notice keeps the agreed sentence, then tells the user how to end', () => {
    expect(ADMIN_CHAT_START_NOTICE.startsWith('กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน')).toBe(true)
    expect(ADMIN_CHAT_START_NOTICE).toContain(ADMIN_CHAT_END_PHRASE)
  })
  it('end notice is the agreed text and never claims encryption', () => {
    expect(ADMIN_CHAT_END_NOTICE).toBe('จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น')
    for (const t of [ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE, ADMIN_CHAT_ACK_NOTICE, ADMIN_CHAT_WARN_NOTICE, ADMIN_CHAT_NOT_ALLOWED_NOTICE]) {
      expect(t).not.toContain('เข้ารหัส')
    }
  })
  it('the not-allowed notice points workers to the right channel', () => {
    expect(ADMIN_CHAT_NOT_ALLOWED_NOTICE).toContain('แจ้งปัญหา')
  })
  it('the warning says 10 minutes', () => {
    expect(ADMIN_CHAT_WARN_NOTICE).toContain('10 นาที')
  })
  it('formats an admin reply with a recognisable prefix', () => {
    expect(formatAdminReply('ได้ครับ')).toBe('💬 แอดมิน: ได้ครับ')
  })
  it('offers a one-tap end chip that sends the exact end phrase', () => {
    expect(ADMIN_CHAT_END_QUICK_REPLY).toEqual([{ label: 'จบการสนทนา', text: ADMIN_CHAT_END_PHRASE }])
  })
  it('reserves both trigger phrases so a tenant custom command phrase cannot collide', () => {
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_START_PHRASE)
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_END_PHRASE)
  })
})
