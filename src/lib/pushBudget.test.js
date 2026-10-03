import { describe, it, expect } from 'vitest'
import { withPushBudget } from '../../supabase/functions/_shared/push-budget.ts'

// Fake admin whose consume_line_push answers from a queue and records calls.
function fakeAdmin(answers) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args })
      const a = answers.shift()
      return a instanceof Error ? { data: null, error: { code: 'XX000' } } : { data: a, error: null }
    },
  }
}

describe('withPushBudget', () => {
  it('sends when the budget allows, and spends exactly one message', async () => {
    const admin = fakeAdmin([true])
    let sent = 0
    const r = await withPushBudget(admin, 't1', async () => { sent++; return { ok: true, status: 200 } })
    expect(r).toEqual({ ok: true, status: 200 })
    expect(sent).toBe(1)
    expect(admin.calls).toEqual([{ name: 'consume_line_push', args: { p_tenant: 't1', p_n: 1 } }])
  })
  it('does not send when the budget is used up', async () => {
    const admin = fakeAdmin([false])
    let sent = 0
    const r = await withPushBudget(admin, 't1', async () => { sent++; return { ok: true, status: 200 } })
    expect(sent).toBe(0)
    expect(r).toEqual({ ok: false, status: 429, skipped: 'budget' })
  })
  it('fails closed when the budget cannot be checked', async () => {
    const admin = fakeAdmin([new Error('db down')])
    let sent = 0
    const r = await withPushBudget(admin, 't1', async () => { sent++; return { ok: true, status: 200 } })
    expect(sent).toBe(0)
    expect(r.skipped).toBe('budget_error')
  })
  it('treats anything other than a literal true as no', async () => {
    for (const odd of [null, undefined, 'true', 1]) {
      const admin = fakeAdmin([odd])
      let sent = 0
      await withPushBudget(admin, 't1', async () => { sent++; return { ok: true, status: 200 } })
      expect(sent).toBe(0)
    }
  })
  it('passes through the send result (e.g. a LINE-side failure)', async () => {
    const admin = fakeAdmin([true])
    const r = await withPushBudget(admin, 't1', async () => ({ ok: false, status: 400 }))
    expect(r).toEqual({ ok: false, status: 400 })
  })
})
