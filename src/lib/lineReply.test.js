import { describe, it, expect, vi } from 'vitest'
import { sendLineReplyMessages } from '../../supabase/functions/_shared/line-reply.ts'

const t = (n) => ({ type: 'text', text: `m${n}` })

describe('sendLineReplyMessages', () => {
  it('posts replyToken + messages with bearer auth', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const r = await sendLineReplyMessages('tok', 'rt', [t(1)], f)
    expect(r).toEqual({ ok: true, status: 200 })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.line.me/v2/bot/message/reply')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ replyToken: 'rt', messages: [t(1)] })
  })
  it('truncates to 5 messages', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await sendLineReplyMessages('tok', 'rt', [1, 2, 3, 4, 5, 6, 7].map(t), f)
    expect(JSON.parse(f.mock.calls[0][1].body).messages).toHaveLength(5)
  })
  it('returns ok:false status 0 when fetch throws', async () => {
    const f = vi.fn().mockRejectedValue(new Error('net'))
    expect(await sendLineReplyMessages('tok', 'rt', [t(1)], f)).toEqual({ ok: false, status: 0 })
  })
})
