import { describe, it, expect } from 'vitest'
import { buildWebhookUrl, buildOaInviteLink } from './customerLine.js'

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
