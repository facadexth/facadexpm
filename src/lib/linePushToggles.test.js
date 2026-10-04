import { describe, it, expect } from 'vitest'
import { LINE_PUSH_TOGGLES, parseToggle } from './linePushToggles.js'
import { WEB_PUSH_TOGGLES } from './webPushToggles.js'
import { PUSH_TOGGLE_DEFAULTS, parseToggle as parseToggleServer, isPushEnabled } from '../../supabase/functions/_shared/push-settings.ts'

describe('push toggle list stays in step between the UI and the functions', () => {
  it('has the same keys and defaults on both sides', () => {
    const ui = Object.fromEntries([...LINE_PUSH_TOGGLES, ...WEB_PUSH_TOGGLES].map(t => [t.key, t.defaultOn]))
    expect(ui).toEqual(PUSH_TOGGLE_DEFAULTS)
  })
  it('has a label and detail for every switch', () => {
    for (const t of LINE_PUSH_TOGGLES) {
      expect(t.label.length).toBeGreaterThan(3)
      expect(t.detail.length).toBeGreaterThan(10)
    }
  })
  it('parses the same way on both sides', () => {
    for (const v of ['true', 'false', true, false, null, undefined, '', 'yes', 0]) {
      for (const d of [true, false]) expect(parseToggle(v, d)).toBe(parseToggleServer(v, d))
    }
  })
  it('only an explicit true/false overrides the default', () => {
    expect(parseToggleServer('false', true)).toBe(false)
    expect(parseToggleServer('true', false)).toBe(true)
    expect(parseToggleServer(null, true)).toBe(true)
    expect(parseToggleServer('garbage', false)).toBe(false)
  })
})

describe('isPushEnabled', () => {
  const adminReturning = (result) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }),
  })
  it('uses the stored value', async () => {
    expect(await isPushEnabled(adminReturning({ data: { value: 'false' }, error: null }), 't', 'line_push_quotation_followup')).toBe(false)
    expect(await isPushEnabled(adminReturning({ data: { value: 'true' }, error: null }), 't', 'cheque_reminder_line_enabled')).toBe(true)
  })
  it('falls back to the key default when nothing is stored', async () => {
    expect(await isPushEnabled(adminReturning({ data: null, error: null }), 't', 'line_push_quotation_followup')).toBe(true)
    expect(await isPushEnabled(adminReturning({ data: null, error: null }), 't', 'cheque_reminder_line_enabled')).toBe(false)
  })
  it('falls back to the default when the lookup fails', async () => {
    expect(await isPushEnabled(adminReturning({ data: null, error: { code: 'X' } }), 't', 'line_push_leave_result')).toBe(true)
  })
})
