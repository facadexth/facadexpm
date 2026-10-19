import { describe, it, expect, vi } from 'vitest'
import { replyWithFallback } from '../../supabase/functions/_shared/reply-fallback.ts'

const flex = { type: 'flex', altText: 'alt', contents: {} }
const txt = { type: 'text', text: 'hi' }

describe('replyWithFallback', () => {
  it('no retry when the first call succeeds', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const log = vi.fn()
    expect(await replyWithFallback(send, 'rt', [flex], log)).toEqual({ ok: true, status: 200 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })
  it('flex failure retries once with altText text', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce({ ok: true, status: 200 })
    const log = vi.fn()
    const r = await replyWithFallback(send, 'rt', [txt, flex], log)
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]).toEqual(['rt', [txt, { type: 'text', text: 'alt' }]])
    expect(log).toHaveBeenCalledWith('customer-line reply failed', 400, 'text,flex')
  })
  it('text-only failure does not retry', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const log = vi.fn()
    expect(await replyWithFallback(send, 'rt', [txt], log)).toEqual({ ok: false, status: 500 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('customer-line reply failed', 500, 'text')
  })
})
