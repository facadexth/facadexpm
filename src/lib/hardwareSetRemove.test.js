import { describe, it, expect } from 'vitest'
import { SET_USAGE, SET_IN_USE_TEXT, removeHardwareSet } from './hardwareSetRemove.js'

// A PostgREST stand-in: every chain is recorded; `answer(table, calls)` gives the awaited result.
function fakeDb(answer) {
  const log = []
  const from = table => {
    const calls = []
    log.push({ table, calls })
    const b = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (res, rej) => Promise.resolve(answer(table, calls)).then(res, rej)
        return (...a) => { calls.push([k, ...a]); return b }
      },
    })
    return b
  }
  return { db: { from }, log }
}
const isRemove = calls => calls.some(c => c[0] === 'delete')
const removes = log => log.filter(e => isRemove(e.calls)).map(e => [e.table, e.calls.find(c => c[0] === 'eq').slice(1)])

describe('removing a hardware set (owner 2026-11-01: only when nothing uses it)', () => {
  it('checks every place that stores a set id', () => {
    expect(SET_USAGE).toEqual([
      { table: 'estimation_openings', column: 'hardware_set_id' },
      { table: 'estimation_projects', column: 'default_hardware_set_id' },
      { table: 'alu_hardware_package_items', column: 'hardware_set_id' },
      { table: 'bom_template_hardware', column: 'part_id' },
      { table: 'alu_part_set_items', column: 'part_id' },
      { table: 'estimation_settings', column: 'sealant_part_id' },
      { table: 'estimation_settings', column: 'shim_part_id' },
      { table: 'estimation_settings', column: 'screw_part_id' },
      { table: 'estimation_settings', column: 'plug_part_id' },
    ])
  })
  it('used (here only by the last place checked): refused with the message, nothing removed', async () => {
    const { db, log } = fakeDb((table, calls) => (isRemove(calls) ? { data: [], error: null }
      : { count: calls.some(c => c[0] === 'eq' && c[1] === 'plug_part_id') ? 1 : 0, error: null }))
    expect(await removeHardwareSet(db, 'SET')).toEqual({ removed: false, message: SET_IN_USE_TEXT })
    expect(SET_IN_USE_TEXT).toBe('ชุดนี้มีรายการใช้อยู่ — ปิดใช้งานแทน')
    expect(removes(log)).toEqual([])
    expect(log.length).toBe(SET_USAGE.length)
    for (const [i, u] of SET_USAGE.entries()) {
      expect(log[i].table).toBe(u.table)
      expect(log[i].calls).toContainEqual(['eq', u.column, 'SET'])
      expect(log[i].calls[0]).toEqual(['select', 'id', { count: 'exact', head: true }])
    }
  })
  it('the first use found stops the checks', async () => {
    const { db, log } = fakeDb((table, calls) => (isRemove(calls) ? { data: [], error: null } : { count: table === 'estimation_openings' ? 3 : 0, error: null }))
    expect(await removeHardwareSet(db, 'SET')).toEqual({ removed: false, message: SET_IN_USE_TEXT })
    expect(log.map(e => e.table)).toEqual(['estimation_openings'])
  })
  it('a usage check that fails stops everything (nothing removed)', async () => {
    const { db, log } = fakeDb((table, calls) => (isRemove(calls) ? { data: [], error: null }
      : table === 'estimation_projects' ? { count: null, error: { code: '42501', message: 'denied' } } : { count: 0, error: null }))
    await expect(removeHardwareSet(db, 'SET')).rejects.toMatchObject({ code: '42501' })
    expect(removes(log)).toEqual([])
  })
  it('unused: items, then series links, then the set row', async () => {
    const { db, log } = fakeDb((table, calls) => (isRemove(calls) ? { data: [{ id: 'x' }], error: null } : { count: 0, error: null }))
    expect(await removeHardwareSet(db, 'SET')).toEqual({ removed: true })
    expect(removes(log)).toEqual([
      ['alu_part_set_items', ['set_id', 'SET']],
      ['alu_series_parts', ['part_id', 'SET']],
      ['alu_parts', ['id', 'SET']],
    ])
  })
  it('the database still refuses (FK 23503): the same message', async () => {
    const { db } = fakeDb((table, calls) => (!isRemove(calls) ? { count: 0, error: null }
      : table === 'alu_parts' ? { data: null, error: { code: '23503', message: 'fk' } } : { data: [], error: null }))
    expect(await removeHardwareSet(db, 'SET')).toEqual({ removed: false, message: SET_IN_USE_TEXT })
  })
  it('the set row did not go (no rights): an error, not a silent success', async () => {
    const { db } = fakeDb((table, calls) => (!isRemove(calls) ? { count: 0, error: null } : { data: [], error: null }))
    await expect(removeHardwareSet(db, 'SET')).rejects.toMatchObject({ code: '42501' })
  })
})
