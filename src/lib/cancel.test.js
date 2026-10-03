import { describe, it, expect } from 'vitest'
import { isCancel, CANCEL_PHRASE, CANCEL_CHIP, CANCEL_REPLY } from '../../supabase/functions/_shared/cancel.ts'
import { todayMenuOptions } from '../../supabase/functions/_shared/today-menu.ts'
import { RESERVED_PHRASES } from './lineCommandSettings.js'

describe('isCancel', () => {
  it('matches the word, ignoring surrounding spaces', () => {
    expect(isCancel('ยกเลิก')).toBe(true)
    expect(isCancel('  ยกเลิก \n')).toBe(true)
  })
  it('does not match a sentence that merely contains it', () => {
    expect(isCancel('ขอยกเลิกวันลา')).toBe(false)
    expect(isCancel('ยกเลิกงานนี้')).toBe(false)
  })
  it('does not match empty or missing text', () => {
    expect(isCancel('')).toBe(false)
    expect(isCancel(null)).toBe(false)
    expect(isCancel(undefined)).toBe(false)
  })
})

describe('the Cancel chip', () => {
  it('sends exactly the phrase the bot treats as cancel', () => {
    expect(CANCEL_CHIP).toEqual({ label: CANCEL_PHRASE, text: CANCEL_PHRASE })
    expect(isCancel(CANCEL_CHIP.text)).toBe(true)
  })
  it('has a short reply that carries no chips of its own', () => {
    expect(CANCEL_REPLY).toBe('ยกเลิกแล้วครับ')
  })
  it('is the last chip under the งานวันนี้ sub-menu in every state', () => {
    const base = { hasOpenTasks: true, tomorrowPhrase: 'งานวันพรุ่งนี้' }
    for (const [hasCheckedIn, hasCheckedOut] of [[false, false], [true, false], [true, true]]) {
      expect(todayMenuOptions({ ...base, hasCheckedIn, hasCheckedOut }).at(-1)).toBe(CANCEL_PHRASE)
    }
  })
  it('is reserved so no command can be renamed to it', () => {
    expect(RESERVED_PHRASES).toContain(CANCEL_PHRASE)
  })
})
