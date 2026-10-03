import { describe, it, expect } from 'vitest'
import {
  routeDmEvent, isSessionExpired, safeErrorSummary,
  ADMIN_CHAT_START_PHRASE, ADMIN_CHAT_END_PHRASE,
  ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE,
} from '../../supabase/functions/_shared/line-admin-chat-logic.ts'
import { RESERVED_PHRASES } from './lineCommandSettings.js'

describe('routeDmEvent in secure_bot mode', () => {
  it('opens a chat only on the exact start phrase (trim allowed)', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'คุยกับแอดมิน' })).toBe('start_chat')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: '  คุยกับแอดมิน \n' })).toBe('start_chat')
  })
  it('does NOT open a chat when the phrase is merely inside a longer sentence', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'ผมอยากคุยกับแอดมินหน่อย' })).toBe('normal_flow')
  })
  it('sends everything else down the normal flow', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'งานวันนี้' })).toBe('normal_flow')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'image' })).toBe('normal_flow')
  })
  it('never routes to a record_* action (nothing is stored in secure_bot)', () => {
    const inputs = [
      { msgType: 'text', text: 'hello' }, { msgType: 'text', text: '' },
      { msgType: 'text', text: 'จบการสนทนา' }, { msgType: 'image' },
    ]
    for (const i of inputs) {
      expect(['record_text', 'record_image']).not.toContain(routeDmEvent({ mode: 'secure_bot', ...i }))
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

describe('isSessionExpired', () => {
  const HOUR = 3600 * 1000
  it('is false at exactly the limit and true just past it', () => {
    expect(isSessionExpired(0, 24, 24 * HOUR)).toBe(false)
    expect(isSessionExpired(0, 24, 24 * HOUR + 1)).toBe(true)
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

describe('copy and reserved phrases', () => {
  it('uses the agreed notices and never claims encryption', () => {
    expect(ADMIN_CHAT_START_NOTICE).toBe('กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน')
    expect(ADMIN_CHAT_END_NOTICE).toBe('จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น')
    expect(ADMIN_CHAT_END_NOTICE).not.toContain('เข้ารหัส')
  })
  it('reserves both phrases so a tenant custom command phrase cannot collide', () => {
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_START_PHRASE)
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_END_PHRASE)
  })
})
