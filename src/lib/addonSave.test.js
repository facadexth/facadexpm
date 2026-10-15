import { describe, it, expect } from 'vitest'
import {
  PIECE_COLUMNS, pieceRowsToSets, pieceSetsToRows, saveAddonPieces, loadAddonPieces,
  itemAddonsFromRows, itemAddonsToRows, saveItemAddons, loadItemAddons,
} from './addonSave.js'
import { setKey } from './addonModel.js'

function fakeClient({ failOn = null, data = {} } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const result = op => (failOn && failOn.table === table && failOn.op === op ? { data: null, error: { message: `boom ${table}` } } : { data: op === 'select' ? data[table] || [] : null, error: null })
      return {
        delete() { return { eq(col, val) { calls.push(['delete', table, col, val]); return Promise.resolve(result('delete')) } } },
        insert(rows) { calls.push(['insert', table, rows.length]); return Promise.resolve(result('insert')) },
        select() {
          const filters = []
          let inF = null, orderCol = null, rng = null
          const chain = {
            in(col, vals) { filters.push([col, vals]); inF = [col, vals]; return chain },
            order(col) { filters.push(['order', col]); orderCol = col; return chain },
            range(from, to) { filters.push(['range', from, to]); rng = [from, to]; return chain },
            then(res, rej) {
              calls.push(['select', table, ...filters])
              const r = result('select')
              if (r.data) {
                let d = inF ? r.data.filter(x => inF[1].includes(x[inF[0]])) : r.data
                if (orderCol) d = [...d].sort((a, b) => String(a[orderCol]).localeCompare(String(b[orderCol])))
                if (rng) d = d.slice(rng[0], rng[1] + 1)
                r.data = d
              }
              return Promise.resolve(r).then(res, rej)
            },
          }
          return chain
        },
      }
    },
  }
}

const row = (o = {}) => ({
  mode: 'merge', kind: 'fixed', position: 'top', piece_key: 'ext', profile_family: 'F1', ref_input: 'w',
  length_factor: 1, deduction_mm: 0, qty_rule: 'fixed', qty_fixed: 1, thickness_role: null, note: null, sort_order: 0, ...o,
})
const attachRow = (o = {}) => row({ mode: 'attach', position: null, piece_key: 'frame_top', ref_input: 'w', ...o })

describe('item add-on align round trip', () => {
  it('keeps align both ways', () => {
    const rows = itemAddonsToRows([{ mode: 'merge', kind: 'fixed', position: 'right', len_mm: 1000, thick_mm: 400, offset_mm: 0, align: 'end', rows: 1, cols: 1 }], 'o1')
    expect(rows[0].align).toBe('end')
    expect(itemAddonsFromRows([{ ...rows[0], id: 'x' }])[0].align).toBe('end')
  })
  it('a row without align reads as start', () => {
    expect(itemAddonsFromRows([{ id: 'x', mode: 'merge', kind: 'fixed', position: 'top', len_m: 1, thick_m: 0.4, offset_m: 0, rows: 1, cols: 1, sort_order: 0 }])[0].align).toBe('start')
  })
})

describe('piece sets <-> rows', () => {
  it('round trips and drops unknown / bookkeeping columns', () => {
    const db = [
      { id: 'x', tenant_id: 't', template_id: 'tpl', created_at: 'c', ...row({ sort_order: 1, piece_key: 'divider' }) },
      { id: 'y', tenant_id: 't', template_id: 'tpl', created_at: 'c', ...row({ sort_order: 0 }) },
    ]
    const sets = pieceRowsToSets(db)
    const k = setKey('merge', 'fixed', 'top')
    expect(Object.keys(sets)).toEqual([k])
    expect(sets[k].map(r => r.sort_order)).toEqual([0, 1])
    expect(sets[k][0]).not.toHaveProperty('id')
    expect(sets[k][0]).not.toHaveProperty('tenant_id')
    expect(sets[k][0]).not.toHaveProperty('template_id')
    const back = pieceSetsToRows(sets, 'tpl')
    expect(back.map(r => Object.keys(r).sort())).toEqual(back.map(() => [...PIECE_COLUMNS, 'template_id'].sort()))
    expect(back.every(r => r.template_id === 'tpl')).toBe(true)
    expect(pieceRowsToSets(back)).toEqual(sets)
  })
  it('forces attach position null, coerces numbers, drops extras, renumbers sort_order', () => {
    const sets = { [setKey('attach', 'fixed', '')]: [attachRow({ position: 'top', length_factor: '1.5', deduction_mm: '10', qty_fixed: '2', sort_order: '9', junk: 1 }), attachRow({ qty_fixed: null, sort_order: 5 })] }
    const rows = pieceSetsToRows(sets, 'tpl')
    expect(rows[0]).toMatchObject({ position: null, length_factor: 1.5, deduction_mm: 10, qty_fixed: 2, sort_order: 0 })
    expect(rows[0]).not.toHaveProperty('junk')
    expect(rows[1]).toMatchObject({ qty_fixed: null, sort_order: 1 })
  })
})

