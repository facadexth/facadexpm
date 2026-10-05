import { describe, it, expect } from 'vitest'
import { runScan, ESCALATE_ONLY_BEFORE_MS } from '../../supabase/functions/_shared/po-scan-flow.ts'

const GOOD = JSON.stringify({ status: 'success', supplier_name_guess: 'ACME', line_items: [{ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0 }], printed_subtotal: 200 })
const MISMATCH = JSON.stringify({ status: 'success', line_items: [{ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0 }], printed_subtotal: 999 })
const REJECT = JSON.stringify({ status: 'error', message: 'unreadable_document_or_missing_table' })
const EMPTY = JSON.stringify({ status: 'success', line_items: [] })
const ok = (text, extra = {}) => ({ ok: true, text, stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, ...extra })

function makeDeps(over = {}) {
  const log = { models: [], usage: [], cacheStored: [], quotaCalls: 0 }
  const clock = { t: 0 }
  const queues = { cheap: [], strong: [], ...(over.queues || {}) }
  const deps = {
    cheapFirst: false, cheapModel: 'cheap', strongModel: 'strong',
    now: () => clock.t,
    lookupCache: async () => { if (over.cacheThrows) throw new Error('db down'); return over.cached ?? null },
    storeCache: async (k, r) => { if (over.storeThrows) throw new Error('db down'); log.cacheStored.push([k, r]) },
    checkQuota: async () => { log.quotaCalls++; return over.quota ?? { ok: true, allowed: true } },
    callModel: async (model) => { log.models.push(model); clock.t += over.callMs ?? 0; return queues[model].shift() },
    recordUsage: async (u) => { if (over.usageThrows) throw new Error('db down'); log.usage.push(u) },
    ...(over.deps || {}),
  }
  return { deps, log, clock }
}

describe('runScan', () => {
  it('serves a cache hit with no quota check, no model call and no usage', async () => {
    const cached = { line_items: [], supplier_name_guess: 'X', document_date_guess: null, reference_no_guess: null, printed_subtotal: null }
    const { deps, log } = makeDeps({ cached, quota: { ok: true, allowed: false } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.cache_hit).toBe(true)
    expect(log.quotaCalls).toBe(0)
    expect(log.models).toEqual([])
    expect(log.usage).toEqual([])
  })

  it('falls through to a normal scan when the cache lookup throws', async () => {
    const { deps, log } = makeDeps({ cacheThrows: true, queues: { strong: [ok(GOOD)] } })
    expect((await runScan(deps, 'k')).status).toBe(200)
    expect(log.models).toEqual(['strong'])
  })

  it('returns 500 quota_check_failed when the quota RPC fails, without calling a model', async () => {
    const { deps, log } = makeDeps({ quota: { ok: false } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 500, body: { code: 'quota_check_failed' } })
    expect(log.models).toEqual([])
  })

  it('returns 429 quota_exhausted when the tenant is over quota', async () => {
    const { deps, log } = makeDeps({ quota: { ok: true, allowed: false } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 429, body: { code: 'quota_exhausted' } })
    expect(log.models).toEqual([])
  })

  it('with cheap-first off, uses only the strong model, records usage once and caches the result', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'key1')
    expect(r.status).toBe(200)
    expect(r.body.model_used).toBe('strong')
    expect(r.body.line_items).toHaveLength(1)
    expect(log.models).toEqual(['strong'])
    expect(log.usage).toEqual([{ model: 'strong', inputTokens: 100, outputTokens: 50 }])
    expect(log.cacheStored).toHaveLength(1)
    expect(log.cacheStored[0][0]).toBe('key1')
  })

  it('with cheap-first on, a good cheap answer never reaches the strong model', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r.body.model_used).toBe('cheap')
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([{ model: 'cheap', inputTokens: 100, outputTokens: 50 }])
  })

  it('escalates once when the cheap answer fails a check, and sums tokens across both calls', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(MISMATCH)], strong: [ok(GOOD, { inputTokens: 300, outputTokens: 80 })] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.model_used).toBe('strong')
    expect(log.models).toEqual(['cheap', 'strong'])
    expect(log.usage).toEqual([{ model: 'strong', inputTokens: 400, outputTokens: 130 }])
  })

  it('escalates when the cheap model call itself fails (network or HTTP error)', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [{ ok: false, detail: 'boom' }], strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(log.models).toEqual(['cheap', 'strong'])
  })

  it('escalates when the cheap model rejects, and returns unreadable only if the strong model also rejects', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok(REJECT)], strong: [ok(REJECT)] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 422, body: { code: 'unreadable' } })
    expect(log.models).toEqual(['cheap', 'strong'])
    expect(log.usage).toEqual([])
    expect(log.cacheStored).toEqual([])
  })

  it('returns the strong result for review (counted, not cached) when it still fails the subtotal check', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(MISMATCH)] } })
    const r = await runScan(deps, 'k')
    expect(r.status).toBe(200)
    expect(r.body.line_items).toHaveLength(1)
    expect(log.usage).toHaveLength(1)
    expect(log.cacheStored).toEqual([])
  })

  it('returns unreadable when the final answer has no line items', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [ok(EMPTY)] } })
    expect(await runScan(deps, 'k')).toMatchObject({ status: 422, body: { code: 'unreadable' } })
    expect(log.usage).toEqual([])
  })

  it('returns too_long and skips the second pass when the answer was cut off by max_tokens', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, queues: { cheap: [ok('{"line_items":[', { stopReason: 'max_tokens' })] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'too_long' } })
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([])
  })

  it('does not start a second pass once too much time has passed, and answers ai_unavailable', async () => {
    const { deps, log } = makeDeps({ deps: { cheapFirst: true }, callMs: ESCALATE_ONLY_BEFORE_MS + 1, queues: { cheap: [ok(MISMATCH)], strong: [ok(GOOD)] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
    expect(log.models).toEqual(['cheap'])
    expect(log.usage).toEqual([])
  })

  it('returns ai_unavailable (with the API detail) when the strong call fails', async () => {
    const { deps, log } = makeDeps({ queues: { strong: [{ ok: false, detail: 'AI API error: authentication_error' }] } })
    const r = await runScan(deps, 'k')
    expect(r).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
    expect(String(r.body.error)).toContain('authentication_error')
    expect(log.usage).toEqual([])
  })

  it('returns ai_unavailable when the strong answer is not JSON', async () => {
    const { deps } = makeDeps({ queues: { strong: [ok('sorry, no')] } })
    expect(await runScan(deps, 'k')).toMatchObject({ status: 502, body: { code: 'ai_unavailable' } })
  })

  it('still succeeds when writing usage or the cache fails', async () => {
    const { deps } = makeDeps({ usageThrows: true, storeThrows: true, queues: { strong: [ok(GOOD)] } })
    expect((await runScan(deps, 'k')).status).toBe(200)
  })
})
