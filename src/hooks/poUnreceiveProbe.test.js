import { describe, it, expect, vi, beforeEach } from 'vitest'

let rpcImpl = null
const rpc = vi.fn((...args) => rpcImpl(...args))
vi.mock('../lib/supabase.js', () => ({ supabase: { rpc: (...a) => rpc(...a), from: () => ({}) } }))
const { poUnreceiveReversesStockProbe, resetUnreceiveProbeCache } = await import('./useSupabase.js')

describe('poUnreceiveReversesStockProbe (2026-10-09-06 live?)', () => {
  beforeEach(() => { resetUnreceiveProbeCache(); rpc.mockClear() })

  it('true when the function answers true, and is called only once', async () => {
    rpcImpl = async () => ({ data: true, error: null })
    expect(await poUnreceiveReversesStockProbe()).toBe(true)
    expect(await poUnreceiveReversesStockProbe()).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('po_unreceive_reverses_stock')
  })

  it('false before the migration (PGRST202 / 42883)', async () => {
    for (const code of ['PGRST202', '42883']) {
      resetUnreceiveProbeCache()
      rpcImpl = async () => ({ data: null, error: { code, message: 'Could not find the function public.po_unreceive_reverses_stock' } })
      expect(await poUnreceiveReversesStockProbe()).toBe(false)
    }
  })

  it('false (never throws) on any other error or a thrown call, and retries next time', async () => {
    rpcImpl = async () => ({ data: null, error: { code: '500', message: 'boom' } })
    expect(await poUnreceiveReversesStockProbe()).toBe(false)
    rpcImpl = () => { throw new Error('network') }
    expect(await poUnreceiveReversesStockProbe()).toBe(false)
    rpcImpl = async () => ({ data: true, error: null })
    expect(await poUnreceiveReversesStockProbe()).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(3)
  })
})