describe('saveAddonPieces', () => {
  it('deletes by template, then inserts', async () => {
    const c = fakeClient()
    await saveAddonPieces({ supabase: c, templateId: 't1', rows: pieceSetsToRows({ a: [row()] }, 't1') })
    expect(c.calls).toEqual([['delete', 'bom_template_addon_pieces', 'template_id', 't1'], ['insert', 'bom_template_addon_pieces', 1]])
  })
  it('invalid rows throw a Thai message with zero calls', async () => {
    const c = fakeClient()
    await expect(saveAddonPieces({ supabase: c, templateId: 't1', rows: [row({ length_factor: 0 })] })).rejects.toThrow(/ตัวคูณความยาว/)
    expect(c.calls).toEqual([])
  })
  it('an insert error is thrown after the delete', async () => {
    const c = fakeClient({ failOn: { table: 'bom_template_addon_pieces', op: 'insert' } })
    await expect(saveAddonPieces({ supabase: c, templateId: 't1', rows: [row()] })).rejects.toThrow('boom')
    expect(c.calls).toHaveLength(2)
  })
  it('a delete error stops before any insert', async () => {
    const c = fakeClient({ failOn: { table: 'bom_template_addon_pieces', op: 'delete' } })
    await expect(saveAddonPieces({ supabase: c, templateId: 't1', rows: [row()] })).rejects.toThrow('boom')
    expect(c.calls).toHaveLength(1)
  })
  it('inserts in chunks of 200', async () => {
    const c = fakeClient()
    await saveAddonPieces({ supabase: c, templateId: 't1', rows: Array.from({ length: 450 }, (_, i) => row({ sort_order: i })) })
    expect(c.calls.filter(x => x[0] === 'insert').map(x => x[2])).toEqual([200, 200, 50])
  })
})

describe('loadAddonPieces', () => {
  it('groups by template and returns [] for ids without rows', async () => {
    const c = fakeClient({ data: { bom_template_addon_pieces: [{ template_id: 'a', ...row() }] } })
    const r = await loadAddonPieces({ supabase: c, templateIds: ['a', 'b'] })
    expect(Object.keys(r)).toEqual(['a', 'b'])
    expect(r.a).toHaveLength(1)
    expect(r.b).toEqual([])
    expect(c.calls[0]).toEqual(['select', 'bom_template_addon_pieces', ['template_id', ['a', 'b']], ['order', 'id'], ['range', 0, 999]])
  })
  it('no ids: no query; read error throws', async () => {
    const c = fakeClient()
    expect(await loadAddonPieces({ supabase: c, templateIds: [] })).toEqual({})
    expect(c.calls).toEqual([])
    await expect(loadAddonPieces({ supabase: fakeClient({ failOn: { table: 'bom_template_addon_pieces', op: 'select' } }), templateIds: ['a'] })).rejects.toThrow('boom')
  })
})

const addon = (o = {}) => ({ mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1000, thick_mm: 400, offset_mm: 0, rows: 1, cols: 3, ...o })

