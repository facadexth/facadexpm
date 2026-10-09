import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { cachedLoad, attachmentsCacheKey, invalidateQuotationAttachments } = await import('./useQuotationAttachments.js')

describe('attachment cache invalidation (final-fix 2)', () => {
  it('after a simulated push the next load re-queries; other quotations stay cached', async () => {
    const q = { id: 'qx', revision: 1, updated_at: 't', quotation_items: [] }
    const other = { id: 'qy', revision: 1, updated_at: 't', quotation_items: [] }
    const load = vi.fn(async () => ({ pages: 1 }))
    const loadOther = vi.fn(async () => null)
    await cachedLoad(attachmentsCacheKey(q), load)
    await cachedLoad(attachmentsCacheKey(q), load)
    await cachedLoad(attachmentsCacheKey(other), loadOther)
    expect(load).toHaveBeenCalledTimes(1)
    invalidateQuotationAttachments('qx')   // what the send path calls once pushToQuotation succeeded
    await cachedLoad(attachmentsCacheKey(q), load)
    await cachedLoad(attachmentsCacheKey(other), loadOther)
    expect(load).toHaveBeenCalledTimes(2)
    expect(loadOther).toHaveBeenCalledTimes(1)
  })
})
