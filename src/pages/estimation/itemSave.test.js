// Save order of the item form: the opening row first, then its inline add-ons (estimation_item_addons); a failed
// add-on save is reported but the opening row stays saved. Fake Supabase client that records every request.
import { describe, it, expect } from 'vitest'
import { saveItemWithAddons, addonSavePlan } from './itemSave.js'

function fakeClient({ failOn = null } = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      const q = { table, op: null, args: null, filters: [] }
      const result = () => {
        calls.push({ table: q.table, op: q.op, args: q.args, filters: q.filters })
        if (failOn && failOn(q)) return { data: null, error: { message: `boom ${q.table} ${q.op}` } }
        return { data: q.op === 'insert' && q.table === 'estimation_openings' ? { id: 'new1' } : { id: 'o1' }, error: null }
      }
      const b = {
        insert(args) { q.op = 'insert'; q.args = args; return b },
        update(args) { q.op = 'update'; q.args = args; return b },
        delete() { q.op = 'delete'; return b },
        eq(c, v) { q.filters.push([c, v]); return b },
        select() { return b },
        single() { return Promise.resolve(result()) },
        then(res, rej) { return Promise.resolve(result()).then(res, rej) },
      }
      return b
    },
  }
  return client
}

const addon = { mode: 'attach', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 2 }
const payload = { project_id: 'p1', opening_no: 'W1', template_id: 't' }
const main = { widthMm: 1800, heightMm: 1200 }

describe('saveItemWithAddons', () => {
  it('saves the opening row first, then the add-ons under its id', async () => {
    const c = fakeClient()
    const r = await saveItemWithAddons({ supabase: c, rowId: null, payload, addons: [addon], main, saveAddons: true })
    expect(r).toEqual({ id: 'new1', addonError: null })
    expect(c.calls.map(x => `${x.table}:${x.op}`)).toEqual(['estimation_openings:insert', 'estimation_item_addons:delete', 'estimation_item_addons:insert'])
    expect(c.calls[1].filters).toEqual([['opening_id', 'new1']])
    expect(c.calls[2].args[0]).toMatchObject({ opening_id: 'new1', len_m: 1.8, thick_m: 0.4, cols: 2 })
  })
  it('an existing item updates its row and, with saveAddons false, never touches the add-on table', async () => {
    const c = fakeClient()
    const r = await saveItemWithAddons({ supabase: c, rowId: 'o1', payload, addons: [], main, saveAddons: false })
    expect(r).toEqual({ id: 'o1', addonError: null })
    expect(c.calls.map(x => `${x.table}:${x.op}`)).toEqual(['estimation_openings:update'])
  })
  it('deleting the last add-on clears the table (saveAddons true, empty list)', async () => {
    const c = fakeClient()
    await saveItemWithAddons({ supabase: c, rowId: 'o1', payload, addons: [], main, saveAddons: true })
    expect(c.calls.map(x => `${x.table}:${x.op}`)).toEqual(['estimation_openings:update', 'estimation_item_addons:delete'])
  })
  it('a failed add-on save is returned as addonError; the opening row stays saved', async () => {
    const c = fakeClient({ failOn: q => q.table === 'estimation_item_addons' && q.op === 'insert' })
    const r = await saveItemWithAddons({ supabase: c, rowId: null, payload, addons: [addon], main, saveAddons: true })
    expect(r.id).toBe('new1')
    expect(r.addonError.message).toBe('boom estimation_item_addons insert')
    expect(c.calls[0]).toMatchObject({ table: 'estimation_openings', op: 'insert' })
    expect(c.calls.some(x => x.table === 'estimation_openings' && x.op === 'delete')).toBe(false)
  })
  it('a failed opening row save throws and the add-ons are not attempted', async () => {
    const c = fakeClient({ failOn: q => q.table === 'estimation_openings' })
    await expect(saveItemWithAddons({ supabase: c, rowId: 'o1', payload, addons: [addon], main, saveAddons: true })).rejects.toMatchObject({ message: 'boom estimation_openings update' })
    expect(c.calls).toHaveLength(1)
  })
})

describe('addonSavePlan (never write an add-on list that was not loaded)', () => {
  const saved = [addon]
  it('loading (no map yet) ⇒ not ready, no seed, no save', () => {
    expect(addonSavePlan({ map: undefined, itemId: 'o1', formAddons: [addon], seeded: false })).toEqual({ ready: false, seed: null, save: false })
    expect(addonSavePlan({ map: { o1: saved }, loading: true, itemId: 'o1', seeded: true, hadAddons: true })).toEqual({ ready: false, seed: null, save: false })
  })
  it('load error with the {} map ⇒ not ready, no seed, no save', () => {
    expect(addonSavePlan({ map: {}, error: 'boom', itemId: 'o1', formAddons: [], seeded: false })).toEqual({ ready: false, seed: null, save: false })
    expect(addonSavePlan({ map: {}, error: 'boom', itemId: 'o1', formAddons: [addon], seeded: true, hadAddons: true }).save).toBe(false)
  })
  it('a recovered load seeds once with the saved list, then no more seeding', () => {
    expect(addonSavePlan({ map: { o1: saved }, itemId: 'o1', seeded: false })).toEqual({ ready: true, seed: saved, save: false })
    expect(addonSavePlan({ map: { o1: saved }, itemId: 'o1', formAddons: saved, seeded: true, hadAddons: true })).toEqual({ ready: true, seed: null, save: true })
  })
  it('ready + empty form: saves (clears) only when the item had add-ons', () => {
    expect(addonSavePlan({ map: { o1: [] }, itemId: 'o1', formAddons: [], seeded: true, hadAddons: true }).save).toBe(true)
    expect(addonSavePlan({ map: { o1: [] }, itemId: 'o1', formAddons: [], seeded: true, hadAddons: false }).save).toBe(false)
  })
  it('M-2: a loaded map without the item id is not ready (no seed, no save); a new item stays ready', () => {
    expect(addonSavePlan({ map: { other: saved }, itemId: 'o1', formAddons: [], seeded: false })).toEqual({ ready: false, seed: null, save: false })
    expect(addonSavePlan({ map: { other: saved }, itemId: 'o1', formAddons: [addon], seeded: true, hadAddons: true })).toEqual({ ready: false, seed: null, save: false })
    expect(addonSavePlan({ map: { other: saved }, itemId: null, formAddons: [addon] })).toEqual({ ready: true, seed: null, save: true })
  })
  it('a new item saves only when it has add-ons', () => {
    expect(addonSavePlan({ map: undefined, itemId: null, formAddons: [addon] })).toEqual({ ready: true, seed: null, save: true })
    expect(addonSavePlan({ map: undefined, itemId: null, formAddons: [] }).save).toBe(false)
  })
  it('with the load-error flag set, the save makes no add-on request', async () => {
    const c = fakeClient()
    const plan = addonSavePlan({ map: {}, error: 'boom', itemId: 'o1', formAddons: [], seeded: true, hadAddons: false })
    await saveItemWithAddons({ supabase: c, rowId: 'o1', payload, addons: [], main, saveAddons: plan.save })
    expect(c.calls.map(x => x.table)).toEqual(['estimation_openings'])
  })
})
