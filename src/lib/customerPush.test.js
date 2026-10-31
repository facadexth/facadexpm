import { describe, it, expect, vi } from 'vitest'
import {
  pushToCustomer, customerPushDeps, CUSTOMER_PUSH_SETTING, LINE_PUSH_URL,
} from '../../supabase/functions/_shared/customer-push.ts'

const TOKEN = 'tok-SECRET-123'
const MSG = [{ type: 'text', text: 'hi' }]

function deps(over = {}) {
  return {
    pushEnabled: vi.fn(async () => true),
    consumeBudget: vi.fn(async () => true),
    accessToken: vi.fn(async () => TOKEN),
    fetch: vi.fn(async () => ({ ok: true, status: 200 })),
    ...over,
  }
}

describe('pushToCustomer', () => {
  it('off: skipped off, no budget call, no send', async () => {
    const d = deps({ pushEnabled: vi.fn(async () => false) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'off' })
    expect(d.pushEnabled).toHaveBeenCalledWith('t1')
    expect(d.consumeBudget).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('budget false: skipped budget, no send', async () => {
    const d = deps({ consumeBudget: vi.fn(async () => false) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'budget' })
    expect(d.consumeBudget).toHaveBeenCalledWith('t1')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('budget check throwing fails closed as budget', async () => {
    const d = deps({ consumeBudget: vi.fn(async () => { throw new Error('rpc') }) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'budget' })
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it.each([null, undefined, '', '   '])('no recipient (%s): skipped no_recipient, no budget spent', async (to) => {
    const d = deps()
    const r = await pushToCustomer(d, 't1', to, MSG)
    expect(r).toEqual({ sent: false, skipped: 'no_recipient' })
    expect(d.consumeBudget).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('missing token (no OA connected): off, no budget spent', async () => {
    const d = deps({ accessToken: vi.fn(async () => null) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'off' })
    expect(d.consumeBudget).not.toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('send ok: POSTs to LINE push with the tenant token', async () => {
    const d = deps()
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: true, status: 200 })
    expect(d.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = d.fetch.mock.calls[0]
    expect(url).toBe(LINE_PUSH_URL)
    expect(url).toBe('https://api.line.me/v2/bot/message/push')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ to: 'U1', messages: MSG })
  })

  it('order: setting, then budget, then send', async () => {
    const order = []
    const d = deps({
      pushEnabled: vi.fn(async () => { order.push('setting'); return true }),
      consumeBudget: vi.fn(async () => { order.push('budget'); return true }),
      fetch: vi.fn(async () => { order.push('send'); return { ok: true, status: 200 } }),
    })
    await pushToCustomer(d, 't1', 'U1', MSG)
    expect(order).toEqual(['setting', 'budget', 'send'])
  })

  it('send 4xx: error with the status', async () => {
    const d = deps({ fetch: vi.fn(async () => ({ ok: false, status: 400 })) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'error', status: 400 })
  })

  it('send throws (network): error with status 0', async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new Error(`boom ${TOKEN}`) }) })
    const r = await pushToCustomer(d, 't1', 'U1', MSG)
    expect(r).toEqual({ sent: false, skipped: 'error', status: 0 })
  })

  it('the token is never in the returned object', async () => {
    const cases = [
      deps(),
      deps({ fetch: vi.fn(async () => ({ ok: false, status: 401, text: async () => TOKEN })) }),
      deps({ fetch: vi.fn(async () => { throw new Error(TOKEN) }) }),
      deps({ consumeBudget: vi.fn(async () => false) }),
    ]
    for (const d of cases) {
      const r = await pushToCustomer(d, 't1', 'U1', MSG)
      expect(JSON.stringify(r)).not.toContain(TOKEN)
    }
  })

  it('strips whitespace from the stored token', async () => {
    const d = deps({ accessToken: vi.fn(async () => ' tok\nabc ') })
    await pushToCustomer(d, 't1', 'U1', MSG)
    expect(d.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tokabc')
  })
})

// Fake supabase client: from('app_settings').select().eq().eq().maybeSingle() and rpc(name, args).
function fakeAdmin({ setting, settingError, rpc } = {}) {
  const calls = { eq: [], rpc: [] }
  const q = {
    select: () => q,
    eq: (c, v) => { calls.eq.push([c, v]); return q },
    maybeSingle: async () => ({ data: setting === undefined ? null : { value: setting }, error: settingError ?? null }),
  }
  return {
    calls,
    from: (table) => { calls.table = table; return q },
    rpc: async (name, args) => { calls.rpc.push([name, args]); return rpc[name] ?? { data: null, error: null } },
  }
}

describe('customerPushDeps', () => {
  it('setting missing = ON; reads the right key for the tenant', async () => {
    const a = fakeAdmin({ rpc: {} })
    expect(await customerPushDeps(a).pushEnabled('t1')).toBe(true)
    expect(a.calls.table).toBe('app_settings')
    expect(a.calls.eq).toEqual([['tenant_id', 't1'], ['key', CUSTOMER_PUSH_SETTING]])
    expect(CUSTOMER_PUSH_SETTING).toBe('customer_line_push_enabled')
  })

  it("setting 'false' = OFF, 'true' = ON", async () => {
    expect(await customerPushDeps(fakeAdmin({ setting: 'false', rpc: {} })).pushEnabled('t1')).toBe(false)
    expect(await customerPushDeps(fakeAdmin({ setting: 'true', rpc: {} })).pushEnabled('t1')).toBe(true)
  })

  it('budget calls consume_customer_push; only true counts', async () => {
    const a = fakeAdmin({ rpc: { consume_customer_push: { data: true, error: null } } })
    expect(await customerPushDeps(a).consumeBudget('t1')).toBe(true)
    expect(a.calls.rpc).toEqual([['consume_customer_push', { p_tenant: 't1' }]])
    const b = fakeAdmin({ rpc: { consume_customer_push: { data: null, error: { code: 'x' } } } })
    expect(await customerPushDeps(b).consumeBudget('t1')).toBe(false)
  })

  it('token from customer_line_creds_by_tenant (array or row), null when missing', async () => {
    const a = fakeAdmin({ rpc: { customer_line_creds_by_tenant: { data: [{ access_token: 'abc' }], error: null } } })
    expect(await customerPushDeps(a).accessToken('t1')).toBe('abc')
    expect(a.calls.rpc[0]).toEqual(['customer_line_creds_by_tenant', { p_tenant: 't1' }])
    const b = fakeAdmin({ rpc: { customer_line_creds_by_tenant: { data: [], error: null } } })
    expect(await customerPushDeps(b).accessToken('t1')).toBe(null)
  })
})

describe('flex fallback', () => {
  const FLEX = [{ type: 'flex', altText: 'นัดเข้าซ่อม', contents: { type: 'bubble' } }]
  it('LINE rejects a card with 400: resend once as its plain altText, one budget use', async () => {
    const d = deps({ fetch: vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce({ ok: true, status: 200 }) })
    const r = await pushToCustomer(d, 't1', 'U1', FLEX)
    expect(r).toEqual({ sent: true, status: 200 })
    expect(d.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(d.fetch.mock.calls[1][1].body).messages).toEqual([{ type: 'text', text: 'นัดเข้าซ่อม' }])
    expect(d.consumeBudget).toHaveBeenCalledTimes(1)
  })
  it('a plain-text 400 is not retried', async () => {
    const d = deps({ fetch: vi.fn(async () => ({ ok: false, status: 400 })) })
    await pushToCustomer(d, 't1', 'U1', MSG)
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })
})
