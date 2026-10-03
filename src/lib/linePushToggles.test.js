import { describe, it, expect } from 'vitest'
import { LINE_PUSH_TOGGLES, parseToggle } from './linePushToggles.js'
import { PUSH_TOGGLE_DEFAULTS, parseToggle as parseToggleServer, isPushEnabled } from '../../supabase/functions/_shared/push-settings.ts'
import { formatInvoiceDueDigest, MAX_SITES_LISTED } from '../../supabase/functions/_shared/invoice-due-message.ts'

describe('push toggle list stays in step between the UI and the functions', () => {
  it('has the same keys and defaults on both sides', () => {
    const ui = Object.fromEntries(LINE_PUSH_TOGGLES.map(t => [t.key, t.defaultOn]))
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
    expect(await isPushEnabled(adminReturning({ data: { value: 'false' }, error: null }), 't', 'line_push_invoice_due')).toBe(false)
    expect(await isPushEnabled(adminReturning({ data: { value: 'true' }, error: null }), 't', 'cheque_reminder_line_enabled')).toBe(true)
  })
  it('falls back to the key default when nothing is stored', async () => {
    expect(await isPushEnabled(adminReturning({ data: null, error: null }), 't', 'line_push_invoice_due')).toBe(true)
    expect(await isPushEnabled(adminReturning({ data: null, error: null }), 't', 'cheque_reminder_line_enabled')).toBe(false)
  })
  it('falls back to the default when the lookup fails', async () => {
    expect(await isPushEnabled(adminReturning({ data: null, error: { code: 'X' } }), 't', 'line_push_leave_result')).toBe(true)
  })
})

describe('formatInvoiceDueDigest', () => {
  const site = (i, pct = 40) => ({ name: `ไซท์ ${i}`, site_number: `SN-${i}`, billing_pct: pct })
  it('lists every site in one message with a count', () => {
    const text = formatInvoiceDueDigest([site(1, 30), site(2, 0)])
    expect(text).toContain('2 ไซท์')
    expect(text).toContain('• ไซท์ 1 (SN-1) เบิกแล้ว 30%')
    expect(text).toContain('• ไซท์ 2 (SN-2) เบิกแล้ว 0%')
  })
  it('treats a missing percentage as 0%', () => {
    expect(formatInvoiceDueDigest([{ name: 'A', site_number: 'S', billing_pct: null }])).toContain('เบิกแล้ว 0%')
  })
  it('turns 26 sites into one message', () => {
    const text = formatInvoiceDueDigest(Array.from({ length: 26 }, (_, i) => site(i + 1)))
    expect(text.split('\n')).toHaveLength(27)
    expect(text).toContain('26 ไซท์')
  })
  it('cuts a long list and says how many were left out', () => {
    const text = formatInvoiceDueDigest(Array.from({ length: 100 }, (_, i) => site(i + 1)))
    expect(text).toContain(`…และอีก ${100 - MAX_SITES_LISTED} ไซท์`)
    expect(text.length).toBeLessThanOrEqual(4600)
  })
  it('stays under the LINE limit even with very long names', () => {
    const long = { name: 'ก'.repeat(300), site_number: 'SN-1', billing_pct: 10 }
    const text = formatInvoiceDueDigest(Array.from({ length: 30 }, () => long))
    expect(text.length).toBeLessThanOrEqual(5000)
    expect(text).toMatch(/…และอีก \d+ ไซท์$/)
  })
})
