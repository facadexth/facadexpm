import { describe, it, expect } from 'vitest'
import { buildWebhookUrl, buildOaInviteLink, inviteErrorText, formatBkkDate } from './customerLine.js'

describe('buildWebhookUrl', () => {
  it('builds the webhook url', () => {
    expect(buildWebhookUrl('https://x.supabase.co', 'abc')).toBe('https://x.supabase.co/functions/v1/customer-line-webhook?t=abc')
  })
  it('strips trailing slash', () => {
    expect(buildWebhookUrl('https://x.supabase.co/', 'abc')).toBe('https://x.supabase.co/functions/v1/customer-line-webhook?t=abc')
  })
})

describe('buildOaInviteLink', () => {
  it('handles basic id without @', () => {
    expect(buildOaInviteLink('facadex', 'ABC123')).toBe('https://line.me/R/oaMessage/@facadex/?ABC123')
  })
  it('handles basic id with @', () => {
    expect(buildOaInviteLink('@facadex', 'ABC123')).toBe('https://line.me/R/oaMessage/@facadex/?ABC123')
  })
})

describe('inviteErrorText', () => {
  it('maps known codes', () => {
    expect(inviteErrorText('site_has_no_client')).toMatch(/ยังไม่ได้ผูก client/)
    expect(inviteErrorText('not_allowed')).toBe('ไม่มีสิทธิ์เชิญลูกค้า')
    expect(inviteErrorText('site_not_found')).toBe('ไม่พบไซท์นี้')
  })
  it('falls back for unknown', () => {
    expect(inviteErrorText('boom')).toContain('boom')
  })
})

describe('formatBkkDate', () => {
  it('uses the Bangkok day', () => {
    expect(formatBkkDate('2026-10-25T18:00:00Z')).toBe('26/10/2026')
  })
  it('handles empty', () => {
    expect(formatBkkDate(null)).toBe('—')
  })
})