describe('item add-ons', () => {
  it('mm -> m (6 dp) with sort_order and whitelisted columns', () => {
    const rows = itemAddonsToRows([addon({ thick_mm: 400, len_mm: 1723.8, extra: 1 }), addon()], 'o1')
    expect(rows[0]).toEqual({ opening_id: 'o1', mode: 'merge', kind: 'fixed', position: 'top', len_m: 1.7238, thick_m: 0.4, offset_m: 0, align: 'start', rows: 1, cols: 3, sort_order: 0 })
    expect(rows[1].sort_order).toBe(1)
  })
  it('m (strings) -> mm, sorted, ids kept', () => {
    const out = itemAddonsFromRows([
      { id: 'b', opening_id: 'o', mode: 'merge', kind: 'fixed', position: 'top', len_m: '1.7238', thick_m: '0.4', offset_m: '0', rows: '1', cols: '3', sort_order: 1 },
      { id: 'a', opening_id: 'o', mode: 'attach', kind: 'awning', position: 'left', len_m: 1, thick_m: 0.4, offset_m: 0.05, rows: 2, cols: 2, sort_order: 0 },
    ])
    expect(out.map(x => x.id)).toEqual(['a', 'b'])
    expect(out[1]).toEqual({ id: 'b', mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1723.8, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3 })
    expect(out[0].offset_mm).toBe(50)
    expect(out[0].align).toBe('start')
  })
  it('saveItemAddons: delete then insert; 7 add-ons => zero calls and a Thai message', async () => {
    const c = fakeClient()
    await saveItemAddons({ supabase: c, openingId: 'o1', addons: [addon()], main: { widthMm: 2000, heightMm: 1500 } })
    expect(c.calls).toEqual([['delete', 'estimation_item_addons', 'opening_id', 'o1'], ['insert', 'estimation_item_addons', 1]])
    const d = fakeClient()
    await expect(saveItemAddons({ supabase: d, openingId: 'o1', addons: Array.from({ length: 7 }, () => addon()), main: {} })).rejects.toThrow(/ไม่เกิน 6/)
    expect(d.calls).toEqual([])
  })
  it('saveItemAddons with none just deletes; errors throw', async () => {
    const c = fakeClient()
    await saveItemAddons({ supabase: c, openingId: 'o1', addons: [], main: {} })
    expect(c.calls).toEqual([['delete', 'estimation_item_addons', 'opening_id', 'o1']])
    await expect(saveItemAddons({ supabase: fakeClient({ failOn: { table: 'estimation_item_addons', op: 'insert' } }), openingId: 'o1', addons: [addon()], main: {} })).rejects.toThrow('boom')
  })
  it('loadItemAddons groups by opening and returns [] for the rest', async () => {
    const c = fakeClient({ data: { estimation_item_addons: [{ id: 'i', opening_id: 'o1', mode: 'merge', kind: 'fixed', position: 'top', len_m: 1, thick_m: 0.4, offset_m: 0, rows: 1, cols: 1, sort_order: 0 }] } })
    const r = await loadItemAddons({ supabase: c, openingIds: ['o1', 'o2'] })
    expect(r.o1[0].len_mm).toBe(1000)
    expect(r.o2).toEqual([])
    expect(await loadItemAddons({ supabase: fakeClient(), openingIds: [] })).toEqual({})
  })
})

describe('I-3: add-on loads are chunked and paged', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `t${String(i).padStart(3, '0')}`)
  it('250 template ids ⇒ 3 chunked requests (100 ids each), merged per id, [] for ids without rows', async () => {
    const c = fakeClient({ data: { bom_template_addon_pieces: [
      { id: 'r1', template_id: 't000', ...row() }, { id: 'r2', template_id: 't150', ...row() }, { id: 'r3', template_id: 't249', ...row({ sort_order: 1 }) },
      { id: 'r4', template_id: 't249', ...row({ sort_order: 0 }) },
    ] } })
    const r = await loadAddonPieces({ supabase: c, templateIds: ids })
    expect(c.calls.filter(x => x[0] === 'select')).toHaveLength(3)
    expect(c.calls.map(x => x[2][1].length)).toEqual([100, 100, 50])
    expect(Object.keys(r)).toHaveLength(250)
    expect(r.t000.map(x => x.id)).toEqual(['r1'])
    expect(r.t150.map(x => x.id)).toEqual(['r2'])
    expect(r.t249.map(x => x.id)).toEqual(['r4', 'r3'])
    expect(r.t001).toEqual([])
  })
  it('a chunk returning exactly the page size reads the next page', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, opening_id: 'o1', mode: 'merge', kind: 'fixed', position: 'top', len_m: 1, thick_m: 0.4, offset_m: 0, rows: 1, cols: 1, sort_order: i }))
    const c = fakeClient({ data: { estimation_item_addons: [...many, { ...many[0], id: 'b0', opening_id: 'o2' }] } })
    const r = await loadItemAddons({ supabase: c, openingIds: ['o1', 'o2', 'o3'] })
    expect(c.calls.map(x => x.slice(3))).toEqual([[['order', 'id'], ['range', 0, 999]], [['order', 'id'], ['range', 1000, 1999]]])
    expect(r.o1).toHaveLength(1000)
    expect(r.o2.map(x => x.id)).toEqual(['b0'])
    expect(r.o3).toEqual([])
  })
})
