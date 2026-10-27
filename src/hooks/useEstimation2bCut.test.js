import { describe, it, expect, vi, beforeEach } from 'vitest'

const sb = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock('../lib/supabase.js', () => ({ supabase: sb }))
const catalog = vi.hoisted(() => ({ useCatalogTable: vi.fn((table, order) => ({ table, order })) }))
vi.mock('./useAluCatalog.js', () => catalog)
const { offcutsByGroup, issueCutPlan, voidCutPlan, saveProjectCutMode, discardOffcut, useOffcuts, useCutPlans } = await import('./useEstimation2b.js')

// Records every builder call; the awaited result is `result`.
function fakeFrom(result) {
  const calls = []
  sb.from.mockImplementation(table => {
    const b = { then: (res, rej) => Promise.resolve(result).then(res, rej) }
    for (const m of ['update', 'eq', 'select']) b[m] = (...a) => { calls.push([m, ...a]); return b }
    calls.push(['from', table])
    return b
  })
  return calls
}

beforeEach(() => { sb.rpc.mockReset(); sb.from.mockReset() })

describe('offcutsByGroup', () => {
  const rows = [
    { id: 'a', code: 'OC-0001', profile_id: 'P', finish_id: 'F', length_m: 1.2, status: 'in_stock', end_a: 'square' },
    { id: 'b', code: 'OC-0002', profile_id: 'P', finish_id: 'G', length_m: 0.8, status: 'in_stock' },
    { id: 'c', code: 'OC-0003', profile_id: 'P', finish_id: null, length_m: 2.5, status: 'in_stock' },
    { id: 'd', code: 'OC-0004', profile_id: 'P', finish_id: 'F', length_m: 3.0, status: 'used' },
    { id: 'e', code: 'OC-0005', profile_id: 'P', finish_id: 'F', length_m: 3.0, status: 'discarded' },
  ]
  it('keys in-stock offcuts the same way the cut plan keys its groups', () => {
    const m = offcutsByGroup(rows)
    expect(m['P|F']).toEqual([{ id: 'a', code: 'OC-0001', length_m: 1.2 }])
    expect(m['P|G']).toEqual([{ id: 'b', code: 'OC-0002', length_m: 0.8 }])
    expect(m['P|']).toEqual([{ id: 'c', code: 'OC-0003', length_m: 2.5 }])
    expect(Object.keys(m).sort()).toEqual(['P|', 'P|F', 'P|G'])
  })
  it('length_m comes back as a number; no rows gives an empty map', () => {
    expect(offcutsByGroup([{ id: 'x', code: 'OC-9', profile_id: 'Q', finish_id: '', length_m: '1.500', status: 'in_stock' }])['Q|'][0].length_m).toBe(1.5)
    expect(offcutsByGroup(null)).toEqual({})
  })
})

describe('issueCutPlan', () => {
  const payload = { p_signature: 's', p_plan: { groups: [] }, p_used_offcut_ids: ['o1'], p_new_offcuts: [] }
  it('calls the RPC with the project id and the payload and returns its data', async () => {
    sb.rpc.mockResolvedValue({ data: { plan_id: 'pl1', offcuts: [{ key: 'P|F#1', id: 'n1', code: 'OC-0010' }] }, error: null })
    const r = await issueCutPlan('proj1', payload)
    expect(sb.rpc).toHaveBeenCalledWith('issue_cut_plan', { p_project_id: 'proj1', ...payload })
    expect(r).toEqual({ plan_id: 'pl1', offcuts: [{ key: 'P|F#1', id: 'n1', code: 'OC-0010' }] })
  })
  it('rejects with the Thai text from the RPC', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { message: 'เศษบางชิ้นถูกใช้ไปแล้ว' } })
    await expect(issueCutPlan('proj1', payload)).rejects.toThrow('เศษบางชิ้นถูกใช้ไปแล้ว')
  })
})

describe('voidCutPlan', () => {
  it('calls void_cut_plan and passes the Thai error through', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: null })
    await voidCutPlan('pl1')
    expect(sb.rpc).toHaveBeenCalledWith('void_cut_plan', { p_plan_id: 'pl1' })
    sb.rpc.mockResolvedValue({ data: null, error: { message: 'แผนนี้ถูกยกเลิกแล้ว' } })
    await expect(voidCutPlan('pl1')).rejects.toThrow('แผนนี้ถูกยกเลิกแล้ว')
  })
})

describe('saveProjectCutMode', () => {
  it('updates cut_mode on the project row', async () => {
    const calls = fakeFrom({ error: null })
    await saveProjectCutMode('proj1', 'custom')
    expect(calls).toEqual([['from', 'estimation_projects'], ['update', { cut_mode: 'custom' }], ['eq', 'id', 'proj1']])
  })
  it('throws on error', async () => {
    fakeFrom({ error: { message: 'x' } })
    await expect(saveProjectCutMode('proj1', 'stock')).rejects.toBeTruthy()
  })
})

describe('discardOffcut', () => {
  it('marks only an in-stock offcut discarded and reads the row back', async () => {
    const calls = fakeFrom({ data: [{ id: 'o1' }], error: null })
    await discardOffcut('o1')
    expect(calls[0]).toEqual(['from', 'alu_offcuts'])
    expect(calls[1][0]).toBe('update')
    expect(calls[1][1].status).toBe('discarded')
    expect(Number.isNaN(Date.parse(calls[1][1].status_at))).toBe(false)
    expect(calls.slice(2)).toEqual([['eq', 'id', 'o1'], ['eq', 'status', 'in_stock'], ['select', 'id']])
  })
  it('throws when no row was updated (already used or discarded)', async () => {
    fakeFrom({ data: [], error: null })
    await expect(discardOffcut('o1')).rejects.toThrow(/เศษ/)
  })
  it('throws on a database error', async () => {
    fakeFrom({ data: null, error: { message: 'boom' } })
    await expect(discardOffcut('o1')).rejects.toBeTruthy()
  })
})

describe('table hooks', () => {
  it('load alu_offcuts by code and alu_cut_plans by issued_at', () => {
    expect(useOffcuts()).toEqual({ table: 'alu_offcuts', order: 'code' })
    expect(useCutPlans()).toEqual({ table: 'alu_cut_plans', order: 'issued_at' })
  })
})
