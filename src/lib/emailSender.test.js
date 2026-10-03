import { describe, it, expect } from 'vitest'
import { sendResendEmail, EMAIL_FROM, LEGACY_EMAIL_FROM, EMAIL_REPLY_TO } from '../../supabase/functions/_shared/email-sender.ts'

const payload = { to: ['a@x.com'], subject: 's', html: '<p>h</p>' }

// A fake fetch that answers from a queue and records each request body.
function fakeFetch(statuses) {
  const calls = []
  const impl = async (_url, init) => {
    calls.push(JSON.parse(init.body))
    const status = statuses[calls.length - 1] ?? 200
    return new Response(status === 200 ? '{"id":"1"}' : '{"message":"nope"}', { status })
  }
  return { impl, calls }
}

describe('sendResendEmail', () => {
  it('sends from CHANG with a reply-to and does not retry on success', async () => {
    const f = fakeFetch([200])
    const r = await sendResendEmail('key', payload, f.impl)
    expect(r.ok).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].from).toBe(EMAIL_FROM)
    expect(f.calls[0].reply_to).toBe(EMAIL_REPLY_TO)
    expect(f.calls[0].to).toEqual(['a@x.com'])
  })
  it('retries once from the previous sender when the new sender is refused with a 4xx', async () => {
    const f = fakeFetch([403, 200])
    const r = await sendResendEmail('key', payload, f.impl)
    expect(r.ok).toBe(true)
    expect(f.calls.map(c => c.from)).toEqual([EMAIL_FROM, LEGACY_EMAIL_FROM])
  })
  it('does not retry on 429 or 5xx', async () => {
    for (const status of [429, 500]) {
      const f = fakeFetch([status])
      const r = await sendResendEmail('key', payload, f.impl)
      expect(r.ok).toBe(false)
      expect(r.status).toBe(status)
      expect(f.calls).toHaveLength(1)
    }
  })
  it('reports the error text when both senders are refused', async () => {
    const f = fakeFetch([403, 403])
    const r = await sendResendEmail('key', payload, f.impl)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('nope')
    expect(f.calls).toHaveLength(2)
  })
})
